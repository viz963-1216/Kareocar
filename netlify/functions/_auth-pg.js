'use strict';

/**
 * 身分流程的共用工具：登入速率限制、手機號碼正規化、驗證碼與比對工具。
 *
 * 密碼與 session token 已交給 Supabase Auth（見 _supabase-auth.js、_session.js），
 * 這裡不再保存或驗證密碼。
 *
 * AUTH_SESSION_SECRET 現在只用來把手機號碼、IP 轉成速率限制表裡不可逆的鍵
 * （opaqueKey），名稱沿用以免正式環境變數改名。
 */

const crypto = require('crypto');

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


function authError(code, message) {
  return Object.assign(new Error(String(message || '驗證失敗')), { code: String(code || 'AUTH_ERROR') });
}

function requireSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw authError('CONFIG_MISSING', `Netlify 尚未設定 ${name}`);
  return value;
}


/* ------------------------------------------------------------------ 雜湊 */

/**
 * 迭代 HMAC-SHA256（PBKDF2 的 F 函式），忘記密碼驗證碼的雜湊用（_auth-reset.js）。
 * HMAC 的 key 是 pepper、訊息是 salt|值。
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

/** 台灣手機號碼正規化成 09 開頭的本地格式。 */
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
  authError, requireSecret, stretchHex, randomHex, secureOtpCode, constantTimeEqual,
  opaqueKey, assertLoginAllowed, recordLoginFailure, clearLoginRate,
  normalizeTaiwanPhone, toE164
};
