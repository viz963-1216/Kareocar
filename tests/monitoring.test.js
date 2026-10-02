'use strict';
/** #17 監控的離線測試：個資清除、Sentry 事件、5xx 回報、前端錯誤轉送、告警管道、health HEAD。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { scrubText, scrubValue } = require(path.join(FN, '_scrub.js'));
const sentry = require(path.join(FN, '_sentry.js'));
const { handleError } = require(path.join(FN, '_http.js'));
const clientError = require(path.join(FN, 'v2-client-error.js'));
const alerts = require(path.join(FN, '_alerts.js'));

let pass = 0;
const tests = [];
const ok = (name, fn) => tests.push([name, fn]);
const DSN = 'https://abc123@o999.ingest.sentry.io/4501';
const captured = [];
sentry.setTransport(async (dsn, event) => { captured.push({ dsn, event }); });

ok('個資清除：手機、市話、Email、身分證號、地址', () => {
  const out = scrubText('聯絡 0912-345-678 或 +886912345678、(02)2345-6789、a.b@c.tw；A123456789；新北市板橋區文化路一段188號3樓');
  for (const leak of ['0912', '345-678', '886912', '2345-6789', 'a.b@c.tw', 'A123456789', '188號']) assert.ok(!out.includes(leak), `${leak} in ${out}`);
});
ok('個資清除：敏感鍵整個拿掉，其他保留', () => {
  const v = scrubValue({ bookingId: 'B1', name: '王', phone: 'x', nested: { pickupAddress: 'y', note: '0911222333', count: 3 } });
  assert.deepEqual(v, { bookingId: 'B1', name: '[redacted]', phone: '[redacted]', nested: { pickupAddress: '[redacted]', note: '[phone]', count: 3 } });
});
ok('DSN 解析', () => {
  assert.deepEqual(sentry.parseDsn(DSN), { publicKey: 'abc123', host: 'o999.ingest.sentry.io', projectId: '4501' });
  assert.equal(sentry.parseDsn('http://x@y/1'), null);
  assert.equal(sentry.parseDsn(''), null);
});
ok('Sentry 事件：訊息清除個資、有堆疊、不帶請求內容', () => {
  const e = new Error('找不到 0912345678 的預約');
  const ev = sentry.buildEvent(e, { tags: { code: 'X' }, request: { method: 'POST', path: '/api/v2/x?phone=0912345678', body: '秘密' } });
  assert.ok(!JSON.stringify(ev).includes('0912345678'));
  assert.ok(!JSON.stringify(ev).includes('秘密'));
  assert.equal(ev.request.url, '/api/v2/x');
  assert.ok(ev.exception.values[0].stacktrace.frames.length > 0);
  assert.match(ev.event_id, /^[0-9a-f]{32}$/);
});
ok('沒有設定 SENTRY_DSN：5xx 照常同步回應，不送事件', () => {
  delete process.env.SENTRY_DSN;
  const before = captured.length;
  const r = handleError(new Error('boom'));
  assert.equal(r.statusCode, 502);
  assert.equal(captured.length, before);
});
ok('未預期的錯誤不把內部訊息回給前端', () => {
  delete process.env.SENTRY_DSN;
  const r = handleError(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }));
  assert.ok(!r.body.includes('relation'));
  const known = handleError(Object.assign(new Error('沒有權限'), { code: 'FORBIDDEN' }));
  assert.ok(known.body.includes('沒有權限'));
});
ok('有 SENTRY_DSN：5xx 送到 Sentry 並回傳錯誤 ID；4xx 不送', async () => {
  process.env.SENTRY_DSN = DSN;
  const before = captured.length;
  const r = await handleError(new Error('boom 0912345678'));
  assert.equal(r.statusCode, 502);
  assert.equal(captured.length, before + 1);
  assert.match(JSON.parse(r.body).error.errorId, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(captured[captured.length - 1].event).includes('0912345678'));
  const r4 = handleError(Object.assign(new Error('x'), { code: 'VALIDATION_ERROR' }));
  assert.equal(r4.statusCode, 400);
  assert.equal(captured.length, before + 1);
  delete process.env.SENTRY_DSN;
});
const post = (body, headers = {}) => clientError.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.9', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
ok('前端錯誤：沒有 DSN 不轉送', async () => {
  delete process.env.SENTRY_DSN;
  const r = await post({ message: 'x' });
  assert.equal(r.statusCode, 202);
  assert.equal(JSON.parse(r.body).data.forwarded, false);
});
ok('前端錯誤：轉送到 Sentry，清掉個資與查詢字串', async () => {
  process.env.SENTRY_DSN = DSN;
  const before = captured.length;
  const r = await post({ kind: 'error', message: '無法讀取 新北市板橋區文化路一段188號', stack: 'at f (https://x/js/app.js:10:5)',
    path: '/booking?phone=0912345678', line: 10, col: 5 }, { 'x-nf-client-connection-ip': '203.0.113.10' });
  assert.equal(r.statusCode, 202);
  const ev = captured[before].event;
  assert.equal(ev.platform, 'javascript');
  assert.equal(ev.request.url, '/booking');
  assert.ok(!JSON.stringify(ev).includes('188號') && !JSON.stringify(ev).includes('0912345678'));
  delete process.env.SENTRY_DSN;
});
ok('前端錯誤：內容上限、方法、頻率限制', async () => {
  assert.equal((await post('x'.repeat(9000))).statusCode, 413);
  assert.equal((await clientError.handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
  let last;
  for (let i = 0; i < 21; i++) last = await post({ message: `m${i}` }, { 'x-nf-client-connection-ip': '198.51.100.7' });
  assert.equal(last.statusCode, 429);
});
ok('告警管道：Discord 與 Email 依設定送出，內容清除個資', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200 }; };
  try {
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
    process.env.RESEND_API_KEY = 're_test';
    process.env.ALERT_EMAIL_FROM = 'alerts@example.org';
    process.env.ALERT_EMAIL_TO = 'ops@example.org, oncall@example.org';
    const r = await alerts.sendAlert(null, { kind: 'test', title: '測試 0912345678', details: { phone: '0912345678', note: 'ok' } });
    assert.deepEqual(r.delivered.sort(), ['discord', 'email']);
    assert.ok(calls.some((c) => c.url === 'https://discord.com/api/webhooks/1/abc'));
    const email = calls.find((c) => c.url === 'https://api.resend.com/emails');
    assert.equal(email.init.headers.authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(email.init.body).to, ['ops@example.org', 'oncall@example.org']);
    assert.ok(!calls.some((c) => String(c.init.body).includes('0912345678')));
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    calls.length = 0;
    const none = await alerts.sendAlert(null, { kind: 'test', title: 't' });
    assert.deepEqual(none.delivered, []);
    assert.equal(calls.length, 0);
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://evil.example/hook';
    assert.deepEqual((await alerts.sendAlert(null, { kind: 'test', title: 't' })).delivered, []);
  } finally {
    global.fetch = realFetch;
    for (const k of ['DISCORD_ALERT_WEBHOOK_URL', 'RESEND_API_KEY', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO']) delete process.env[k];
  }
});
ok('health 接受 HEAD（外部存活檢查），沒有內容', async () => {
  for (const k of ['DATABASE_URL', 'AUTH_SESSION_SECRET']) delete process.env[k];
  // 沒有設定環境變數時 health 不會連資料庫；pg 以假模組替代，本機沒裝 pg 也能跑
  const Module = require('module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'pg') return path.join(__dirname, '_pg-unused-stub.js');
    return resolve.call(this, request, ...rest);
  };
  const health = require(path.join(FN, 'health.js'));
  Module._resolveFilename = resolve;
  const r = await health.handler({ httpMethod: 'HEAD', headers: {} });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body, '');
  assert.equal((await health.handler({ httpMethod: 'POST', headers: {} })).statusCode, 405);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); pass++; console.log('  PASS', name); }
  console.log(`monitoring: ${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
