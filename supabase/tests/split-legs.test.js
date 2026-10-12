'use strict';
/**
 * 跨機構排車（#108、ADR 0004）的整合測試：來回預約的一段退回需求池、收回（#112）、接下單一段成為協力機構（#113）。
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
const cancelFn = require('../../netlify/functions/v2-cancel-booking');
const legFn = require('../../netlify/functions/v2-booking-leg');
const scheduleFn = require('../../netlify/functions/v2-schedule-trips');
const loadFn = require('../../netlify/functions/v2-state-load');
const expireFn = require('../../netlify/functions/leg-pool-expire');

const ORG_A = 'ORG-SPL-A';
const ORG_B = 'ORG-SPL-B';
const ORG_C = 'ORG-SPL-C';
const U = { req: 'USR-SPL-REQ', dspA: 'USR-SPL-DSPA', dspB: 'USR-SPL-DSPB', dspC: 'USR-SPL-DSPC', drvA: 'USR-SPL-DRVA', drvB: 'USR-SPL-DRVB', drvC: 'USR-SPL-DRVC' };
const DRIVERS = { 'ORG-SPL-A': 'DRV-SPL-A', 'ORG-SPL-B': 'DRV-SPL-B', 'ORG-SPL-C': 'DRV-SPL-C' };
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
const leg = (userId, action, bookingId, legId, organizationId) => call(legFn.handler, 'POST', userId, { action, bookingId, legId, organizationId });
const claimLeg = (userId, bookingId, legId, organizationId) => leg(userId, 'claim', bookingId, legId, organizationId);
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
/** 排車只走 command（ADR 0003）：把這筆預約的某一段排進某個機構（預設 A）的行程 */
const scheduleLeg = (bookingId, legId, tripId, org = ORG_A, userId = U.dspA) => call(scheduleFn.handler, 'POST', userId, { trips: [{
  ...F.makeTrip({ id: tripId, organizationId: org, driverId: DRIVERS[org], vehicleId: null, bookingId,
    startAt: F.addMinutes(new Date().toISOString(), 24 * 60), extra: { pickupAddress: HOME } }),
  bookingIds: [bookingId], bookingLegRefs: [{ bookingId, legId }] }] });

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, tax_id, contact_phone, active) values
      ('${ORG_A}','transport_provider','合成承運 A','12345678','02-1111-2222',true),
      ('${ORG_B}','transport_provider','合成承運 B','87654321','02-3333-4444',true),
      ('${ORG_C}','transport_provider','合成承運 C','11223344','02-5555-6666',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886945000001','none',true),
      ('${U.dspA}','合成調度 A','+886945000002','none',true),
      ('${U.dspB}','合成調度 B','+886945000003','none',true),
      ('${U.dspC}','合成調度 C','+886945000005','none',true),
      ('${U.drvA}','合成司機 A','+886945000004','none',true),
      ('${U.drvB}','合成司機 B','+886945000006','none',true),
      ('${U.drvC}','合成司機 C','+886945000007','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-SPL-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-SPL-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-SPL-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-SPL-DSPC','${U.dspC}','${ORG_C}','dispatcher','active'),
      ('M-SPL-DRVA','${U.drvA}','${ORG_A}','driver','active'),
      ('M-SPL-DRVB','${U.drvB}','${ORG_B}','driver','active'),
      ('M-SPL-DRVC','${U.drvC}','${ORG_C}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER_A}','${U.drvA}','${ORG_A}','on_duty',true),
      ('DRV-SPL-B','${U.drvB}','${ORG_B}','on_duty',true),
      ('DRV-SPL-C','${U.drvC}','${ORG_C}','on_duty',true);
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

  console.log('--- 接下單一段成為協力機構（#113）---');
  record('（前提）同意分段載送的來回預約，A 接案、退回回程', await claimedRoundTrip('BKG-SPL-5')
    && (await leg(U.dspA, 'release', 'BKG-SPL-5', 'BKG-SPL-5_return')).status === 200);
  const notInPool = await claimLeg(U.dspB, 'BKG-SPL-5', 'BKG-SPL-5_outbound', ORG_B);
  record('不在需求池的段不能接', [400, 409].includes(notInPool.status) && ((await legOf('BKG-SPL-5', 'outbound')).poolStatus || 'primary') === 'primary', outcome(notInPool));
  const ownClaim = await claimLeg(U.dspA, 'BKG-SPL-5', 'BKG-SPL-5_return', ORG_A);
  record('承接機構不能接自己退回的段（要用收回）', [400, 409].includes(ownClaim.status), outcome(ownClaim));
  const wrongOrg = await claimLeg(U.dspC, 'BKG-SPL-5', 'BKG-SPL-5_return', ORG_B);
  record('不能代表別的機構接', wrongOrg.status === 403, outcome(wrongOrg));
  const [byB, byC] = await Promise.all([claimLeg(U.dspB, 'BKG-SPL-5', 'BKG-SPL-5_return', ORG_B), claimLeg(U.dspC, 'BKG-SPL-5', 'BKG-SPL-5_return', ORG_C)]);
  const winner = byB.status === 200 ? ORG_B : byC.status === 200 ? ORG_C : null;
  record('兩家同時接同一段：只有一家成功，另一家回衝突', [byB.status, byC.status].sort().join(',') === '200,409', `${outcome(byB)} / ${outcome(byC)}`);
  const partnerLeg = await legOf('BKG-SPL-5', 'return');
  record('回程由成功的那家負責（協力機構），預約仍由 A 承接', partnerLeg.poolStatus === 'partner' && partnerLeg.partnerOrganizationId === winner
    && (await row('bookings', 'BKG-SPL-5')).organization_id === ORG_A, JSON.stringify(partnerLeg));
  // 之後的檢查固定以 B 為協力機構：C 贏的話，A 收不回，改用新的一筆
  let P = { org: winner, dsp: winner === ORG_B ? U.dspB : U.dspC, other: winner === ORG_B ? U.dspC : U.dspB, name: winner === ORG_B ? '合成承運 B' : '合成承運 C', phone: winner === ORG_B ? '02-3333-4444' : '02-5555-6666' };
  const pEv = await events('BKG-SPL-5', 'leg_partner_claimed');
  record('留下預約事件「接下一段」（承接機構看得到）與稽核紀錄', pEv.length === 1 && pEv[0].organization_id === ORG_A
    && pEv[0].data.metadata.partnerOrganizationId === winner && await audits('BKG-SPL-5', 'booking.leg_partner_claimed') === 1, JSON.stringify(pEv.map((e) => e.data)));
  record('接走後需求池不再列出這一段', poolRows(await load(P.other), 'BKG-SPL-5').length === 0);

  const pLoad = await load(P.dsp);
  const pBooking = ((pLoad.data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-5');
  const pJson = JSON.stringify(pBooking || {});
  record('協力機構讀得到這筆預約（協力機構的檢視）', !!pBooking && pBooking.partnerView === true && pBooking.partnerOrganizationId === P.org, pJson.slice(0, 300));
  const own = pBooking ? pBooking.legs.find((l) => l.direction === 'return') : null;
  const otherLeg = pBooking ? pBooking.legs.find((l) => l.direction === 'outbound') : null;
  record('協力機構看得到自己那段的完整時間、服務對象與聯絡人', !!own && own.requestedPickupAt === '2099-01-01T08:00:00.000Z'
    && pBooking.name === '合成需求者' && pBooking.phone === '0911000001' && pBooking.pickupAddress === CLINIC && pBooking.destination === HOME
    && pBooking.pickupTime === '16:00', pJson.slice(0, 400));
  record('另一段只標示由其他機構負責，沒有時間與地點', !!otherLeg && otherLeg.maskedForPartner === true && !otherLeg.requestedPickupAt
    && !otherLeg.pickup && !otherLeg.dropoff && !pJson.includes('"09:00"') && !pJson.includes('T01:00:00'), JSON.stringify(otherLeg));
  record('協力機構看得到承接機構的名稱與電話', pBooking && pBooking.primaryOrganizationName === '合成承運 A' && pBooking.primaryOrganizationPhone === '02-1111-2222');
  const otherLoad = JSON.stringify(await load(P.other));
  record('沒有關係的機構讀不到任何個資', !otherLoad.includes('BKG-SPL-5') || (!otherLoad.includes('合成需求者') && !otherLoad.includes('0911000001')),
    otherLoad.includes('BKG-SPL-5') ? '（只在需求池以外出現 ID）' : '');
  const aLoad5 = await load(U.dspA);
  const aRet = (((aLoad5.data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-5') || { legs: [] }).legs.find((l) => l.direction === 'return') || {};
  record('承接機構看得到協力機構的名稱與電話', aRet.partnerOrganizationName === P.name && aRet.partnerOrganizationPhone === P.phone, JSON.stringify(aRet));
  const reqRet = ((((await load(U.req)).data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-5') || { legs: [] }).legs.find((l) => l.direction === 'return') || {};
  record('需求者看得到回程由哪家機構載送', reqRet.poolStatus === 'partner' && reqRet.partnerOrganizationName === P.name, JSON.stringify(reqRet));
  const notes = async (userId, template) => (await admin.query(
    `select payload from notifications where recipient_user_id = $1 and booking_id = 'BKG-SPL-5' and template = $2`, [userId, template])).rows;
  const reqNote = await notes(U.req, 'booking_leg_partner_claimed');
  record('通知需求者：回程改由哪家機構載送', reqNote.length === 1 && reqNote[0].payload.legLabel === '回程' && reqNote[0].payload.organizationName === P.name, JSON.stringify(reqNote));
  const opsNote = await notes(U.dspA, 'leg_partner_claimed');
  record('通知承接機構的調度：協力機構接下回程', opsNote.length === 1 && opsNote[0].payload.organizationName === P.name, JSON.stringify(opsNote));
  const relPartner = await leg(U.dspA, 'release', 'BKG-SPL-5', 'BKG-SPL-5_return');
  const recPartner = await leg(U.dspA, 'reclaim', 'BKG-SPL-5', 'BKG-SPL-5_return');
  record('承接機構不能退回或收回已交給協力機構的段', relPartner.status === 400 && recPartner.status === 400
    && (await legOf('BKG-SPL-5', 'return')).poolStatus === 'partner', `${outcome(relPartner)} / ${outcome(recPartner)}`);
  const again = await claimLeg(P.other, 'BKG-SPL-5', 'BKG-SPL-5_return', P.other === U.dspB ? ORG_B : ORG_C);
  record('已有協力機構的段，別家再接回衝突', again.status === 409, outcome(again));

  console.log('--- 協力機構排自己那段（#113）---');
  const otherOrg = P.org === ORG_B ? ORG_C : ORG_B;
  const aTakesPartner = await scheduleLeg('BKG-SPL-5', 'BKG-SPL-5_return', 'TRP-SPL-A-RET');
  record('承接機構不能把交給協力機構的段排進自己的行程', aTakesPartner.status === 409 && !(await row('trips', 'TRP-SPL-A-RET')), outcome(aTakesPartner));
  const pTakesOut = await scheduleLeg('BKG-SPL-5', 'BKG-SPL-5_outbound', 'TRP-SPL-P-OUT', P.org, P.dsp);
  record('協力機構不能排另一段', [400, 403, 409].includes(pTakesOut.status) && !(await row('trips', 'TRP-SPL-P-OUT'))
    && (await legOf('BKG-SPL-5', 'outbound')).status === 'pending', outcome(pTakesOut));
  const strangerSched = await scheduleLeg('BKG-SPL-5', 'BKG-SPL-5_return', 'TRP-SPL-X-RET', otherOrg, P.other);
  record('沒有關係的機構不能排', [403, 404].includes(strangerSched.status) && !(await row('trips', 'TRP-SPL-X-RET')), outcome(strangerSched));
  const pSched = await scheduleLeg('BKG-SPL-5', 'BKG-SPL-5_return', 'TRP-SPL-P-RET', P.org, P.dsp);
  const pRet = await legOf('BKG-SPL-5', 'return');
  const pTrip = await row('trips', 'TRP-SPL-P-RET');
  record('協力機構把自己那段排進自己的行程：行程屬於協力機構、回程已排車', pSched.status === 200 && pTrip && pTrip.organization_id === P.org
    && pRet.status === 'scheduled' && pRet.tripId === 'TRP-SPL-P-RET' && pRet.scheduledOrganizationId === P.org && pRet.poolStatus === 'partner', outcome(pSched));
  const afterP = await row('bookings', 'BKG-SPL-5');
  record('去程還沒排：預約是部分排車，仍由 A 承接', afterP.data.state === 'partially_scheduled' && afterP.organization_id === ORG_A
    && (await legOf('BKG-SPL-5', 'outbound')).status === 'pending', afterP.data.state);
  record('留下預約事件「排車」', (await events('BKG-SPL-5', 'leg_scheduled')).some((e) => e.data.metadata.legId === 'BKG-SPL-5_return'));
  const aSched = await scheduleLeg('BKG-SPL-5', 'BKG-SPL-5_outbound', 'TRP-SPL-A-OUT');
  record('承接機構排去程：兩段都排好，預約已排車', aSched.status === 200 && (await row('bookings', 'BKG-SPL-5')).data.state === 'scheduled', outcome(aSched));
  const aView = (((await load(U.dspA)).data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-5') || { legs: [] };
  record('承接機構看得到回程由協力機構排車，但讀不到協力機構的行程', aView.legs.find((l) => l.direction === 'return').status === 'scheduled'
    && !(((await load(U.dspA)).data.collections.trips) || []).some((t) => t.id === 'TRP-SPL-P-RET'));
  const pTrips = (((await load(P.dsp)).data.collections.trips) || []).map((t) => t.id);
  record('協力機構讀得到自己的行程、讀不到承接機構的行程', pTrips.includes('TRP-SPL-P-RET') && !pTrips.includes('TRP-SPL-A-OUT'), JSON.stringify(pTrips));

  console.log('--- 解除協力關係（#114）---');
  /** 同意分段載送的來回預約：A 接案、退回回程、B 接下回程 */
  async function partnered(id) {
    return await claimedRoundTrip(id) && (await leg(U.dspA, 'release', id, `${id}_return`)).status === 200
      && (await claimLeg(U.dspB, id, `${id}_return`, ORG_B)).status === 200;
  }
  const partnerSees = async (id) => (((await load(U.dspB)).data.collections.bookings) || []).some((b) => b.id === id);
  const opsNotes = async (userId, id, template) => (await admin.query(
    `select payload from notifications where recipient_user_id = $1 and booking_id = $2 and template = $3`, [userId, id, template])).rows;
  const writeAs = async (userId, id, patch) => writeBooking(userId, { ...(await row('bookings', id)).data, ...patch });

  record('（前提）BKG-SPL-6：B 是回程的協力機構', await partnered('BKG-SPL-6') && await partnerSees('BKG-SPL-6'));
  const bOut = await leg(U.dspB, 'release', 'BKG-SPL-6', 'BKG-SPL-6_outbound');
  record('協力機構不能退回不是自己負責的段', [400, 403, 404].includes(bOut.status), outcome(bOut));
  const bRel = await leg(U.dspB, 'release', 'BKG-SPL-6', 'BKG-SPL-6_return');
  const r6 = await legOf('BKG-SPL-6', 'return');
  record('協力機構退回自己那段：回到需求池', bRel.status === 200 && r6.poolStatus === 'in_pool' && !r6.partnerOrganizationId
    && r6.releasedByOrganizationId === ORG_B, outcome(bRel));
  record('協力機構立即讀不到', !(await partnerSees('BKG-SPL-6')));
  record('通知承接機構：協力機構退回了回程', (await opsNotes(U.dspA, 'BKG-SPL-6', 'leg_partner_released')).length === 1);
  record('留下預約事件「協力機構退回」', (await events('BKG-SPL-6', 'leg_partner_released')).length === 1);
  record('那段又出現在別家的需求池', poolRows(await load(U.dspC), 'BKG-SPL-6').some((r) => r.leg_id === 'BKG-SPL-6_return'));

  record('（前提）BKG-SPL-7：B 是回程的協力機構，並已排車', await partnered('BKG-SPL-7')
    && (await scheduleLeg('BKG-SPL-7', 'BKG-SPL-7_return', 'TRP-SPL-B7', ORG_B, U.dspB)).status === 200);
  const bRelSched = await leg(U.dspB, 'release', 'BKG-SPL-7', 'BKG-SPL-7_return');
  record('協力機構已排車的段要先取消行程才能退回', bRelSched.status === 400 && /取消行程/.test(bRelSched.error.message), outcome(bRelSched));

  record('（前提）BKG-SPL-8：B 是回程的協力機構', await partnered('BKG-SPL-8'));
  const needs = await writeAs(U.req, 'BKG-SPL-8', { specialNeed: '需要協助上下車' });
  record('需求者只改服務需求：協力關係不變', needs.status === 200 && (await legOf('BKG-SPL-8', 'return')).poolStatus === 'partner', outcome(needs));
  record('只改需求：通知承接機構與協力機構', (await opsNotes(U.dspA, 'BKG-SPL-8', 'booking_needs_changed')).length === 1
    && (await opsNotes(U.dspB, 'BKG-SPL-8', 'booking_needs_changed')).length === 1);
  const amend = await writeAs(U.req, 'BKG-SPL-8', { returnTime: '17:30' });
  const r8 = await legOf('BKG-SPL-8', 'return');
  record('需求者改了回程時間：協力關係解除、回程回到需求池', amend.status === 200 && r8.poolStatus === 'in_pool' && !r8.partnerOrganizationId, outcome(amend));
  record('協力機構立即讀不到，並收到通知', !(await partnerSees('BKG-SPL-8'))
    && (await opsNotes(U.dspB, 'BKG-SPL-8', 'leg_partner_removed')).some((n) => n.payload.reason === 'amended'));
  record('改了去程時間不影響回程的協力機構', await partnered('BKG-SPL-9')
    && (await writeAs(U.req, 'BKG-SPL-9', { pickupTime: '08:30' })).status === 200 && (await legOf('BKG-SPL-9', 'return')).poolStatus === 'partner');

  const toOneWay9 = await writeAs(U.req, 'BKG-SPL-9', { tripType: '單程', returnDate: '', returnTime: '', legs: [(await row('bookings', 'BKG-SPL-9')).data.legs[0]] });
  record('改成單程：回程拿掉、協力機構讀不到並收到通知', toOneWay9.status === 200 && !(await legOf('BKG-SPL-9', 'return'))
    && !(await partnerSees('BKG-SPL-9')) && (await opsNotes(U.dspB, 'BKG-SPL-9', 'leg_partner_removed')).some((n) => n.payload.reason === 'removed'), outcome(toOneWay9));

  record('（前提）BKG-SPL-10：B 是回程的協力機構', await partnered('BKG-SPL-10'));
  const cancelled = await call(cancelFn.handler, 'POST', U.req, { bookingId: 'BKG-SPL-10', reasonCode: 'requester_no_longer_needed' });
  record('需求者取消整筆：承接機構與協力機構都收到通知', cancelled.status === 200
    && (await opsNotes(U.dspA, 'BKG-SPL-10', 'booking_cancelled_ops')).length === 1
    && (await opsNotes(U.dspB, 'BKG-SPL-10', 'booking_cancelled_ops')).length === 1, outcome(cancelled));
  record('取消後兩家都讀不到', !(await partnerSees('BKG-SPL-10'))
    && !(((await load(U.dspA)).data.collections.bookings) || []).some((b) => b.id === 'BKG-SPL-10'));

  let strangerErr = null;
  try { await db.withUser(U.dspC, (c) => c.query(`select app.notify_booking_orgs('BKG-SPL-8', 'booking_needs_changed', '{}'::jsonb, array['${ORG_A}'])`)); }
  catch (e) { strangerErr = e; }
  record('沒有關係的機構不能透過通知函式通知這筆預約的機構', strangerErr && strangerErr.code === '42501', strangerErr && strangerErr.code);
  const toStranger = await db.withUser(U.req, (c) => c.query(`select app.notify_booking_orgs('BKG-SPL-8', 'booking_needs_changed', '{}'::jsonb, array['${ORG_C}']) as n`));
  record('需求者也只能通知這筆預約現在的承接機構或協力機構', Number(toStranger.rows[0].n) === 0, JSON.stringify(toStranger.rows));

  console.log('--- 整筆退回限制與升格（#115）---');
  record('（前提）BKG-SPL-11：B 是回程的協力機構', await partnered('BKG-SPL-11'));
  const wholeOpen = await writeAs(U.dspA, 'BKG-SPL-11', { state: 'open', claimStatus: 'open', status: 'open', organizationId: null });
  const wholeReject = await writeAs(U.dspA, 'BKG-SPL-11', { state: 'rejected', status: 'rejected' });
  record('有協力機構時承接機構不能整筆退回或不受理，並說明原因', wholeOpen.status === 400 && /協力機構/.test(wholeOpen.error.message)
    && wholeReject.status === 400 && (await row('bookings', 'BKG-SPL-11')).organization_id === ORG_A, `${outcome(wholeOpen)} / ${outcome(wholeReject)}`);
  const promote = await leg(U.dspA, 'release', 'BKG-SPL-11', 'BKG-SPL-11_outbound');
  const p11 = await row('bookings', 'BKG-SPL-11');
  const o11 = (p11.data.legs || []).find((l) => l.direction === 'outbound');
  const r11 = (p11.data.legs || []).find((l) => l.direction === 'return');
  record('承接機構退回自己那段：協力機構升格為承接機構，去程回到需求池', promote.status === 200 && p11.organization_id === ORG_B
    && p11.data.organizationId === ORG_B && o11.poolStatus === 'in_pool' && (r11.poolStatus || 'primary') === 'primary' && !r11.partnerOrganizationId, outcome(promote));
  const bFull = (((await load(U.dspB)).data.collections.bookings) || []).find((b) => b.id === 'BKG-SPL-11');
  record('新的承接機構看得到整筆預約', !!bFull && !bFull.partnerView && bFull.pickupAddress === HOME && bFull.legs.every((l) => !l.maskedForPartner));
  record('原承接機構讀不到', !(((await load(U.dspA)).data.collections.bookings) || []).some((b) => b.id === 'BKG-SPL-11'));
  record('通知需求者：承接機構換成新的機構', (await admin.query(
    `select payload from notifications where recipient_user_id = $1 and booking_id = 'BKG-SPL-11' and template = 'booking_primary_changed'`, [U.req])).rows
    .some((n) => n.payload.organizationName === '合成承運 B'));
  record('通知新的承接機構：已升格', (await opsNotes(U.dspB, 'BKG-SPL-11', 'leg_partner_promoted')).length === 1);
  record('留下預約事件「升格」', (await events('BKG-SPL-11', 'leg_partner_promoted')).length === 1);
  record('退回的去程出現在別家（含原承接機構）的需求池', poolRows(await load(U.dspA), 'BKG-SPL-11').some((r) => r.leg_id === 'BKG-SPL-11_outbound'));
  const bReclaim = await leg(U.dspB, 'reclaim', 'BKG-SPL-11', 'BKG-SPL-11_outbound');
  record('新的承接機構可以收回去程，自己兩段都載', bReclaim.status === 200 && ((await legOf('BKG-SPL-11', 'outbound')).poolStatus || 'primary') === 'primary', outcome(bReclaim));

  console.log('--- 單一段的接案期限（#116）---');
  record('（前提）BKG-SPL-12：A 退回回程', await claimedRoundTrip('BKG-SPL-12')
    && (await leg(U.dspA, 'release', 'BKG-SPL-12', 'BKG-SPL-12_return')).status === 200);
  const row12 = poolRows(await load(U.dspB), 'BKG-SPL-12')[0] || {};
  record('需求池列出那一段的接案期限：回程接送時間前 30 分鐘', row12.market_expires_at && new Date(row12.market_expires_at).toISOString() === '2099-01-01T07:30:00.000Z', JSON.stringify(row12.market_expires_at));
  let notSystem = null;
  try { await db.withUser(U.dspA, (c) => c.query(`select * from app.expire_pool_legs('2099-01-02'::timestamptz)`)); } catch (e) { notSystem = e; }
  record('過期處理只能由系統排程或平台管理者執行', notSystem && notSystem.code === '42501', notSystem && notSystem.code);
  const early = await db.withoutUser((c) => c.query(`select * from app.expire_pool_legs('2099-01-01T07:00:00Z'::timestamptz)`));
  record('還沒到期限不處理', !early.rows.some((r) => r.booking_id === 'BKG-SPL-12') && (await legOf('BKG-SPL-12', 'return')).poolStatus === 'in_pool');
  const late = await db.withoutUser((c) => c.query(`select * from app.expire_pool_legs('2099-01-01T07:31:00Z'::timestamptz)`));
  const r12 = await legOf('BKG-SPL-12', 'return');
  record('過了期限：那段標示沒有機構承接', late.rows.some((r) => r.booking_id === 'BKG-SPL-12') && r12.poolStatus === 'unclaimed', JSON.stringify(r12));
  record('另一段與預約狀態不變', ((await legOf('BKG-SPL-12', 'outbound')).poolStatus || 'primary') === 'primary'
    && (await row('bookings', 'BKG-SPL-12')).data.state === 'claimed' && (await row('bookings', 'BKG-SPL-12')).organization_id === ORG_A);
  record('需求池不再列出', poolRows(await load(U.dspB), 'BKG-SPL-12').length === 0);
  record('通知需求者與承接機構', (await admin.query(`select 1 from notifications where recipient_user_id = $1 and booking_id = 'BKG-SPL-12' and template = 'booking_leg_unclaimed'`, [U.req])).rows.length === 1
    && (await opsNotes(U.dspA, 'BKG-SPL-12', 'leg_unclaimed')).length === 1);
  record('留下預約事件「沒有機構承接」', (await events('BKG-SPL-12', 'leg_unclaimed')).length === 1);
  const again12 = await db.withoutUser((c) => c.query(`select * from app.expire_pool_legs('2099-01-02'::timestamptz)`));
  record('重跑不會重複處理', !again12.rows.some((r) => r.booking_id === 'BKG-SPL-12'));
  const takeBack = await leg(U.dspA, 'reclaim', 'BKG-SPL-12', 'BKG-SPL-12_return');
  record('承接機構可以把沒有機構承接的那段收回自己載', takeBack.status === 200 && ((await legOf('BKG-SPL-12', 'return')).poolStatus || 'primary') === 'primary', outcome(takeBack));

  record('（前提）BKG-SPL-13：A 退回回程', await claimedRoundTrip('BKG-SPL-13')
    && (await leg(U.dspA, 'release', 'BKG-SPL-13', 'BKG-SPL-13_return')).status === 200);
  await admin.query(`update bookings set data = jsonb_set(data, '{legs,1,requestedPickupAt}', to_jsonb(to_char((now() - interval '1 hour') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where id = 'BKG-SPL-13'`);
  record('排程還沒跑、期限已過的那段，需求池也不列出', poolRows(await load(U.dspB), 'BKG-SPL-13').length === 0);
  const sweep = await expireFn.handler({});
  record('排程函式（每 15 分鐘）處理到期的段', sweep.statusCode === 200 && (await legOf('BKG-SPL-13', 'return')).poolStatus === 'unclaimed', sweep.body);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
