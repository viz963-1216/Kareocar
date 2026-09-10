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

const { getPool } = require(path.join(FN, '_db.js'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};

const call = (mod, body) => mod.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} });
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });

const TOKEN = 'one-time-bootstrap-token-abc123';
const PHONE = '0912000009';
const PW = 'SuperAdminPass2026!';

(async () => {
  console.log('--- 未設定 BOOTSTRAP_TOKEN 時等於不存在 ---');
  delete process.env.BOOTSTRAP_TOKEN;
  delete require.cache[require.resolve(path.join(FN, 'v2-bootstrap-admin.js'))];
  let boot = require(path.join(FN, 'v2-bootstrap-admin.js'));
  await t('回 404，不透露端點存在', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: PHONE, password: PW }));
    return r.status === 404 && r.error.code === 'NOT_FOUND';
  });

  process.env.BOOTSTRAP_TOKEN = TOKEN;
  delete require.cache[require.resolve(path.join(FN, 'v2-bootstrap-admin.js'))];
  boot = require(path.join(FN, 'v2-bootstrap-admin.js'));

  console.log('--- token 把關 ---');
  await t('token 錯誤回 404', async () => {
    const r = parse(await call(boot, { token: 'wrong-token', phone: PHONE, password: PW }));
    return r.status === 404;
  });
  await t('沒帶 token 回 404', async () => parse(await call(boot, { phone: PHONE, password: PW })).status === 404);
  await t('GET 也回 404', async () =>
    JSON.parse((await boot.handler({ httpMethod: 'GET', headers: {} })).body).error.code === 'NOT_FOUND');

  console.log('--- 參數把關 ---');
  await t('手機格式錯誤被拒', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: '123', password: PW }));
    return r.status === 400 && r.error.code === 'INVALID_PHONE';
  });
  await t('密碼太短被拒', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: PHONE, password: 'short123' }));
    return r.status === 400 && r.error.code === 'WEAK_PASSWORD';
  });
  await t('帳號不存在時明確告知', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: '0955555555', password: PW }));
    return r.status === 409 && r.error.code === 'USER_NOT_FOUND';
  });

  console.log('--- 正常初始化 ---');
  await t('成功設定超級管理者密碼', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: PHONE, password: PW }));
    return r.ok === true && r.data.userId === 'USR-ROOT';
  });
  await t('回應不含密碼相關欄位', async () => {
    const res = await call(boot, { token: TOKEN, phone: PHONE, password: PW });
    return !/hash|salt|pepper/i.test(res.body);
  });

  console.log('--- 只能用一次 ---');
  await t('第二次呼叫被拒（已有密碼）', async () => {
    const r = parse(await call(boot, { token: TOKEN, phone: PHONE, password: 'CompletelyDifferentPw2026!' }));
    return r.status === 409 && r.error.code === 'ALREADY_INITIALIZED';
  });

  console.log('--- 設好的密碼真的能登入 ---');
  const login = require(path.join(FN, 'v2-password-login.js'));
  await t('用新密碼登入成功且身分是 super_admin', async () => {
    const r = parse(await login.handler({ httpMethod: 'POST',
      body: JSON.stringify({ phone: PHONE, password: PW }),
      headers: { 'x-nf-client-connection-ip': '203.0.113.77' } }));
    return r.ok === true && r.data.user.platformRole === 'super_admin' && !!r.data.sessionToken;
  });
  await t('舊的錯誤密碼登不進去', async () => {
    const r = parse(await login.handler({ httpMethod: 'POST',
      body: JSON.stringify({ phone: PHONE, password: 'CompletelyDifferentPw2026!' }),
      headers: { 'x-nf-client-connection-ip': '203.0.113.78' } }));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS';
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
