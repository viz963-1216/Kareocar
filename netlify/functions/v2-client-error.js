'use strict';

/**
 * POST /api/v2/client-error  —— 前端的未處理錯誤轉送到 Sentry（#17）
 *
 * body: { kind: 'error'|'unhandledrejection', message, stack, path, line, col, release }
 *
 * 前端不直接連 Sentry：CSP 的 connect-src 只允許本站，DSN 也不放在瀏覽器。這支端點不需要登入
 * （錯誤可能發生在登入前），所以：內容上限 8KB、每個 Function 實例每個來源 IP 每分鐘最多 20 筆、
 * 所有文字經 _scrub 清掉個資、只送路徑不送查詢字串。沒有設定 SENTRY_DSN 時直接回 202。
 */

const { json, parseBody, clientIp } = require('./_http');
const sentry = require('./_sentry');
const { scrubText } = require('./_scrub');

const MAX_BODY = 8 * 1024;
const LIMIT_PER_MINUTE = 20;
const buckets = new Map();

function allow(ip, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const key = `${ip}|${minute}`;
  const n = (buckets.get(key) || 0) + 1;
  buckets.set(key, n);
  if (buckets.size > 5000) for (const k of buckets.keys()) if (!k.endsWith(`|${minute}`)) buckets.delete(k);
  return n <= LIMIT_PER_MINUTE;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  if (String(event.body || '').length > MAX_BODY) return json(413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '內容過大' } });
  if (!allow(clientIp(event) || 'unknown')) return json(429, { ok: false, error: { code: 'RATE_LIMITED', message: '回報太頻繁' } });
  let body;
  try { body = parseBody(event); } catch (_) { return json(400, { ok: false, error: { code: 'BAD_JSON', message: 'JSON 格式錯誤' } }); }
  if (!sentry.enabled()) return json(202, { ok: true, data: { forwarded: false } });

  const error = new Error(scrubText(String(body.message || '未知前端錯誤').slice(0, 500)));
  error.name = body.kind === 'unhandledrejection' ? 'UnhandledRejection' : 'BrowserError';
  error.stack = `${error.name}: ${error.message}\n${String(body.stack || '').slice(0, 4000)}`;
  const path = String(body.path || '').split(/[?#]/)[0].slice(0, 200);
  const eventId = await sentry.captureException(error, {
    platform: 'javascript',
    tags: { source: 'browser', kind: String(body.kind || 'error').slice(0, 40), release: String(body.release || '').slice(0, 40) },
    extra: { line: Number(body.line) || null, col: Number(body.col) || null },
    request: { method: 'GET', path }
  });
  return json(202, { ok: true, data: { forwarded: Boolean(eventId) } });
};

exports._test = { allow, buckets };
