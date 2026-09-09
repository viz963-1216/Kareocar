'use strict';

const REQUIRED_ENV = ['APPS_SCRIPT_WEB_APP_URL', 'APPS_SCRIPT_GATEWAY_SECRET'];

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

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw Object.assign(new Error(`Netlify 尚未設定 ${name}`), { code: 'CONFIG_MISSING' });
  return value;
}

async function callAppsScript({ method = 'POST', path, body = {}, query = {} }) {
  REQUIRED_ENV.forEach(requireEnv);
  const url = requireEnv('APPS_SCRIPT_WEB_APP_URL');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(url)) {
    throw Object.assign(new Error('APPS_SCRIPT_WEB_APP_URL 格式錯誤'), { code: 'CONFIG_INVALID' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
      body: JSON.stringify({
        gatewaySecret: requireEnv('APPS_SCRIPT_GATEWAY_SECRET'),
        method,
        path,
        body,
        query,
        requestId: `NET-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      })
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch (_) {
      throw Object.assign(new Error(`Apps Script 回傳非 JSON（HTTP ${response.status}）`), { code: 'UPSTREAM_INVALID_JSON' });
    }
    if (!response.ok) throw Object.assign(new Error(`Apps Script HTTP ${response.status}`), { code: 'UPSTREAM_HTTP_ERROR' });
    if (!payload?.ok) {
      const err = new Error(payload?.error?.message || 'Apps Script 請求失敗');
      err.code = payload?.error?.code || 'UPSTREAM_ERROR';
      throw err;
    }
    return payload.data;
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Apps Script 請求逾時'), { code: 'UPSTREAM_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(event) {
  try { return event?.body ? JSON.parse(event.body) : {}; }
  catch (_) { throw Object.assign(new Error('JSON 請求格式錯誤'), { code: 'BAD_JSON' }); }
}

function handleError(error) {
  const code = error?.code || 'FUNCTION_ERROR';
  const userStatus = code === 'INVALID_CREDENTIALS' ? 401
    : code === 'LOGIN_RATE_LIMITED' || code === 'PASSWORD_RESET_REQUIRED' ? 429
    : code === 'FORBIDDEN' || code === 'GATEWAY_UNAUTHORIZED' || code === 'COLLECTION_FORBIDDEN' || code === 'TABLE_FORBIDDEN' ? 403
    : code === 'BOOKING_CONFLICT' || code === 'TRIP_CONFLICT' ? 409
    : code === 'SESSION_INVALID' || code === 'SESSION_EXPIRED' || code === 'SESSION_REQUIRED' ? 401
    : code === 'VALIDATION_ERROR' || code === 'WEAK_PASSWORD' || code === 'ACCOUNT_EXISTS' || code === 'PHONE_EXISTS' || code === 'MEMBERSHIP_EXISTS' || code === 'OWNER_EXISTS' || code === 'RESET_CODE_INVALID' ? 400
    : code === 'RESET_PROVIDER_UNAVAILABLE' ? 503
    : code === 'CONFIG_MISSING' || code === 'CONFIG_INVALID' ? 503
    : 502;
  return json(userStatus, { ok: false, error: { code, message: error?.message || '服務暫時無法使用' } });
}

module.exports = { json, requireEnv, callAppsScript, parseBody, handleError };
