/**
 * 讀取路徑測試：v2-state-load 跑在真實 Postgres + 真實 RLS 上。
 * 重點是「每個身分只拿得到自己該看的」，而且個資不會從需求池外流。
 */
const path = require('path');
const { execFileSync } = require('child_process');
// 預設用真正的 pg；裝不了 pg 的環境才退回 psql 替身（見 _pg-driver.js）
require('./_pg-driver');
const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const mutate = fx.adapt(require(path.join(FN, 'v2-state-mutate.js')));
const bookingWrite = fx.adapt(require(path.join(FN, 'v2-booking-write.js')));
const load = fx.adapt(require(path.join(FN, 'v2-state-load.js')));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (r) => ({ status: r.statusCode, ...JSON.parse(r.body) });
const doLogin = async (p, pw, ip) => parse(await login.handler({ httpMethod: 'POST',
  body: JSON.stringify({ phone: p, password: pw }), headers: { 'x-nf-client-connection-ip': ip } }));
const send = (tok, changes) => mutate.handler({ httpMethod: 'POST',
  headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ changes }) });
const sendBooking = (tok, changes) => bookingWrite.handler({ httpMethod: 'POST',
  headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ changes }) });
const get = (tok) => load.handler({ httpMethod: 'GET', headers: tok ? { authorization: `Bearer ${tok}` } : {} });

(async () => {
  await withoutUser(async (c) => {
    for (const [u, p] of [['USR-VICTIM','VictimPass123'],['USR-ATTACK','AttackPass123'],
                          ['USR-DISP1','DispatchPass123'],['USR-OWN2','Own2Pass123']]) {
      await fx.setSeedPassword(u, p);
    }
  });
  const victim = (await doLogin('0912000001','VictimPass123','203.0.113.1')).data.sessionToken;
  const attacker = (await doLogin('0912000002','AttackPass123','203.0.113.2')).data.sessionToken;
  const dispatcher = (await doLogin('0912000003','DispatchPass123','203.0.113.3')).data.sessionToken;

  const bk = (id, extra={}) => ({ collection:'bookings', id, record:{ id, state:'open',
    pickupDate:'2026-10-01', pickupAddress:'新北市板橋區文化路一段100號',
    destination:'台北市中正區公園路20號', passengerCount:1, ...extra } });
  await sendBooking(victim, [bk('LD-VICTIM')]);
  await sendBooking(attacker, [bk('LD-ATTACK')]);
  await send(victim, [{ collection:'careRecipients', id:'LD-VIC-CR', record:{ id:'LD-VIC-CR', displayName:'合成' } }]);
  await send(dispatcher, [{ collection:'issues', id:'LD-ISS',
    record:{ id:'LD-ISS', organizationId:'ORG-TP-001', description:'自家異常' } }]);

  console.log('--- 基本 ---');
  await t('沒有 token 回 401', async () => parse(await get(null)).status === 401);
  await t('需求者載入成功', async () => { const r = parse(await get(victim)); return r.ok === true && !!r.data.collections; });

  console.log('--- 每個人只拿到自己該看的 ---');
  await t('需求者拿得到自己的預約', async () => {
    const r = parse(await get(victim));
    return (r.data.collections.bookings || []).some(b => b.id === 'LD-VICTIM');
  });
  await t('需求者拿不到別人的預約', async () => {
    const r = parse(await get(victim));
    return !(r.data.collections.bookings || []).some(b => b.id === 'LD-ATTACK');
  });
  await t('需求者拿不到別家組織的異常紀錄', async () => {
    const r = parse(await get(victim));
    return !(r.data.collections.issues || []).some(i => i.id === 'LD-ISS');
  });
  await t('調度員拿得到自家組織的異常紀錄', async () => {
    const r = parse(await get(dispatcher));
    return (r.data.collections.issues || []).some(i => i.id === 'LD-ISS');
  });
  await t('調度員拿不到需求者的私人預約內容', async () => {
    const r = parse(await get(dispatcher));
    return !(r.data.collections.bookings || []).some(b => b.id === 'LD-VICTIM');
  });

  console.log('--- 個資不外流 ---');
  await t('回應裡沒有密碼雜湊相關欄位', async () => {
    const res = await get(victim);
    return !/hash|salt|pepper|passwordHash/i.test(res.body);
  });
  await t('調度員的需求池只有模糊地址（路段＋門牌去尾），看不到完整門牌', async () => {
    const r = parse(await get(dispatcher));
    const text = JSON.stringify(r.data.pool || []);
    return (r.data.pool || []).length >= 1 && !/100號/.test(text) && text.includes('文化路一段1xx號附近');
  });
  await t('需求者的需求池是空的', async () => {
    const r = parse(await get(victim));
    return (r.data.pool || []).length === 0;
  });

  console.log('--- 伺服器欄位是權威 ---');
  await t('organizationId 以資料庫為準：需求者謊報承接機構被拒，也沒有寫入', async () => {
    const w = parse(await sendBooking(victim, [bk('LD-LIE', { organizationId: 'ORG-TP-001' })]));
    const r = parse(await get(victim));
    return w.ok !== true && !(r.data.collections.bookings || []).some(b => b.id === 'LD-LIE');
  });
  await t('version 由伺服器帶回', async () => {
    const r = parse(await get(victim));
    const row = (r.data.collections.bookings || []).find(b => b.id === 'LD-VICTIM');
    return row && Number(row.version) >= 1;
  });

  console.log('--- 軟刪除的資料不會回來 ---');
  await t('刪除後就不在載入結果裡', async () => {
    await send(victim, [{ collection:'careRecipients', id:'LD-VIC-CR', record:{ id:'LD-VIC-CR' }, deleted:true }]);
    const r = parse(await get(victim));
    return !(r.data.collections.careRecipients || []).some(b => b.id === 'LD-VIC-CR');
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
