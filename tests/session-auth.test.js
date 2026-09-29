'use strict';
/**
 * access token 驗證與 session cookie 的離線測試（不需要資料庫、不連 Supabase）。
 *
 * 驗證的是正式環境用的同一段程式：netlify/functions/_supabase-auth.js 的
 * verifyAccessToken，與 _session.js 的 cookie 與請求檢查。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

process.env.SUPABASE_JWT_SECRET = 'offline-test-secret-0123456789abcdef';
process.env.SUPABASE_URL = 'https://offline-test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'offline-anon';

const FN = path.join(__dirname, '..', 'netlify', 'functions');
const supa = require(path.join(FN, '_supabase-auth.js'));
const session = require(path.join(FN, '_session.js'));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function hs(payload, { secret = process.env.SUPABASE_JWT_SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const h = b64(header), p = b64(payload);
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (extra = {}) => ({ sub: 'USR-A', role: 'authenticated', iat: now(), exp: now() + 600, ...extra });

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { assert.equal(e.code, code, `預期 ${code}，實得 ${e.code}：${e.message}`); return; }
  assert.fail(`預期 ${code}，實際通過`);
};

(async () => {
  console.log('--- verifyAccessToken ---');
  await ok('HS256 有效 token 回傳 userId 與 iat', async () => {
    const c = await supa.verifyAccessToken(hs(good()));
    assert.equal(c.userId, 'USR-A');
    assert.ok(c.iat > 0);
  });
  await ok('簽章金鑰不同 → SESSION_INVALID', () => rejects(supa.verifyAccessToken(hs(good(), { secret: 'other-secret' })), 'SESSION_INVALID'));
  await ok('竄改 payload（sub 換人）→ SESSION_INVALID', async () => {
    const [h, , s] = hs(good()).split('.');
    await rejects(supa.verifyAccessToken(`${h}.${b64(good({ sub: 'USR-ADMIN' }))}.${s}`), 'SESSION_INVALID');
  });
  await ok('alg=none → SESSION_INVALID', () =>
    rejects(supa.verifyAccessToken(`${b64({ alg: 'none' })}.${b64(good())}.`), 'SESSION_INVALID'));
  await ok('過期 → SESSION_EXPIRED', () => rejects(supa.verifyAccessToken(hs(good({ iat: now() - 7200, exp: now() - 3600 }))), 'SESSION_EXPIRED'));
  await ok('role 不是 authenticated（例如 service_role）→ SESSION_INVALID', () =>
    rejects(supa.verifyAccessToken(hs(good({ role: 'service_role' }))), 'SESSION_INVALID'));
  await ok('沒有 sub → SESSION_INVALID', () => rejects(supa.verifyAccessToken(hs(good({ sub: undefined }))), 'SESSION_INVALID'));
  await ok('格式不對 → SESSION_INVALID', () => rejects(supa.verifyAccessToken('not-a-jwt'), 'SESSION_INVALID'));

  await ok('ES256：以 JWKS 公鑰驗證，kid 不符或簽章錯誤都拒絕', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
    supa.setProvider({ fetchJwks: async () => [jwk] });
    const sign = (payload, kid = 'k1', key = privateKey) => {
      const h = b64({ alg: 'ES256', kid, typ: 'JWT' }), p = b64(payload);
      const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return `${h}.${p}.${sig}`;
    };
    assert.equal((await supa.verifyAccessToken(sign(good()))).userId, 'USR-A');
    await rejects(supa.verifyAccessToken(sign(good(), 'unknown')), 'SESSION_INVALID');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await rejects(supa.verifyAccessToken(sign(good(), 'k1', other)), 'SESSION_INVALID');
    supa.setProvider(null);
  });

  console.log('--- cookie 與請求檢查 ---');
  const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 };
  await ok('正式站（https）的 cookie：HttpOnly、SameSite=Strict、Secure，路徑分開', async () => {
    const [at, rt] = session.sessionCookies({ headers: { host: 'kareocar.example' } }, tokens);
    for (const c of [at, rt]) {
      assert.match(c, /; HttpOnly/);
      assert.match(c, /; SameSite=Strict/);
      assert.match(c, /; Secure/);
    }
    assert.match(at, /^cr_at=AT; Path=\/api; Max-Age=3600/);
    assert.match(rt, /^cr_rt=RT; Path=\/api\/v2\/session;/);
  });
  await ok('本機 http（127.0.0.1）不加 Secure，其餘屬性不變', async () => {
    const [at] = session.sessionCookies({ headers: { host: '127.0.0.1:8888' } }, tokens);
    assert.doesNotMatch(at, /Secure/);
    assert.match(at, /HttpOnly; SameSite=Strict$/);
  });
  await ok('本機但經過 https 代理 → 仍加 Secure', async () => {
    const [at] = session.sessionCookies({ headers: { host: 'localhost', 'x-forwarded-proto': 'https' } }, tokens);
    assert.match(at, /; Secure/);
  });
  await ok('清除 cookie 是 Max-Age=0', async () => {
    for (const c of session.clearSessionCookies({ headers: { host: 'a.example' } })) assert.match(c, /Max-Age=0/);
  });
  await ok('沒有 cookie → SESSION_REQUIRED', () =>
    rejects(session.requireSession({ httpMethod: 'POST', headers: { host: 'a.example' } }), 'SESSION_REQUIRED'));
  await ok('cookie 裡的有效 token → 通過，並帶回 accessToken', async () => {
    const t = hs(good());
    const s = await session.requireSession({ httpMethod: 'POST', headers: { host: 'a.example', cookie: `x=1; cr_at=${t}; y=2` } });
    assert.equal(s.userId, 'USR-A');
    assert.equal(s.accessToken, t);
  });
  await ok('Authorization: Bearer 不再被接受（token 只能從 HttpOnly cookie 來）', () =>
    rejects(session.requireSession({ httpMethod: 'POST', headers: { host: 'a.example', authorization: `Bearer ${hs(good())}` } }), 'SESSION_REQUIRED'));
  await ok('寫入請求的 Origin 與 Host 不同 → FORBIDDEN', () =>
    rejects(session.requireSession({ httpMethod: 'POST', headers: { host: 'a.example', origin: 'https://evil.example', cookie: `cr_at=${hs(good())}` } }), 'FORBIDDEN'));
  await ok('Origin 與 Host 相同 → 通過', async () => {
    await session.requireSession({ httpMethod: 'POST', headers: { host: 'a.example', origin: 'https://a.example', cookie: `cr_at=${hs(good())}` } });
  });

  console.log('--- assertSessionActive ---');
  const client = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  const s = { userId: 'USR-A', iat: 1000 };
  await ok('使用者不存在 → SESSION_INVALID', () => rejects(session.assertSessionActive(client(null), s), 'SESSION_INVALID'));
  await ok('帳號停用 → SESSION_INVALID', () => rejects(session.assertSessionActive(client({ active: false, valid_after: 0 }), s), 'SESSION_INVALID'));
  await ok('token 簽發早於生效起點（改過密碼）→ SESSION_INVALID，並帶 revokedUntil', async () => {
    try { await session.assertSessionActive(client({ active: true, valid_after: 1001 }), s); assert.fail('應該拒絕'); }
    catch (e) { assert.equal(e.code, 'SESSION_INVALID'); assert.equal(e.revokedUntil, 1001); }
  });
  await ok('簽發時間等於生效起點 → 通過', () => session.assertSessionActive(client({ active: true, valid_after: 1000 }), s));

  console.log(`session-auth: ${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
