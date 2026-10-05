'use strict';

/**
 * 登入工作階段：HttpOnly cookie 與每次請求的驗證。
 *
 * Supabase Auth 簽發的 access token 與 refresh token 只存在 HttpOnly cookie 裡，
 * 瀏覽器的 JavaScript 讀不到，XSS 偷不走 token。
 *
 *   cr_at  access token，Path=/api，每支 API 都會帶
 *   cr_rt  refresh token，Path=/api/v2/session，只有換 token 的端點收得到
 *
 * 兩個 cookie 都是 SameSite=Strict：跨站請求不會帶上，所以不需要另外的 CSRF token；
 * 寫入類請求另外檢查 Origin，當作第二道防線。
 *
 * 驗證分兩步：
 *   requireSession(event)          驗 JWT 簽章與有效期，不碰資料庫
 *   assertSessionActive(client, s) 在 withUser 交易內確認帳號啟用、token 簽發時間
 *                                  不早於 sessions_valid_after（改密碼會把它推到現在）
 */

const supabaseAuth = require('./_supabase-auth');

const ACCESS_COOKIE = 'cr_at';
const REFRESH_COOKIE = 'cr_rt';
const ACCESS_PATH = '/api';
const REFRESH_PATH = '/api/v2/session';
const REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function sessionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] || '') : '';
}

function readCookie(event, name) {
  for (const part of header(event, 'cookie').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// 正式站一律 https，一律加 Secure。唯一的例外是本機 http 開發伺服器與端對端測試
// （127.0.0.1、localhost），而且沒有經過 https 代理。
function secureAttr(event) {
  const host = header(event, 'host').replace(/:\d+$/, '');
  const proto = header(event, 'x-forwarded-proto');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  return loopback && proto !== 'https' ? '' : '; Secure';
}

function cookie(event, name, value, path, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=Strict${secureAttr(event)}`;
}

/** 登入、換 token 成功後要設定的 cookie。 */
function sessionCookies(event, tokens) {
  return [
    cookie(event, ACCESS_COOKIE, tokens.accessToken, ACCESS_PATH, tokens.expiresIn),
    cookie(event, REFRESH_COOKIE, tokens.refreshToken, REFRESH_PATH, REFRESH_MAX_AGE_SECONDS)
  ];
}

/** 登出或 session 失效時清掉 cookie。 */
function clearSessionCookies(event) {
  return [
    cookie(event, ACCESS_COOKIE, '', ACCESS_PATH, 0),
    cookie(event, REFRESH_COOKIE, '', REFRESH_PATH, 0)
  ];
}

/** 寫入類請求：有 Origin 標頭時必須與 Host 相同。 */
function assertSameOrigin(event) {
  if (String(event.httpMethod || 'GET').toUpperCase() === 'GET') return;
  const origin = header(event, 'origin');
  if (!origin) return;
  let originHost = '';
  try { originHost = new URL(origin).host; } catch (_) { originHost = ''; }
  if (!originHost || originHost !== header(event, 'host')) {
    throw sessionError('FORBIDDEN', '拒絕跨站請求');
  }
}

/** 驗 access token（簽章、有效期）。回傳 { userId, iat, exp, accessToken }。 */
async function requireSession(event) {
  assertSameOrigin(event);
  const accessToken = readCookie(event, ACCESS_COOKIE);
  if (!accessToken) throw sessionError('SESSION_REQUIRED', '請先登入');
  const claims = await supabaseAuth.verifyAccessToken(accessToken);
  return { ...claims, accessToken };
}

/**
 * 在 withUser(session.userId) 交易內呼叫：帳號啟用中、token 沒有被撤銷；用綁定的社群帳號登入時
 * （token 的 sub 與使用者不同，見 0014），對應必須還在——解除綁定後舊 token 立即失效。
 */
async function assertSessionActive(client, session) {
  if (session.authUserId && session.authUserId !== session.userId) {
    const owner = (await client.query('select app.social_login_user($1) as u', [session.authUserId])).rows[0];
    if (!owner || owner.u !== session.userId) throw sessionError('SESSION_INVALID', '社群登入已解除綁定，請重新登入');
  }
  const { rows } = await client.query('select * from app.session_state($1)', [session.userId]);
  const state = rows[0];
  if (!state) throw sessionError('SESSION_INVALID', '使用者不存在，請重新登入');
  if (state.active !== true) throw sessionError('SESSION_INVALID', '此帳號已停用');
  if (Number(session.iat) < Number(state.valid_after)) {
    throw Object.assign(sessionError('SESSION_INVALID', '登入工作階段已失效，請重新登入'),
      { revokedUntil: Number(state.valid_after) });
  }
}

/** 讓這個使用者所有既有的 access token 失效。回傳新的生效起點（epoch 秒）。 */
async function revokeSessions(client, userId) {
  const { rows } = await client.query('select app.revoke_sessions($1) as valid_after', [userId]);
  return Number(rows[0] && rows[0].valid_after);
}

/** 等到生效起點之後（最多約一秒），這之後簽發的 token 才會被接受。 */
async function waitUntilValid(validAfterEpochSeconds) {
  const wait = Number(validAfterEpochSeconds) * 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 2000) + 5));
}

module.exports = {
  ACCESS_COOKIE, REFRESH_COOKIE,
  readCookie, sessionCookies, clearSessionCookies, assertSameOrigin,
  requireSession, assertSessionActive, revokeSessions, waitUntilValid
};
