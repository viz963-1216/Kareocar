'use strict';
/**
 * 排車 command（v2-schedule-trips）整合測試。
 *
 * 經過實際的 handler（booking-write、claim-booking、state-mutate、schedule-trips），handler 以
 * care_ride_app 連線，RLS 全部生效。postgres 連線只用來建立身分 fixture 與讀取資料庫實際狀態。
 *
 * 重點是「一筆交易」：任何一趟、任何一段不合規則，行程、預約、事件、排車建議都不寫入。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_schedule_test') {
  throw Error('Requires dedicated local endpoint and careride_schedule_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_schedule_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_schedule_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-schedule-0123456789';
const fx = require('./_auth-fixture');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_schedule_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const scheduleFn = require('../../netlify/functions/v2-schedule-trips');

const ORG_A = 'ORG-SCH-A';
const ORG_B = 'ORG-SCH-B';
const U = { req: 'USR-SCH-REQ', dspA: 'USR-SCH-DSPA', dspB: 'USR-SCH-DSPB', drvA: 'USR-SCH-DRVA', drvB: 'USR-SCH-DRVB' };
const DRIVER_A = 'DRV-SCH-A';
const DRIVER_B = 'DRV-SCH-B';
const VEH_A = 'VEH-SCH-A';
const VEH_B = 'VEH-SCH-B';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
async function call(handler, userId, body) {
  const res = await handler({
    httpMethod: 'POST',
    headers: { host: '127.0.0.1', cookie: `cr_at=${fx.mintAccessToken(userId)}` },
    body: JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const outcome = (r) => `${r.status} ${r.error ? `${r.error.code} ${r.error.message}` : 'ok'}`;
const row = async (collection, id) => (await admin.query(
  'select organization_id, data, version from app_state where collection = $1 and id = $2', [collection, id])).rows[0];
const count = async (collection, where, params) => Number((await admin.query(
  `select count(*)::int as n from app_state where collection = $1 and ${where}`, [collection, ...params])).rows[0].n);
const notifications = async (bookingId) => Number((await admin.query(
  `select count(*)::int as n from notifications where booking_id = $1 and template = 'booking_scheduled'`, [bookingId])).rows[0].n);

function leg(bookingId, direction, sequence, at) {
  return { id: `${bookingId}_${direction}`, schemaVersion: 1, sequence, direction, label: direction === 'return' ? '回程' : '去程',
    status: 'pending', requestedPickupAt: at, pickup: null, dropoff: null, tripId: null, scheduledOrganizationId: null, scheduledAt: null };
}
function booking(id, { roundTrip = false } = {}) {
  const legs = [leg(id, 'outbound', 1, '2099-01-01T01:00:00.000Z')];
  if (roundTrip) legs.push(leg(id, 'return', 2, '2099-01-01T05:00:00.000Z'));
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00', pickupAddress: '新北市板橋區文化路一段188號', destination: '臺北市中正區公園路20號',
    tripType: roundTrip ? '來回' : '單程', returnDate: roundTrip ? '2099-01-01' : '', returnTime: roundTrip ? '13:00' : '',
    passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true, legs
  };
}
async function claimedBooking(id, opts) {
  const c = await call(bookingWriteFn.handler, U.req, { changes: [{ collection: 'bookings', id, record: booking(id, opts) }] });
  const k = await call(claimFn.handler, U.dspA, { bookingId: id, organizationId: ORG_A });
  if (c.status !== 200 || k.status !== 200) throw Error(`準備預約 ${id} 失敗：${outcome(c)} / ${outcome(k)}`);
}
function trip(id, refs, extra = {}) {
  const ids = [...new Set(refs.map((r) => r.bookingId))];
  return F.makeTrip({ id, organizationId: ORG_A, driverId: DRIVER_A, vehicleId: VEH_A, bookingId: ids[0] || null,
    startAt: '2099-01-01T01:00:00.000Z', extra: { bookingIds: ids, bookingLegRefs: refs, ...extra } });
}
const schedule = (userId, body) => call(scheduleFn.handler, userId, body);

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values
      ('${ORG_A}','transport_provider','合成承運 A',true),
      ('${ORG_B}','transport_provider','合成承運 B',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886955000001','none',true),
      ('${U.dspA}','合成調度 A','+886955000002','none',true),
      ('${U.dspB}','合成調度 B','+886955000003','none',true),
      ('${U.drvA}','合成司機 A','+886955000004','none',true),
      ('${U.drvB}','合成司機 B','+886955000005','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-SCH-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-SCH-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-SCH-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-SCH-DRVA','${U.drvA}','${ORG_A}','driver','active'),
      ('M-SCH-DRVB','${U.drvB}','${ORG_B}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER_A}','${U.drvA}','${ORG_A}','on_duty',true),
      ('${DRIVER_B}','${U.drvB}','${ORG_B}','on_duty',true);
  `);
  await call(mutateFn.handler, U.dspA, { changes: [{ collection: 'vehicles', id: VEH_A, record: { id: VEH_A, organizationId: ORG_A, plate: 'A-0001' } }] });
  await call(mutateFn.handler, U.dspB, { changes: [{ collection: 'vehicles', id: VEH_B, record: { id: VEH_B, organizationId: ORG_B, plate: 'B-0001' } }] });

  console.log('--- 從預約建立行程 ---');
  await claimedBooking('BKG-SCH-1');
  const row1 = await row('bookings', 'BKG-SCH-1');
  const before1 = row1.data;
  // 前端拿到的版本是資料列的 version（state-load 用它覆蓋）
  const ok1 = await schedule(U.dspA, { trips: [trip('TRP-SCH-1', [{ bookingId: 'BKG-SCH-1', legId: 'BKG-SCH-1_outbound' }])],
    expectedVersions: { 'BKG-SCH-1': row1.version } });
  const after1 = await row('bookings', 'BKG-SCH-1');
  const b1 = after1.data;
  record('排車成功：預約變成已排車、這一段記下行程', ok1.status === 200 && b1.state === 'scheduled'
    && b1.legs[0].status === 'scheduled' && b1.legs[0].tripId === 'TRP-SCH-1' && b1.tripId === 'TRP-SCH-1', outcome(ok1));
  record('預約版本 +1', after1.version === row1.version + 1, `${row1.version} → ${after1.version}`);
  record('行程寫入且屬於機構 A', (await row('trips', 'TRP-SCH-1'))?.organization_id === ORG_A);
  record('伺服器產生預約事件 leg_scheduled', await count('bookingEvents', `booking_id = $2 and data->>'eventType' = 'leg_scheduled'`, ['BKG-SCH-1']) === 1);
  record('伺服器產生行程事件 trip_created', await count('tripEvents', `trip_id = $2 and data->>'eventType' = 'trip_created'`, ['TRP-SCH-1']) === 1);
  record('通知需求者已排車', await notifications('BKG-SCH-1') === 1);

  const again = await schedule(U.dspA, { trips: [trip('TRP-SCH-1B', [{ bookingId: 'BKG-SCH-1', legId: 'BKG-SCH-1_outbound' }])] });
  record('已排車的一段不能再排', again.status === 409 && !(await row('trips', 'TRP-SCH-1B')), outcome(again));

  console.log('--- 一筆交易：任何一趟不合規則就全部不寫入 ---');
  await claimedBooking('BKG-SCH-2');
  await claimedBooking('BKG-SCH-3');
  const row2 = await row('bookings', 'BKG-SCH-2');
  const before2 = row2.data;
  const bad = await schedule(U.dspA, { trips: [
    trip('TRP-SCH-2', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }]),
    trip('TRP-SCH-3', [{ bookingId: 'BKG-SCH-3', legId: 'BKG-SCH-3_outbound' }], { driverId: DRIVER_B })
  ] });
  const row2after = await row('bookings', 'BKG-SCH-2');
  const after2 = row2after.data;
  record('第二趟用了別家司機：整批被拒', bad.status >= 400 && bad.status < 500, outcome(bad));
  record('第一趟的行程也沒有寫入', !(await row('trips', 'TRP-SCH-2')));
  record('第一趟的預約維持已承接、版本不變', after2.state === 'claimed' && row2after.version === row2.version && after2.legs[0].status === 'pending');
  record('沒有留下任何事件', await count('bookingEvents', `booking_id = any($2)`, [['BKG-SCH-2', 'BKG-SCH-3']]) === 0
    && await count('tripEvents', `trip_id = any($2)`, [['TRP-SCH-2', 'TRP-SCH-3']]) === 0);

  const stale = await schedule(U.dspA, { trips: [trip('TRP-SCH-2', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }])],
    expectedVersions: { 'BKG-SCH-2': row2.version - 1 } });
  record('預約版本和畫面上的不同：拒絕，請重新整理', stale.status === 409 && stale.error.code === 'BOOKING_CONFLICT'
    && !(await row('trips', 'TRP-SCH-2')), outcome(stale));

  const dup = await schedule(U.dspA, { trips: [
    trip('TRP-SCH-4', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }]),
    trip('TRP-SCH-5', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }])
  ] });
  record('同一段排進兩趟：拒絕', dup.status === 400, outcome(dup));

  const mismatch = await schedule(U.dspA, { trips: [trip('TRP-SCH-6', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }], { bookingIds: ['BKG-SCH-3'] })] });
  record('行程的預約清單與排進來的段不一致：拒絕', mismatch.status === 400, outcome(mismatch));

  console.log('--- 權限 ---');
  const other = await schedule(U.dspB, { trips: [F.makeTrip({ id: 'TRP-SCH-7', organizationId: ORG_B, driverId: DRIVER_B, vehicleId: VEH_B,
    bookingId: 'BKG-SCH-2', startAt: '2099-01-01T01:00:00.000Z', extra: { bookingLegRefs: [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }] } })] });
  record('別家機構不能排 A 的預約', other.status === 403 || other.status === 404, outcome(other));
  const requester = await schedule(U.req, { trips: [trip('TRP-SCH-8', [{ bookingId: 'BKG-SCH-2', legId: 'BKG-SCH-2_outbound' }])] });
  record('需求者不能排車', requester.status === 403 || requester.status === 404, outcome(requester));

  console.log('--- 來回：先排去程是部分排車，再排回程是全部排車 ---');
  await claimedBooking('BKG-SCH-RT', { roundTrip: true });
  const out = await schedule(U.dspA, { trips: [trip('TRP-SCH-RT1', [{ bookingId: 'BKG-SCH-RT', legId: 'BKG-SCH-RT_outbound' }])] });
  const rt1 = (await row('bookings', 'BKG-SCH-RT')).data;
  record('只排去程：部分已排車', out.status === 200 && rt1.state === 'partially_scheduled', outcome(out));
  const back = await schedule(U.dspA, { trips: [trip('TRP-SCH-RT2', [{ bookingId: 'BKG-SCH-RT', legId: 'BKG-SCH-RT_return' }])] });
  const rt2 = (await row('bookings', 'BKG-SCH-RT')).data;
  record('再排回程：全部已排車，通知只發一次', back.status === 200 && rt2.state === 'scheduled'
    && await notifications('BKG-SCH-RT') === 1, outcome(back));

  console.log('--- 套用自動排車建議（共乘一趟） ---');
  await claimedBooking('BKG-SCH-P1');
  await claimedBooking('BKG-SCH-P2');
  const planRecord = { id: 'PLAN-SCH-1', organizationId: ORG_A, status: 'confirmed', items: [] };
  await call(mutateFn.handler, U.dspA, { changes: [{ collection: 'dispatchPlans', id: 'PLAN-SCH-1', record: planRecord }] });
  const pooled = trip('TRP-SCH-P', [{ bookingId: 'BKG-SCH-P1', legId: 'BKG-SCH-P1_outbound' }, { bookingId: 'BKG-SCH-P2', legId: 'BKG-SCH-P2_outbound' }], { isPooled: true });
  const applied = await schedule(U.dspA, { trips: [pooled], dispatchPlanId: 'PLAN-SCH-1' });
  const plan = (await row('dispatchPlans', 'PLAN-SCH-1')).data;
  record('共乘一趟兩筆預約都排進去', applied.status === 200
    && (await row('bookings', 'BKG-SCH-P1')).data.state === 'scheduled' && (await row('bookings', 'BKG-SCH-P2')).data.state === 'scheduled', outcome(applied));
  record('排車建議標成已套用', plan.status === 'applied' && JSON.stringify(plan.appliedTripIds) === '["TRP-SCH-P"]', JSON.stringify(plan.status));
  const reapply = await schedule(U.dspA, { trips: [trip('TRP-SCH-P9', [])], dispatchPlanId: 'PLAN-SCH-1' });
  record('同一個建議不能套用兩次', reapply.status === 409 && !(await row('trips', 'TRP-SCH-P9')), outcome(reapply));

  console.log('--- 沒有預約的手動行程 ---');
  const manual = await schedule(U.dspA, { trips: [trip('TRP-SCH-M', [])] });
  record('手動行程也走同一個 command', manual.status === 200 && Boolean(await row('trips', 'TRP-SCH-M')), outcome(manual));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
