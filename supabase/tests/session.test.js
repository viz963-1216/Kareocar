const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./pg-psql-shim.js');
  return origResolve.call(this, request, ...rest);
};

const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.AUTH_PASSWORD_PEPPER = 'test-pepper-0123456789abcdefghijkl';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';

const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, withUser, getPool } = require(path.join(FN, '_db.js'));
const login = require(path.join(FN, 'v2-password-login.js'));
const session = require(path.join(FN, 'v2-session.js'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });
const doLogin = async (phone, password, ip) => parse(await login.handler({ httpMethod: 'POST',
  body: JSON.stringify({ phone, password }), headers: { 'x-nf-client-connection-ip': ip } }));
const resume = (body, headers) => session.handler({ httpMethod: 'POST',
  body: JSON.stringify(body || {}), headers: headers || {} });

const ADMIN_PHONE = '0912000009', ADMIN_PW = 'SuperAdminPass2026!';
const DISP_PHONE = '0912000003', DISP_PW = 'DispatcherPass2026!';

(async () => {
  await withoutUser((c) => auth.setPasswordCredential(c, 'USR-DISP1', DISP_PW));

  console.log('--- 超級管理者 ---');
  let adminToken = null;
  await t('登入拿到 token', async () => {
    const r = parse(await login.handler({ httpMethod: 'POST',
      body: JSON.stringify({ phone: ADMIN_PHONE, password: ADMIN_PW }),
      headers: { 'x-nf-client-connection-ip': '203.0.113.10' } }));
    adminToken = r.data && r.data.sessionToken;
    return r.ok === true && !!adminToken;
  });
  await t('resume 回傳同一個身分', async () => {
    const r = parse(await resume({ sessionToken: adminToken }));
    return r.ok === true && r.data.user.userId === 'USR-ROOT'
      && r.data.user.platformRole === 'super_admin';
  });
  await t('手機號碼回成 09 格式（與登入端點一致）', async () => {
    const r = parse(await resume({ sessionToken: adminToken }));
    return r.data.user.phone === ADMIN_PHONE;
  });
  await t('super_admin 沒有成員資格也能 resume', async () => {
    const r = parse(await resume({ sessionToken: adminToken }));
    return r.ok === true && Array.isArray(r.data.memberships) && r.data.memberships.length === 0;
  });
  await t('token 還新時不換發新 token', async () => {
    const r = parse(await resume({ sessionToken: adminToken }));
    return r.data.sessionToken === undefined;
  });
  await t('也接受 Authorization: Bearer', async () => {
    const r = parse(await resume({}, { authorization: `Bearer ${adminToken}` }));
    return r.ok === true && r.data.user.userId === 'USR-ROOT';
  });

  console.log('--- 調度員（有組織身分） ---');
  let dispToken = null;
  await t('登入並 resume 帶回成員資格', async () => {
    const r = parse(await login.handler({ httpMethod: 'POST',
      body: JSON.stringify({ phone: DISP_PHONE, password: DISP_PW }),
      headers: { 'x-nf-client-connection-ip': '203.0.113.11' } }));
    dispToken = r.data.sessionToken;
    const s = parse(await resume({ sessionToken: dispToken }));
    return s.ok === true && s.data.memberships.length === 1
      && s.data.memberships[0].organizationId === 'ORG-TP-001'
      && s.data.memberships[0].role === 'dispatcher';
  });

  console.log('--- 拒絕的情況 ---');
  await t('沒有 token 回 401', async () => parse(await resume({})).status === 401);
  await t('亂寫的 token 被拒', async () => {
    const r = parse(await resume({ sessionToken: 'bogus.token' }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });
  await t('竄改 payload（改成別人的 userId）被拒', async () => {
    const body = Buffer.from(JSON.stringify({ v: 2, userId: 'USR-ROOT', sv: 1,
      iat: Math.floor(Date.now() / 1e3), exp: Math.floor(Date.now() / 1e3) + 3600, nonce: 'x' })).toString('base64url');
    const forged = `${body}.${'0'.repeat(64)}`;
    const r = parse(await resume({ sessionToken: forged }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });
  await t('GET 不被接受', async () =>
    JSON.parse((await session.handler({ httpMethod: 'GET', headers: {} })).body).error.code === 'METHOD_NOT_ALLOWED');
  await t('回應不含密碼欄位', async () => {
    const res = await resume({ sessionToken: adminToken });
    return !/hash|salt|pepper|password/i.test(res.body);
  });

  console.log('--- 改密碼後舊 token 立刻失效 ---');
  await t('bump session 版本後 resume 被拒', async () => {
    await withUser('USR-DISP1', (c) => auth.bumpSessionVersion(c, 'USR-DISP1'));
    const r = parse(await resume({ sessionToken: dispToken }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });

  console.log('--- 停用帳號後不能 resume ---');
  await t('active=false 之後被拒', async () => {
    const { execFileSync } = require('child_process');
    const fresh = await doLogin(DISP_PHONE, DISP_PW, '203.0.113.12');
    const tok = fresh.data.sessionToken;
    execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc', "update users set active = false where id = 'USR-DISP1'"]);
    const r = parse(await resume({ sessionToken: tok }));
    execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc', "update users set active = true where id = 'USR-DISP1'"]);
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
