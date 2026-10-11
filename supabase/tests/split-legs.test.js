'use strict';
/**
 * 跨機構排車（#108、ADR 0004）的整合測試：來回預約的一段退回需求池、收回（#112）。
 *
 * 經過實際的 handler（booking-write、claim-booking、booking-leg、schedule-trips、state-load），
 * handler 以 care_ride_app 連線，RLS 全部生效。postgres 連線只用來建立身分 fixture 與讀取資料庫實際狀態。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_split_test') {
  throw Error('Requires dedicated local endpoint and careride_split_test database');
}
process.env.DATABASE_URL = `postgresql://care_ride_app@${isSocket ? encodeURIComponent(host) : host}:${process.env.PGPORT}/careride_split_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-split-0123456789';
const fx = require('./_auth-fixture');
const { selectRow } = require('./_state-tables');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_split_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const legFn = require('../../netlify/functions/v2-booking-leg');
const scheduleFn = require('../../netlify/functions/v2-schedule-trips');
const loadFn = require('../../netlify/functions/v2-state-load');

const ORG_A = 'ORG-SPL-A';
const ORG_B = 'ORG-SPL-B';
const U = { req: 'USR-SPL-REQ', dspA: 'USR-SPL-DSPA', dspB: 'USR-SPL-DSPB', drvA: 'USR-SPL-DRVA' };
const DRIVER_A = 'DRV-SPL-A';
const HOME = '新北市板橋區文化路一段188號';
const CLINIC = '臺北市中正區公園路20號';

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
const writeBooking = (userId, rec) => call(bookingWriteFn.handler, 'POST', userId, { changes: [{ collection: 'bookings', id: rec.id, record: rec }] });
const claim = (userId, bookingId, organizationId) => call(claimFn.handler, 'POST', userId, { bookingId, organizationId });
const leg = (userId, action, bookingId, legId) => call(legFn.handler, 'POST', userId, { action, bookingId, legId });
const load = (userId) => call(loadFn.handler, 'GET', userId);
const row = async (collection, id) => selectRow(admin, collection, id, ['organization_id', 'data']);
const legOf = async (bookingId, direction) => ((await row('bookings', bookingId)).data.legs || []).find((l) => l.direction === direction);
const poolRows = (loaded, bookingId) => ((loaded.data && loaded.data.pool) || []).filter((r) => r.id === bookingId);
const sees = (loaded, collection, id) => ((loaded.data && loaded.data.collections[collection]) || []).some((r) => r.id === id);
const events = async (bookingId, type) => (await admin.query(
  `select organization_id, data from app_state where collection = 'bookingEvents' and booking_id = $1 and data->>'eventType' = $2`, [bookingId, type])).rows;
const audits = async (bookingId, type) => Number((await admin.query(
  `select count(*) from audit_events where entity_id = $1 and event_type = $2`, [bookingId, type])).rows[0].count);

function roundTrip(id, extra = {}) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00', pickupAddress: HOME, destination: CLINIC,
    tripType: '來回', returnDate: '2099-01-01', returnTime: '16:00', splitLegConsent: true,
    passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    legs: [F.outboundLeg(id), { id: `${id}_return`, direction: 'return', sequence: 2, label: '回程', status: 'pending',
      requestedPickupAt: '2099-01-01T08:00:00.000Z' }],
    ...extra
  };
}
async function claimedRoundTrip(id, extra = {}) {
  const c = await writeBooking(U.req, roundTrip(id, extra));
  const k = await claim(U.dspA, id, ORG_A);
  return c.status === 200 && k.status === 200;
}
/** 排車只走 command（ADR 0003）：把這筆預約的某一段排進 A 的行程 */
const scheduleLeg = (bookingId, legId, tripId) => call(scheduleFn.handler, 'POST', U.dspA, { trips: [{
  ...F.makeTrip({ id: tripId, organizationId: ORG_A, driverId: DRIVER_A, vehicleId: null, bookingId,
    startAt: F.addMinutes(new Date().toISOString(), 24 * 60), extra: { pickupAddress: HOME } }),
  bookingIds: [bookingId], bookingLegRefs: [{ bookingId, legId }] }] });

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, tax_id, contact_phone, active) values
      ('${ORG_A}','transport_provider','合成承運 A','12345678','02-1111-2222',true),
      ('${ORG_B}','transport_provider','合成承運 B','87654321','02-3333-4444',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886945000001','none',true),
      ('${U.dspA}','合成調度 A','+886945000002','none',true),
      ('${U.dspB}','合成調度 B','+886945000003','none',true),
      ('${U.drvA}','合成司機 A','+886945000004','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-SPL-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-SPL-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-SPL-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-SPL-DRVA','${U.drvA}','${ORG_A}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER_A}','${U.drvA}','${ORG_A}','on_duty',true);
  `);

  console.log('--- 承接機構退回一段到需求池 ---');
  record('（前提）需求者建立同意分段載送的來回預約，A 接案', await claimedRoundTrip('BKG-SPL-1'));
  const released = await leg(U.dspA, 'release', 'BKG-SPL-1', 'BKG-SPL-1_return');
  const ret = await legOf('BKG-SPL-1', 'return');
  record('A 退回回程：回程在需求池，預約仍由 A 承接', released.status === 200 && ret.poolStatus === 'in_pool'
    && (await row('bookings', 'BKG-SPL-1')).organization_id === ORG_A, outcome(released));
  record('去程仍由 A 負責', ((await legOf('BKG-SPL-1', 'outbound')).poolStatus || 'primary') === 'primary');
  const ev = await events('BKG-SPL-1', 'leg_released');
  record('留下預約事件「退回一段」（承接機構看得到）', ev.length === 1 && ev[0].organization_id === ORG_A && ev[0].data.metadata.legId === 'BKG-SPL-1_return', JSON.stringify(ev.map((e) => e.data)));
  record('留下稽核紀錄', await audits('BKG-SPL-1', 'booking.leg_released') === 1);

  console.log('--- 需求池 ---');
  const bLoad = await load(U.dspB);
  const bRows = poolRows(bLoad, 'BKG-SPL-1');
  const r0 = bRows[0] || {};
  record('別家機構在需求池看到「只有回程」一列', bRows.length === 1 && r0.leg_direction === 'return' && r0.leg_id === 'BKG-SPL-1_return', JSON.stringify(bRows));
  record('回程那一列：上車是原本的目的地、時間是回程時間', r0.pickup_area && CLINIC.startsWith(r0.pickup_area.replace(/台/g, '臺').slice(0, 3))
    && r0.pickup_at === '2099-01-01' && r0.pickup_time === '16:00' && !r0.return_date && !r0.return_time, JSON.stringify(r0));
  const leaked = JSON.stringify(bRows);
  record('需求池那一列只有模糊資訊：沒有門牌、姓名、電話', !leaked.includes('188號') && !leaked.includes('公園路20號')
    && !leaked.includes('合成需求者') && !leaked.includes('0911000001'), leaked.slice(0, 300));
  record('別家機構仍讀不到這筆預約', !sees(bLoad, 'bookings', 'BKG-SPL-1'));
  const aLoad = await load(U.dspA);
  record('承接機構自己的需求池不列出自己退回的那段', poolRows(aLoad, 'BKG-SPL-1').length === 0);
  const aBooking = ((aLoad.data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-1');
  record('承接機構看得到回程在需求池', aBooking && aBooking.legs.find((l) => l.direction === 'return').poolStatus === 'in_pool');
  const reqLoad = await load(U.req);
  record('需求者的資料裡看得到回程在需求池', (((reqLoad.data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-1') || { legs: [] })
    .legs.some((l) => l.direction === 'return' && l.poolStatus === 'in_pool'));

  console.log('--- 排車 ---');
  const schedPool = await scheduleLeg('BKG-SPL-1', 'BKG-SPL-1_return', 'TRP-SPL-POOL');
  record('承接機構不能把在需求池的那一段排車', schedPool.status === 409 && schedPool.error.code === 'BOOKING_CONFLICT' && /需求池/.test(schedPool.error.message)
    && !(await row('trips', 'TRP-SPL-POOL')), outcome(schedPool));
  const schedOut = await scheduleLeg('BKG-SPL-1', 'BKG-SPL-1_outbound', 'TRP-SPL-OUT');
  record('去程照常排車；回程在需求池，預約是部分排車', schedOut.status === 200
    && (await row('bookings', 'BKG-SPL-1')).data.state === 'partially_scheduled', outcome(schedOut));

  console.log('--- 被拒的情況 ---');
  record('（前提）沒同意分段載送的來回預約，A 接案', await claimedRoundTrip('BKG-SPL-2', { splitLegConsent: false }));
  const noConsent = await leg(U.dspA, 'release', 'BKG-SPL-2', 'BKG-SPL-2_return');
  record('需求者沒同意分段載送：被拒並說明原因', noConsent.status === 400 && /沒有同意分段載送/.test(noConsent.error.message)
    && ((await legOf('BKG-SPL-2', 'return')).poolStatus || 'primary') === 'primary', outcome(noConsent));
  const oneWayOk = await writeBooking(U.req, { ...roundTrip('BKG-SPL-3'), tripType: '單程', returnDate: '', returnTime: '', legs: [F.outboundLeg('BKG-SPL-3')] });
  await claim(U.dspA, 'BKG-SPL-3', ORG_A);
  const oneWay = await leg(U.dspA, 'release', 'BKG-SPL-3', 'BKG-SPL-3_outbound');
  record('單程預約：被拒並說明原因', oneWayOk.status === 200 && oneWay.status === 400 && /來回/.test(oneWay.error.message), outcome(oneWay));
  const scheduledLeg = await leg(U.dspA, 'release', 'BKG-SPL-1', 'BKG-SPL-1_outbound');
  record('已排車的段：被拒並說明原因', scheduledLeg.status === 400 && /已經排車/.test(scheduledLeg.error.message), outcome(scheduledLeg));
  record('（前提）另一筆來回預約，A 接案', await claimedRoundTrip('BKG-SPL-4'));
  const byOther = await leg(U.dspB, 'release', 'BKG-SPL-4', 'BKG-SPL-4_return');
  record('別家機構不能退回：被拒', [403, 404].includes(byOther.status) && ((await legOf('BKG-SPL-4', 'return')).poolStatus || 'primary') === 'primary', outcome(byOther));
  const byRequester = await leg(U.req, 'release', 'BKG-SPL-4', 'BKG-SPL-4_return');
  record('需求者不能退回：被拒', [403, 404].includes(byRequester.status) && ((await legOf('BKG-SPL-4', 'return')).poolStatus || 'primary') === 'primary', outcome(byRequester));
  const badAction = await leg(U.dspA, 'nope', 'BKG-SPL-4', 'BKG-SPL-4_return');
  record('不認得的動作：被拒', badAction.status === 400, outcome(badAction));
  const forged = await writeBooking(U.req, { ...(await row('bookings', 'BKG-SPL-4')).data,
    legs: (await row('bookings', 'BKG-SPL-4')).data.legs.map((l) => ({ ...l, poolStatus: 'in_pool' })) });
  record('一般預約寫入改不了需求池狀態', forged.status === 200 && ((await legOf('BKG-SPL-4', 'return')).poolStatus || 'primary') === 'primary', outcome(forged));

  console.log('--- 收回 ---');
  record('（前提）A 退回 BKG-SPL-4 的去程', (await leg(U.dspA, 'release', 'BKG-SPL-4', 'BKG-SPL-4_outbound')).status === 200);
  const second = await leg(U.dspA, 'release', 'BKG-SPL-4', 'BKG-SPL-4_return');
  record('另一段已在需求池：再退回被拒，要整筆退回請用整筆退回', second.status === 400 && /整筆退回/.test(second.error.message), outcome(second));
  const reclaimByB = await leg(U.dspB, 'reclaim', 'BKG-SPL-4', 'BKG-SPL-4_outbound');
  record('別家機構不能收回', [403, 404].includes(reclaimByB.status), outcome(reclaimByB));
  const reclaimed = await leg(U.dspA, 'reclaim', 'BKG-SPL-4', 'BKG-SPL-4_outbound');
  record('A 在沒有人接之前收回去程', reclaimed.status === 200 && ((await legOf('BKG-SPL-4', 'outbound')).poolStatus || 'primary') === 'primary', outcome(reclaimed));
  record('收回後別家的需求池不再列出', poolRows(await load(U.dspB), 'BKG-SPL-4').length === 0);
  record('留下預約事件「收回一段」與稽核紀錄', (await events('BKG-SPL-4', 'leg_reclaimed')).length === 1 && await audits('BKG-SPL-4', 'booking.leg_reclaimed') === 1);
  const reclaimAgain = await leg(U.dspA, 'reclaim', 'BKG-SPL-4', 'BKG-SPL-4_outbound');
  record('不在需求池的段不能收回', reclaimAgain.status === 400 && /不在需求池/.test(reclaimAgain.error.message), outcome(reclaimAgain));

  console.log('--- 整筆退回 ---');
  record('（前提）A 再退回 BKG-SPL-4 的回程', (await leg(U.dspA, 'release', 'BKG-SPL-4', 'BKG-SPL-4_return')).status === 200);
  const whole = await writeBooking(U.dspA, { ...(await row('bookings', 'BKG-SPL-4')).data, state: 'open', claimStatus: 'open', status: 'open', organizationId: null });
  const after = await row('bookings', 'BKG-SPL-4');
  record('整筆退回：預約回到公開、去程回程都不再標示在需求池', whole.status === 200 && after.organization_id === null
    && after.data.legs.every((l) => (l.poolStatus || 'primary') === 'primary'), outcome(whole));
  const wholePool = poolRows(await load(U.dspB), 'BKG-SPL-4');
  record('需求池只列整筆一列，沒有單一段', wholePool.length === 1 && !wholePool[0].leg_id, JSON.stringify(wholePool));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
