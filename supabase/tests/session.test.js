const path = require('path');

// 預設用真正的 pg；裝不了 pg 的環境才退回 psql 替身（見 _pg-driver.js）
require('./_pg-driver');

const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, withUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const session = fx.adapt(require(path.join(FN, 'v2-session.js')));

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
  fx.setSeedPassword('USR-DISP1', DISP_PW);
  fx.setSeedPassword('USR-ROOT', ADMIN_PW);
  // 未經轉接器的原始 handler：直接驗證 cookie、Set-Cookie 與 Bearer 不被接受
  const rawLogin = require(path.join(FN, 'v2-password-login.js'));
  const rawSession = require(path.join(FN, 'v2-session.js'));
  const rawLogout = require(path.join(FN, 'v2-logout.js'));

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
  await t('不接受 Authorization: Bearer（token 只能在 HttpOnly cookie）', async () => {
    const r = parse(await rawSession.handler({ httpMethod: 'POST', body: '{}',
      headers: { host: '127.0.0.1', authorization: `Bearer ${adminToken}` } }));
    return r.status === 401 && r.error.code === 'SESSION_REQUIRED';
  });
  await t('登入回應的 cookie 是 HttpOnly、SameSite=Strict，本體不含 token', async () => {
    const res = await rawLogin.handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', 'x-nf-client-connection-ip': '203.0.113.13' },
      body: JSON.stringify({ phone: ADMIN_PHONE, password: ADMIN_PW }) });
    const lines = fx.setCookieLines(res);
    return res.statusCode === 200 && lines.length === 2
      && lines.every((l) => /HttpOnly/.test(l) && /SameSite=Strict/.test(l))
      && !/eyJ[\w-]+\.eyJ/.test(res.body);
  });
  await t('access token 過期時以 refresh token 換新 cookie，身分不變', async () => {
    const res = await rawLogin.handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', 'x-nf-client-connection-ip': '203.0.113.14' },
      body: JSON.stringify({ phone: ADMIN_PHONE, password: ADMIN_PW }) });
    const rt = (fx.cookiesFrom(res).match(/cr_rt=([^;]*)/) || [])[1];
    const expired = fx.mintAccessToken('USR-ROOT', { iatOffsetSeconds: -7200, expInSeconds: 3600 });
    const again = await rawSession.handler({ httpMethod: 'POST', body: '{}',
      headers: { host: '127.0.0.1', cookie: `cr_at=${expired}; cr_rt=${rt}` } });
    const body = JSON.parse(again.body);
    return again.statusCode === 200 && body.data.user.userId === 'USR-ROOT'
      && /cr_at=/.test(fx.cookiesFrom(again)) && /cr_rt=/.test(fx.cookiesFrom(again));
  });
  await t('refresh token 也無效時回 401 並清掉 cookie', async () => {
    const expired = fx.mintAccessToken('USR-ROOT', { iatOffsetSeconds: -7200, expInSeconds: 3600 });
    const res = await rawSession.handler({ httpMethod: 'POST', body: '{}',
      headers: { host: '127.0.0.1', cookie: `cr_at=${expired}; cr_rt=not-a-real-refresh-token` } });
    return res.statusCode === 401 && fx.setCookieLines(res).every((l) => /Max-Age=0/.test(l));
  });
  await t('登出清掉 cookie，並撤銷這個裝置的 refresh token', async () => {
    const before = fx.calls.filter((c) => c[0] === 'signOut' && c[1] === 'local').length;
    const res = await rawLogout.handler({ httpMethod: 'POST', body: '{}',
      headers: { host: '127.0.0.1', cookie: `cr_at=${adminToken}` } });
    return res.statusCode === 200 && fx.setCookieLines(res).every((l) => /Max-Age=0/.test(l))
      && fx.calls.filter((c) => c[0] === 'signOut' && c[1] === 'local').length === before + 1;
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
  await t('用別的金鑰簽、宣稱是超級管理者的 token 被拒', async () => {
    const forged = fx.mintAccessToken('USR-ROOT', { secret: 'attacker-guessed-secret' });
    const r = parse(await resume({ sessionToken: forged }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });
  await t('GET 不被接受', async () =>
    JSON.parse((await session.handler({ httpMethod: 'GET', headers: {} })).body).error.code === 'METHOD_NOT_ALLOWED');
  await t('回應不含密碼欄位', async () => {
    const res = await resume({ sessionToken: adminToken });
    return !/hash|salt|pepper|password/i.test(res.body);
  });

  console.log('--- 撤銷 session 後舊 token 立刻失效 ---');
  await t('revoke_sessions 之後 resume 被拒', async () => {
    await withUser('USR-DISP1', (c) => c.query("select app.revoke_sessions('USR-DISP1')"));
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
