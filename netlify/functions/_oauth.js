'use strict';

/**
 * Google、Facebook 登入的共用工具（#58）。
 *
 * 流程（都走自己的 API，token 一樣只放在 HttpOnly cookie）：
 *
 *   oauth-start ──302──▶ Supabase ──▶ Google／Facebook ──▶ Supabase ──302──▶ oauth-callback?code=…
 *
 *   - oauth-start 產生 PKCE 的 code_verifier，放在 cr_oauth cookie（只送到 oauth-callback）。
 *     只有發起登入的這個瀏覽器拿得到 verifier，別人塞過來的授權碼換不到 session（擋 login CSRF）。
 *   - oauth-callback 以授權碼＋verifier 換 session：
 *       已綁定的帳號 → 寫入登入 cookie
 *       還沒綁定     → 不給登入 cookie，只給 cr_bind（簽章過的待綁定資料，15 分鐘），轉到綁定畫面
 *   - 綁定既有帳號要輸入那支手機的密碼；綁定完成後所有 API 才用得到。
 *
 * cr_oauth 必須 SameSite=Lax：回呼是從 Supabase 跨站轉回來的頂層 GET，Strict 的 cookie 不會被帶上。
 * 它只有一次性的 verifier，沒有登入能力。cr_bind 是 Strict，只在本站的 fetch 用。
 */

const crypto = require('crypto');
const auth = require('./_auth-pg');

const OAUTH_COOKIE = 'cr_oauth';
const OAUTH_PATH = '/api/v2/oauth-callback';
const OAUTH_MAX_AGE_SECONDS = 10 * 60;
const BIND_COOKIE = 'cr_bind';
const BIND_PATH = '/api/v2/oauth-bind';
const BIND_MAX_AGE_SECONDS = 15 * 60;
const CALLBACK_PATH = '/api/v2/oauth-callback';

function header(event, name) {
  const headers = (event && event.headers) || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] || '') : '';
}

function isLoopback(event) {
  const host = header(event, 'host').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function secureAttr(event) {
  return isLoopback(event) && header(event, 'x-forwarded-proto') !== 'https' ? '' : '; Secure';
}

function cookie(event, name, value, path, maxAge, sameSite) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=${sameSite}${secureAttr(event)}`;
}

/** 本站的 origin（正式站、Deploy Preview 各用自己的網址）。Supabase 只接受白名單裡的回呼網址。 */
function siteOrigin(event) {
  const host = header(event, 'host');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) && !/^\[::1\](:\d+)?$/.test(host)) {
    throw auth.authError('VALIDATION_ERROR', '無法判斷網站網址');
  }
  return `${secureAttr(event) ? 'https' : 'http'}://${host}`;
}

function callbackUrl(event) {
  return `${siteOrigin(event)}${CALLBACK_PATH}`;
}

/* ------------------------------------------------- 簽章（cr_oauth、cr_bind 共用） */

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', auth.requireSecret('AUTH_SESSION_SECRET'))
    .update(`oauth|${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function verify(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', auth.requireSecret('AUTH_SESSION_SECRET'))
    .update(`oauth|${body}`).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * PKCE 暫存：verifier、登入方式、用途（login＝登入；link＝已登入者綁定，expectUserId 是
 * 預期換到的使用者）。簽章是為了讓 mode／expectUserId 不能被改；verifier 本身只在這裡。
 */
function oauthCookie(event, { verifier, provider, mode = 'login', expectUserId = null }) {
  const value = sign({ v: verifier, p: provider, m: mode, u: expectUserId, exp: nowSec() + OAUTH_MAX_AGE_SECONDS });
  return cookie(event, OAUTH_COOKIE, value, OAUTH_PATH, OAUTH_MAX_AGE_SECONDS, 'Lax');
}
function clearOauthCookie(event) { return cookie(event, OAUTH_COOKIE, '', OAUTH_PATH, 0, 'Lax'); }

function bindCookie(event, { authUserId, provider, email, name }) {
  const value = sign({ a: authUserId, p: provider, e: email || '', n: name || '', exp: nowSec() + BIND_MAX_AGE_SECONDS });
  return cookie(event, BIND_COOKIE, value, BIND_PATH, BIND_MAX_AGE_SECONDS, 'Strict');
}
function clearBindCookie(event) { return cookie(event, BIND_COOKIE, '', BIND_PATH, 0, 'Strict'); }

function readCookie(event, name) {
  for (const part of header(event, 'cookie').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; }
    }
  }
  return '';
}

function readOauth(event) {
  const p = verify(readCookie(event, OAUTH_COOKIE));
  return p && p.v ? { verifier: p.v, provider: p.p, mode: p.m, expectUserId: p.u || null } : null;
}

function readBind(event) {
  const p = verify(readCookie(event, BIND_COOKIE));
  return p && p.a ? { authUserId: String(p.a), provider: p.p, email: p.e || '', name: p.n || '' } : null;
}

/** 302 轉址，附加 Set-Cookie。 */
function redirect(location, cookies = []) {
  const res = {
    statusCode: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    body: ''
  };
  const list = cookies.filter(Boolean);
  if (list.length) res.multiValueHeaders = { 'Set-Cookie': list };
  return res;
}

module.exports = {
  OAUTH_COOKIE, BIND_COOKIE, CALLBACK_PATH,
  siteOrigin, callbackUrl, oauthCookie, clearOauthCookie, bindCookie, clearBindCookie,
  readOauth, readBind, redirect
};
