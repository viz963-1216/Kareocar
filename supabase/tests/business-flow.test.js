'use strict';
/**
 * 業務權限整合測試：接案、司機執行、需求者取消。
 *
 * 所有斷言都經過實際的 netlify/functions handler（state-load、state-mutate、
 * claim-booking、trip-execute、cancel-booking），handler 以 care_ride_app 連線，
 * RLS、app_state_force_scope 觸發器與 baseline 第 8 部分的 security definer 函式全部生效。
 * 不用 postgres 連線、也不直接呼叫 SQL 函式來代替 API 驗證。
 *
 * postgres 連線只用在：
 *   1. 建立身分 fixture（users / memberships / drivers / organizations）
 *   2. 讀取資料庫實際狀態，當作「有沒有真的寫進去／有沒有被改掉」的判準
 *   3. 情境 3 的狀態 fixture（把預約設為已承接並排車），理由寫在該段
 *
 * 司機送出的請求本體由 tests/_trip-fixtures.js 依前端規則模擬產生。這裡通過代表
 * 伺服器接受「照前端規則算出來的結果」並擋下越權變化；前端實際送出的內容由瀏覽器
 * 端對端測試另外確認。
 *
 * 與 PR #6（fec25cb）的關係：
 *   #6 的業務預期（調度員能接案且組織綁定、被指派司機能讀取並執行、需求者能取消
 *   已排車預約）全部保留。修正後這三件事改走專用端點，所以「怎麼送出」改了；
 *   #6 原本透過 state-mutate 的寫法另外保留成「[安全] 舊的一般寫入管道仍被拒」
 *   斷言，確認修正沒有靠放寬一般寫入權限達成。
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
// access token 以測試金鑰簽發，function 端走正式的 JWT 驗證；必須在載入 function 之前
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_flow_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const load = require('../../netlify/functions/v2-state-load');
const mutate = require('../../netlify/functions/v2-state-mutate');
const bookingWrite = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const executeFn = require('../../netlify/functions/v2-trip-execute');
const cancelFn = require('../../netlify/functions/v2-cancel-booking');
const F = require('../../tests/_trip-fixtures');

// ---------------------------------------------------------------- 合成身分
const ORG_A = 'ORG-FLOW-A';
const ORG_B = 'ORG-FLOW-B';
const ORG_X = 'ORG-FLOW-X';          // 不是可承接案件的組織類型
const U = {
  req: 'USR-FLOW-REQ', req2: 'USR-FLOW-REQ2', dspA: 'USR-FLOW-DSP-A', dspB: 'USR-FLOW-DSP-B',
  dspX: 'USR-FLOW-DSP-X', drvA1: 'USR-FLOW-DRV-A1', drvA2: 'USR-FLOW-DRV-A2', drvB1: 'USR-FLOW-DRV-B1'
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
    headers: token ? { host: '127.0.0.1', cookie: `cr_at=${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const loadAs = (token) => call(load.handler, 'GET', token);
const mutateAs = (token, changes) => call(mutate.handler, 'POST', token, { changes });
const bookingWriteAs = (token, changes) => call(bookingWrite.handler, 'POST', token, { changes });
const claimAs = (token, bookingId, organizationId) =>
  call(claimFn.handler, 'POST', token, { bookingId, organizationId });
const executeAs = (token, body) => call(executeFn.handler, 'POST', token, body);
const cancelAs = (token, body) => call(cancelFn.handler, 'POST', token, body);

const outcome = (r) => `HTTP ${r.status}${r.error ? ` ${r.error.code}` : ''}${r.error && r.status >= 400 && r.status !== 403 ? ` ${r.error.message}` : ''}`;
const idsIn = (r, collection) => ((r.data && r.data.collections && r.data.collections[collection]) || []).map((x) => x.id);
const nowIso = () => new Date().toISOString();

async function row(collection, id) {
  const { rows } = await admin.query(
    `select organization_id, owner_user_id, deleted, version, revision, data
       from app_state where collection = $1 and id = $2`, [collection, id]);
  return rows[0] || null;
}
const snapshot = async (collection, id) => JSON.stringify(await row(collection, id));
/** 司機裝置上看到的行程：資料列 data 加上伺服器的 revision（與 state-load 相同）。 */
async function tripState(id) {
  const r = await row('trips', id);
  return { ...r.data, organizationId: r.organization_id, revision: r.revision };
}
async function countWhere(collection, column, value) {
  const { rows } = await admin.query(
    `select count(*)::int as n from app_state where collection = $1 and ${column} = $2`, [collection, value]);
  return rows[0].n;
}
async function notificationsFor(bookingId) {
  const { rows } = await admin.query(
    `select id, organization_id, owner_user_id, data from app_state
      where collection = 'notifications' and booking_id = $1 order by id`, [bookingId]);
  return rows;
}

/** 被拒絕的呼叫：狀態碼、錯誤碼都要對，而且指定資料列完全沒變。 */
async function expectRejected(S, name, promise, { status, code }, watched) {
  const before = await Promise.all(watched.map(([c, i]) => snapshot(c, i)));
  const r = await promise;
  const after = await Promise.all(watched.map(([c, i]) => snapshot(c, i)));
  record(S, `${name}：被拒絕`, r.status === status && (!code || (r.error && r.error.code === code)),
    `${outcome(r)}，預期 HTTP ${status}${code ? ` ${code}` : ''}`);
  record(S, `${name}：資料未異動`, JSON.stringify(before) === JSON.stringify(after));
  return r;
}

// ---------------------------------------------------------------- fixture
async function seedIdentities() {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values
      ('${ORG_A}','transport_provider','合成承運 A',true),
      ('${ORG_B}','transport_provider','合成承運 B',true),
      ('${ORG_X}','requester_hub','合成非承運組織',true)
    on conflict (id) do nothing;
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886911000001','none',true),
      ('${U.req2}','合成需求者二','+886911000009','none',true),
      ('${U.dspA}','合成調度 A','+886911000002','none',true),
      ('${U.dspB}','合成調度 B','+886911000003','none',true),
      ('${U.dspX}','合成調度 X','+886911000008','none',true),
      ('${U.drvA1}','合成司機 A1','+886911000004','none',true),
      ('${U.drvA2}','合成司機 A2','+886911000005','none',true),
      ('${U.drvB1}','合成司機 B1','+886911000006','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-FLOW-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-FLOW-REQ2','${U.req2}','ORG-REQ-001','requester','active'),
      ('M-FLOW-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-FLOW-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-FLOW-DSPX','${U.dspX}','${ORG_X}','dispatcher','active'),
      ('M-FLOW-DA1','${U.drvA1}','${ORG_A}','driver','active'),
      ('M-FLOW-DA2','${U.drvA2}','${ORG_A}','driver','active'),
      ('M-FLOW-DB1','${U.drvB1}','${ORG_B}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER.a1}','${U.drvA1}','${ORG_A}','on_duty',true),
      ('${DRIVER.a2}','${U.drvA2}','${ORG_A}','on_duty',true),
      ('${DRIVER.b1}','${U.drvB1}','${ORG_B}','on_duty',true);
  `);
}

const token = async (userId) => fx.mintAccessToken(userId);

function openBooking(id, requester = U.req) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: requester, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: SECRET_ADDRESS, destination: '台北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    aidNeed: '無', companions: '1', specialNeed: '合成特殊需求自由文字'
  };
}
/** 接送時間在 10 分鐘後，出發站已在可執行時間內。 */
function scheduledTrip(id, driverId, extra = {}) {
  return F.makeTrip({
    id, organizationId: ORG_A, driverId, vehicleId: 'VEH-FLOW-A1',
    bookingId: extra.bookingId || null, startAt: F.addMinutes(nowIso(), 10),
    extra: { pickupAddress: SECRET_ADDRESS, ...extra }
  });
}

/** 狀態 fixture：把預約設為「組織 A 已承接並排車」。 */
async function fixtureScheduled(bookingId, tripId) {
  const c = await admin.connect();
  try {
    await c.query('begin');
    // app_state_force_scope 會還原 UPDATE 的 organization_id；用與 claim 函式
    // 相同的交易級旗標，只作用在這筆 fixture。
    await c.query(`select set_config('app.state_scope_override','1',true)`);
    await c.query(
      `update app_state set organization_id = $1,
              data = data || jsonb_build_object('state','scheduled','claimStatus','claimed','status','scheduled',
                                                'organizationId',$1::text,'tripId',$2::text)
        where collection = 'bookings' and id = $3`, [ORG_A, tripId, bookingId]);
    await c.query('commit');
  } finally { c.release(); }
}

// ================================================================ 情境 1
async function scenario1(t) {
  const S = '情境1 接案';
  const id = 'BKG-FLOW-S1';

  const created = await bookingWriteAs(t.req, [{ collection: 'bookings', id, record: openBooking(id) }]);
  record(S, '需求者建立公開預約', created.status === 200, outcome(created));

  const loadA = await loadAs(t.dspA);
  const poolRowA = ((loadA.data && loadA.data.pool) || []).find((x) => x.id === id);
  record(S, '調度員 A 的 state-load 需求池含此預約', loadA.status === 200 && Boolean(poolRowA), outcome(loadA));
  const poolText = JSON.stringify(poolRowA || {});
  record(S, '需求池列只到行政區、不含門牌／預約者身分／電話／自由文字需求',
    Boolean(poolRowA) && !poolText.includes('188號') && !poolText.includes(U.req)
      && !poolText.includes('0911000001') && !poolText.includes('合成需求者') && !poolText.includes('合成特殊需求'),
    poolRowA ? `pickup_area=${poolRowA.pickup_area}` : '需求池無此列');
  record(S, '需求池帶出接案畫面需要的時間欄位',
    Boolean(poolRowA) && poolRowA.pickup_at === '2099-01-01' && poolRowA.pickup_time === '09:00',
    poolRowA ? `pickup_at=${poolRowA.pickup_at} pickup_time=${poolRowA.pickup_time}` : '');
  record(S, '調度員 A 的原始 bookings 集合不含未承接預約（遮蔽不可繞過）',
    loadA.status === 200 && !idsIn(loadA, 'bookings').includes(id),
    `bookings=${JSON.stringify(idsIn(loadA, 'bookings'))}`);

  // #6 原本的寫法：透過一般寫入管道接案。修正後這條路仍必須被拒。
  const forgedClaim = { ...openBooking(id), state: 'claimed', claimStatus: 'claimed', status: 'claimed',
    organizationId: ORG_A, claimedByUserId: U.dspA, version: 2 };
  await expectRejected(S, '[安全] 透過 state-mutate 接案', mutateAs(t.dspA, [{
    collection: 'bookings', id, record: forgedClaim
  }]), { status: 403, code: 'COLLECTION_FORBIDDEN' }, [['bookings', id]]);
  // 調度員看不到未承接的預約，會被當成新增；偽造的需求者欄位先被擋下
  await expectRejected(S, '[安全] 透過預約端點接案', bookingWriteAs(t.dspA, [{
    collection: 'bookings', id, record: forgedClaim
  }]), { status: 400, code: 'VALIDATION_ERROR' }, [['bookings', id]]);
  await expectRejected(S, '[安全] 透過預約端點接案（不帶需求者）', bookingWriteAs(t.dspA, [{
    collection: 'bookings', id, record: { ...forgedClaim, requestedByUserId: null }
  }]), { status: 403, code: 'FORBIDDEN' }, [['bookings', id]]);
  await expectRejected(S, '[安全] 需求者自己把預約改成已承接', bookingWriteAs(t.req, [{
    collection: 'bookings', id, record: forgedClaim
  }]), { status: 400, code: 'VALIDATION_ERROR' }, [['bookings', id]]);

  await expectRejected(S, '調度員 A 代表未加入的組織 B 接案', claimAs(t.dspA, id, ORG_B),
    { status: 403, code: 'FORBIDDEN' }, [['bookings', id]]);
  await expectRejected(S, '非承運組織的調度員接案', claimAs(t.dspX, id, ORG_X),
    { status: 403, code: 'FORBIDDEN' }, [['bookings', id]]);
  await expectRejected(S, '需求者自己接案', claimAs(t.req, id, 'ORG-REQ-001'),
    { status: 403, code: 'FORBIDDEN' }, [['bookings', id]]);

  const claimA = await claimAs(t.dspA, id, ORG_A);
  const afterA = await row('bookings', id);
  record(S, '調度員 A 接案成功（HTTP 200）', claimA.status === 200, outcome(claimA));
  record(S, '接案後資料庫 organization_id = A 且 state = claimed',
    Boolean(afterA) && afterA.organization_id === ORG_A && afterA.data.state === 'claimed'
      && afterA.data.claimedByUserId === U.dspA,
    afterA ? `organization_id=${afterA.organization_id} state=${afterA.data.state}` : '找不到資料列');

  await expectRejected(S, '組織 B 重複承接已被接走的預約', claimAs(t.dspB, id, ORG_B),
    { status: 409, code: 'BOOKING_CONFLICT' }, [['bookings', id]]);

  const loadA2 = await loadAs(t.dspA);
  record(S, '接案後調度員 A 取得完整預約、需求池不再列出',
    loadA2.status === 200 && idsIn(loadA2, 'bookings').includes(id)
      && !((loadA2.data.pool || []).some((x) => x.id === id)), outcome(loadA2));

  const loadB = await loadAs(t.dspB);
  record(S, '組織 B 的 state-load 看不到完整門牌',
    loadB.status === 200 && !JSON.stringify(loadB.data || {}).includes('188號'), outcome(loadB));

  // ---- 兩組織同時接案，只能一方成功
  const cid = 'BKG-FLOW-S1C';
  // 勝出的組織本來就會拿到完整預約；用另一個地址，後面「其他組織讀不到 SECRET_ADDRESS」
  // 的檢查才不會因為這裡由 B 勝出而失敗。
  await bookingWriteAs(t.req, [{ collection: 'bookings', id: cid,
    record: { ...openBooking(cid), pickupAddress: '台北市大安區復興南路一段390號' } }]);
  const [ra, rb] = await Promise.all([claimAs(t.dspA, cid, ORG_A), claimAs(t.dspB, cid, ORG_B)]);
  const winners = [ra, rb].filter((r) => r.status === 200);
  const losers = [ra, rb].filter((r) => r.status === 409 && r.error && r.error.code === 'BOOKING_CONFLICT');
  const concurrentRow = await row('bookings', cid);
  const expectedOrg = ra.status === 200 ? ORG_A : ORG_B;
  record(S, '兩組織同時接案：恰好一方 200、另一方 409 BOOKING_CONFLICT',
    winners.length === 1 && losers.length === 1, `A=${outcome(ra)} B=${outcome(rb)}`);
  record(S, '同時接案後資料庫只綁定勝出的組織',
    winners.length === 1 && Boolean(concurrentRow) && concurrentRow.organization_id === expectedOrg,
    concurrentRow ? `organization_id=${concurrentRow.organization_id}` : '');
}

// ================================================================ 情境 2
async function scenario2(t) {
  const S = '情境2 司機執行';
  const id = 'TRP-FLOW-S2';
  const other = 'TRP-FLOW-S2-A2';

  // A2 自己那趟用不同的地址：A2 看得到自己的行程是正確的，若沿用 SECRET_ADDRESS，
  // 下面「A2 讀不到 A1 行程的門牌」的洩露檢查會被 A2 自己合法的資料誤判。
  const created = await mutateAs(t.dspA, [
    { collection: 'trips', id, record: scheduledTrip(id, DRIVER.a1) },
    { collection: 'trips', id: other, record: scheduledTrip(other, DRIVER.a2, { pickupAddress: '台北市信義區松仁路1號' }) }
  ]);
  const createdRow = await row('trips', id);
  record(S, '調度員 A 建立指派給司機 A1（及另一趟給 A2）的行程', created.status === 200, outcome(created));
  record(S, '行程歸屬組織 A', Boolean(createdRow) && createdRow.organization_id === ORG_A,
    createdRow ? `organization_id=${createdRow.organization_id}` : '找不到資料列');

  const loadA1 = await loadAs(t.drvA1);
  const tripForA1 = ((loadA1.data && loadA1.data.collections && loadA1.data.collections.trips) || []).find((x) => x.id === id);
  record(S, '被指派司機 A1 的 state-load 含此行程',
    loadA1.status === 200 && Boolean(tripForA1),
    `${outcome(loadA1)} trips=${JSON.stringify(idsIn(loadA1, 'trips'))}`);
  record(S, '司機 A1 取得執行所需的停靠點資料', Boolean(tripForA1) && Array.isArray(tripForA1.steps) && tripForA1.steps.length === 3);
  record(S, '司機 A1 看不到指派給 A2 的行程', loadA1.status === 200 && !idsIn(loadA1, 'trips').includes(other));

  const t0 = await tripState(id);
  const rev0 = t0.revision;
  const watched = [['trips', id]];

  // #6 原本的寫法：司機透過一般寫入管道改行程。修正後這條路仍必須被拒。
  await expectRejected(S, '[安全] 司機 A1 透過 state-mutate 直接改行程', mutateAs(t.drvA1, [{
    collection: 'trips', id, expectedRevision: rev0,
    record: { ...t0, status: 'in_progress' }
  }]), { status: 403, code: 'FORBIDDEN' }, watched);

  // ---- 非法指令、欄位與狀態轉換
  const depart = F.completeStep(t0, U.drvA1, nowIso());
  await expectRejected(S, '舊草稿的 start 指令已不存在', executeAs(t.drvA1, { tripId: id, command: 'start', expectedRevision: rev0, idempotencyKey: 'k-start' }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, '司機無中斷權限（interrupt 指令不存在）', executeAs(t.drvA1, { tripId: id, command: 'interrupt', expectedRevision: rev0, idempotencyKey: 'k-int' }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, 'revision 過期', executeAs(t.drvA1, { ...depart.request, expectedRevision: rev0 + 5 }),
    { status: 409, code: 'TRIP_CONFLICT' }, watched);
  for (const [label, key, value] of [
    ['改組織', 'organizationId', ORG_B], ['改指派司機', 'driverId', DRIVER.a2],
    ['改車輛', 'vehicleId', 'VEH-OTHER'], ['關掉服務證明規則', 'proofPolicy', { requiredPerDropoff: false }]
  ]) {
    const req = F.clone(depart.request);
    req.trip[key] = value;
    await expectRejected(S, `透過執行端點${label}`, executeAs(t.drvA1, req), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  }
  {
    const req = F.clone(depart.request);
    req.trip.steps[1].destination = '竄改地址';
    await expectRejected(S, '透過執行端點改停靠點地址', executeAs(t.drvA1, req), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  }
  {
    const req = F.clone(depart.request);
    req.trip.steps[0] = F.clone(t0.steps[0]);
    Object.assign(req.trip.steps[1], { status: 'completed', completedAt: nowIso(), actualAt: nowIso(), arrivedAt: nowIso(),
      serviceStartedAt: nowIso(), passengerBoardedAt: nowIso(), departedAt: nowIso() });
    req.trip.steps[1].actualAt = req.trip.steps[1].completedAt;
    await expectRejected(S, '跳站處理（先完成接送站）', executeAs(t.drvA1, req), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  }

  // ---- 非指派司機與他組織
  for (const [label, tok] of [['同組織其他司機 A2', t.drvA2], ['其他組織司機 B1', t.drvB1], ['其他組織調度員 B', t.dspB]]) {
    const l = await loadAs(tok);
    record(S, `${label} 讀不到此行程且無門牌洩露`,
      l.status === 200 && !idsIn(l, 'trips').includes(id) && !JSON.stringify(l.data.collections || {}).includes('188號'),
      `${outcome(l)} trips=${JSON.stringify(idsIn(l, 'trips'))}`);
    await expectRejected(S, `${label} 呼叫執行端點`, executeAs(tok, depart.request),
      { status: 403, code: 'FORBIDDEN' }, watched);
    await expectRejected(S, `${label} 透過 state-mutate 改行程`, mutateAs(tok, [{
      collection: 'trips', id, expectedRevision: rev0, record: { ...t0, status: 'cancelled' }
    }]), { status: 403, code: 'FORBIDDEN' }, watched);
  }

  // ---- 合法流程：出發
  const r1 = await executeAs(t.drvA1, depart.request);
  const a1 = await row('trips', id);
  record(S, '完成出發站（HTTP 200）', r1.status === 200, outcome(r1));
  record(S, '出發後狀態 = in_progress、revision +1、組織／司機／車輛未變、伺服器寫入冪等收據',
    Boolean(a1) && a1.data.status === 'in_progress' && a1.revision === rev0 + 1
      && a1.organization_id === ORG_A && a1.data.driverId === DRIVER.a1 && a1.data.vehicleId === 'VEH-FLOW-A1'
      && (a1.data.mutationReceipts || []).some((x) => x.key === depart.request.idempotencyKey && x.source === 'trip_execute_endpoint'),
    a1 ? `status=${a1.data.status} revision=${a1.revision}` : '');
  const eventId = depart.request.events[0].id;
  const eventRow = await row('tripEvents', eventId);
  record(S, '行程事件寫入且歸屬行程組織（調度端看得到）', Boolean(eventRow) && eventRow.organization_id === ORG_A,
    eventRow ? `organization_id=${eventRow.organization_id}` : '找不到事件');
  const loadDspA = await loadAs(t.dspA);
  record(S, '調度員 A 的 state-load 含司機寫入的行程事件', idsIn(loadDspA, 'tripEvents').includes(eventId));

  const eventsBefore = await countWhere('tripEvents', 'trip_id', id);
  const retry = await executeAs(t.drvA1, depart.request);
  const a1r = await row('trips', id);
  record(S, '重送同一個操作：200 且標記 duplicate', retry.status === 200 && retry.data && retry.data.duplicate === true, outcome(retry));
  record(S, '重送沒有再次寫入（revision 與事件數不變）',
    a1r.revision === a1.revision && (await countWhere('tripEvents', 'trip_id', id)) === eventsBefore);

  // ---- 定位：不動 revision
  const loc = F.locationSample(await tripState(id), U.drvA1, nowIso());
  const rl = await executeAs(t.drvA1, loc.request);
  const al = await row('trips', id);
  record(S, '回報定位（HTTP 200）且 revision 不變', rl.status === 200 && al.revision === a1.revision
    && (al.data.locationSamples || []).length === 1, outcome(rl));

  // ---- 接送
  const pickup = F.completeStep(await tripState(id), U.drvA1, nowIso());
  const rp = await executeAs(t.drvA1, pickup.request);
  const ap = await row('trips', id);
  record(S, '完成接送站：乘客在車上', rp.status === 200 && ap.data.passengers[0].status === 'onboard', outcome(rp));

  // ---- 現場異常：寫入異常並讓調度看得到
  const iss = F.reportIssue(await tripState(id), U.drvA1, nowIso(), '交通壅塞', '合成異常說明');
  const ri = await executeAs(t.drvA1, iss.request);
  const issueRow = await row('issues', iss.issue.id);
  record(S, '回報一般異常（HTTP 200），異常歸屬組織 A', ri.status === 200 && Boolean(issueRow) && issueRow.organization_id === ORG_A,
    `${outcome(ri)} ${issueRow ? `organization_id=${issueRow.organization_id}` : '找不到異常'}`);
  const loadDspA2 = await loadAs(t.dspA);
  const loadDspB = await loadAs(t.dspB);
  record(S, '調度員 A 看得到司機回報的異常、組織 B 看不到',
    idsIn(loadDspA2, 'issues').includes(iss.issue.id) && !idsIn(loadDspB, 'issues').includes(iss.issue.id));
  const riRetry = await executeAs(t.drvA1, iss.request);
  record(S, '重送同一筆異常：200 duplicate，不重複建立',
    riRetry.status === 200 && riRetry.data.duplicate === true && (await countWhere('issues', 'trip_id', id)) === 1, outcome(riRetry));

  // ---- 返回上一步再重做
  const undo = F.undoStep(await tripState(id), U.drvA1, nowIso());
  const ru = await executeAs(t.drvA1, undo.request);
  const au = await row('trips', id);
  record(S, '返回上一步（HTTP 200）：接送站回到未完成、乘客回到等待',
    ru.status === 200 && au.data.steps[1].status === 'pending' && au.data.passengers[0].status === 'waiting'
      && au.data.status === 'in_progress', outcome(ru));
  const redo = F.completeStep(await tripState(id), U.drvA1, nowIso());
  const rr = await executeAs(t.drvA1, redo.request);
  record(S, '重新完成接送站', rr.status === 200, outcome(rr));

  // ---- 送達：缺服務證明時不能完成
  const dropoff = F.completeStep(await tripState(id), U.drvA1, nowIso());
  {
    const req = F.clone(dropoff.request);
    req.trip.status = 'completed'; req.trip.completedAt = nowIso(); req.trip.completionPending = null;
    await expectRejected(S, '缺服務證明卻宣稱完成行程', executeAs(t.drvA1, req), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  }
  const rd = await executeAs(t.drvA1, dropoff.request);
  const ad = await row('trips', id);
  record(S, '完成送達站：行程仍進行中並標記待補服務證明',
    rd.status === 200 && ad.data.status === 'in_progress' && Boolean(ad.data.completionPending), outcome(rd));

  // ---- 服務證明（含照片描述資料）→ 完成
  const proof = F.addProof(await tripState(id), U.drvA1, nowIso(),
    { photo: { name: 'proof.jpg', type: 'image/jpeg', size: 2048, storage: 'indexeddb', objectKey: 'proofblob_synthetic' } });
  const rpr = await executeAs(t.drvA1, proof.request);
  const apr = await row('trips', id);
  record(S, '建立服務證明後行程完成，指派仍保留',
    rpr.status === 200 && apr.data.status === 'completed' && apr.data.serviceProofs.length === 1
      && apr.data.driverId === DRIVER.a1 && apr.data.vehicleId === 'VEH-FLOW-A1', outcome(rpr));
  record(S, '伺服器只存照片描述資料，沒有照片內容',
    Boolean(apr.data.serviceProofs[0].photo) && !JSON.stringify(apr.data.serviceProofs[0].photo).includes('data:'));

  const late = F.reportIssue(await tripState(id), U.drvA1, nowIso(), '交通壅塞');
  await expectRejected(S, '已完成的行程再回報異常', executeAs(t.drvA1, late.request),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);

  // ---- 完成後限時修正
  const undoDone = F.undoStep(await tripState(id), U.drvA1, nowIso());
  const rud = await executeAs(t.drvA1, undoDone.request);
  const aud = await row('trips', id);
  record(S, '完成後 15 分鐘內返回上一步：回到進行中、舊服務證明標記已被修正',
    rud.status === 200 && aud.data.status === 'in_progress' && aud.data.serviceProofs[0].status === 'superseded', outcome(rud));
  const redrop = F.completeStep(await tripState(id), U.drvA1, nowIso());
  const rrd = await executeAs(t.drvA1, redrop.request);
  const reproof = F.addProof(await tripState(id), U.drvA1, nowIso());
  const rrp = await executeAs(t.drvA1, reproof.request);
  const final = await row('trips', id);
  record(S, '重新送達並補新服務證明後再次完成',
    rrd.status === 200 && rrp.status === 200 && final.data.status === 'completed'
      && final.data.serviceProofs.filter((p) => p.status === 'active').length === 1, `${outcome(rrd)} / ${outcome(rrp)}`);
}

// ================================================================ 情境 2B
async function scenario2b(t) {
  const S = '情境2B 異常與中斷';
  const id = 'TRP-FLOW-S2B';
  await mutateAs(t.dspA, [{ collection: 'trips', id, record: scheduledTrip(id, DRIVER.a1, { pickupAddress: '台北市信義區松仁路1號' }) }]);
  const watched = [['trips', id]];

  for (let i = 0; i < 2; i++) {
    const step = F.completeStep(await tripState(id), U.drvA1, nowIso());
    const r = await executeAs(t.drvA1, step.request);
    if (r.status !== 200) record(S, `前置：完成第 ${i + 1} 站`, false, outcome(r));
  }
  const critical = F.reportIssue(await tripState(id), U.drvA1, nowIso(), '交通事故');
  const rc = await executeAs(t.drvA1, critical.request);
  record(S, '回報重大異常（交通事故）', rc.status === 200 && (await row('issues', critical.issue.id)).data.severity === 'critical', outcome(rc));

  const drop = F.completeStep(await tripState(id), U.drvA1, nowIso(), { blocking: true });
  const rd = await executeAs(t.drvA1, drop.request);
  record(S, '有未結案重大異常時完成送達站（行程保持進行中）', rd.status === 200, outcome(rd));

  const claimsDone = F.addProof(await tripState(id), U.drvA1, nowIso());
  await expectRejected(S, '有未結案重大異常時宣稱完成行程', executeAs(t.drvA1, claimsDone.request),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  const held = F.addProof(await tripState(id), U.drvA1, nowIso(), { blocking: true });
  const rh = await executeAs(t.drvA1, held.request);
  record(S, '服務證明照常保存，行程等調度結案異常', rh.status === 200 && (await row('trips', id)).data.status === 'in_progress', outcome(rh));

  // 中斷是調度的權限，走既有的 state-mutate（組織 A 調度可寫）
  const cur = await tripState(id);
  const interrupt = await mutateAs(t.dspA, [{ collection: 'trips', id, expectedRevision: cur.revision,
    record: { ...cur, status: 'interrupted', interruptedAt: nowIso(), interruptReason: '合成中斷' } }]);
  record(S, '調度員 A 中斷行程（既有路徑）', interrupt.status === 200, outcome(interrupt));
  const undo = F.undoStep(await tripState(id), U.drvA1, nowIso());
  await expectRejected(S, '中斷中的行程司機不能返回上一步', executeAs(t.drvA1, { ...undo.request, trip: { ...undo.request.trip, status: 'in_progress' } }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
}

// ================================================================ 情境 3
async function scenario3(t) {
  const S = '情境3 需求者取消已排車預約';
  const bookingId = 'BKG-FLOW-S3';
  const tripId = 'TRP-FLOW-S3';

  const created = await bookingWriteAs(t.req, [{ collection: 'bookings', id: bookingId, record: openBooking(bookingId) }]);
  record(S, '需求者建立預約', created.status === 200, outcome(created));

  // 狀態 fixture（非斷言）：刻意不走情境 1 的接案端點，讓本情境只驗取消。
  await fixtureScheduled(bookingId, tripId);

  const tripCreated = await mutateAs(t.dspA, [{
    collection: 'trips', id: tripId,
    record: scheduledTrip(tripId, DRIVER.a1, { bookingId, bookingIds: [bookingId] })
  }]);
  record(S, '調度員 A 為此預約建立行程', tripCreated.status === 200, outcome(tripCreated));

  const reqLoad = await loadAs(t.req);
  record(S, '需求者的 state-load 含自己的預約',
    reqLoad.status === 200 && idsIn(reqLoad, 'bookings').includes(bookingId), outcome(reqLoad));

  const watched = [['bookings', bookingId], ['trips', tripId]];
  const bookingBefore = await row('bookings', bookingId);
  const tripBefore = await row('trips', tripId);

  // #6 原本的寫法：同批 state-mutate。修正後這條路仍必須被拒且整批回滾。
  await expectRejected(S, '[安全] 透過 state-mutate 同批取消預約與行程', mutateAs(t.req, [
    { collection: 'bookings', id: bookingId,
      record: { ...bookingBefore.data, state: 'cancelled', status: 'cancelled' } },
    { collection: 'trips', id: tripId, expectedRevision: tripBefore.revision,
      record: { ...tripBefore.data, status: 'cancelled' } }
  ]), { status: 403, code: 'COLLECTION_FORBIDDEN' }, watched);
  await expectRejected(S, '[安全] 透過預約端點把預約改成已取消', bookingWriteAs(t.req, [
    { collection: 'bookings', id: bookingId,
      record: { ...bookingBefore.data, state: 'cancelled', status: 'cancelled' } }
  ]), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, '[安全] 需求者改已排車預約的接送地址', bookingWriteAs(t.req, [
    { collection: 'bookings', id: bookingId,
      record: { ...bookingBefore.data, pickupAddress: '新北市板橋區文化路一段999號' } }
  ]), { status: 400, code: 'VALIDATION_ERROR' }, watched);

  await expectRejected(S, '其他需求者取消此預約',
    cancelAs(t.req2, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 403, code: 'FORBIDDEN' }, watched);
  await expectRejected(S, '調度員透過需求者取消端點取消',
    cancelAs(t.dspA, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 403, code: 'FORBIDDEN' }, watched);
  await expectRejected(S, '缺少取消原因', cancelAs(t.req, { bookingId }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  record(S, '失敗的取消嘗試沒有留下任何通知', (await notificationsFor(bookingId)).length === 0);

  const cancel = await cancelAs(t.req, { bookingId, reasonCode: 'requester_no_longer_needed', reasonText: '合成取消原因' });
  const bookingAfter = await row('bookings', bookingId);
  const tripAfter = await row('trips', tripId);
  record(S, '需求者取消已排車預約成功（HTTP 200）', cancel.status === 200, outcome(cancel));
  record(S, '取消後預約狀態 = cancelled', Boolean(bookingAfter) && bookingAfter.data.state === 'cancelled',
    bookingAfter ? `state=${bookingAfter.data.state}` : '找不到資料列');
  record(S, '取消後行程狀態 = cancelled', Boolean(tripAfter) && tripAfter.data.status === 'cancelled',
    tripAfter ? `status=${tripAfter.data.status}` : '找不到資料列');
  record(S, '保留歷史關聯：預約 tripId、cancelledTripIds、行程 bookingIds／司機／車輛',
    Boolean(bookingAfter) && Boolean(tripAfter)
      && bookingAfter.data.tripId === tripId
      && JSON.stringify(bookingAfter.data.cancelledTripIds) === JSON.stringify([tripId])
      && JSON.stringify(tripAfter.data.bookingIds) === JSON.stringify([bookingId])
      && tripAfter.data.driverId === DRIVER.a1 && tripAfter.data.vehicleId === 'VEH-FLOW-A1');
  record(S, '行程 revision +1、組織與擁有者未變',
    Boolean(tripAfter) && tripAfter.revision === tripBefore.revision + 1
      && tripAfter.organization_id === tripBefore.organization_id && tripAfter.owner_user_id === tripBefore.owner_user_id);

  // ---- 通知
  const ntfs = await notificationsFor(bookingId);
  const toDriver = ntfs.find((n) => n.data.template === 'trip_cancelled');
  const toRequester = ntfs.find((n) => n.data.template === 'booking_cancelled');
  record(S, '取消成功後恰好排入兩則通知（司機、需求者）', ntfs.length === 2 && Boolean(toDriver) && Boolean(toRequester),
    `notifications=${JSON.stringify(ntfs.map((n) => n.data.template))}`);
  record(S, '司機通知：收件人為被指派司機、歸屬行程組織、內容指向行程',
    Boolean(toDriver) && toDriver.data.recipientId === U.drvA1 && toDriver.organization_id === ORG_A
      && toDriver.data.payload.tripId === tripId && toDriver.data.payload.bookingId === bookingId);
  record(S, '需求者通知：收件人為需求者、含取消原因與被取消的行程',
    Boolean(toRequester) && toRequester.data.recipientId === U.req
      && toRequester.data.payload.reason === '合成取消原因'
      && JSON.stringify(toRequester.data.payload.cancelledTripIds) === JSON.stringify([tripId]));
  record(S, '通知只是排入佇列（status = queued、未送出）',
    ntfs.every((n) => n.data.status === 'queued' && n.data.sentAt === null && n.data.channel === 'line'));
  record(S, '回應帶出通知 ID', cancel.status === 200 && JSON.stringify([...cancel.data.notificationIds].sort()) === JSON.stringify(ntfs.map((n) => n.id).sort()));
  const reqLoad2 = await loadAs(t.req);
  const dspLoad = await loadAs(t.dspA);
  const dspBLoad = await loadAs(t.dspB);
  record(S, '需求者讀得到自己的取消通知、調度員 A 讀得到司機通知、組織 B 都讀不到',
    Boolean(toRequester) && Boolean(toDriver)
      && idsIn(reqLoad2, 'notifications').includes(toRequester.id)
      && idsIn(dspLoad, 'notifications').includes(toDriver.id)
      && !idsIn(dspBLoad, 'notifications').some((x) => x === toDriver.id || x === toRequester.id));
  const drvA1Load = await loadAs(t.drvA1);
  const drvA2Load = await loadAs(t.drvA2);
  record(S, '被指派司機讀得到寫給自己的取消通知、讀不到寫給需求者的通知',
    Boolean(toDriver) && Boolean(toRequester)
      && idsIn(drvA1Load, 'notifications').includes(toDriver.id) && !idsIn(drvA1Load, 'notifications').includes(toRequester.id),
    `driver A1 notifications=${JSON.stringify(idsIn(drvA1Load, 'notifications'))}`);
  record(S, '同組織其他司機讀不到任何一則取消通知',
    !idsIn(drvA2Load, 'notifications').some((x) => ntfs.some((n) => n.id === x)));

  await expectRejected(S, '重複取消已取消的預約',
    cancelAs(t.req, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  record(S, '重複取消不會重複通知', (await notificationsFor(bookingId)).length === 2);

  // ---- 尚未承接的預約：沒有行程，只通知需求者
  const openId = 'BKG-FLOW-S3O';
  await bookingWriteAs(t.req, [{ collection: 'bookings', id: openId, record: openBooking(openId) }]);
  const openCancel = await cancelAs(t.req, { bookingId: openId, reasonCode: 'requester_no_longer_needed' });
  const openNtfs = await notificationsFor(openId);
  record(S, '取消尚未承接的預約：成功、只通知需求者',
    openCancel.status === 200 && openNtfs.length === 1 && openNtfs[0].data.template === 'booking_cancelled'
      && openCancel.data.cancelledTripIds.length === 0, outcome(openCancel));

  // ---- 同時送出兩次取消（重複點擊、兩個分頁）
  const cc = 'BKG-FLOW-S3CC';
  await bookingWriteAs(t.req, [{ collection: 'bookings', id: cc, record: openBooking(cc) }]);
  const pair = await Promise.all([
    cancelAs(t.req, { bookingId: cc, reasonCode: 'requester_no_longer_needed' }),
    cancelAs(t.req, { bookingId: cc, reasonCode: 'requester_no_longer_needed' })]);
  record(S, '同時送出兩次取消：恰好一次成功、另一次 400',
    JSON.stringify(pair.map((r) => r.status).sort()) === JSON.stringify([200, 400]), pair.map(outcome).join(' / '));
  record(S, '同時取消只排入一則通知', (await notificationsFor(cc)).length === 1);

  // ---- 交易中途失敗能完整回滾
  // 兩趟行程依 id 排序處理：-1 是 scheduled（會先被改成 cancelled），
  // -2 已經 in_progress（處理到它時丟錯）。整筆交易必須回滾，-1 不能殘留。
  const rb = 'BKG-FLOW-S3R';
  const rt1 = 'TRP-FLOW-S3R-1';
  const rt2 = 'TRP-FLOW-S3R-2';
  await bookingWriteAs(t.req, [{ collection: 'bookings', id: rb, record: openBooking(rb) }]);
  await fixtureScheduled(rb, rt1);
  const two = await mutateAs(t.dspA, [
    { collection: 'trips', id: rt1, record: scheduledTrip(rt1, DRIVER.a1, { bookingId: rb, bookingIds: [rb] }) },
    { collection: 'trips', id: rt2, record: scheduledTrip(rt2, DRIVER.a1, { bookingId: rb, bookingIds: [rb], status: 'in_progress' }) }
  ]);
  record(S, '回滾情境 fixture：一趟 scheduled、一趟 in_progress', two.status === 200, outcome(two));
  await expectRejected(S, '含已開始行程時取消（中途失敗）',
    cancelAs(t.req, { bookingId: rb, reasonCode: 'requester_no_longer_needed' }),
    { status: 400, code: 'VALIDATION_ERROR' }, [['bookings', rb], ['trips', rt1], ['trips', rt2]]);
  record(S, '中途失敗的取消沒有留下任何通知', (await notificationsFor(rb)).length === 0);

  // ---- 共乘：目前一律拒絕（產品決策待定，見 PR 描述），而且不影響同車其他人
  const p1 = 'BKG-FLOW-S3P1';
  const p2 = 'BKG-FLOW-S3P2';
  const pt = 'TRP-FLOW-S3P';
  await bookingWriteAs(t.req, [{ collection: 'bookings', id: p1, record: openBooking(p1) }]);
  await bookingWriteAs(t.req2, [{ collection: 'bookings', id: p2, record: openBooking(p2, U.req2) }]);
  await fixtureScheduled(p1, pt);
  await fixtureScheduled(p2, pt);
  const pooled = await mutateAs(t.dspA, [{ collection: 'trips', id: pt,
    record: scheduledTrip(pt, DRIVER.a1, { bookingIds: [p1, p2], isPooled: true }) }]);
  record(S, '共乘 fixture：一趟行程載兩筆預約', pooled.status === 200, outcome(pooled));
  await expectRejected(S, '[待產品決策] 需求者取消共乘中的一筆預約',
    cancelAs(t.req, { bookingId: p1, reasonCode: 'requester_no_longer_needed' }),
    { status: 400, code: 'VALIDATION_ERROR' }, [['bookings', p1], ['bookings', p2], ['trips', pt]]);
  record(S, '共乘取消被拒時沒有通知', (await notificationsFor(p1)).length === 0 && (await notificationsFor(p2)).length === 0);
}

// ================================================================ 情境 4
async function scenario4(t) {
  const S = '情境4 通知權限';
  const all = async () => (await admin.query(`select id, collection, organization_id, owner_user_id, deleted, data from app_state where collection = 'notifications' order by id`)).rows;
  const provenance = async (id) => (await admin.query(`select recipient_user_id from app.notification_provenance where notification_id = $1`, [id])).rows[0] || null;
  const legit = await notificationsFor('BKG-FLOW-S3');
  const toDriver = legit.find((n) => n.data.template === 'trip_cancelled');
  const legitProof = await Promise.all(legit.map((n) => provenance(n.id)));
  record(S, '（前提）兩則合法取消通知都有後端來源證明，證明上的收件人與通知一致',
    legit.length === 2 && legit.every((n, i) => legitProof[i] && legitProof[i].recipient_user_id === n.data.recipientId));
  const forged = (id, recipientId) => ({ id, organizationId: ORG_A, recipientId, channel: 'line', template: 'trip_cancelled',
    eventType: 'trip_cancelled', payload: { tripId: 'TRP-FLOW-S3', reason: '偽造內容' }, status: 'queued',
    source: 'cancel_booking_endpoint', serverCreated: true });

  // ---- 前端流程的通知照舊回存；沒有來源證明，收件人讀不到
  let n = 0;
  for (const [label, tok, owner, recipient] of [
    ['需求者寫給司機', t.req, U.req, U.drvA1], ['調度員 A 寫給組織內司機', t.dspA, U.dspA, U.drvA1],
    ['調度員 B 跨組織寫給組織 A 司機', t.dspB, U.dspB, U.drvA1], ['司機 A2 寫給司機 A1', t.drvA2, U.drvA2, U.drvA1]
  ]) {
    const id = `NTF-CLIENT-${++n}`;
    const r = await mutateAs(tok, [{ collection: 'notifications', id, record: forged(id, recipient) }]);
    const saved = await row('notifications', id);
    record(S, `${label}（自帶 serverCreated 與後端 source）：照舊回存`, r.status === 200 && Boolean(saved) && saved.owner_user_id === owner, outcome(r));
    record(S, `${label}：沒有來源證明、收件司機 A1 讀不到`,
      !(await provenance(id)) && !idsIn(await loadAs(t.drvA1), 'notifications').includes(id));
  }
  record(S, '寫入者本人仍讀得到自己寫的通知（與舊版相同）', idsIn(await loadAs(t.req), 'notifications').includes('NTF-CLIENT-1'));

  // ---- API：不能竄改系統通知
  for (const [label, tok, change] of [
    ['需求者（資料列擁有者）把系統通知收件人改成其他司機', t.req, { recipientId: U.drvA2 }],
    ['調度員 A（行程組織）把系統通知收件人改成其他司機', t.dspA, { recipientId: U.drvA2 }],
    ['需求者竄改系統通知內容', t.req, { payload: { reason: '竄改' } }]
  ]) {
    await expectRejected(S, `經 state-mutate ${label}`, mutateAs(tok, [{ collection: 'notifications', id: toDriver.id,
      record: { ...toDriver.data, ...change } }]), { status: 403, code: 'FORBIDDEN' }, [['notifications', toDriver.id]]);
  }
  await expectRejected(S, '經 state-mutate 需求者軟刪除系統通知', mutateAs(t.req, [{ collection: 'notifications', id: toDriver.id,
    deleted: true, record: toDriver.data }]), { status: 403, code: 'FORBIDDEN' }, [['notifications', toDriver.id]]);

  // ---- 資料庫層：以 care_ride_app 直接執行（模擬舊版或其他 handler 的寫入路徑）
  const asUser = (uid, sqls) => db.withUser(uid, async (c) => { let last; for (const [sql, params] of sqls) last = await c.query(sql, params); return last; })
    .then((res) => ({ ok: true, rowCount: res.rowCount }), (e) => ({ ok: false, code: e.code, message: e.message }));
  const state = async () => JSON.stringify([await all(), await row('bookings', 'BKG-FLOW-S3O'),
    (await admin.query('select * from app.notification_provenance order by notification_id')).rows]);

  const guc = await asUser(U.req, [
    [`select set_config('app.notification_writer', '1', true), set_config('app.state_scope_override', '1', true)`, []],
    [`insert into app_state (collection, id, data) values ('notifications', 'NTF-DB-GUC', $1::jsonb)`, [JSON.stringify(forged('NTF-DB-GUC', U.drvA1))]]]);
  record(S, '[資料庫層] care_ride_app 自設工作階段變數後寫入：沒有來源證明、收件司機讀不到',
    guc.ok && !(await provenance('NTF-DB-GUC')) && !idsIn(await loadAs(t.drvA1), 'notifications').includes('NTF-DB-GUC'), JSON.stringify(guc));

  for (const [label, sql, params] of [
    ['直接寫入來源證明表', `insert into app.notification_provenance (notification_id, source, booking_id, template, recipient_user_id) values ('NTF-CLIENT-1', 'cancel_booking_endpoint', 'BKG-FLOW-S3', 'trip_cancelled', $1)`, [U.drvA1]],
    ['直接讀取來源證明表', 'select * from app.notification_provenance', []],
    ['SET ROLE postgres', 'set role postgres', []],
    ['SET SESSION AUTHORIZATION postgres', 'set session authorization postgres', []]
  ]) {
    const before = await state();
    const r = await asUser(U.req, [[sql, params]]);
    record(S, `[資料庫層] care_ride_app ${label}：被拒絕`, !r.ok, JSON.stringify(r));
    record(S, `[資料庫層] care_ride_app ${label}：資料完全不變`, (await state()) === before);
  }

  for (const [label, uid, sql, params] of [
    ['需求者 UPDATE 系統通知收件人', U.req, `update app_state set data = jsonb_set(data, '{recipientId}', to_jsonb($1::text)) where collection = 'notifications' and id = $2`, [U.drvA2, toDriver.id]],
    ['調度員 A UPDATE 系統通知收件人', U.dspA, `update app_state set data = jsonb_set(data, '{recipientId}', to_jsonb($1::text)) where collection = 'notifications' and id = $2`, [U.drvA2, toDriver.id]],
    ['需求者把系統通知的 collection 改成 tripEvents', U.req, `update app_state set collection = 'tripEvents' where collection = 'notifications' and id = $1`, [toDriver.id]],
    ['需求者改系統通知的 id', U.req, `update app_state set id = 'NTF-RENAMED' where collection = 'notifications' and id = $1`, [toDriver.id]],
    ['需求者把自己的預約改成通知', U.req, `update app_state set collection = 'notifications' where collection = 'bookings' and id = $1`, ['BKG-FLOW-S3O']],
    ['需求者把自己寫的通知改成其他 id', U.req, `update app_state set id = 'NTF-CLIENT-1-RENAMED' where collection = 'notifications' and id = $1`, ['NTF-CLIENT-1']],
    ['需求者軟刪除系統通知', U.req, `update app_state set deleted = true where collection = 'notifications' and id = $1`, [toDriver.id]]
  ]) {
    const before = await state();
    const r = await asUser(uid, [[sql, params]]);
    record(S, `[資料庫層] ${label}：被拒絕`, !r.ok && r.code === '42501', JSON.stringify(r));
    record(S, `[資料庫層] ${label}：資料完全不變`, (await state()) === before);
  }
  // 實體 DELETE：沒有 DELETE 政策，RLS 下影響 0 列；以「0 列且資料不變」作為被擋的證據
  // （觸發器本身的 DELETE 分支在 migrations.test.sh 第 4 段以隔離情境另外驗證）
  for (const [label, uid] of [['需求者', U.req], ['調度員 A', U.dspA]]) {
    const before = await state();
    const r = await asUser(uid, [[`delete from app_state where collection = 'notifications' and id = $1`, [toDriver.id]]]);
    record(S, `[資料庫層] ${label}實體 DELETE 系統通知：影響 0 列且資料完全不變`,
      r.ok && r.rowCount === 0 && (await state()) === before, JSON.stringify(r));
  }

  const relabel = await asUser(U.req, [[`update app_state set data = data || '{"serverCreated": true, "source": "cancel_booking_endpoint"}'::jsonb where collection = 'notifications' and id = 'NTF-CLIENT-1'`, []]]);
  record(S, '[資料庫層] 需求者替自己寫的通知補上系統欄位：沒有來源證明、收件人讀不到',
    relabel.ok && !(await provenance('NTF-CLIENT-1')) && !idsIn(await loadAs(t.drvA1), 'notifications').includes('NTF-CLIENT-1'), JSON.stringify(relabel));

  // ---- 不以日期判斷：自帶系統欄位、created_at 在未來、以擁有者身分寫入但沒有來源證明
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.state_scope_override','1',true)`);
    await c.query(`insert into app_state (collection, id, data, created_at) values ('notifications', 'NTF-LEGACY-1', $1::jsonb, '2099-01-01')`,
      [JSON.stringify(forged('NTF-LEGACY-1', U.drvA2))]);
    await c.query(`update app_state set organization_id = $1 where collection = 'notifications' and id = 'NTF-LEGACY-1'`, [ORG_A]);
    await c.query('commit');
  } finally { c.release(); }
  record(S, '自帶 serverCreated、created_at 在未來、沒有來源證明的通知：收件司機 A2 讀不到',
    !idsIn(await loadAs(t.drvA2), 'notifications').includes('NTF-LEGACY-1'));

  const sees = async () => idsIn(await loadAs(t.drvA1), 'notifications').includes(toDriver.id);
  record(S, '合法取消通知：收件司機 A1 讀得到、其他司機 A2 讀不到',
    (await sees()) && !idsIn(await loadAs(t.drvA2), 'notifications').includes(toDriver.id));
  record(S, '所有嘗試後，合法取消通知仍兩則，收件人、刪除狀態、來源證明未變',
    JSON.stringify((await notificationsFor('BKG-FLOW-S3')).map((x) => [x.id, x.data.recipientId, x.deleted]))
      === JSON.stringify(legit.map((x) => [x.id, x.data.recipientId, x.deleted]))
      && JSON.stringify(await Promise.all(legit.map((x) => provenance(x.id)))) === JSON.stringify(legitProof));

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
  console.log('--- 情境 2B：重大異常擋住完成、中斷中的行程司機不能執行 ---');
  await scenario2b(t);
  console.log('--- 情境 3：需求者取消自己的已排車預約（含通知與共乘） ---');
  await scenario3(t);
  console.log('--- 情境 4：通知來源證明；前端通知照舊回存；系統通知不能偽造、竄改、刪除 ---');
  await scenario4(t);

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
