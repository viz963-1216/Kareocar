'use strict';

/**
 * 密碼重設的 OTP 挑戰（Postgres 版）。
 *
 * 對應 AuthCore.gs 的 authCreatePasswordResetChallenge_ / authVerifyPasswordResetChallenge_，
 * 儲存位置從 CacheService 換成 auth_rate_limits 表（有 expires_at，會自己過期）。
 *
 * 幾個刻意的設計：
 *  - 驗證碼本身不落地，落地的是加了 pepper 的雜湊。資料庫整個被讀走也拿不到碼。
 *  - 還沒過期的挑戰會「重複使用」而不是重發：使用者連按兩下重寄，不會多花一則
 *    簡訊，也不會看到節流錯誤，只會被告知手上那組還有多久有效。
 *  - 節流檢查排在重複使用之後，所以正常的重寄永遠不會撞到節流。
 *  - 錯誤次數累計在挑戰本身（3 次），超過就作廢，避免用暴力猜六位數。
 */

const crypto = require('crypto');
const auth = require('./_auth-pg');

const RESET_TTL_SECONDS = 5 * 60;
const RESET_MAX_ATTEMPTS = 3;
const RESET_MIN_INTERVAL_SECONDS = 60;
const RESET_WINDOW_SECONDS = 60 * 60;
const RESET_MAX_PER_WINDOW = 5;
const RESET_ITERATIONS = 1000;

const nowSec = () => Math.floor(Date.now() / 1000);

const challengeKey = (phone) => auth.opaqueKey('reset', phone);
const throttleKey = (phone) => auth.opaqueKey('resetrate', phone);

async function stateGet(client, key) {
  const { rows } = await client.query('SELECT app.rate_get($1) AS state', [key]);
  return (rows[0] && rows[0].state) || null;
}
async function statePut(client, key, state, ttlSeconds) {
  await client.query('SELECT app.rate_put($1,$2,$3)',
    [key, JSON.stringify(state), Math.max(1, Math.floor(ttlSeconds))]);
}
async function stateClear(client, key) {
  await client.query('SELECT app.rate_clear($1)', [key]);
}

function hashCode(code, salt) {
  return auth.stretchHex(String(code), String(salt), RESET_ITERATIONS,
    auth.requireSecret('AUTH_PASSWORD_PEPPER'));
}

/** 目前還有效的挑戰，沒有就回 null。 */
async function activeChallenge(client, phone) {
  const state = await stateGet(client, challengeKey(phone));
  if (!state) return null;
  const now = nowSec();
  if (Number(state.expiresAt || 0) <= now) {
    await stateClear(client, challengeKey(phone));
    return null;
  }
  return { state, expiresInSeconds: Number(state.expiresAt) - now };
}

async function assertSendAllowed(client, phone) {
  const key = throttleKey(phone);
  const now = nowSec();
  let state = await stateGet(client, key);
  if (!state || now - Number(state.windowStartedAt || 0) > RESET_WINDOW_SECONDS) {
    state = { count: 0, windowStartedAt: now, lastSentAt: 0 };
  }
  const sinceLast = now - Number(state.lastSentAt || 0);
  if (Number(state.lastSentAt || 0) > 0 && sinceLast < RESET_MIN_INTERVAL_SECONDS) {
    throw Object.assign(
      auth.authError('RESET_RATE_LIMITED', '請求過於頻繁，請稍後再試'),
      { retryAfterSeconds: RESET_MIN_INTERVAL_SECONDS - sinceLast });
  }
  if (Number(state.count || 0) >= RESET_MAX_PER_WINDOW) {
    const retry = Math.max(1, RESET_WINDOW_SECONDS - (now - Number(state.windowStartedAt || 0)));
    throw Object.assign(
      auth.authError('RESET_RATE_LIMITED', '重設次數已達上限，請稍後再試'),
      { retryAfterSeconds: retry });
  }
  return { key, state, now };
}

async function recordSent(client, ctx) {
  ctx.state.count = Number(ctx.state.count || 0) + 1;
  ctx.state.lastSentAt = ctx.now;
  await statePut(client, ctx.key, ctx.state, RESET_WINDOW_SECONDS);
}

/**
 * 建立（或重複使用）一組驗證碼。
 * sendCode 是實際發送的函式，由呼叫端注入——發送可能要好幾秒，而且失敗時
 * 必須把剛寫進去的挑戰刪掉，否則使用者會拿不到碼卻被擋在節流後面。
 */
async function createChallenge(client, userId, phone, sendCode) {
  const existing = await activeChallenge(client, phone);
  if (existing && String(existing.state.userId) === String(userId)) {
    return { expiresInSeconds: existing.expiresInSeconds, resent: false };
  }

  const ctx = await assertSendAllowed(client, phone);
  const code = auth.secureOtpCode();
  const salt = auth.randomHex(16);
  const now = nowSec();
  const state = {
    v: 2, userId: String(userId), phone: String(phone),
    salt, hash: hashCode(code, salt), iterations: RESET_ITERATIONS,
    expiresAt: now + RESET_TTL_SECONDS, attempts: 0, createdAt: now
  };
  await statePut(client, challengeKey(phone), state, RESET_TTL_SECONDS);

  try {
    await sendCode(code);
  } catch (error) {
    await stateClear(client, challengeKey(phone));
    throw error;
  }

  await recordSent(client, ctx);
  return { expiresInSeconds: RESET_TTL_SECONDS, resent: true };
}

/** 驗證成功回傳 { userId }；任何失敗都拋 RESET_CODE_INVALID，不透露是哪一種。 */
async function verifyChallenge(client, phone, code) {
  const key = challengeKey(phone);
  const state = await stateGet(client, key);
  const now = nowSec();
  const invalid = () => auth.authError('RESET_CODE_INVALID', '驗證碼無效或已失效');

  if (!state) throw invalid();
  if (Number(state.expiresAt || 0) <= now) {
    await stateClear(client, key);
    throw auth.authError('RESET_CODE_INVALID', '驗證碼已過期，請重新取得');
  }

  state.attempts = Math.max(0, Number(state.attempts) || 0) + 1;
  if (state.attempts > RESET_MAX_ATTEMPTS) {
    await stateClear(client, key);
    throw auth.authError('RESET_CODE_INVALID', '驗證碼錯誤次數過多，請重新取得');
  }

  const expected = auth.stretchHex(String(code || ''), String(state.salt || ''),
    Math.max(1, Number(state.iterations) || RESET_ITERATIONS),
    auth.requireSecret('AUTH_PASSWORD_PEPPER'));

  if (!auth.constantTimeEqual(expected, String(state.hash || ''))) {
    // 把累加後的嘗試次數寫回去，剩餘有效期不延長
    await statePut(client, key, state, Math.max(1, Number(state.expiresAt) - now));
    throw auth.authError('RESET_CODE_INVALID', '驗證碼錯誤');
  }

  return { userId: String(state.userId) };
}

async function clearChallenge(client, phone) {
  await stateClear(client, challengeKey(phone));
}

module.exports = {
  createChallenge, verifyChallenge, clearChallenge, activeChallenge,
  RESET_TTL_SECONDS, RESET_MAX_ATTEMPTS
};
