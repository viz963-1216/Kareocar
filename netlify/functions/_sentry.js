'use strict';

/**
 * 把錯誤送到 Sentry（#17）。不用 SDK，直接以 envelope 格式 POST，沒有額外依賴。
 *
 *   captureException(error, { platform, tags, extra, request })  → Promise<eventId | null>
 *
 * 沒設定 SENTRY_DSN 時什麼都不做。送出前所有文字經 _scrub 清掉個資；不送請求內容、cookie、
 * 查詢字串與使用者資料。逾時 2 秒，送不出去只寫 Function 記錄，不影響回應。
 * 測試用 setTransport() 換成記錄呼叫的假實作。
 */

const crypto = require('crypto');
const { scrubText, scrubValue } = require('./_scrub');

const TIMEOUT_MS = 2000;

function parseDsn(dsn) {
  const m = String(dsn || '').trim().match(/^https:\/\/([^@:\s]+)@([^/\s]+)\/(?:.*\/)?(\d+)$/);
  return m ? { publicKey: m[1], host: m[2], projectId: m[3] } : null;
}

function stackFrames(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1, 40)) {
    const m = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/) || line.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
    if (!m) continue;
    const filename = String(m[2]).replace(/^.*\/(netlify\/functions|js)\//, '$1/').replace(/[?#].*$/, '');
    frames.push({ function: m[1] ? scrubText(m[1]) : '?', filename, lineno: Number(m[3]), colno: Number(m[4]),
      in_app: /netlify\/functions|js\//.test(filename) });
  }
  return frames.reverse(); // Sentry 要由外而內
}

function buildEvent(error, { platform = 'node', tags = {}, extra = {}, request = null } = {}) {
  const err = error instanceof Error ? error : new Error(String(error && error.message ? error.message : error));
  return {
    event_id: crypto.randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform,
    level: 'error',
    environment: process.env.CONTEXT || process.env.NODE_ENV || 'development',
    release: process.env.COMMIT_REF ? `care-ride@${process.env.COMMIT_REF}` : undefined,
    tags: scrubValue(tags),
    extra: scrubValue(extra),
    request: request ? { method: request.method, url: scrubText(String(request.path || '').split('?')[0]) } : undefined,
    exception: { values: [{ type: err.name || 'Error', value: scrubText(err.message),
      stacktrace: { frames: stackFrames(err.stack) } }] }
  };
}

const defaultTransport = async (dsn, event) => {
  const envelope = [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event)
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://${dsn.host}/api/${dsn.projectId}/envelope/`, {
      method: 'POST', signal: controller.signal, body: envelope,
      headers: { 'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=care-ride/1.0` }
    });
    if (!res.ok) console.error('[sentry] 送出失敗', res.status);
  } finally {
    clearTimeout(timer);
  }
};
let transport = defaultTransport;
function setTransport(next) { transport = next || defaultTransport; }

function enabled() { return Boolean(parseDsn(process.env.SENTRY_DSN)); }

async function captureException(error, ctx = {}) {
  const dsn = parseDsn(process.env.SENTRY_DSN);
  if (!dsn) return null;
  const event = buildEvent(error, ctx);
  try { await transport(dsn, event); } catch (e) { console.error('[sentry] 送出失敗', e && e.message); }
  return event.event_id;
}

module.exports = { captureException, buildEvent, parseDsn, stackFrames, enabled, setTransport };
