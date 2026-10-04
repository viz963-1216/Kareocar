'use strict';
/**
 * 測試用的 Supabase Auth 替身與 JWT 簽發。
 *
 * CI 不啟動 Supabase Auth（見 #11 測試決策）。這裡：
 *   - 以測試金鑰設定 SUPABASE_JWT_SECRET，簽 HS256 的 access token。function 端走的是
 *     與正式環境相同的 verifyAccessToken，簽章、有效期、role 都照常檢查
 *   - 以 setProvider() 換掉 Supabase Auth 的 HTTP 呼叫：帳號、密碼、refresh token
 *     都存在記憶體裡
 *
 * 用法：
 *   const fx = require('./_auth-fixture');          // 在 require 任何 function 之前
 *   fx.addUser('USR-A', '0912000001', 'Password123!');
 *   handler({ httpMethod: 'POST', headers: fx.headersFor('USR-A'), body })
 *   fx.cookiesFrom(response)  // 從回應的 Set-Cookie 取出 cookie 標頭，供下一個請求使用
 *
 * 社群登入（#58）：fx.oauthLogin() 模擬「使用者在 Google／Facebook 完成登入、Supabase 轉回
 * 回呼網址」，回傳授權碼；fx.completeLink() 模擬綁定時的同一段。授權碼只能以對應的
 * code_verifier 換一次 session（PKCE），和 Supabase 相同。
 */
const crypto = require('node:crypto');
const path = require('node:path');

const SECRET = 'synthetic-supabase-jwt-secret-0123456789abcdef';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://synthetic-project.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'synthetic-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'synthetic-service-key';

const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const supabaseAuth = require(path.join(FN, '_supabase-auth.js'));

const byPhone = new Map();     // +8869… → { id, password }
const refreshTokens = new Map(); // refresh token → userId
const calls = [];               // 呼叫紀錄，測試可以斷言「有撤銷 refresh token」等行為
const identities = new Map();   // provider:subject → { userId, identityId, email }
const profiles = new Map();     // 社群登入建立的 userId → { email, name }
const codes = new Map();        // 授權碼 → { userId, challenge, provider }
const links = new Map();        // 綁定請求 → { userId, provider, challenge }
const sha256url = (v) => crypto.createHash('sha256').update(String(v)).digest('base64url');
const subOf = (token) => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).sub;
const phoneOf = (userId) => { for (const [phone, u] of byPhone) if (u.id === userId) return phone; return null; };
function identitiesOf(userId) {
  const list = [];
  if (phoneOf(userId)) list.push({ identityId: `phone-${userId}`, provider: 'phone', email: '' });
  for (const [key, i] of identities) if (i.userId === userId) list.push({ identityId: i.identityId, provider: key.split(':')[0], email: i.email });
  return list;
}
function newCode(userId, challenge, provider) {
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { userId, challenge, provider });
  return code;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** 簽一張 access token。iat 預設現在；可傳 iatOffsetSeconds／expInSeconds 測邊界。 */
function mintAccessToken(userId, { iatOffsetSeconds = 0, expInSeconds = 3600, role = 'authenticated', secret = SECRET, alg = 'HS256' } = {}) {
  const iat = Math.floor(Date.now() / 1000) + iatOffsetSeconds;
  const header = b64({ alg, typ: 'JWT' });
  const payload = b64({ sub: String(userId), role, iat, exp: iat + expInSeconds, aud: 'authenticated' });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function toE164(phone) {
  const p = String(phone);
  return p.startsWith('+') ? p : `+886${p.replace(/^0/, '')}`;
}

function issue(userId) {
  const refreshToken = crypto.randomBytes(16).toString('hex');
  refreshTokens.set(refreshToken, userId);
  return { accessToken: mintAccessToken(userId), refreshToken, expiresIn: 3600, authUserId: userId };
}

const invalid = () => Object.assign(new Error('帳號或密碼錯誤'), { code: 'INVALID_CREDENTIALS' });

const fakeProvider = {
  async signInWithPassword(phoneE164, password) {
    calls.push(['signIn', phoneE164]);
    const u = byPhone.get(phoneE164);
    if (!u || u.password !== password) throw invalid();
    return issue(u.id);
  },
  async refresh(refreshToken) {
    calls.push(['refresh']);
    const userId = refreshTokens.get(refreshToken);
    if (!userId) throw Object.assign(new Error('登入工作階段已過期'), { code: 'SESSION_EXPIRED' });
    refreshTokens.delete(refreshToken);   // Supabase 的 refresh token 用一次就換新
    return issue(userId);
  },
  async createUser({ phoneE164, password }) {
    calls.push(['createUser', phoneE164]);
    if (byPhone.has(phoneE164)) throw Object.assign(new Error('此手機號碼已經註冊'), { code: 'PHONE_EXISTS' });
    const id = crypto.randomUUID();
    byPhone.set(phoneE164, { id, password });
    return id;
  },
  async updateUser(userId, { phoneE164, password } = {}) {
    calls.push(['updateUser', userId, Boolean(phoneE164), Boolean(password)]);
    const entry = [...byPhone.entries()].find(([, u]) => u.id === userId);
    if (!entry && profiles.has(userId) && phoneE164) {
      // 社群登入建立、還沒有手機的帳號：加上手機與密碼
      const owner = byPhone.get(phoneE164);
      if (owner && owner.id !== userId) throw Object.assign(new Error('此手機號碼已經註冊'), { code: 'PHONE_EXISTS' });
      byPhone.set(phoneE164, { id: userId, password: password || '' });
      return;
    }
    if (!entry) throw Object.assign(new Error('找不到帳號'), { code: 'AUTH_PROVIDER_ERROR' });
    const [oldPhone, u] = entry;
    if (password) u.password = password;
    if (phoneE164 && phoneE164 !== oldPhone) { byPhone.delete(oldPhone); byPhone.set(phoneE164, u); }
  },
  async deleteUser(userId) {
    calls.push(['deleteUser', userId]);
    for (const [phone, u] of byPhone) if (u.id === userId) byPhone.delete(phone);
    for (const [key, i] of identities) if (i.userId === userId) identities.delete(key);
    profiles.delete(userId);
  },
  async exchangeCode(code, verifier) {
    calls.push(['exchangeCode']);
    const pending = codes.get(code);
    codes.delete(code);   // 授權碼只能用一次
    if (!pending || sha256url(verifier) !== pending.challenge) {
      throw Object.assign(new Error('社群登入失敗'), { code: 'OAUTH_FAILED' });
    }
    const p = profiles.get(pending.userId) || {};
    const own = [...identities.values()].find((i) => i.userId === pending.userId);
    return { ...issue(pending.userId), profile: { authUserId: pending.userId, email: (own && own.email) || p.email || '', name: p.name || '' } };
  },
  async linkIdentityUrl(accessToken, { provider, redirectTo, codeChallenge }) {
    calls.push(['linkIdentityUrl', provider, codeChallenge]);
    const token = crypto.randomBytes(8).toString('hex');
    links.set(token, { userId: subOf(accessToken), provider, challenge: codeChallenge, redirectTo });
    return `https://synthetic-project.supabase.co/auth/v1/link?req=${token}`;
  },
  async listIdentities(accessToken) {
    calls.push(['listIdentities']);
    return identitiesOf(subOf(accessToken));
  },
  async unlinkIdentity(accessToken, identityId) {
    calls.push(['unlinkIdentity']);
    const userId = subOf(accessToken);
    if (identitiesOf(userId).length < 2) throw Object.assign(new Error('至少要保留一種登入方式'), { code: 'VALIDATION_ERROR' });
    for (const [key, i] of identities) if (i.userId === userId && i.identityId === identityId) identities.delete(key);
  },
  async signOut(accessToken, scope) {
    calls.push(['signOut', scope]);
    const claims = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString());
    if (scope === 'global') for (const [t, id] of refreshTokens) if (id === claims.sub) refreshTokens.delete(t);
  },
  async fetchJwks() { throw Object.assign(new Error('測試只用 HS256'), { code: 'AUTH_PROVIDER_UNAVAILABLE' }); }
};
supabaseAuth.setProvider(fakeProvider);

// ---- 假的地址定位與路線（Google Maps 的替身）----
// 地址含「不存在」或 NOT-FOUND 視為找不到；其他依字串決定性地產生座標、行政區、路段與門牌。
const geo = require(path.join(FN, '_geo.js'));
const geoCalls = [];
const hashInt = (text) => parseInt(crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8), 16);
geo.setProvider({
  async geocode(address) {
    geoCalls.push(['geocode', address]);
    if (/不存在|NOT-FOUND/i.test(address)) {
      throw Object.assign(new Error(`找不到這個地址：${address}`), { code: 'ADDRESS_NOT_FOUND' });
    }
    const text = String(address).replace(/\s+/g, '');
    const m = text.match(/^(.{2}[市縣])(.{1,3}?[區鄉鎮市])(.*?)(\d+)號/);
    const h = hashInt(text);
    return {
      lat: 25 + (h % 1000) / 10000, lng: 121.5 + (h % 997) / 10000,
      district: m ? `${m[1]}${m[2]}` : '合成市合成區',
      route: m && m[3] ? m[3] : '合成路',
      streetNumber: m ? m[4] : '123',
      formattedAddress: text
    };
  },
  async route(from, to) {
    geoCalls.push(['route']);
    const d = 1000 + (hashInt(`${from.lat},${from.lng}>${to.lat},${to.lng}`) % 20000);
    return { distanceMeters: d, durationSeconds: Math.round(d / 8) };
  }
});

/**
 * 模擬在 Google／Facebook 完成登入後，Supabase 轉回回呼網址：這個社群身分已經掛在某個帳號上
 * 就用那個帳號，否則 Supabase 自動建立一個新帳號。回傳授權碼（綁在 codeChallenge 上）。
 */
function oauthLogin({ provider, subject, email = '', name = '', codeChallenge }) {
  const key = `${provider}:${subject}`;
  let entry = identities.get(key);
  if (!entry) {
    const userId = crypto.randomUUID();
    entry = { userId, identityId: crypto.randomUUID(), email };
    identities.set(key, entry);
    profiles.set(userId, { email, name });
  }
  return newCode(entry.userId, codeChallenge, provider);
}

/** 模擬綁定流程的授權完成。社群身分已經在別人身上時，回傳 Supabase 的錯誤參數。 */
function completeLink(url, { subject, email = '' }) {
  const req = new URL(url).searchParams.get('req');
  const link = links.get(req);
  links.delete(req);
  if (!link) throw new Error('沒有這個綁定請求');
  const key = `${link.provider}:${subject}`;
  const owner = identities.get(key);
  if (owner && owner.userId !== link.userId) return { error: 'server_error', error_code: 'identity_already_exists' };
  identities.set(key, { userId: link.userId, identityId: crypto.randomUUID(), email });
  return { code: newCode(link.userId, link.challenge, link.provider) };
}

/** 從授權網址取出 code_challenge（測試用，模擬 Supabase 記住它）。 */
function challengeFrom(url) { return new URL(url).searchParams.get('code_challenge'); }

/** 在假的 Supabase Auth 裡建立帳號（資料庫的 users 列由測試自己建立，id 要相同）。 */
function addUser(userId, phone, password) {
  byPhone.set(toE164(phone), { id: String(userId), password: String(password) });
}

/** 請求標頭：帶 access token cookie，Host 是本機（不加 Secure 旗標）。 */
function headersFor(userId, extra = {}) {
  return { host: '127.0.0.1', cookie: `cr_at=${mintAccessToken(userId)}`, ...extra };
}

/** 回應的 Set-Cookie → 下一個請求的 cookie 標頭（Max-Age=0 的視為刪除）。 */
function cookiesFrom(response, previous = '') {
  const jar = new Map(String(previous).split(';').map((p) => p.trim()).filter(Boolean)
    .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const set = (response && response.multiValueHeaders && response.multiValueHeaders['Set-Cookie']) || [];
  for (const line of set) {
    const [pair, ...attrs] = line.split(';');
    const name = pair.slice(0, pair.indexOf('='));
    const value = pair.slice(pair.indexOf('=') + 1);
    if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0')) jar.delete(name); else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 回應裡設定的 cookie 屬性（測試 HttpOnly、SameSite 等）。 */
function setCookieLines(response) {
  return (response && response.multiValueHeaders && response.multiValueHeaders['Set-Cookie']) || [];
}

// seed.sql 裡的合成帳號與手機號碼（假 Supabase Auth 需要手機號碼才能登入）
const SEED_PHONES = {
  'USR-VICTIM': '0912000001', 'USR-ATTACK': '0912000002', 'USR-DISP1': '0912000003',
  'USR-DRV1': '0912000004', 'USR-OWN2': '0912000005', 'USR-ROOT': '0912000009'
};
/** 替 seed.sql 的帳號設定密碼（取代舊的 auth.setPasswordCredential）。 */
function setSeedPassword(userId, password) {
  const phone = SEED_PHONES[userId];
  if (!phone) throw new Error(`seed.sql 沒有 ${userId} 的手機號碼`);
  addUser(userId, phone, password);
}

/**
 * 舊測試的轉接器：舊測試把 token 放在 Authorization: Bearer 或 body.sessionToken，
 * 並從登入回應的 data.sessionToken 取 token。新 API 只認 HttpOnly cookie、回應裡
 * 沒有 token。這個轉接器只在測試端做格式轉換——function 收到的就是正式的 cookie
 * 請求，回應也照樣經過正式的 Set-Cookie；轉換後把 cookie 裡的 access token 放回
 * data.sessionToken，讓舊測試的斷言寫法不用全部改寫。
 */
function adapt(mod) {
  return {
    handler: async (event = {}) => {
      const headers = { host: '127.0.0.1', ...(event.headers || {}) };
      let token = '';
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'authorization') { token = String(headers[k]).replace(/^Bearer\s+/i, '').trim(); delete headers[k]; }
      }
      let body = event.body;
      if (typeof body === 'string' && body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && 'sessionToken' in parsed) {
            token = token || String(parsed.sessionToken || '');
            delete parsed.sessionToken;
            body = JSON.stringify(parsed);
          }
        } catch (_) { /* 非 JSON 本體照原樣送 */ }
      }
      if (token) headers.cookie = [headers.cookie, `cr_at=${token}`].filter(Boolean).join('; ');
      const res = await mod.handler({ ...event, headers, body });
      const cookies = cookiesFrom(res);
      const at = (cookies.match(/(?:^|; )cr_at=([^;]*)/) || [])[1];
      if (at) {
        try {
          const parsed = JSON.parse(res.body);
          if (parsed && parsed.data && typeof parsed.data === 'object') {
            parsed.data.sessionToken = decodeURIComponent(at);
            return { ...res, body: JSON.stringify(parsed) };
          }
        } catch (_) { /* 非 JSON 回應照原樣回 */ }
      }
      return res;
    }
  };
}

module.exports = { SECRET, mintAccessToken, addUser, setSeedPassword, adapt, headersFor, cookiesFrom, setCookieLines, calls, geoCalls, toE164,
  oauthLogin, completeLink, challengeFrom, identitiesOf };
