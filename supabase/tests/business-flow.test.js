'use strict';
/**
 * 業務權限整合測試：接案、司機執行、需求者取消。
 *
 * 所有斷言都經過實際的 netlify/functions handler（state-load、state-mutate、
 * claim-booking、trip-execute、cancel-booking），handler 以 care_ride_app 連線，
 * RLS、app_state_force_scope 觸發器與 0008 的 security definer 函式全部生效。
 * 不用 postgres 連線、也不直接呼叫 SQL 函式來代替 API 驗證。
 *
 * postgres 連線只用在：
 *   1. 建立身分 fixture（users / memberships / drivers / organizations）
 *   2. 讀取資料庫實際狀態，當作「有沒有真的寫進去／有沒有被改掉」的判準
 *   3. 情境 3 的狀態 fixture（把預約設為已承接並排車），理由寫在該段
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
process.env.AUTH_PBKDF2_ITERATIONS = '1000';

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_flow_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const auth = require('../../netlify/functions/_auth-pg');
const load = require('../../netlify/functions/v2-state-load');
const mutate = require('../../netlify/functions/v2-state-mutate');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const executeFn = require('../../netlify/functions/v2-trip-execute');
const cancelFn = require('../../netlify/functions/v2-cancel-booking');

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
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const loadAs = (token) => call(load.handler, 'GET', token);
const mutateAs = (token, changes) => call(mutate.handler, 'POST', token, { changes });
const claimAs = (token, bookingId, organizationId) =>
  call(claimFn.handler, 'POST', token, { bookingId, organizationId });
const executeAs = (token, body) => call(executeFn.handler, 'POST', token, body);
const cancelAs = (token, body) => call(cancelFn.handler, 'POST', token, body);

const outcome = (r) => `HTTP ${r.status}${r.error ? ` ${r.error.code}` : ''}`;
const idsIn = (r, collection) => ((r.data && r.data.collections && r.data.collections[collection]) || []).map((x) => x.id);

async function row(collection, id) {
  const { rows } = await admin.query(
    `select organization_id, owner_user_id, deleted, version, revision, data
       from app_state where collection = $1 and id = $2`, [collection, id]);
  return rows[0] || null;
}
const snapshot = async (collection, id) => JSON.stringify(await row(collection, id));

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

const token = (userId) => db.withoutUser((c) => auth.issueSessionToken(c, userId));

function openBooking(id) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: SECRET_ADDRESS, destination: '台北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    aidNeed: '無', companions: '1', specialNeed: '合成特殊需求自由文字'
  };
}
function scheduledTrip(id, driverId, extra = {}) {
  return {
    id, organizationId: ORG_A, driverId, vehicleId: 'VEH-FLOW-A1',
    status: 'scheduled', date: '2099-01-01', code: `CR-${id}`,
    passengerSummary: '合成乘客', pickupAddress: SECRET_ADDRESS,
    dropoffAddress: '台北市中正區公園路20號', currentStepIndex: 0,
    steps: [
      { id: `${id}_depart`, type: 'depart', status: 'pending' },
      { id: `${id}_pickup`, type: 'pickup', status: 'pending', contacts: [{ name: '合成乘客', phone: '0911000001' }] },
      { id: `${id}_dropoff`, type: 'dropoff', status: 'pending' }
    ],
    ...extra
  };
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

  const created = await mutateAs(t.req, [{ collection: 'bookings', id, record: openBooking(id) }]);
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
  await expectRejected(S, '[安全] 透過 state-mutate 接案', mutateAs(t.dspA, [{
    collection: 'bookings', id,
    record: { ...openBooking(id), state: 'claimed', claimStatus: 'claimed', status: 'claimed',
              organizationId: ORG_A, claimedByUserId: U.dspA, version: 2 }
  }]), { status: 403, code: 'FORBIDDEN' }, [['bookings', id]]);

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
  await mutateAs(t.req, [{ collection: 'bookings', id: cid, record: openBooking(cid) }]);
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

  const created = await mutateAs(t.dspA, [
    { collection: 'trips', id, record: scheduledTrip(id, DRIVER.a1) },
    { collection: 'trips', id: other, record: scheduledTrip(other, DRIVER.a2) }
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

  const rev0 = createdRow ? createdRow.revision : 0;
  const watched = [['trips', id]];

  // #6 原本的寫法：司機透過一般寫入管道改行程。修正後這條路仍必須被拒。
  await expectRejected(S, '[安全] 司機 A1 透過 state-mutate 直接改行程', mutateAs(t.drvA1, [{
    collection: 'trips', id, expectedRevision: rev0,
    record: scheduledTrip(id, DRIVER.a1, { status: 'in_progress' })
  }]), { status: 403, code: 'FORBIDDEN' }, watched);

  // ---- 非法狀態轉換與欄位
  await expectRejected(S, '尚未開始就完成行程', executeAs(t.drvA1, { tripId: id, action: 'complete', expectedRevision: rev0 }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, 'revision 過期', executeAs(t.drvA1, { tripId: id, action: 'start', expectedRevision: rev0 + 5 }),
    { status: 409, code: 'TRIP_CONFLICT' }, watched);
  for (const [label, payload] of [
    ['改組織', { organizationId: ORG_B }], ['改指派司機', { driverId: DRIVER.a2 }],
    ['改車輛', { vehicleId: 'VEH-OTHER' }], ['改任意欄位', { passengerSummary: '竄改' }]
  ]) {
    await expectRejected(S, `透過執行端點${label}`, executeAs(t.drvA1, { tripId: id, action: 'start', expectedRevision: rev0, payload }),
      { status: 400, code: 'VALIDATION_ERROR' }, watched);
  }
  await expectRejected(S, '不支援的動作（reassign）', executeAs(t.drvA1, { tripId: id, action: 'reassign', expectedRevision: rev0 }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);

  // ---- 非指派司機與他組織
  for (const [label, tok] of [['同組織其他司機 A2', t.drvA2], ['其他組織司機 B1', t.drvB1], ['其他組織調度員 B', t.dspB]]) {
    const l = await loadAs(tok);
    record(S, `${label} 讀不到此行程且無門牌洩露`,
      l.status === 200 && !idsIn(l, 'trips').includes(id) && !JSON.stringify(l.data.collections || {}).includes('188號'),
      outcome(l));
    await expectRejected(S, `${label} 呼叫執行端點`, executeAs(tok, { tripId: id, action: 'start', expectedRevision: rev0 }),
      { status: 403, code: 'FORBIDDEN' }, watched);
    await expectRejected(S, `${label} 透過 state-mutate 改行程`, mutateAs(tok, [{
      collection: 'trips', id, expectedRevision: rev0, record: scheduledTrip(id, DRIVER.a1, { status: 'cancelled' })
    }]), { status: 403, code: 'FORBIDDEN' }, watched);
  }

  // ---- 合法流程
  const start = await executeAs(t.drvA1, { tripId: id, action: 'start', expectedRevision: rev0 });
  const afterStart = await row('trips', id);
  record(S, '被指派司機 A1 開始執行（HTTP 200）', start.status === 200, outcome(start));
  record(S, '開始後狀態 = in_progress，revision +1，組織／司機／車輛未變',
    Boolean(afterStart) && afterStart.data.status === 'in_progress' && afterStart.revision === rev0 + 1
      && afterStart.organization_id === ORG_A && afterStart.data.driverId === DRIVER.a1
      && afterStart.data.vehicleId === 'VEH-FLOW-A1',
    afterStart ? `status=${afterStart.data.status} revision=${afterStart.revision}` : '');

  let rev = afterStart ? afterStart.revision : 0;
  await expectRejected(S, '重複開始（in_progress → in_progress）', executeAs(t.drvA1, { tripId: id, action: 'start', expectedRevision: rev }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, '跳站處理（先完成 pickup）', executeAs(t.drvA1, {
    tripId: id, action: 'step', expectedRevision: rev, payload: { stepId: `${id}_pickup`, milestone: 'completed' }
  }), { status: 400, code: 'VALIDATION_ERROR' }, watched);
  await expectRejected(S, '停靠點未完成就完成行程', executeAs(t.drvA1, { tripId: id, action: 'complete', expectedRevision: rev }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);

  let stepsOk = true;
  for (const suffix of ['depart', 'pickup', 'dropoff']) {
    const r = await executeAs(t.drvA1, {
      tripId: id, action: 'step', expectedRevision: rev, payload: { stepId: `${id}_${suffix}`, milestone: 'completed' }
    });
    if (r.status !== 200) { stepsOk = false; console.log(`      step ${suffix}: ${outcome(r)}`); break; }
    rev = r.data.revision;
  }
  const afterSteps = await row('trips', id);
  record(S, '依序完成三個停靠點', stepsOk && Boolean(afterSteps)
    && afterSteps.data.steps.every((s) => s.status === 'completed') && afterSteps.data.currentStepIndex === 3);

  const proof = await executeAs(t.drvA1, {
    tripId: id, action: 'proof', expectedRevision: rev,
    payload: { stepId: `${id}_dropoff`, receiverName: '合成收受人', receiverRole: 'family' }
  });
  const afterProof = await row('trips', id);
  record(S, '建立服務證明（HTTP 200）', proof.status === 200
    && Boolean(afterProof) && Array.isArray(afterProof.data.serviceProofs) && afterProof.data.serviceProofs.length === 1,
    outcome(proof));
  rev = proof.status === 200 ? proof.data.revision : rev;

  const done = await executeAs(t.drvA1, { tripId: id, action: 'complete', expectedRevision: rev });
  const afterDone = await row('trips', id);
  record(S, '被指派司機 A1 完成行程（HTTP 200）', done.status === 200, outcome(done));
  record(S, '完成後狀態 = completed，指派仍保留',
    Boolean(afterDone) && afterDone.data.status === 'completed' && afterDone.data.driverId === DRIVER.a1
      && afterDone.data.vehicleId === 'VEH-FLOW-A1', afterDone ? `status=${afterDone.data.status}` : '');

  await expectRejected(S, '完成後再中斷（completed → interrupted）', executeAs(t.drvA1, {
    tripId: id, action: 'interrupt', expectedRevision: afterDone ? afterDone.revision : 0, payload: { reason: '測試' }
  }), { status: 400, code: 'VALIDATION_ERROR' }, watched);
}

// ================================================================ 情境 3
async function scenario3(t) {
  const S = '情境3 需求者取消已排車預約';
  const bookingId = 'BKG-FLOW-S3';
  const tripId = 'TRP-FLOW-S3';

  const created = await mutateAs(t.req, [{ collection: 'bookings', id: bookingId, record: openBooking(bookingId) }]);
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
  ]), { status: 403, code: 'FORBIDDEN' }, watched);

  await expectRejected(S, '其他需求者取消此預約',
    cancelAs(t.req2, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 403, code: 'FORBIDDEN' }, watched);
  await expectRejected(S, '調度員透過需求者取消端點取消',
    cancelAs(t.dspA, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 403, code: 'FORBIDDEN' }, watched);
  await expectRejected(S, '缺少取消原因', cancelAs(t.req, { bookingId }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);

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

  await expectRejected(S, '重複取消已取消的預約',
    cancelAs(t.req, { bookingId, reasonCode: 'requester_no_longer_needed' }),
    { status: 400, code: 'VALIDATION_ERROR' }, watched);

  // ---- 交易中途失敗能完整回滾
  // 兩趟行程依 id 排序處理：-1 是 scheduled（會先被改成 cancelled），
  // -2 已經 in_progress（處理到它時丟錯）。整筆交易必須回滾，-1 不能殘留。
  const rb = 'BKG-FLOW-S3R';
  const rt1 = 'TRP-FLOW-S3R-1';
  const rt2 = 'TRP-FLOW-S3R-2';
  await mutateAs(t.req, [{ collection: 'bookings', id: rb, record: openBooking(rb) }]);
  await fixtureScheduled(rb, rt1);
  const two = await mutateAs(t.dspA, [
    { collection: 'trips', id: rt1, record: scheduledTrip(rt1, DRIVER.a1, { bookingId: rb, bookingIds: [rb] }) },
    { collection: 'trips', id: rt2, record: scheduledTrip(rt2, DRIVER.a1, { bookingId: rb, bookingIds: [rb], status: 'in_progress' }) }
  ]);
  record(S, '回滾情境 fixture：一趟 scheduled、一趟 in_progress', two.status === 200, outcome(two));
  await expectRejected(S, '含已開始行程時取消（中途失敗）',
    cancelAs(t.req, { bookingId: rb, reasonCode: 'requester_no_longer_needed' }),
    { status: 400, code: 'VALIDATION_ERROR' }, [['bookings', rb], ['trips', rt1], ['trips', rt2]]);
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
