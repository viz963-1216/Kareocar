'use strict';
/**
 * 通知只能由後端建立（#25）的整合測試。
 *
 * 走完整條流程：需求者建立預約 → 調度接案 → 排車 → 指派司機 → 改派 → 司機執行到完成，
 * 檢查每一步由伺服器產生的通知、收件人、重試不重複，以及收件人只讀得到自己的通知。
 * 取消的通知與偽造／竄改的拒絕在 business-flow 的情境 3、4。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_notify_test') {
  throw Error('Requires dedicated local endpoint and careride_notify_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_notify_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_notify_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-notify-0123456789';
const fx = require('./_auth-fixture');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_notify_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const tripWriteFn = require('../../netlify/functions/v2-trip-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const executeFn = require('../../netlify/functions/v2-trip-execute');
const loadFn = require('../../netlify/functions/v2-state-load');

const ORG = 'ORG-NTF-A';
const U = { req: 'USR-NTF-REQ', dsp: 'USR-NTF-DSP', d1: 'USR-NTF-D1', d2: 'USR-NTF-D2' };
const DRV = { d1: 'DRV-NTF-1', d2: 'DRV-NTF-2' };
const BOOKING = 'BKG-NTF-1';
const TRIP = 'TRP-NTF-1';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
async function call(handler, method, userId, body) {
  const res = await handler({
    httpMethod: method,
    headers: userId ? { host: '127.0.0.1', cookie: `cr_at=${fx.mintAccessToken(userId)}` } : { host: '127.0.0.1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const outcome = (r) => `${r.status} ${r.error ? `${r.error.code} ${r.error.message}` : 'ok'}`;
const nowIso = () => new Date().toISOString();
const ntfs = async (where = 'true', params = []) => (await admin.query(
  `select id, recipient_user_id, template, organization_id, booking_id, trip_id, payload, status, source
     from notifications where ${where} order by created_at, id`, params)).rows;
const templatesFor = async (userId) => (await ntfs('recipient_user_id = $1', [userId])).map((n) => n.template);
const loadIds = async (userId) => (((await call(loadFn.handler, 'GET', userId)).data || {}).collections || {}).notifications || [];
async function tripState() {
  const r = (await admin.query(`select data, organization_id, revision from app_state where collection = 'trips' and id = $1`, [TRIP])).rows[0];
  return { ...r.data, organizationId: r.organization_id, revision: r.revision };
}
const bookingData = async () => (await admin.query(`select data from app_state where collection = 'bookings' and id = $1`, [BOOKING])).rows[0].data;
const execute = (userId, request) => call(executeFn.handler, 'POST', userId, request);

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values ('${ORG}','transport_provider','合成通知交通',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886955000001','none',true),
      ('${U.dsp}','合成調度','+886955000002','none',true),
      ('${U.d1}','合成司機一','+886955000003','none',true),
      ('${U.d2}','合成司機二','+886955000004','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-NTF-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-NTF-DSP','${U.dsp}','${ORG}','dispatcher','active'),
      ('M-NTF-D1','${U.d1}','${ORG}','driver','active'),
      ('M-NTF-D2','${U.d2}','${ORG}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRV.d1}','${U.d1}','${ORG}','on_duty',true),
      ('${DRV.d2}','${U.d2}','${ORG}','on_duty',true);
  `);

  console.log('--- 建立預約不產生通知 ---');
  const created = await call(bookingWriteFn.handler, 'POST', U.req, { changes: [{ collection: 'bookings', id: BOOKING, record: {
    id: BOOKING, state: 'open', claimStatus: 'open', status: 'open', requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00', pickupAddress: '新北市板橋區文化路一段188號', destination: '臺北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true } }] });
  record('需求者建立預約', created.status === 200, outcome(created));
  record('建立預約時沒有任何通知', (await ntfs()).length === 0);

  console.log('--- 承接 ---');
  const claim = await call(claimFn.handler, 'POST', U.dsp, { bookingId: BOOKING, organizationId: ORG });
  const claimed = (await ntfs(`template = 'booking_claimed'`))[0];
  record('接案後通知需求者：booking_claimed，帶承接單位名稱', claim.status === 200 && claimed
    && claimed.recipient_user_id === U.req && claimed.booking_id === BOOKING && claimed.payload.organizationName === '合成通知交通'
    && claimed.payload.pickupDate === '2099-01-01' && claimed.source === 'claim_booking_endpoint', outcome(claim));

  console.log('--- 排車與指派司機 ---');
  const scheduled = await call(bookingWriteFn.handler, 'POST', U.dsp, { changes: [{ collection: 'bookings', id: BOOKING,
    record: { ...(await bookingData()), state: 'scheduled', status: 'scheduled', tripId: TRIP } }] });
  const sched = await ntfs(`template = 'booking_scheduled'`);
  record('排車後通知需求者：booking_scheduled', scheduled.status === 200 && sched.length === 1
    && sched[0].recipient_user_id === U.req && sched[0].payload.tripId === TRIP, outcome(scheduled));
  const again = await call(bookingWriteFn.handler, 'POST', U.dsp, { changes: [{ collection: 'bookings', id: BOOKING,
    record: { ...(await bookingData()), note: '合成備註' } }] });
  record('已排車的預約再修改不重複通知', again.status === 200 && (await ntfs(`template = 'booking_scheduled'`)).length === 1, outcome(again));

  const trip = F.makeTrip({ id: TRIP, organizationId: ORG, driverId: DRV.d1, vehicleId: 'VEH-NTF-1', bookingId: BOOKING,
    startAt: F.addMinutes(nowIso(), 10), extra: { bookingIds: [BOOKING] } });
  const tripCreated = await call(tripWriteFn.handler, 'POST', U.dsp, { changes: [{ collection: 'trips', id: TRIP, record: trip }] });
  record('建立行程後通知被指派的司機一：trip_assigned', tripCreated.status === 200
    && JSON.stringify(await templatesFor(U.d1)) === JSON.stringify(['trip_assigned']), outcome(tripCreated));
  const reassign = await call(tripWriteFn.handler, 'POST', U.dsp, { changes: [{ collection: 'trips', id: TRIP, expectedRevision: 1,
    record: { ...(await tripState()), driverId: DRV.d2 } }] });
  record('改派給司機二：司機一收到 trip_unassigned、司機二收到 trip_assigned', reassign.status === 200
    && JSON.stringify(await templatesFor(U.d1)) === JSON.stringify(['trip_assigned', 'trip_unassigned'])
    && JSON.stringify(await templatesFor(U.d2)) === JSON.stringify(['trip_assigned']), outcome(reassign));
  const sameDriver = await call(tripWriteFn.handler, 'POST', U.dsp, { changes: [{ collection: 'trips', id: TRIP, expectedRevision: 2,
    record: { ...(await tripState()), needs: '合成需求更新' } }] });
  record('沒換司機的修改不產生通知', sameDriver.status === 200 && (await templatesFor(U.d2)).length === 1, outcome(sameDriver));

  console.log('--- 司機執行到完成 ---');
  for (let i = 0; i < 3; i++) {
    const step = F.completeStep(await tripState(), U.d2, nowIso());
    const r = await execute(U.d2, step.request);
    record(`司機二完成第 ${i + 1} 站`, r.status === 200, outcome(r));
  }
  record('送達但還沒補服務證明：還沒有完成通知', (await ntfs(`template = 'trip_completed'`)).length === 0);
  const proof = F.addProof(await tripState(), U.d2, nowIso());
  const done = await execute(U.d2, proof.request);
  const completed = await ntfs(`template = 'trip_completed'`);
  record('行程完成後通知需求者：trip_completed', done.status === 200 && done.data.status === 'completed' && completed.length === 1
    && completed[0].recipient_user_id === U.req && completed[0].booking_id === BOOKING && completed[0].payload.tripId === TRIP, outcome(done));
  const replay = await execute(U.d2, proof.request);
  record('重送同一個完成操作不重複通知', replay.status === 200 && (await ntfs(`template = 'trip_completed'`)).length === 1, outcome(replay));

  console.log('--- 收件人只讀得到自己的通知 ---');
  const reqSees = (await loadIds(U.req)).map((n) => n.template).sort();
  record('需求者讀到承接、排車、完成三則，都是自己的', JSON.stringify(reqSees) === JSON.stringify(['booking_claimed', 'booking_scheduled', 'trip_completed'])
    && (await loadIds(U.req)).every((n) => n.recipientUserId === U.req), JSON.stringify(reqSees));
  const d1Sees = (await loadIds(U.d1)).map((n) => n.template).sort();
  record('司機一只讀到自己的指派與改派通知', JSON.stringify(d1Sees) === JSON.stringify(['trip_assigned', 'trip_unassigned']), JSON.stringify(d1Sees));
  record('調度員讀不到任何一則（不是收件人）', (await loadIds(U.dsp)).length === 0);
  const all = await ntfs();
  record('總共六則：承接、排車、司機一指派與改派、司機二指派、完成；都由伺服器產生', all.length === 6
    && all.every((n) => n.source && n.status === 'queued'), `count=${all.length}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
