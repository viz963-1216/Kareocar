'use strict';
/**
 * 預約寫入與存取撤銷（#22）的整合測試。
 *
 * 經過實際的 handler（booking-write、state-mutate、claim-booking、cancel-booking、state-load），
 * handler 以 care_ride_app 連線，RLS、0005 的撤銷函式全部生效。postgres 連線只用來建立身分
 * fixture 與讀取資料庫實際狀態。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_access_test') {
  throw Error('Requires dedicated local endpoint and careride_access_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_access_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_access_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-access-0123456789';
const fx = require('./_auth-fixture');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_access_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const cancelFn = require('../../netlify/functions/v2-cancel-booking');
const loadFn = require('../../netlify/functions/v2-state-load');

const ORG_A = 'ORG-ACC-A';
const ORG_B = 'ORG-ACC-B';
const U = { req: 'USR-ACC-REQ', dspA: 'USR-ACC-DSPA', dspB: 'USR-ACC-DSPB', drvA: 'USR-ACC-DRVA', drvB: 'USR-ACC-DRVB' };
const DRIVER_A = 'DRV-ACC-A';
const DRIVER_B = 'DRV-ACC-B';
const ADDRESS = '新北市板橋區文化路一段188號';

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
const writeBooking = (userId, record) => call(bookingWriteFn.handler, 'POST', userId, { changes: [{ collection: 'bookings', id: record.id, record }] });
const mutate = (userId, changes) => call(mutateFn.handler, 'POST', userId, { changes });
const tripWriteFn = require('../../netlify/functions/v2-trip-write');
const writeTrips = (userId, changes) => call(tripWriteFn.handler, 'POST', userId, { changes });
const scheduleFn = require('../../netlify/functions/v2-schedule-trips');
/** 排車只走 command（ADR 0003）：建立行程並把這筆預約的去程排進去 */
const scheduleTrip = (userId, trip, bookingId) => call(scheduleFn.handler, 'POST', userId,
  { trips: [{ ...trip, bookingIds: [bookingId], bookingLegRefs: F.legRefsFor([bookingId]) }] });
const claim = (userId, bookingId, organizationId) => call(claimFn.handler, 'POST', userId, { bookingId, organizationId });
const cancel = (userId, bookingId) => call(cancelFn.handler, 'POST', userId, { bookingId, reasonCode: 'requester_no_longer_needed' });
const load = (userId) => call(loadFn.handler, 'GET', userId);
const row = async (collection, id) => (await admin.query(
  'select organization_id, data from app_state where collection = $1 and id = $2', [collection, id])).rows[0];
const sees = (loaded, collection, id) => ((loaded.data && loaded.data.collections[collection]) || []).some((r) => r.id === id);
const inPool = (loaded, id) => ((loaded.data && loaded.data.pool) || []).some((r) => r.id === id);

function booking(id, extra = {}) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00', pickupAddress: ADDRESS, destination: '臺北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    legs: [F.outboundLeg(id)],
    ...extra
  };
}
/** 承接機構的調度員以預約端點更新預約（模擬前端 transition 後送出的整筆資料）。 */
async function opsUpdate(userId, id, patch) {
  const current = (await row('bookings', id)).data;
  return writeBooking(userId, { ...current, ...patch });
}
async function newClaimed(id) {
  const c = await writeBooking(U.req, booking(id));
  const k = await claim(U.dspA, id, ORG_A);
  return c.status === 200 && k.status === 200;
}

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, tax_id, contact_phone, active) values
      ('${ORG_A}','transport_provider','合成承運 A','12345678','02-1111-2222',true),
      ('${ORG_B}','transport_provider','合成承運 B','87654321','02-3333-4444',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req}','合成需求者','+886944000001','none',true),
      ('${U.dspA}','合成調度 A','+886944000002','none',true),
      ('${U.dspB}','合成調度 B','+886944000003','none',true),
      ('${U.drvA}','合成司機 A','+886944000004','none',true),
      ('${U.drvB}','合成司機 B','+886944000005','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-ACC-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-ACC-DSPA','${U.dspA}','${ORG_A}','dispatcher','active'),
      ('M-ACC-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-ACC-DRVA','${U.drvA}','${ORG_A}','driver','active'),
      ('M-ACC-DRVB','${U.drvB}','${ORG_B}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values
      ('${DRIVER_A}','${U.drvA}','${ORG_A}','on_duty',true),
      ('${DRIVER_B}','${U.drvB}','${ORG_B}','on_duty',true);
  `);

  console.log('--- 建立與狀態規則 ---');
  const created = await writeBooking(U.req, booking('BKG-ACC-1'));
  record('需求者建立公開預約', created.status === 200, outcome(created));
  const viaState = await mutate(U.req, [{ collection: 'bookings', id: 'BKG-ACC-X', record: booking('BKG-ACC-X') }]);
  record('一般寫入端點不接受預約', viaState.status === 403 && viaState.error.code === 'COLLECTION_FORBIDDEN', outcome(viaState));
  const forgedOwner = await writeBooking(U.req, booking('BKG-ACC-2', { requestedByUserId: U.dspB }));
  record('不能替其他帳號建立預約', forgedOwner.status === 400, outcome(forgedOwner));
  const selfClaim = await writeBooking(U.req, { ...(await row('bookings', 'BKG-ACC-1')).data, state: 'claimed', organizationId: ORG_A });
  record('需求者不能自己把預約改成已承接', selfClaim.status === 400 && (await row('bookings', 'BKG-ACC-1')).organization_id === null, outcome(selfClaim));
  const expire = await writeBooking(U.req, { ...(await row('bookings', 'BKG-ACC-1')).data, pickupTime: '10:00' });
  record('需求者可以修改公開中的預約', expire.status === 200, outcome(expire));
  const forgedFields = await writeBooking(U.req, { ...(await row('bookings', 'BKG-ACC-1')).data, claimedByUserId: U.dspA, cancelledAt: '2099-01-01T00:00:00Z' });
  const afterForged = (await row('bookings', 'BKG-ACC-1')).data;
  record('伺服器決定的欄位（承接人、取消紀錄）沿用資料庫的值', forgedFields.status === 200
    && !afterForged.claimedByUserId && !afterForged.cancelledAt, JSON.stringify({ c: afterForged.claimedByUserId, x: afterForged.cancelledAt }));

  console.log('--- 承接機構退回公開池 ---');
  record('（前提）A 接案', (await claim(U.dspA, 'BKG-ACC-1', ORG_A)).status === 200);
  const aSees = await load(U.dspA);
  record('承接機構 A 看得到完整預約', sees(aSees, 'bookings', 'BKG-ACC-1'));
  const bBefore = await load(U.dspB);
  record('其他機構 B 看不到這筆預約', !sees(bBefore, 'bookings', 'BKG-ACC-1') && !JSON.stringify(bBefore.data.collections).includes('188號'));
  const release = await opsUpdate(U.dspA, 'BKG-ACC-1', { state: 'open', claimStatus: 'open', status: 'open', organizationId: null, claimedByUserId: null, claimedAt: null });
  const released = await row('bookings', 'BKG-ACC-1');
  record('A 退回公開池：organization_id 清空，記下前一個承接機構', release.status === 200 && released.organization_id === null
    && JSON.stringify(released.data.previousOrganizationIds) === JSON.stringify([ORG_A]), outcome(release));
  const aAfter = await load(U.dspA);
  record('退回後 A 立即讀不到這筆預約的個資（只在遮蔽的需求池裡）',
    !sees(aAfter, 'bookings', 'BKG-ACC-1') && inPool(aAfter, 'BKG-ACC-1')
      && !JSON.stringify(aAfter.data.collections).includes('188號'));
  // A 已經看不到這筆，伺服器把它當成新增：帶著需求者欄位會先被 400 擋下，不帶則撞上 RLS（403）
  const aWriteBack = await opsUpdate(U.dspA, 'BKG-ACC-1', { state: 'claimed', organizationId: ORG_A });
  const aWriteBack2 = await opsUpdate(U.dspA, 'BKG-ACC-1', { state: 'claimed', organizationId: ORG_A, requestedByUserId: null });
  const stillOpen = await row('bookings', 'BKG-ACC-1');
  record('退回後 A 不能再寫這筆預約', [400, 403].includes(aWriteBack.status) && aWriteBack2.status === 403
    && stillOpen.organization_id === null && stillOpen.data.state === 'open', `${outcome(aWriteBack)} / ${outcome(aWriteBack2)}`);
  const bClaim = await claim(U.dspB, 'BKG-ACC-1', ORG_B);
  record('B 可以重新接案並看到完整預約', bClaim.status === 200 && sees(await load(U.dspB), 'bookings', 'BKG-ACC-1'), outcome(bClaim));

  console.log('--- 不受理 ---');
  record('（前提）A 接第二筆', await newClaimed('BKG-ACC-3'));
  const reject = await opsUpdate(U.dspA, 'BKG-ACC-3', { state: 'rejected', claimStatus: 'rejected', status: 'rejected' });
  record('A 不受理：原機構立即讀不到', reject.status === 200 && (await row('bookings', 'BKG-ACC-3')).organization_id === null
    && !sees(await load(U.dspA), 'bookings', 'BKG-ACC-3'), outcome(reject));
  const reqSeesRejected = await load(U.req);
  record('需求者仍看得到自己被不受理的預約', sees(reqSeesRejected, 'bookings', 'BKG-ACC-3'));

  console.log('--- 需求者重大修改需重新承接 ---');
  record('（前提）A 接第三筆', await newClaimed('BKG-ACC-4'));
  const amend = await writeBooking(U.req, { ...(await row('bookings', 'BKG-ACC-4')).data,
    pickupAddress: '新北市板橋區縣民大道二段7號', state: 'open', claimStatus: 'open', status: 'open', organizationId: null });
  record('需求者改地址讓原承接失效：A 立即讀不到、預約回到需求池', amend.status === 200
    && (await row('bookings', 'BKG-ACC-4')).organization_id === null && !sees(await load(U.dspA), 'bookings', 'BKG-ACC-4')
    && inPool(await load(U.dspA), 'BKG-ACC-4'), outcome(amend));

  console.log('--- 排車後的規則 ---');
  record('（前提）A 接第四筆', await newClaimed('BKG-ACC-5'));
  const tripId = 'TRP-ACC-5';
  const trip = F.makeTrip({ id: tripId, organizationId: ORG_A, driverId: DRIVER_A, vehicleId: 'VEH-ACC-A',
    bookingId: 'BKG-ACC-5', startAt: F.addMinutes(new Date().toISOString(), 24 * 60),
    extra: { pickupAddress: ADDRESS, passengerSummary: '合成需求者' } });
  const schedule = await scheduleTrip(U.dspA, trip, 'BKG-ACC-5');
  record('A 排車：預約 scheduled、行程寫入', schedule.status === 200 && (await row('bookings', 'BKG-ACC-5')).data.state === 'scheduled'
    && Boolean(await row('trips', tripId)), outcome(schedule));
  const lockedEdit = await writeBooking(U.req, { ...(await row('bookings', 'BKG-ACC-5')).data, pickupTime: '11:00' });
  record('排車後需求者不能改時間', lockedEdit.status === 400, outcome(lockedEdit));
  const backToOpen = await opsUpdate(U.dspA, 'BKG-ACC-5', { state: 'open' });
  record('已排車的預約不能直接退回公開池', backToOpen.status === 400, outcome(backToOpen));
  const opsCancel = await opsUpdate(U.dspA, 'BKG-ACC-5', { state: 'cancelled' });
  record('預約端點不接受改成已取消', opsCancel.status === 400, outcome(opsCancel));
  const driverRead = await load(U.drvA);
  record('司機讀得到指派給自己的行程', sees(driverRead, 'trips', tripId));

  console.log('--- 需求者取消 ---');
  const cancelled = await cancel(U.req, 'BKG-ACC-5');
  record('需求者取消已排車預約', cancelled.status === 200, outcome(cancelled));
  const bRow = await row('bookings', 'BKG-ACC-5');
  record('取消後預約的 organization_id 清空、記下前一個承接機構', bRow.organization_id === null
    && JSON.stringify(bRow.data.previousOrganizationIds) === JSON.stringify([ORG_A]));
  const aAfterCancel = await load(U.dspA);
  record('取消後 A 讀不到這筆預約', !sees(aAfterCancel, 'bookings', 'BKG-ACC-5'));
  const tRow = await row('trips', tripId);
  const tripText = JSON.stringify(tRow.data);
  record('被取消的行程仍屬於 A（營運紀錄），狀態 cancelled', tRow.organization_id === ORG_A && tRow.data.status === 'cancelled');
  record('被取消的行程移除乘客姓名、電話、完整地址', !tripText.includes('188號') && !tripText.includes('0911000001')
    && !tripText.includes('合成乘客') && tRow.data.pickupAddress === '新北市板橋區' && Boolean(tRow.data.piiRedactedAt),
    tRow.data.pickupAddress);
  const aTrip = (aAfterCancel.data.collections.trips || []).find((t) => t.id === tripId);
  record('A 讀到的取消行程沒有個資', Boolean(aTrip) && !JSON.stringify(aTrip).includes('188號'));
  const inProgress = 'BKG-ACC-6';
  record('（前提）A 接第五筆', await newClaimed(inProgress));
  const runTrip = F.makeTrip({ id: 'TRP-ACC-6', organizationId: ORG_A, driverId: DRIVER_A, vehicleId: 'VEH-ACC-A',
    bookingId: inProgress, startAt: new Date().toISOString() });
  await scheduleTrip(U.dspA, runTrip, inProgress);
  await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-6', expectedRevision: 1, record: { ...runTrip, status: 'in_progress' } }]);
  const cancelRunning = await cancel(U.req, inProgress);
  record('已開始的行程取消被拒，並說明原因', cancelRunning.status === 400 && /已開始/.test(cancelRunning.error.message)
    && (await row('bookings', inProgress)).organization_id === ORG_A, outcome(cancelRunning));

  console.log('--- 行程寫入規則（跨機構隔離）---');
  const tripRow = async (id) => row('trips', id);
  const baseTrip = (id, extra = {}) => F.makeTrip({ id, organizationId: ORG_A, driverId: DRIVER_A, vehicleId: 'VEH-ACC-A',
    startAt: F.addMinutes(new Date().toISOString(), 48 * 60), extra });
  const viaStateTrip = await mutate(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-X', record: baseTrip('TRP-ACC-X') }]);
  record('行程不能從一般寫入端點寫', viaStateTrip.status === 403 && viaStateTrip.error.code === 'COLLECTION_FORBIDDEN', outcome(viaStateTrip));
  const viaStateCancel = await mutate(U.req, [{ collection: 'cancellations', id: 'CXL-1', record: { id: 'CXL-1', bookingId: 'BKG-ACC-1' } }]);
  record('取消紀錄不能從一般寫入端點寫', viaStateCancel.status === 403 && viaStateCancel.error.code === 'COLLECTION_FORBIDDEN', outcome(viaStateCancel));
  const bForA = await writeTrips(U.dspB, [{ collection: 'trips', id: 'TRP-ACC-B4A', record: baseTrip('TRP-ACC-B4A') }]);
  record('B 的調度員不能替 A 建立行程', bForA.status === 403 && !(await tripRow('TRP-ACC-B4A')), outcome(bForA));
  const reqTrip = await writeTrips(U.req, [{ collection: 'trips', id: 'TRP-ACC-REQ', record: baseTrip('TRP-ACC-REQ') }]);
  record('需求者不能建立行程', reqTrip.status === 403, outcome(reqTrip));
  const otherDriver = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-D', record: baseTrip('TRP-ACC-D', { driverId: DRIVER_B }) }]);
  record('A 不能指派 B 的司機', otherDriver.status === 400 && /司機/.test(otherDriver.error.message) && !(await tripRow('TRP-ACC-D')), outcome(otherDriver));
  await mutate(U.dspB, [{ collection: 'vehicles', id: 'VEH-ACC-B', record: { id: 'VEH-ACC-B', organizationId: ORG_B, plate: 'B-0001' } }]);
  const otherVehicle = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-V', record: baseTrip('TRP-ACC-V', { vehicleId: 'VEH-ACC-B' }) }]);
  record('A 不能指派 B 的車輛', otherVehicle.status === 400 && /車輛/.test(otherVehicle.error.message), outcome(otherVehicle));
  const otherBooking = await scheduleTrip(U.dspA, baseTrip('TRP-ACC-BK'), 'BKG-ACC-1');
  record('A 不能把 B 承接的預約排進自己的行程', [403, 404].includes(otherBooking.status) && !(await row('trips', 'TRP-ACC-BK')), outcome(otherBooking));
  const viaTripWrite = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-BK2',
    record: baseTrip('TRP-ACC-BK2', { bookingId: 'BKG-ACC-1', bookingIds: ['BKG-ACC-1'] }) }]);
  record('行程寫入不能把預約排進行程（排車只走 command）', viaTripWrite.status === 400 && /排車功能/.test(viaTripWrite.error.message), outcome(viaTripWrite));
  const startedNew = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-S', record: baseTrip('TRP-ACC-S', { status: 'in_progress' }) }]);
  record('新行程不能直接是進行中', startedNew.status === 400, outcome(startedNew));
  const running = await tripRow('TRP-ACC-6');
  const cancelRunningTrip = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-6', expectedRevision: 2,
    record: { ...running.data, status: 'cancelled' } }]);
  record('已開始的行程不能由調度取消，回傳改用中斷的說明', cancelRunningTrip.status === 400 && /中斷/.test(cancelRunningTrip.error.message)
    && (await tripRow('TRP-ACC-6')).data.status === 'in_progress', outcome(cancelRunningTrip));
  const moveOrg = await writeTrips(U.dspA, [{ collection: 'trips', id: 'TRP-ACC-6', expectedRevision: 2,
    record: { ...running.data, organizationId: ORG_B, note: '合成備註' } }]);
  const moved = await tripRow('TRP-ACC-6');
  record('行程的機構不能改', moveOrg.status === 200 && moved.organization_id === ORG_A && moved.data.organizationId === ORG_A, outcome(moveOrg));
  const delTrip = await call(tripWriteFn.handler, 'POST', U.dspA, { changes: [{ collection: 'trips', id: 'TRP-ACC-6', deleted: true, record: { id: 'TRP-ACC-6' } }] });
  record('行程不能刪除', delTrip.status === 400, outcome(delTrip));
  const bTrips = await load(U.dspB);
  record('B 讀不到 A 的行程與司機', !sees(bTrips, 'trips', 'TRP-ACC-6') && !(bTrips.data.collections.drivers || []).some((d) => d.id === DRIVER_A));
  const drvBLoad = await load(U.drvB);
  record('B 的司機讀不到 A 的行程', !sees(drvBLoad, 'trips', 'TRP-ACC-6') && !sees(drvBLoad, 'trips', tripId));

  console.log('--- 需求者只看得到承接單位名稱 ---');
  const reqLoad = await load(U.req);
  const orgs = reqLoad.data.collections.organizations || [];
  const orgB = orgs.find((o) => o.id === ORG_B);
  record('需求者看得到承接單位 B 的名稱', Boolean(orgB) && orgB.name === '合成承運 B', JSON.stringify(orgB));
  record('只有名稱：沒有統編、電話、審核資料', orgB && !('taxId' in orgB) && !('contactPhone' in orgB)
    && !('application' in orgB) && !JSON.stringify(orgs).includes('87654321'));
  record('看不到承接單位的成員', !(reqLoad.data.collections.memberships || []).some((m) => m.organizationId === ORG_B)
    && !(reqLoad.data.collections.users || []).some((u) => u.id === U.dspB));
  record('沒有承接過自己預約的機構（A 已撤銷）看不到名稱', !orgs.some((o) => o.id === ORG_A && o.name)
    || (reqLoad.data.collections.bookings || []).some((b) => b.organizationId === ORG_A));
  const reqBooking = (reqLoad.data.collections.bookings || []).find((b) => b.id === 'BKG-ACC-1');
  record('需求者看到自己的預約已被 B 承接', reqBooking && reqBooking.state === 'claimed' && reqBooking.organizationId === ORG_B);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
