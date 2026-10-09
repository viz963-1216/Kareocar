/**
 * 接線測試：Netlify Function 的實際程式碼，跑在真實 Postgres 上。
 *
 * 驗證的是「登入 → 拿 token → 讀預約」這一整條路徑，包含 RLS 是否真的
 * 在資料庫層把別人的資料擋掉。預設用真正的 pg 驅動；裝不了 pg 的環境才退回 psql 替身
 *（見 _pg-driver.js）。SQL、角色與 RLS 都是真的。
 */
const path = require('path');
const { execFileSync } = require('child_process');

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
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });

(async () => {
  // 給種子使用者設定可登入的密碼
  await withoutUser(async (c) => {
    for (const [uid, pw] of [['USR-VICTIM', 'VictimPass123'], ['USR-DISP1', 'DispatchPass123']]) {
      await fx.setSeedPassword(uid, pw);
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

  // 「讀預約」與「公開需求池」兩段已移除：它們打的是 v2-bookings，讀 typed
  // bookings 表。預約資料現在寫在 app_state，那條路徑已經沒有人走。等價的驗證
  // 在 state.test.js（寫入與遮蔽）與 load.test.js（每個身分讀得到什麼）。

  console.log('--- 撤銷 session 後舊 token 失效 ---');
  await t('revoke_sessions 之後舊 token 被拒', async () => {
    await withUser('USR-VICTIM', (c) => c.query("select app.revoke_sessions('USR-VICTIM')"));
    const load = fx.adapt(require(path.join(FN, 'v2-state-load.js')));
    const r = parse(await load.handler({ httpMethod: 'GET',
      headers: { authorization: `Bearer ${victimToken}` } }));
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
