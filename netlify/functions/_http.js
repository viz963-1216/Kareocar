'use strict';

/**
 * Netlify Function 共用的 HTTP 小工具：JSON 回應、請求本體解析、錯誤碼對應 HTTP 狀態、
 * 來源 IP。原本放在 _apps-script.js，和轉送 Apps Script 的程式放在一起；Apps Script
 * 移除之後只留下這些。
 */

const sentry = require('./_sentry');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

/** 在回應上附加 Set-Cookie（Netlify 以 multiValueHeaders 支援多個同名標頭）。 */
function withCookies(response, cookies) {
  const list = (cookies || []).filter(Boolean);
  if (!list.length) return response;
  const multi = { ...(response.multiValueHeaders || {}) };
  multi['Set-Cookie'] = [...(multi['Set-Cookie'] || []), ...list];
  return { ...response, multiValueHeaders: multi };
}

/**
 * Source IP of the caller, for per-IP login throttling. Netlify sets
 * x-nf-client-connection-ip; the x-forwarded-for fallback takes only the
 * left-most entry, which is the one Netlify's edge actually observed.
 */
function clientIp(event) {
  const headers = event?.headers || {};
  const direct = headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'];
  if (direct) return String(direct).trim();
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  return String(forwarded).split(',')[0].trim();
}

function parseBody(event) {
  try { return event?.body ? JSON.parse(event.body) : {}; }
  catch (_) { throw Object.assign(new Error('JSON 請求格式錯誤'), { code: 'BAD_JSON' }); }
}

function handleError(error) {
  const code = error?.code || 'FUNCTION_ERROR';
  const userStatus = code === 'INVALID_CREDENTIALS' ? 401
    : code === 'LOGIN_RATE_LIMITED' ? 429
    : code === 'FORBIDDEN' || code === 'COLLECTION_FORBIDDEN' || code === 'TABLE_FORBIDDEN' || code === 'CONSENT_REQUIRED' ? 403
    : code === 'BOOKING_CONFLICT' || code === 'TRIP_CONFLICT' ? 409
    : code === 'SESSION_INVALID' || code === 'SESSION_EXPIRED' || code === 'SESSION_REQUIRED' ? 401
    : code === 'VALIDATION_ERROR' || code === 'ADDRESS_NOT_FOUND' || code === 'ROUTE_NOT_FOUND' || code === 'WEAK_PASSWORD' || code === 'ACCOUNT_EXISTS' || code === 'PHONE_EXISTS' || code === 'MEMBERSHIP_EXISTS' || code === 'OWNER_EXISTS' ? 400
    : code === 'CURRENT_PASSWORD_REQUIRED' ? 400
    : code === 'CONFIG_MISSING' || code === 'CONFIG_INVALID' || code === 'AUTH_PROVIDER_UNAVAILABLE' || code === 'AUTH_PROVIDER_MISCONFIGURED' || code === 'GEO_PROVIDER_UNAVAILABLE' ? 503
    // 「找不到」與「沒有權限」不是伺服器故障。漏掉這幾個會掉進最後的 502，
    // 前端就會顯示「後端服務錯誤」，而實際上只是這個人看不到那個組織。
    : code === 'ORG_NOT_FOUND' || code === 'USER_NOT_FOUND' || code === 'NOT_FOUND' ? 404
    : code === 'NO_ACTIVE_IDENTITY' ? 403
    : code === 'IDENTITY_CONFLICT' ? 409
    : 502;
  // 沒有我們定義錯誤碼的例外（程式錯誤、資料庫原始錯誤）不把內部訊息回給前端
  const unexpected = !error?.code || code === 'FUNCTION_ERROR' || /^[0-9A-Z]{5}$/.test(code);
  const detail = { code, message: unexpected && userStatus >= 500 ? '服務暫時無法使用，請稍後再試' : (error?.message || '服務暫時無法使用') };
  // 欄位層級的錯誤（例如哪一個地址找不到）讓前端可以標在正確的輸入框
  if (error && typeof error.field === 'string') detail.field = error.field;
  const response = json(userStatus, { ok: false, error: detail });
  // 伺服器端錯誤（5xx）送到 Sentry（#17）；有設定 SENTRY_DSN 時回傳 Promise，等送出後才回應，
  // 避免 Function 回應後被凍結、事件沒送出去。所有呼叫端都是 `return handleError(...)`。
  if (userStatus >= 500 && sentry.enabled()) {
    return sentry.captureException(error, { tags: { code, status: String(userStatus) } })
      .then((eventId) => (eventId ? { ...response, body: JSON.stringify({ ok: false, error: { ...detail, errorId: eventId } }) } : response),
        () => response);
  }
  return response;
}

module.exports = { json, withCookies, parseBody, handleError, clientIp };
