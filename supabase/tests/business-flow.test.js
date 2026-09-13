'use strict';
/**
 * 業務權限整合測試：接案、司機執行、需求者取消。
 *
 * 所有斷言都經過實際的 netlify/functions/v2-state-load 與 v2-state-mutate handler，
 * handler 以 care_ride_app 連線（真正的 RLS 與 app_state_force_scope 觸發器生效）。
 * 不用 postgres 連線、也不直接呼叫 SQL 函式來代替 API 驗證。
 *
 * postgres 連線只用在兩件事：
 *   1. 建立身分 fixture（users / memberships / drivers / organizations）——
 *      這四個集合本來就不接受 state-mutate 寫入。
 *   2. 讀取資料庫實際狀態，當作「有沒有真的寫進去／有沒有被改掉」的判準。
 * 情境 3 另有一個明確標示的狀態 fixture，理由寫在該段。
 *
 * 斷言寫的是「預期的業務行為」。目前若回 403，就讓它如實失敗，不把缺陷寫成預期。
 * 負向（越權）斷言則同時確認沒有洩露、沒有異動。
 *
 * 只允許本機隔離端點與固定測試庫名稱，不會連到正式或預覽資料庫。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_flow_test') {
  throw Error('Requires dedicated local endpoint and careride_flow_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_flow_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_flow_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-flow-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-flow-0123456789';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_flow_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const auth = require('../../netlify/functions/_auth-pg');
const load = require('../../netlify/functions/v2-state-load');
const mutate = require('../../netlify/functions/v2-state-mutate');

// ---------------------------------------------------------------- 合成身分
const ORG_A = 'ORG-FLOW-A';
const ORG_B = 'ORG-FLOW-B';
const U = {
  req: 'USR-FLOW-REQ', dspA: 'USR-FLOW-DSP-A', dspB: 'USR-FLOW-DSP-B',
  drvA1: 'USR-FLOW-DRV-A1', drvA2: 'USR-FLOW-DRV-A2', drvB1: 'USR-FLOW-DRV-B1'
};
const DRIVER = { a1: 'DRV-FLOW-A1', a2: 'DRV-FLOW-A2', b1: 'DRV-FLOW-B1' };
// 可辨識的完整門牌，只要出現在不該看到的人的回應裡就是洩露
const SECRET_ADDRESS = '新北市板橋區文化路一段188號';

// ---------------------------------------------------------------- 結果紀錄
const results = [];
function record(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------------------------------------------------------------- 呼叫 handler
async function call(handler, method, token, body) {
  const res = await handler({
    httpMethod: method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const loadAs = (token) => call(load.handler, 'GET', token);
const mutateAs = (token, changes) => call(mutate.handler, 'POST', token, { changes });
const outcome = (r) => `HTTP ${r.status}${r.error ? ` ${r.error.code}` : ''}`;
const idsIn = (r, collection) => ((r.data && r.data.collections && r.data.collections[collection]) || []).map((x) => x.id);
const poolIds = (r) => ((r.data && r.data.pool) || []).map((x) => x.id);

async function row(collection, id) {
  const { rows } = await admin.query(
    `select organization_id, owner_user_id, deleted, version, revision, data
       from app_state where collection = $1 and id = $2`, [collection, id]);
  return rows[0] || null;
}
const snapshot = async (collection, id) => JSON.stringify(await row(collection, id));

// ---------------------------------------------------------------- fixture
async function seedIdentities() {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values
      ('${ORG_A}','transport_provider','合成承運 A',true),
      ('${ORG_B}','transport_provider','合成承運 B',true)
    on conflict (id) do nothing;
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886911000001','none',true),
      ('${U.dspA}','合成調度 A','+886911000002','none',true),
      ('${U.dspB}','合成調度 B','+886911000003','none',true),
      ('${U.drvA1}','合成司機 A1','+886911000004','none',true),
      ('${U.drvA2}','合成司機 A2','+886911000005','none',true),
      ('${U.drvB1}','合成司機 B1','+886911000006','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-FLOW-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-FLOW-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-FLOW-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-FLOW-DA1','${U.drvA1}','${ORG_A}','driver','active'),
      ('M-FLOW-DA2','${U.drvA2}','${ORG_A}','driver','active'),
      ('M-FLOW-DB1','${U.drvB1}','${ORG_B}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER.a1}','${U.drvA1}','${ORG_A}','on_duty',true),
      ('${DRIVER.a2}','${U.drvA2}','${ORG_A}','on_duty',true),
      ('${DRIVER.b1}','${U.drvB1}','${ORG_B}','on_duty',true);
  `);
}

const token = (userId) => db.withoutUser((c) => auth.issueSessionToken(c, userId));

function openBooking(id) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: SECRET_ADDRESS, destination: '台北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true
  };
}
function scheduledTrip(id, driverId, extra = {}) {
  return {
    id, organizationId: ORG_A, driverId, vehicleId: 'VEH-FLOW-A1',
    status: 'scheduled', date: '2099-01-01', code: `CR-${id}`,
    passengerSummary: '合成乘客', pickupAddress: SECRET_ADDRESS,
    dropoffAddress: '台北市中正區公園路20號', currentStepIndex: 0, steps: [], ...extra
  };
}

// ================================================================ 情境 1
async function scenario1(t) {
  const S = '情境1 接案';
  const id = 'BKG-FLOW-S1';

  const created = await mutateAs(t.req, [{ collection: 'bookings', id, record: openBooking(id) }]);
  record(S, '需求者建立公開預約', created.status === 200, outcome(created));

  const loadA = await loadAs(t.dspA);
  const poolRowA = ((loadA.data && loadA.data.pool) || []).find((x) => x.id === id);
  record(S, '調度員 A 的 state-load 需求池含此預約', loadA.status === 200 && Boolean(poolRowA), outcome(loadA));
  record(S, '需求池列只到行政區、不含門牌與預約者身分',
    Boolean(poolRowA) && !JSON.stringify(poolRowA).includes('188號')
      && !JSON.stringify(poolRowA).includes(U.req) && !JSON.stringify(poolRowA).includes('0911000001'),
    poolRowA ? `pickup_area=${poolRowA.pickup_area}` : '需求池無此列');
  record(S, '調度員 A 的原始 bookings 集合不含未承接預約（遮蔽不可繞過）',
    loadA.status === 200 && !idsIn(loadA, 'bookings').includes(id),
    `bookings=${JSON.stringify(idsIn(loadA, 'bookings'))}`);

  // 前端 Booking.claim 實際送出的寫入：同一筆 bookings 記錄，state→claimed、organizationId→自己組織
  const claimA = await mutateAs(t.dspA, [{
    collection: 'bookings', id,
    record: { ...openBooking(id), state: 'claimed', claimStatus: 'claimed', status: 'claimed',
              organizationId: ORG_A, claimedByUserId: U.dspA, version: 2 }
  }]);
  const afterA = await row('bookings', id);
  record(S, '調度員 A 透過 state-mutate 接案成功（HTTP 200）', claimA.status === 200, outcome(claimA));
  record(S, '接案後資料庫 organization_id = A 且 state = claimed',
    Boolean(afterA) && afterA.organization_id === ORG_A && afterA.data.state === 'claimed',
    afterA ? `organization_id=${afterA.organization_id} state=${afterA.data.state}` : '找不到資料列');

  const beforeB = await snapshot('bookings', id);
  const claimB = await mutateAs(t.dspB, [{
    collection: 'bookings', id,
    record: { ...openBooking(id), state: 'claimed', claimStatus: 'claimed', status: 'claimed',
              organizationId: ORG_B, claimedByUserId: U.dspB, version: 2 }
  }]);
  record(S, '組織 B 重複承接被拒絕', claimB.status !== 200, outcome(claimB));
  record(S, '組織 B 的嘗試沒有異動資料', (await snapshot('bookings', id)) === beforeB);

  const loadB = await loadAs(t.dspB);
  record(S, '組織 B 的 state-load 看不到完整門牌',
    loadB.status === 200 && !JSON.stringify(loadB.data.collections || {}).includes('188號'), outcome(loadB));
}

// ================================================================ 情境 2
async function scenario2(t) {
  const S = '情境2 司機執行';
  const id = 'TRP-FLOW-S2';

  const created = await mutateAs(t.dspA, [{ collection: 'trips', id, record: scheduledTrip(id, DRIVER.a1) }]);
  const createdRow = await row('trips', id);
  record(S, '調度員 A 建立指派給司機 A1 的行程', created.status === 200, outcome(created));
  record(S, '行程歸屬組織 A', Boolean(createdRow) && createdRow.organization_id === ORG_A,
    createdRow ? `organization_id=${createdRow.organization_id}` : '找不到資料列');

  const loadA1 = await loadAs(t.drvA1);
  record(S, '被指派司機 A1 的 state-load 含此行程',
    loadA1.status === 200 && idsIn(loadA1, 'trips').includes(id),
    `${outcome(loadA1)} trips=${JSON.stringify(idsIn(loadA1, 'trips'))}`);

  const rev = createdRow ? createdRow.revision : 0;
  const execA1 = await mutateAs(t.drvA1, [{
    collection: 'trips', id, expectedRevision: rev,
    record: scheduledTrip(id, DRIVER.a1, { status: 'in_progress', startedAt: '2099-01-01T00:40:00Z' })
  }]);
  const afterA1 = await row('trips', id);
  record(S, '被指派司機 A1 透過 state-mutate 開始執行（HTTP 200）', execA1.status === 200, outcome(execA1));
  record(S, '執行後資料庫行程狀態 = in_progress',
    Boolean(afterA1) && afterA1.data.status === 'in_progress',
    afterA1 ? `status=${afterA1.data.status} revision=${afterA1.revision}` : '找不到資料列');

  for (const [label, tok, driverId] of [
    ['同組織其他司機 A2', t.drvA2, DRIVER.a2],
    ['其他組織司機 B1', t.drvB1, DRIVER.b1],
    ['其他組織調度員 B', t.dspB, null]
  ]) {
    const l = await loadAs(tok);
    record(S, `${label} 讀不到此行程且無門牌洩露`,
      l.status !== 200 || (!idsIn(l, 'trips').includes(id) && !JSON.stringify(l.data.collections || {}).includes('188號')),
      outcome(l));
    const before = await snapshot('trips', id);
    const current = await row('trips', id);
    const w = await mutateAs(tok, [{
      collection: 'trips', id, expectedRevision: current ? current.revision : 0,
      record: scheduledTrip(id, driverId || DRIVER.a1, { status: 'cancelled' })
    }]);
    record(S, `${label} 寫入被拒絕`, w.status !== 200, outcome(w));
    record(S, `${label} 的嘗試沒有異動行程`, (await snapshot('trips', id)) === before);
  }
}

// ================================================================ 情境 3
async function scenario3(t) {
  const S = '情境3 需求者取消已排車預約';
  const bookingId = 'BKG-FLOW-S3';
  const tripId = 'TRP-FLOW-S3';

  const created = await mutateAs(t.req, [{ collection: 'bookings', id: bookingId, record: openBooking(bookingId) }]);
  record(S, '需求者建立預約', created.status === 200, outcome(created));

  // 狀態 fixture（非斷言）：把預約直接設成「已由組織 A 承接並排車」。
  // 刻意不走情境 1 的接案 API，讓本情境只驗取消，不被接案結果連帶影響。
  // app_state_force_scope 會還原 UPDATE 的 organization_id，所以用與
  // app.claim_app_state_booking 相同的交易級旗標繞過，只作用在這筆 fixture。
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.state_scope_override','1',true)`);
    await c.query(
      `update app_state set organization_id = $1,
              data = data || jsonb_build_object('state','scheduled','claimStatus','claimed','status','scheduled',
                                                'organizationId',$1::text,'tripId',$2::text)
        where collection = 'bookings' and id = $3`, [ORG_A, tripId, bookingId]);
    await c.query('commit');
  } finally { c.release(); }

  const tripCreated = await mutateAs(t.dspA, [{
    collection: 'trips', id: tripId,
    record: scheduledTrip(tripId, DRIVER.a1, { bookingId, bookingIds: [bookingId] })
  }]);
  record(S, '調度員 A 為此預約建立行程', tripCreated.status === 200, outcome(tripCreated));

  const bookingBefore = await row('bookings', bookingId);
  const tripBefore = await row('trips', tripId);
  const snapBooking = JSON.stringify(bookingBefore);
  const snapTrip = JSON.stringify(tripBefore);

  const reqLoad = await loadAs(t.req);
  record(S, '需求者的 state-load 含自己的預約',
    reqLoad.status === 200 && idsIn(reqLoad, 'bookings').includes(bookingId), outcome(reqLoad));
  console.log(`      [觀察] 需求者 state-load 是否含對應行程：${idsIn(reqLoad, 'trips').includes(tripId)}`);

  // 前端 Booking.cancelOwn 在同一個 store.mutate 裡同時改預約與行程，
  // outbox 會把兩筆放在同一批 changes 送出。
  const cancel = await mutateAs(t.req, [
    { collection: 'bookings', id: bookingId,
      record: { ...bookingBefore.data, state: 'cancelled', claimStatus: 'cancelled', status: 'cancelled',
                cancelledByUserId: U.req, cancelReasonCode: 'requester_no_longer_needed' } },
    { collection: 'trips', id: tripId, expectedRevision: tripBefore ? tripBefore.revision : 0,
      record: { ...(tripBefore ? tripBefore.data : {}), status: 'cancelled', cancelledByUserId: U.req } }
  ]);
  const bookingAfter = await row('bookings', bookingId);
  const tripAfter = await row('trips', tripId);

  record(S, '需求者取消已排車預約成功（HTTP 200）', cancel.status === 200, outcome(cancel));
  record(S, '取消後預約狀態 = cancelled', Boolean(bookingAfter) && bookingAfter.data.state === 'cancelled',
    bookingAfter ? `state=${bookingAfter.data.state}` : '找不到資料列');
  record(S, '取消後行程狀態 = cancelled', Boolean(tripAfter) && tripAfter.data.status === 'cancelled',
    tripAfter ? `status=${tripAfter.data.status}` : '找不到資料列');

  if (cancel.status !== 200) {
    record(S, '失敗時整批回滾：預約未異動', JSON.stringify(bookingAfter) === snapBooking);
    record(S, '失敗時整批回滾：行程未異動', JSON.stringify(tripAfter) === snapTrip);
  }
}

// ================================================================ 執行
(async () => {
  await seedIdentities();
  const t = {};
  for (const [k, uid] of Object.entries(U)) t[k] = await token(uid);

  console.log('--- 情境 1：調度員取得遮蔽需求池並接案；另一組織不能重複承接 ---');
  await scenario1(t);
  console.log('--- 情境 2：被指派司機讀取並執行自己的行程；其他司機不能讀寫 ---');
  await scenario2(t);
  console.log('--- 情境 3：需求者取消自己的已排車預約 ---');
  await scenario3(t);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  for (const s of [...new Set(results.map((r) => r.scenario))]) {
    const rows = results.filter((r) => r.scenario === s);
    console.log(`  ${s}：${rows.filter((r) => r.ok).length} 通過 / ${rows.filter((r) => !r.ok).length} 失敗`);
  }
  console.log(`結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
