'use strict';

/**
 * Supabase Auth 的窄介面。
 *
 * 密碼、token 簽發與撤銷都由 Supabase Auth 負責；這支模組只做三件事：
 *   1. 呼叫 Supabase Auth 的 HTTP API（登入、換 token、建立／更新使用者、登出）
 *   2. Google、Facebook 登入（#58）：產生授權網址（PKCE）、以授權碼換 session、
 *      綁定與解除綁定登入方式
 *   3. 驗證 access token（JWT）的簽章與有效期
 *
 * 測試時用 setProvider() 換成假的實作（supabase/tests/_auth-fixture.js），CI 不需要
 * 啟動 Supabase Auth。JWT 驗證本身不換：測試用測試金鑰簽 HS256，走的是跟正式
 * 環境相同的驗證程式。
 *
 * 環境變數：
 *   SUPABASE_URL                 https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY            公開金鑰（anon 或 sb_publishable_…），密碼登入與換 token 用
 *   SUPABASE_SERVICE_ROLE_KEY    秘密金鑰（service_role 或 sb_secret_…），建立與更新使用者用
 *   SUPABASE_JWT_SECRET          （選用）舊版 HS256 簽章金鑰；新版專案用非對稱金鑰，
 *                                會從 /auth/v1/.well-known/jwks.json 取公鑰
 */

const crypto = require('crypto');

const REQUEST_TIMEOUT_MS = 10_000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

function authError(code, message, extra = {}) {
  return Object.assign(new Error(String(message || '驗證失敗')), { code: String(code || 'AUTH_ERROR') }, extra);
}

function env(name, { optional = false } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value && !optional) throw authError('CONFIG_MISSING', `Netlify 尚未設定 ${name}`);
  return value;
}

function baseUrl() {
  const url = env('SUPABASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    throw authError('CONFIG_INVALID', 'SUPABASE_URL 必須是 https 網址');
  }
  return url;
}

/* --------------------------------------------------------------- HTTP 實作 */

async function call(path, { method = 'POST', key, bearer, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: key,
        authorization: `Bearer ${bearer || key}`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw authError('AUTH_PROVIDER_UNAVAILABLE', error && error.name === 'AbortError'
      ? '身分驗證服務逾時，請稍後再試' : '身分驗證服務暫時無法使用');
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: response.status, data };
}

// Supabase Auth 回的錯誤訊息不直接轉給使用者（可能透露帳號是否存在），
// 只依狀態與錯誤碼歸類。
function providerError(result, fallbackCode, fallbackMessage) {
  const code = String((result.data && (result.data.error_code || result.data.code || result.data.error)) || '');
  // 排查用：只印 HTTP 狀態與錯誤代碼，不印訊息本文或 token
  if (process.env.SUPABASE_AUTH_DEBUG === '1') {
    console.warn(`[supabase-auth] HTTP ${result.status} error_code=${code || '（無）'}`);
  }
  if (result.status === 429) return authError('LOGIN_RATE_LIMITED', '嘗試過於頻繁，請稍後再試');
  // 專案設定問題（例如沒有啟用 Phone 登入），不是使用者的帳密錯——不能回「帳號或密碼錯誤」
  if (/provider_disabled|signup_disabled|phone_provider|sms_send_failed|hook_/.test(code)) {
    return authError('AUTH_PROVIDER_MISCONFIGURED', '登入服務設定不完整，請聯絡平台管理者');
  }
  if (/identity_already_exists/.test(code)) {
    return authError('IDENTITY_IN_USE', '這個社群帳號已經綁定在其他帳號上');
  }
  if (/manual_linking_disabled|single_identity_not_deletable/.test(code)) {
    return authError(/single_identity/.test(code) ? 'VALIDATION_ERROR' : 'AUTH_PROVIDER_MISCONFIGURED',
      /single_identity/.test(code) ? '至少要保留一種登入方式' : '登入服務尚未啟用帳號綁定，請聯絡平台管理者');
  }
  if (/phone_exists|user_already_exists|email_exists/.test(code) || result.status === 422 && /already/i.test(String(result.data && result.data.msg))) {
    return authError('PHONE_EXISTS', '此手機號碼已經註冊');
  }
  if (/weak_password/.test(code)) return authError('WEAK_PASSWORD', '密碼強度不足');
  if (result.status >= 500) return authError('AUTH_PROVIDER_UNAVAILABLE', '身分驗證服務暫時無法使用');
  return authError(fallbackCode, fallbackMessage);
}

function tokensFrom(data) {
  if (!data || !data.access_token || !data.refresh_token) {
    throw authError('AUTH_PROVIDER_UNAVAILABLE', '身分驗證服務回應格式不符');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 3600,
    authUserId: data.user && data.user.id ? String(data.user.id) : null
  };
}

/** Supabase 使用者物件裡，社群登入用得到的欄位（不含 token）。 */
function profileFrom(user) {
  const meta = (user && user.user_metadata) || {};
  return {
    authUserId: user && user.id ? String(user.id) : null,
    email: String((user && user.email) || meta.email || '').trim().toLowerCase(),
    name: String(meta.full_name || meta.name || '').trim().slice(0, 80)
  };
}

function identitiesFrom(user) {
  return ((user && user.identities) || []).map((i) => ({
    identityId: String(i.identity_id || i.id || ''),
    provider: String(i.provider || ''),
    email: String((i.identity_data && i.identity_data.email) || i.email || '').toLowerCase()
  }));
}

/* ---------------------------------------------------------- 社群登入（PKCE） */

const OAUTH_PROVIDERS = ['google', 'facebook'];

function assertOAuthProvider(name) {
  const p = String(name || '').toLowerCase();
  if (!OAUTH_PROVIDERS.includes(p)) throw authError('VALIDATION_ERROR', '不支援的登入方式');
  return p;
}

/** 產生 PKCE 的 code_verifier 與 code_challenge（S256）。 */
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 瀏覽器要前往的 Supabase 授權網址（Supabase 再轉到 Google／Facebook）。 */
function authorizeUrl({ provider, redirectTo, codeChallenge }) {
  const q = new URLSearchParams({
    provider: assertOAuthProvider(provider), redirect_to: redirectTo,
    code_challenge: codeChallenge, code_challenge_method: 's256'
  });
  return `${baseUrl()}/auth/v1/authorize?${q}`;
}

const httpProvider = {
  async signInWithPassword(phoneE164, password) {
    const result = await call('/auth/v1/token?grant_type=password',
      { key: env('SUPABASE_ANON_KEY'), body: { phone: phoneE164, password } });
    if (result.status !== 200) throw providerError(result, 'INVALID_CREDENTIALS', '帳號或密碼錯誤');
    return tokensFrom(result.data);
  },

  async refresh(refreshToken) {
    const result = await call('/auth/v1/token?grant_type=refresh_token',
      { key: env('SUPABASE_ANON_KEY'), body: { refresh_token: refreshToken } });
    if (result.status !== 200) throw providerError(result, 'SESSION_EXPIRED', '登入工作階段已過期，請重新登入');
    return tokensFrom(result.data);
  },

  /** 以管理權限建立已驗證手機的使用者。回傳 Supabase Auth 的使用者 ID。 */
  async createUser({ phoneE164, password }) {
    const result = await call('/auth/v1/admin/users', {
      key: env('SUPABASE_SERVICE_ROLE_KEY'),
      body: { phone: phoneE164, password, phone_confirm: true }
    });
    if (result.status !== 200 && result.status !== 201) throw providerError(result, 'AUTH_PROVIDER_ERROR', '無法建立帳號');
    const id = result.data && (result.data.id || (result.data.user && result.data.user.id));
    if (!id) throw authError('AUTH_PROVIDER_UNAVAILABLE', '身分驗證服務回應格式不符');
    return String(id);
  },

  async updateUser(authUserId, { phoneE164, password } = {}) {
    const body = {};
    if (phoneE164) { body.phone = phoneE164; body.phone_confirm = true; }
    if (password) body.password = password;
    const result = await call(`/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
      { method: 'PUT', key: env('SUPABASE_SERVICE_ROLE_KEY'), body });
    if (result.status !== 200) throw providerError(result, 'AUTH_PROVIDER_ERROR', '無法更新帳號');
  },

  /** 建立使用者後，資料庫交易失敗時用來補償刪除。 */
  async deleteUser(authUserId) {
    const result = await call(`/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
      { method: 'DELETE', key: env('SUPABASE_SERVICE_ROLE_KEY') });
    if (result.status !== 200 && result.status !== 204) throw providerError(result, 'AUTH_PROVIDER_ERROR', '無法刪除帳號');
  },

  /** 撤銷這個使用者所有裝置的 refresh token。scope=local 只撤銷目前這一組。 */
  async signOut(accessToken, scope = 'global') {
    const result = await call(`/auth/v1/logout?scope=${scope === 'local' ? 'local' : 'global'}`,
      { key: env('SUPABASE_ANON_KEY'), bearer: accessToken });
    if (result.status !== 204 && result.status !== 200 && result.status !== 401) {
      throw providerError(result, 'AUTH_PROVIDER_ERROR', '登出失敗');
    }
  },

  /** 以授權碼與 code_verifier 換 session（PKCE）。驗證碼不符或用過就失敗。 */
  async exchangeCode(authCode, codeVerifier) {
    const result = await call('/auth/v1/token?grant_type=pkce',
      { key: env('SUPABASE_ANON_KEY'), body: { auth_code: authCode, code_verifier: codeVerifier } });
    if (result.status !== 200) throw providerError(result, 'OAUTH_FAILED', '社群登入失敗，請再試一次');
    return { ...tokensFrom(result.data), profile: profileFrom(result.data && result.data.user) };
  },

  /** 已登入的使用者綁定新的登入方式：回傳要前往的授權網址。 */
  async linkIdentityUrl(accessToken, { provider, redirectTo, codeChallenge }) {
    const q = new URLSearchParams({
      provider: assertOAuthProvider(provider), redirect_to: redirectTo, skip_http_redirect: 'true',
      code_challenge: codeChallenge, code_challenge_method: 's256'
    });
    const result = await call(`/auth/v1/user/identities/authorize?${q}`,
      { method: 'GET', key: env('SUPABASE_ANON_KEY'), bearer: accessToken });
    if (result.status !== 200 || !result.data || !result.data.url) {
      throw providerError(result, 'OAUTH_FAILED', '無法開始綁定，請確認登入服務已啟用綁定功能');
    }
    return String(result.data.url);
  },

  /** 這個使用者目前的登入方式（Supabase 的 identities）。 */
  async listIdentities(accessToken) {
    const result = await call('/auth/v1/user', { method: 'GET', key: env('SUPABASE_ANON_KEY'), bearer: accessToken });
    if (result.status !== 200) throw providerError(result, 'SESSION_INVALID', '登入工作階段已失效，請重新登入');
    return identitiesFrom(result.data);
  },

  async unlinkIdentity(accessToken, identityId) {
    const result = await call(`/auth/v1/user/identities/${encodeURIComponent(identityId)}`,
      { method: 'DELETE', key: env('SUPABASE_ANON_KEY'), bearer: accessToken });
    if (result.status !== 200 && result.status !== 204) throw providerError(result, 'OAUTH_FAILED', '解除綁定失敗');
  },

  async fetchJwks() {
    const result = await call('/auth/v1/.well-known/jwks.json', { method: 'GET', key: env('SUPABASE_ANON_KEY') });
    if (result.status !== 200 || !result.data || !Array.isArray(result.data.keys)) {
      throw authError('AUTH_PROVIDER_UNAVAILABLE', '無法取得身分驗證公鑰');
    }
    return result.data.keys;
  }
};

let provider = httpProvider;

/** 測試用：換掉 Supabase Auth 的 HTTP 實作。傳 null 還原。 */
function setProvider(next) {
  provider = next || httpProvider;
  jwksCache = null;
}

function getProvider() { return provider; }

/* -------------------------------------------------------------- JWT 驗證 */

let jwksCache = null;

async function publicKeyFor(kid, alg) {
  const now = Date.now();
  if (!jwksCache || now - jwksCache.at > JWKS_TTL_MS || !jwksCache.keys.some((k) => k.kid === kid)) {
    jwksCache = { at: now, keys: await provider.fetchJwks() };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid && (!k.alg || k.alg === alg));
  if (!jwk) throw authError('SESSION_INVALID', '登入工作階段簽章無效，請重新登入');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function decodePart(part) {
  try { return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8')); }
  catch (_) { throw authError('SESSION_INVALID', '登入工作階段格式錯誤'); }
}

/**
 * 驗證 access token，回傳 claims。只接受 HS256（搭配 SUPABASE_JWT_SECRET）、
 * ES256、RS256；alg=none 或其他演算法一律拒絕。
 */
async function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw authError('SESSION_INVALID', '登入工作階段無效，請重新登入');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = Buffer.from(parts[2], 'base64url');

  let valid = false;
  if (header.alg === 'HS256') {
    const secret = env('SUPABASE_JWT_SECRET', { optional: true });
    if (!secret) throw authError('SESSION_INVALID', '登入工作階段簽章無效，請重新登入');
    const expected = crypto.createHmac('sha256', secret).update(signed).digest();
    valid = expected.length === signature.length && crypto.timingSafeEqual(expected, signature);
  } else if (header.alg === 'ES256') {
    const key = await publicKeyFor(header.kid, 'ES256');
    valid = crypto.verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } else if (header.alg === 'RS256') {
    const key = await publicKeyFor(header.kid, 'RS256');
    valid = crypto.verify('sha256', signed, key, signature);
  } else {
    throw authError('SESSION_INVALID', '登入工作階段簽章無效，請重新登入');
  }
  if (!valid) throw authError('SESSION_INVALID', '登入工作階段簽章無效，請重新登入');

  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.sub !== 'string') throw authError('SESSION_INVALID', '登入工作階段無效，請重新登入');
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) + CLOCK_SKEW_SECONDS <= now) {
    throw authError('SESSION_EXPIRED', '登入工作階段已過期，請重新登入');
  }
  if (claims.role && claims.role !== 'authenticated') throw authError('SESSION_INVALID', '登入工作階段無效，請重新登入');
  return { userId: claims.sub, iat: Number(claims.iat) || 0, exp: Number(claims.exp) };
}

module.exports = {
  signInWithPassword: (...a) => provider.signInWithPassword(...a),
  refresh: (...a) => provider.refresh(...a),
  createUser: (...a) => provider.createUser(...a),
  updateUser: (...a) => provider.updateUser(...a),
  deleteUser: (...a) => provider.deleteUser(...a),
  signOut: (...a) => provider.signOut(...a),
  exchangeCode: (...a) => provider.exchangeCode(...a),
  linkIdentityUrl: (...a) => provider.linkIdentityUrl(...a),
  listIdentities: (...a) => provider.listIdentities(...a),
  unlinkIdentity: (...a) => provider.unlinkIdentity(...a),
  OAUTH_PROVIDERS, assertOAuthProvider, pkcePair, authorizeUrl,
  verifyAccessToken, setProvider, getProvider, authError
};
