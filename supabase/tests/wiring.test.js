/**
 * 接線測試：Netlify Function 的實際程式碼，跑在真實 Postgres 上。
 *
 * 驗證的是「登入 → 拿 token → 讀預約」這一整條路徑，包含 RLS 是否真的
 * 在資料庫層把別人的資料擋掉。pg 驅動被替換成 psql 傳輸層（見
 * pg-psql-shim.js），SQL、角色與 RLS 都是真的。
 */
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

// 把 require('pg') 導向 psql 替身
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
const bookings = require(path.join(FN, 'v2-bookings.js'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
  } catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};

const post = (body, ip) => login.handler({
  httpMethod: 'POST', body: JSON.stringify(body),
  headers: ip ? { 'x-nf-client-connection-ip': ip } : {}
});
const getBookings = (token, qs) => bookings.handler({
  httpMethod: 'GET',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  queryStringParameters: qs || {}
});
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });

(async () => {
  // 給種子使用者設定可登入的密碼
  await withoutUser(async (c) => {
    for (const [uid, pw] of [['USR-VICTIM', 'VictimPass123'], ['USR-DISP1', 'DispatchPass123']]) {
      await auth.setPasswordCredential(c, uid, pw);
    }
  });

  console.log('--- 登入 ---');
  let victimToken = null, dispatchToken = null;

  await t('正確密碼可登入', async () => {
    const r = parse(await post({ phone: '0912000001', password: 'VictimPass123' }, '203.0.113.1'));
    victimToken = r.data && r.data.sessionToken;
    return r.ok === true && r.data.user.userId === 'USR-VICTIM' && !!victimToken;
  });
  await t('回傳身分含有效成員資格', async () => {
    const r = parse(await post({ phone: '0912000003', password: 'DispatchPass123' }, '203.0.113.2'));
    dispatchToken = r.data && r.data.sessionToken;
    return r.data.memberships.some((m) => m.organizationId === 'ORG-TP-001' && m.role === 'dispatcher');
  });
  await t('錯誤密碼被拒且不透露帳號是否存在', async () => {
    const r = parse(await post({ phone: '0912000001', password: 'WrongPass123' }, '203.0.113.3'));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS';
  });
  await t('不存在的帳號回相同錯誤', async () => {
    const r = parse(await post({ phone: '0999999999', password: 'Whatever123' }, '203.0.113.4'));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS';
  });
  await t('回應中不含密碼雜湊', async () => {
    const res = await post({ phone: '0912000001', password: 'VictimPass123' }, '203.0.113.1');
    return !/hash|salt|pepper/i.test(res.body);
  });

  console.log('--- 連續失敗會被鎖，且會自己解除 ---');
  await t('第 5 次失敗後鎖定並回傳 429', async () => {
    let r;
    for (let i = 0; i < 5; i++) {
      r = parse(await post({ phone: '0912000005', password: 'nope' + i }, '203.0.113.9'));
    }
    return r.status === 429 && r.error.code === 'LOGIN_RATE_LIMITED';
  });
  await t('應用角色完全讀不到速率限制表', async () => {
    let denied = false;
    try { await withoutUser((c) => c.query('select count(*) from auth_rate_limits')); }
    catch (e) { denied = true; }
    // RLS 無政策時 select 回 0 列而非報錯，兩種都算擋住
    if (!denied) {
      const r = await withoutUser((c) => c.query('select * from auth_rate_limits'));
      return r.rows.length === 0;
    }
    return true;
  });
  await t('速率限制表裡沒有明文手機號碼（以 owner 身分檢查）', () => {
    const out = execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc',
      "select count(*) from auth_rate_limits where key like '%0912000005%' or state::text like '%0912000005%'"
    ]).toString().trim();
    const total = execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc', 'select count(*) from auth_rate_limits']).toString().trim();
    return out === '0' && Number(total) > 0;
  });

  console.log('--- 讀預約：RLS 決定看得到什麼 ---');
  await t('沒有 token 回 401', async () => parse(await getBookings(null)).status === 401);
  await t('偽造 token 被拒', async () =>
    parse(await getBookings('bogus.token')).error.code === 'SESSION_INVALID');
  await t('需求者只看得到自己的預約', async () => {
    const r = parse(await getBookings(victimToken));
    return r.ok && r.data.bookings.every((b) => b.requested_by_user_id === 'USR-VICTIM');
  });
  await t('調度員看得到自家組織的預約', async () => {
    const r = parse(await getBookings(dispatchToken));
    return r.ok && r.data.bookings.some((b) => b.organization_id === 'ORG-TP-001');
  });
  await t('調度員看不到別家組織的預約', async () => {
    const r = parse(await getBookings(dispatchToken));
    return r.data.bookings.every((b) => b.organization_id === 'ORG-TP-001' || b.organization_id === null);
  });

  console.log('--- 公開需求池已遮蔽 ---');
  await t('調度員讀得到需求池', async () => {
    const r = parse(await getBookings(dispatchToken, { pool: '1' }));
    return r.ok && Array.isArray(r.data.pool);
  });
  await t('需求池不含門牌與預約者', async () => {
    const res = await getBookings(dispatchToken, { pool: '1' });
    return !/文化路|requested_by|USR-VICTIM/.test(res.body);
  });
  await t('需求者讀需求池得到空結果', async () => {
    const r = parse(await getBookings(victimToken, { pool: '1' }));
    return r.ok && r.data.pool.length === 0;
  });

  console.log('--- 改密碼後舊 token 失效 ---');
  await t('bump session 版本後舊 token 被拒', async () => {
    await withUser('USR-VICTIM', (c) => auth.bumpSessionVersion(c, 'USR-VICTIM'));
    const r = parse(await getBookings(victimToken));
    return r.error && r.error.code === 'SESSION_INVALID';
  });

  console.log('--- 設定防呆 ---');
  await t('DATABASE_URL 用 postgres 角色會被拒絕啟動', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://postgres:pw@db.example.com:5432/postgres';
    delete require.cache[require.resolve(path.join(FN, '_db.js'))];
    const fresh = require(path.join(FN, '_db.js'));
    let blocked = false;
    try { await fresh.withoutUser(async () => {}); }
    catch (e) { blocked = e.code === 'CONFIG_INVALID'; }
    process.env.DATABASE_URL = saved;
    delete require.cache[require.resolve(path.join(FN, '_db.js'))];
    return blocked;
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
