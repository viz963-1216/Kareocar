'use strict';

/**
 * 身分驗證核心（Postgres 版）。
 *
 * 這是原本 Apps Script AuthCore.gs（已移除）的 Node 移植版，演算法刻意保持一致，讓
 * Apps Script 期間建立的憑證在切換之後仍然驗得過。差別只在儲存位置：
 *
 *   憑證     Script Properties / 密碼憑證工作表  →  password_credentials 表
 *   速率狀態 CacheService                       →  auth_rate_limits 表（有 TTL）
 *   session  Script Properties                  →  users.session_version
 *
 * 密碼雜湊仍然經過 pepper，而 pepper 只在 Netlify 的環境變數裡——資料庫整個
 * 外洩也沒有 pepper 可以拿來離線破解。
 */

const crypto = require('crypto');

const SESSION_TTL_SECONDS = 12 * 60 * 60;

const LOGIN_WINDOW_SECONDS = 30 * 60;
const LOGIN_LOCK_STEPS = [
  { failures: 5, lockSeconds: 3 * 60 },
  { failures: 10, lockSeconds: 30 * 60 },
  { failures: 20, lockSeconds: 60 * 60 }
];
const LOGIN_MAX_LOCK_SECONDS = 60 * 60;
const LOGIN_IP_WINDOW_SECONDS = 30 * 60;
const LOGIN_IP_MAX_FAILURES = 30;
const LOGIN_IP_LOCK_SECONDS = 30 * 60;

const PBKDF2_DEFAULT_ITERATIONS = 6000;
const PBKDF2_MIN_ITERATIONS = 1000;
const PBKDF2_MAX_ITERATIONS = 100000;

function authError(code, message) {
  return Object.assign(new Error(String(message || '驗證失敗')), { code: String(code || 'AUTH_ERROR') });
}

function requireSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw authError('CONFIG_MISSING', `Netlify 尚未設定 ${name}`);
  return value;
}

function iterations() {
  const n = Number(process.env.AUTH_PBKDF2_ITERATIONS) || PBKDF2_DEFAULT_ITERATIONS;
  return Math.min(PBKDF2_MAX_ITERATIONS, Math.max(PBKDF2_MIN_ITERATIONS, Math.floor(n)));
}

/* ------------------------------------------------------------------ 雜湊 */

/**
 * 與 AuthCore.gs 的 authPbkdf2Hex_ 完全相同的演算法：PBKDF2 的 F 函式
 * （迭代 HMAC-SHA256 + XOR 累加），HMAC 的 key 是 pepper、訊息是 salt|password。
 * 保持一致是為了讓兩套系統在切換期間可以驗證同一批憑證。
 */
function stretchHex(password, salt, rounds, pepper) {
  const key = Buffer.from(String(pepper), 'utf8');
  let u = crypto.createHmac('sha256', key).update(Buffer.from(`${salt}|${password}`, 'utf8')).digest();
  const acc = Buffer.from(u);
  for (let i = 1; i < rounds; i++) {
    u = crypto.createHmac('sha256', key).update(u).digest();
    for (let j = 0; j < acc.length; j++) acc[j] ^= u[j];
  }
  return acc.toString('hex');
}

function randomHex(bytes) {
  return crypto.randomBytes(Math.max(16, Number(bytes) || 16)).toString('hex');
}

function secureOtpCode() {
  // 拒絕取樣，避免取模造成的分布偏差
  while (true) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < 4294000000) return String(100000 + (n % 900000));
  }
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------------------------------------------------------- 憑證 */

async function setPasswordCredential(client, userId, password) {
  const pw = String(password || '');
  if (pw.length < 8) throw authError('WEAK_PASSWORD', '密碼至少需要 8 碼');
  if (pw.length > 128) throw authError('WEAK_PASSWORD', '密碼長度不可超過 128 碼');
  const pepper = requireSecret('AUTH_PASSWORD_PEPPER');
  const salt = randomHex(16);
  const rounds = iterations();
  const hash = stretchHex(pw, salt, rounds, pepper);
  await client.query('SELECT app.set_credential($1,$2,$3,$4,$5,$6)',
    [userId, 2, 'iterated-hmac-sha256-peppered', rounds, salt, hash]);
}

async function deletePasswordCredential(client, userId) {
  await client.query('SELECT app.delete_credential($1)', [userId]);
}

/**
 * 驗證密碼，成功時順手把過舊的憑證升級（演算法舊、或成本被調高）。
 * 帳號不存在時仍然做一次完整運算，避免用回應時間判斷帳號是否存在。
 */
async function verifyPasswordCredential(client, userId, password) {
  const pepper = requireSecret('AUTH_PASSWORD_PEPPER');
  const { rows } = await client.query('SELECT * FROM app.get_credential($1)', [userId]);
  const cred = rows[0];
  if (!cred) {
    stretchHex(String(password || ''), 'absent-account-timing-equalizer', iterations(), pepper);
    return false;
  }
  const rounds = Math.min(PBKDF2_MAX_ITERATIONS, Math.max(1, Number(cred.iterations) || PBKDF2_DEFAULT_ITERATIONS));
  const version = Number(cred.version) || 1;
  const computed = version >= 2
    ? stretchHex(String(password || ''), String(cred.salt), rounds, pepper)
    : crypto.createHmac('sha256', Buffer.from(pepper, 'utf8'))
        .update(`${cred.salt}|${String(password || '')}`).digest('hex');

  if (!constantTimeEqual(computed, String(cred.hash))) return false;

  if (version < 2 || rounds < iterations()) {
    try { await setPasswordCredential(client, userId, String(password || '')); } catch (_) { /* 非致命 */ }
  }
  return true;
}

async function hasPasswordCredential(client, userId) {
  const { rows } = await client.query('SELECT app.has_credential($1) AS has', [userId]);
  return !!(rows[0] && rows[0].has);
}

/* ------------------------------------------------------------ session */

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

async function issueSessionToken(client, userId) {
  const { rows } = await client.query('SELECT app.get_session_version($1) AS v', [userId]);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 2, userId: String(userId), sv: Number(rows[0].v) || 1,
    iat: now, exp: now + SESSION_TTL_SECONDS, nonce: randomHex(16)
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', requireSecret('AUTH_SESSION_SECRET')).update(body).digest('hex');
  return `${body}.${sig}`;
}

/** 只驗簽章與有效期，不碰資料庫——中介層用。 */
function parseSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw authError('SESSION_INVALID', '登入工作階段無效，請重新登入');
  const expected = crypto.createHmac('sha256', requireSecret('AUTH_SESSION_SECRET')).update(parts[0]).digest('hex');
  if (!constantTimeEqual(expected, parts[1])) throw authError('SESSION_INVALID', '登入工作階段簽章無效，請重新登入');
  let payload;
  try { payload = JSON.parse(unb64url(parts[0])); } catch (_) { throw authError('SESSION_INVALID', '登入工作階段格式錯誤'); }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.userId || Number(payload.exp || 0) <= now) {
    throw authError('SESSION_EXPIRED', '登入工作階段已過期，請重新登入');
  }
  return payload;
}

/** 完整驗證：加上 session 版本比對，改過密碼的舊 token 會被踢掉。 */
async function verifySessionToken(client, token) {
  const payload = parseSessionToken(token);
  const { rows } = await client.query('SELECT app.get_session_version($1) AS v', [payload.userId]);
  const current = Number(rows[0] && rows[0].v) || 0;
  if (current === 0) throw authError('SESSION_INVALID', '使用者不存在，請重新登入');
  if (Number(payload.sv || 1) !== current) throw authError('SESSION_INVALID', '登入工作階段已失效，請重新登入');
  return payload;
}

async function bumpSessionVersion(client, userId) {
  const { rows } = await client.query('SELECT app.bump_session_version($1) AS v', [userId]);
  return Number(rows[0].v);
}

/* ------------------------------------------------------------ 速率限制 */

function opaqueKey(kind, value) {
  return crypto.createHmac('sha256', requireSecret('AUTH_SESSION_SECRET'))
    .update(`${kind}:${String(value || '')}`).digest('hex').slice(0, 40);
}

async function rateGet(client, key) {
  const { rows } = await client.query('SELECT app.rate_get($1) AS state', [key]);
  return (rows[0] && rows[0].state) || null;
}
async function ratePut(client, key, state, ttlSeconds) {
  await client.query('SELECT app.rate_put($1,$2,$3)', [key, JSON.stringify(state), Math.floor(ttlSeconds)]);
}
async function rateClear(client, key) {
  await client.query('SELECT app.rate_clear($1)', [key]);
}

function rateLimitedError(retryAfterSeconds) {
  return Object.assign(authError('LOGIN_RATE_LIMITED', '登入嘗試過於頻繁，請稍後再試'),
    { retryAfterSeconds: Math.max(1, Number(retryAfterSeconds) || 1) });
}

function freshState(now) { return { failures: 0, windowStartedAt: now, lockedUntil: 0 }; }

async function loadRateState(client, key, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  let state = await rateGet(client, key) || freshState(now);
  if (Number(state.lockedUntil || 0) <= now &&
      now - Number(state.windowStartedAt || 0) > windowSeconds) {
    state = freshState(now);
  }
  return { state, now };
}

/**
 * 鎖定是「會自己解除的階梯式軟鎖」，不是永久鎖。舊版累積 10 次失敗會設定
 * 永不解除的旗標，等於任何知道對方手機號碼的人都能讓他登不進去。
 */
async function assertLoginAllowed(client, phone, sourceIp) {
  const phoneKey = opaqueKey('phone', phone);
  const { state, now } = await loadRateState(client, phoneKey, LOGIN_WINDOW_SECONDS);
  if (Number(state.lockedUntil || 0) > now) throw rateLimitedError(Number(state.lockedUntil) - now);

  if (sourceIp) {
    const ipKey = opaqueKey('ip', sourceIp);
    const ip = await loadRateState(client, ipKey, LOGIN_IP_WINDOW_SECONDS);
    if (Number(ip.state.lockedUntil || 0) > ip.now) {
      throw rateLimitedError(Number(ip.state.lockedUntil) - ip.now);
    }
  }
}

function lockSecondsForFailures(failures) {
  let lock = 0;
  for (const step of LOGIN_LOCK_STEPS) if (failures >= step.failures) lock = step.lockSeconds;
  return Math.min(LOGIN_MAX_LOCK_SECONDS, lock);
}

async function recordLoginFailure(client, phone, sourceIp) {
  const phoneKey = opaqueKey('phone', phone);
  const { state, now } = await loadRateState(client, phoneKey, LOGIN_WINDOW_SECONDS);
  state.failures = Math.max(0, Number(state.failures) || 0) + 1;
  state.lastFailureAt = now;
  const lock = lockSecondsForFailures(state.failures);
  if (lock > 0) state.lockedUntil = now + lock;
  await ratePut(client, phoneKey, state, LOGIN_WINDOW_SECONDS + LOGIN_MAX_LOCK_SECONDS);

  if (sourceIp) {
    const ipKey = opaqueKey('ip', sourceIp);
    const ip = await loadRateState(client, ipKey, LOGIN_IP_WINDOW_SECONDS);
    ip.state.failures = Math.max(0, Number(ip.state.failures) || 0) + 1;
    if (ip.state.failures >= LOGIN_IP_MAX_FAILURES) {
      ip.state.lockedUntil = ip.now + LOGIN_IP_LOCK_SECONDS;
      ip.state.failures = 0;
      ip.state.windowStartedAt = ip.now;
    }
    await ratePut(client, ipKey, ip.state, LOGIN_IP_WINDOW_SECONDS + LOGIN_IP_LOCK_SECONDS);
  }
  return state;
}

async function clearLoginRate(client, phone) {
  await rateClear(client, opaqueKey('phone', phone));
}

/* ---------------------------------------------------------------- 工具 */

/** 台灣手機號碼正規化，與 IdentityApi.gs 的 normalizeTaiwanPhoneForIdentity_ 一致。 */
function normalizeTaiwanPhone(value) {
  const raw = String(value || '').replace(/[^\d+]/g, '');
  if (/^09\d{8}$/.test(raw)) return raw;
  if (/^\+8869\d{8}$/.test(raw)) return `0${raw.substring(4)}`;
  if (/^8869\d{8}$/.test(raw)) return `0${raw.substring(3)}`;
  return raw.replace(/\D/g, '');
}

function toE164(localPhone) {
  return `+886${String(localPhone).substring(1)}`;
}

module.exports = {
  authError, requireSecret, iterations, stretchHex, randomHex, secureOtpCode, constantTimeEqual,
  setPasswordCredential, deletePasswordCredential, verifyPasswordCredential, hasPasswordCredential,
  issueSessionToken, parseSessionToken, verifySessionToken, bumpSessionVersion,
  opaqueKey, assertLoginAllowed, recordLoginFailure, clearLoginRate,
  normalizeTaiwanPhone, toE164,
  SESSION_TTL_SECONDS
};
