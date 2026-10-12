'use strict';
/**
 * js/lifecycle.js 的離線測試：前端與伺服器共用的預約、行程狀態轉換。
 *
 * 也確認兩邊真的用同一份：瀏覽器在 app.js 之前載入它、伺服器規則 require 它，
 * 沒有任何一邊再自己寫一份轉換表。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'js', 'lifecycle.js'));
const bookingRules = require(path.join(ROOT, 'netlify', 'functions', '_booking-rules.js'));
const tripRules = require(path.join(ROOT, 'netlify', 'functions', '_trip-rules.js'));
const { readFrontendSource } = require(path.join(ROOT, 'tools', '_frontend-source.js'));

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };
const sorted = (table) => Object.fromEntries(Object.entries(table).sort().map(([k, v]) => [k, [...v].sort()]));

ok('一般預約寫入：需求者只能改公開與已承接的預約，重大修改可退回公開', () => {
  assert.deepEqual(sorted(L.bookingWriteTransitions('owner')), {
    claimed: ['claimed', 'open'],
    open: ['expired', 'open']
  });
});
ok('一般預約寫入：承接機構可以退回、不受理、逾期；排車狀態只由排車 command 改變', () => {
  assert.deepEqual(sorted(L.bookingWriteTransitions('ops')), {
    claimed: ['claimed', 'expired', 'open', 'rejected'],
    partially_scheduled: ['partially_scheduled'],
    scheduled: ['scheduled']
  });
});
ok('接案、取消、排車有專用端點，一般預約寫入不接受', () => {
  for (const role of ['owner', 'ops']) {
    const t = L.bookingWriteTransitions(role);
    assert.ok(!(t.open || []).includes('claimed'), role);
    for (const tos of Object.values(t)) assert.ok(!tos.includes('cancelled'), role);
    assert.ok(!(t.claimed || []).some((to) => ['partially_scheduled', 'scheduled'].includes(to)), role);
    assert.ok(!(t.partially_scheduled || []).includes('scheduled'), role);
  }
});
ok('前端的動作：每個動作從每個狀態最多一個目標，只有排車可能是部分或全部', () => {
  assert.deepEqual(L.bookingTargets('open', 'claim'), ['claimed']);
  assert.deepEqual(L.bookingTargets('claimed', 'release'), ['open']);
  assert.deepEqual(L.bookingTargets('claimed', 'reject'), ['rejected']);
  assert.deepEqual(L.bookingTargets('scheduled', 'cancel'), ['cancelled']);
  assert.deepEqual(L.bookingTargets('scheduled', 'release'), []);
  assert.deepEqual(L.bookingTargets('claimed', 'schedule').sort(), ['partially_scheduled', 'scheduled']);
  const multi = new Set();
  for (const from of L.BOOKING_STATES) for (const [, , action] of L.BOOKING_EDGES) {
    if (L.bookingTargets(from, action).length > 1) multi.add(action);
  }
  assert.deepEqual([...multi], ['schedule']);
});
ok('每一條轉換的狀態都是合法狀態，結案狀態沒有出路', () => {
  for (const [from, to] of L.BOOKING_EDGES) {
    assert.ok(L.BOOKING_STATES.includes(from) && L.BOOKING_STATES.includes(to), `${from}>${to}`);
  }
  for (const end of ['rejected', 'cancelled', 'expired']) {
    assert.ok(!L.BOOKING_EDGES.some(([from]) => from === end), end);
  }
});
ok('行程：已開始不能取消、結束不能再改；修正只能退一步', () => {
  assert.equal(L.canTripTransition('scheduled', 'cancelled'), true);
  assert.equal(L.canTripTransition('in_progress', 'cancelled'), false);
  assert.equal(L.canTripTransition('completed', 'in_progress'), false);
  assert.equal(L.canTripTransition('completed', 'in_progress', { correction: true }), true);
  assert.equal(L.canTripTransition('in_progress', 'scheduled', { correction: true }), true);
  assert.equal(L.canTripTransition('cancelled', 'cancelled'), true);
  assert.equal(L.canTripTransition('bogus', 'bogus'), false);
});
ok('伺服器的預約與行程規則用的就是這一份', () => {
  assert.deepEqual(bookingRules.OWNER_TRANSITIONS, L.bookingWriteTransitions('owner'));
  assert.deepEqual(bookingRules.OPS_TRANSITIONS, L.bookingWriteTransitions('ops'));
  assert.equal(tripRules.TRIP_STATUS_TRANSITIONS, L.TRIP_STATUS_TRANSITIONS);
});
ok('瀏覽器在 app.js 之前載入 lifecycle.js，app.js 沒有自己的轉換表', () => {
  const { scripts } = readFrontendSource();
  const order = scripts.map((s) => s.src);
  assert.ok(order.indexOf('js/lifecycle.js') >= 0 && order.indexOf('js/lifecycle.js') < order.indexOf('js/app.js'), order.join(','));
  const app = scripts.find((s) => s.src === 'js/app.js').code;
  assert.ok(!/BOOKING_TRANSITIONS\s*=/.test(app));
  assert.ok(/TRIP_STATUS_TRANSITIONS=LIFECYCLE\.TRIP_STATUS_TRANSITIONS/.test(app));
  // app.js 分成多個區塊；LIFECYCLE 必須宣告在最外層，否則其他區塊會 ReferenceError，整個網站打不開
  const outer = app.slice(0, app.indexOf('\n{'));
  assert.ok(/\nconst LIFECYCLE = window\.CareRideLifecycle;/.test(outer), 'LIFECYCLE 要宣告在 app.js 最外層、第一個區塊之前');
});
ok('在瀏覽器環境（沒有 module）掛到 window.CareRideLifecycle', () => {
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'lifecycle.js'), 'utf8'), sandbox);
  // vm 的陣列來自另一個 realm，用 JSON 比較內容
  assert.equal(JSON.stringify(sandbox.self.CareRideLifecycle.bookingTargets('open', 'claim')), '["claimed"]');
});

const legOf = (id, direction, sequence, extra = {}) => ({ id: `B1_${direction}`, sequence, direction, label: direction === 'return' ? '回程' : '去程',
  status: 'pending', requestedPickupAt: '2099-01-01T01:00:00.000Z', tripId: null, ...extra });
const claimedBooking = (legs) => ({ id: 'B1', state: 'claimed', organizationId: 'ORG-A', version: 3, legs });
const AT = '2099-01-01T00:00:00.000Z';

ok('排車：單程排完是已排車，不改傳入的預約', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1)]);
  const r = L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.to, 'scheduled');
  assert.equal(r.booking.version, 4);
  assert.equal(r.booking.tripId, 'T1');
  assert.equal(r.booking.legs[0].status, 'scheduled');
  assert.equal(b.legs[0].status, 'pending');
  assert.equal(b.state, 'claimed');
});
ok('排車：來回只排一段是部分排車，再排另一段變已排車', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1), legOf('B1', 'return', 2)]);
  const first = L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT });
  assert.equal(first.to, 'partially_scheduled');
  assert.equal(first.leg.direction, 'outbound');
  const second = L.scheduleBookingLeg(first.booking, { legId: 'B1_return', tripId: 'T2', organizationId: 'ORG-A', at: AT });
  assert.equal(second.to, 'scheduled');
  assert.equal(second.booking.tripId, 'T1');
});
ok('排車：已排的段、別家機構、公開中的預約、缺時間都不行', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1, { status: 'scheduled', tripId: 'T0' })]);
  assert.equal(L.scheduleBookingLeg(b, { legId: 'B1_outbound', tripId: 'T1', organizationId: 'ORG-A', at: AT }).ok, false);
  const c = claimedBooking([legOf('B1', 'outbound', 1)]);
  assert.equal(L.scheduleBookingLeg(c, { tripId: 'T1', organizationId: 'ORG-B', at: AT }).ok, false);
  assert.equal(L.scheduleBookingLeg({ ...c, state: 'open', organizationId: null }, { tripId: 'T1', at: AT }).ok, false);
  const d = claimedBooking([legOf('B1', 'outbound', 1, { requestedPickupAt: null })]);
  assert.equal(L.scheduleBookingLeg(d, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).ok, false);
  assert.equal(L.scheduleBookingLeg(c, { legId: 'NOPE', tripId: 'T1', organizationId: 'ORG-A', at: AT }).ok, false);
});
ok('排車：平台指定機構已移除（#110），殘留的指定欄位不影響負責機構', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1, { assignedOrganizationId: 'ORG-B' })]);
  assert.equal(L.legResponsibleOrganization(b, b.legs[0]), 'ORG-A');
  assert.equal(L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).ok, true);
  assert.equal(L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-B', at: AT }).ok, false);
});

ok('排車狀態集合由這裡提供，伺服器規則與排車端點共用', () => {
  assert.deepEqual([...L.BOOKING_SCHEDULING_STATES].sort(), ['partially_scheduled', 'scheduled']);
});
ok('取消行程（#76 決策「排好的退回部分排車」）：這趟的去程退回待排車，已排車的預約退回部分排車', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1), legOf('B1', 'return', 2)]);
  const s1 = L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).booking;
  const s2 = L.scheduleBookingLeg(s1, { legId: 'B1_return', tripId: 'T2', organizationId: 'ORG-A', at: AT }).booking;
  assert.equal(s2.state, 'scheduled');
  const r = L.unscheduleTripLegs(s2, { tripId: 'T1', at: AT });
  assert.equal(r.changed, true);
  assert.equal(r.from, 'scheduled'); assert.equal(r.to, 'partially_scheduled');
  const out = r.booking.legs.find((l) => l.direction === 'outbound');
  assert.deepEqual([out.status, out.tripId, out.scheduledOrganizationId, out.scheduledAt], ['pending', null, null, null]);
  assert.equal(r.booking.legs.find((l) => l.direction === 'return').tripId, 'T2');
  assert.equal(r.booking.tripId, 'T2');
  assert.equal(s2.legs[0].status, 'scheduled', '不改傳入的預約');
  // 退回後可以再排
  assert.equal(L.scheduleBookingLeg(r.booking, { tripId: 'T3', organizationId: 'ORG-A', at: AT }).ok, true);
});
ok('取消行程：部分排車的預約維持部分排車；沒有排在這趟的預約不變', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1), legOf('B1', 'return', 2)]);
  const s1 = L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).booking;
  const r = L.unscheduleTripLegs(s1, { tripId: 'T1', at: AT });
  assert.equal(r.to, 'partially_scheduled'); assert.equal(r.booking.tripId, null);
  assert.equal(L.unscheduleTripLegs(s1, { tripId: 'T9', at: AT }).changed, false);
});
ok('退回部分排車只由伺服器在取消行程時做，一般預約寫入不接受', () => {
  assert.deepEqual(L.bookingTargets('scheduled', 'unschedule'), ['partially_scheduled']);
  assert.ok(!(L.bookingWriteTransitions('ops').scheduled || []).includes('partially_scheduled'));
});

// ---------------------------------------------------------------- 退回一段到需求池、收回（#112，ADR 0004）
const roundTrip = (extra = {}) => ({ ...claimedBooking([legOf('B1', 'outbound', 1), legOf('B1', 'return', 2, { requestedPickupAt: '2099-01-01T08:00:00.000Z' })]),
  tripType: '來回', splitLegConsent: true, ...extra });
const releaseReturn = (b, org = 'ORG-A') => L.releaseLeg(b, { legId: 'B1_return', organizationId: org, actorUserId: 'U1', at: AT });
ok('退回一段：承接機構把還沒排車的回程放回需求池，不改傳入的預約', () => {
  const b = roundTrip();
  const r = releaseReturn(b);
  assert.equal(r.ok, true, r.error);
  const ret = r.booking.legs.find((l) => l.id === 'B1_return');
  assert.equal(L.legPoolStatus(ret), 'in_pool');
  assert.equal(ret.releasedByOrganizationId, 'ORG-A');
  assert.equal(L.legPoolStatus(r.booking.legs[0]), 'primary');
  assert.equal(r.booking.organizationId, 'ORG-A', '預約仍由承接機構負責');
  assert.equal(r.booking.version, 4);
  assert.equal(L.legPoolStatus(b.legs[1]), 'primary', '傳入的預約不變');
});
ok('退回一段：在需求池的那一段沒有負責機構，也不會被當成下一個待排車的段', () => {
  const r = releaseReturn(roundTrip());
  assert.equal(L.legResponsibleOrganization(r.booking, r.booking.legs[1]), null);
  const s = L.scheduleBookingLeg(r.booking, { tripId: 'T1', organizationId: 'ORG-A', at: AT });
  assert.equal(s.ok, true, s.error); assert.equal(s.leg.id, 'B1_outbound');
  assert.equal(s.to, 'partially_scheduled', '回程在需求池，排完去程只算部分排車');
  const again = L.scheduleBookingLeg(s.booking, { legId: 'B1_return', tripId: 'T2', organizationId: 'ORG-A', at: AT });
  assert.equal(again.ok, false); assert.match(again.error, /需求池/);
});
ok('退回一段被拒：需求者沒同意分段載送、沒有這個欄位、單程', () => {
  assert.match(releaseReturn(roundTrip({ splitLegConsent: false })).error, /沒有同意分段載送/);
  const noField = roundTrip(); delete noField.splitLegConsent;
  assert.match(releaseReturn(noField).error, /沒有同意分段載送/);
  const oneWay = { ...claimedBooking([legOf('B1', 'outbound', 1)]), tripType: '單程' };
  assert.match(L.releaseLeg(oneWay, { legId: 'B1_outbound', organizationId: 'ORG-A', actorUserId: 'U1', at: AT }).error, /來回/);
});
ok('退回一段被拒：那一段已排車、不是承接機構、預約不在承接中、另一段已在需求池、找不到那一段', () => {
  const scheduled = L.scheduleBookingLeg(roundTrip(), { legId: 'B1_return', tripId: 'T1', organizationId: 'ORG-A', at: AT }).booking;
  assert.match(releaseReturn(scheduled).error, /已經排車/);
  assert.match(releaseReturn(roundTrip(), 'ORG-B').error, /承接機構/);
  assert.match(releaseReturn(roundTrip({ state: 'open', organizationId: null })).error, /承接/);
  const oneOut = L.releaseLeg(roundTrip(), { legId: 'B1_outbound', organizationId: 'ORG-A', actorUserId: 'U1', at: AT }).booking;
  assert.match(releaseReturn(oneOut).error, /整筆退回/);
  assert.match(L.releaseLeg(roundTrip(), { legId: 'NOPE', organizationId: 'ORG-A', actorUserId: 'U1', at: AT }).error, /找不到/);
  assert.match(releaseReturn(releaseReturn(roundTrip()).booking).error, /已經在需求池/);
});
ok('收回一段：承接機構把還在需求池的那一段拿回來；不在需求池或不是承接機構被拒', () => {
  const released = releaseReturn(roundTrip()).booking;
  const r = L.reclaimLeg(released, { legId: 'B1_return', organizationId: 'ORG-A', at: AT });
  assert.equal(r.ok, true, r.error);
  const ret = r.booking.legs[1];
  assert.equal(L.legPoolStatus(ret), 'primary');
  assert.ok(!('releasedAt' in ret) && !('releasedByOrganizationId' in ret));
  assert.equal(L.legResponsibleOrganization(r.booking, ret), 'ORG-A');
  assert.match(L.reclaimLeg(roundTrip(), { legId: 'B1_return', organizationId: 'ORG-A', at: AT }).error, /不在需求池/);
  assert.match(L.reclaimLeg(released, { legId: 'B1_return', organizationId: 'ORG-B', at: AT }).error, /承接機構/);
});
ok('整筆退回時去程／回程的需求池狀態一併清掉', () => {
  const released = releaseReturn(roundTrip()).booking;
  const cleared = L.clearLegPool(released);
  assert.ok(cleared.legs.every((l) => L.legPoolStatus(l) === 'primary' && !('releasedAt' in l)));
});
ok('一般預約寫入：去程／回程的需求池欄位沿用資料庫的值，整筆退回時清掉', () => {
  const stored = releaseReturn(roundTrip()).booking;
  const forged = JSON.parse(JSON.stringify(stored));
  forged.legs[1].poolStatus = 'primary'; delete forged.legs[1].releasedAt;
  forged.legs[0].poolStatus = 'in_pool';
  const kept = bookingRules.checkBookingWrite({ actorUserId: 'U1', record: forged,
    existing: { data: stored, organization_id: 'ORG-A', owner_user_id: 'U9' }, roles: { opsOfExisting: true } }).record;
  assert.equal(L.legPoolStatus(kept.legs[1]), 'in_pool'); assert.equal(kept.legs[1].releasedAt, AT);
  assert.equal(L.legPoolStatus(kept.legs[0]), 'primary');
  const whole = bookingRules.checkBookingWrite({ actorUserId: 'U1', record: { ...stored, state: 'open' },
    existing: { data: stored, organization_id: 'ORG-A', owner_user_id: 'U9' }, roles: { opsOfExisting: true } });
  assert.equal(whole.revoke, true);
  assert.ok(whole.record.legs.every((l) => L.legPoolStatus(l) === 'primary'));
});

// ---------------------------------------------------------------- 接下單一段成為協力機構（#113）
const claimReturn = (b, org = 'ORG-B') => L.claimLeg(b, { legId: 'B1_return', organizationId: org, organizationName: '合成 B', organizationPhone: '02-3333-4444', actorUserId: 'UB', at: AT });
ok('接下單一段：別家機構接下在需求池的回程，成為協力機構；預約仍由承接機構負責', () => {
  const released = releaseReturn(roundTrip()).booking;
  const r = claimReturn(released);
  assert.equal(r.ok, true, r.error);
  const ret = r.booking.legs[1];
  assert.equal(L.legPoolStatus(ret), 'partner');
  assert.equal(ret.partnerOrganizationId, 'ORG-B'); assert.equal(ret.partnerOrganizationName, '合成 B'); assert.equal(ret.partnerOrganizationPhone, '02-3333-4444');
  assert.ok(!('releasedAt' in ret));
  assert.equal(r.booking.organizationId, 'ORG-A');
  assert.equal(L.legResponsibleOrganization(r.booking, ret), 'ORG-B');
  assert.equal(L.legResponsibleOrganization(r.booking, r.booking.legs[0]), 'ORG-A');
});
ok('接下單一段被拒：不在需求池、承接機構自己、預約不在承接中', () => {
  assert.match(claimReturn(roundTrip()).error, /不在需求池/);
  const released = releaseReturn(roundTrip()).booking;
  assert.match(claimReturn(released, 'ORG-A').error, /承接機構/);
  assert.match(claimReturn({ ...released, state: 'cancelled' }).error, /承接/);
  assert.match(claimReturn(claimReturn(released).booking, 'ORG-C').error, /已經有其他機構/);
});
ok('待排車的段依負責機構：承接機構不再看到交給協力機構的段，協力機構的資料只列自己那段', () => {
  const partnered = claimReturn(releaseReturn(roundTrip()).booking).booking;
  assert.equal(L.nextPendingLeg(partnered).id, 'B1_outbound', '承接機構：去程');
  assert.equal(L.nextPendingLeg(partnered, 'ORG-B').id, 'B1_return', '協力機構：回程');
  const outScheduled = L.scheduleBookingLeg(partnered, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).booking;
  assert.equal(L.nextPendingLeg(outScheduled), null, '承接機構排完去程就沒有待排車的段');
  assert.equal(L.nextPendingLeg({ ...outScheduled, partnerView: true, partnerOrganizationId: 'ORG-B' }).id, 'B1_return',
    '協力機構讀到的預約（partnerView）預設看自己那段');
});

// ---------------------------------------------------------------- 解除協力關係（#114）
const partneredTrip = () => ({ ...claimReturn(releaseReturn(roundTrip({ pickupDate: '2099-01-01', pickupTime: '09:00', returnDate: '2099-01-01',
  returnTime: '16:00', pickupAddress: '家', destination: '醫院' })).booking).booking });
ok('協力機構退回自己那段：回到需求池，協力機構不再負責；不能退回另一段', () => {
  const b = partneredTrip();
  const r = L.releaseLeg(b, { legId: 'B1_return', organizationId: 'ORG-B', actorUserId: 'UB', at: AT });
  assert.equal(r.ok, true, r.error);
  assert.equal(L.legPoolStatus(r.booking.legs[1]), 'in_pool');
  assert.equal(r.booking.legs[1].releasedByOrganizationId, 'ORG-B');
  assert.ok(!('partnerOrganizationId' in r.booking.legs[1]));
  assert.match(L.releaseLeg(b, { legId: 'B1_outbound', organizationId: 'ORG-B', actorUserId: 'UB', at: AT }).error, /承接機構/);
  const scheduled = L.scheduleBookingLeg(b, { legId: 'B1_return', tripId: 'TB', organizationId: 'ORG-B', at: AT }).booking;
  assert.match(L.releaseLeg(scheduled, { legId: 'B1_return', organizationId: 'ORG-B', actorUserId: 'UB', at: AT }).error, /已經排車/);
});
ok('需求者修改：改了協力機構那段的時間或地點才解除；改了另一段的時間不影響', () => {
  const b = partneredTrip();
  assert.deepEqual(L.partnerLegsToDissolve(b, { ...b, returnTime: '17:00' }).map((x) => x.legId), ['B1_return']);
  assert.deepEqual(L.partnerLegsToDissolve(b, { ...b, destination: '另一家醫院' }).map((x) => x.legId), ['B1_return'], '地點改了，兩段都受影響');
  assert.deepEqual(L.partnerLegsToDissolve(b, { ...b, pickupTime: '10:00' }), [], '去程是承接機構的');
  assert.deepEqual(L.partnerLegsToDissolve(b, { ...b, specialNeed: '需要協助上下車' }), [], '只改需求不解除');
});
ok('需求者修改：改成單程，協力機構那段被拿掉；解除後那段回到需求池', () => {
  const b = partneredTrip();
  const oneWay = { ...b, tripType: '單程', legs: [b.legs[0]] };
  const d = L.partnerLegsToDissolve(b, oneWay);
  assert.deepEqual(d.map((x) => [x.legId, x.organizationId, x.removed]), [['B1_return', 'ORG-B', true]]);
  const back = L.dissolvePartnerLegs({ ...b, returnTime: '17:00' }, ['B1_return'], { actorUserId: 'U9', at: AT });
  assert.equal(L.legPoolStatus(back.legs[1]), 'in_pool');
  assert.ok(!('partnerOrganizationId' in back.legs[1]) && back.legs[1].releasedByOrganizationId === null);
});

// ---------------------------------------------------------------- 整筆退回限制與升格（#115）
ok('有協力機構時不能整筆退回或不受理', () => {
  assert.equal(L.wholeReleaseBlockedReason(roundTrip()), null);
  assert.match(L.wholeReleaseBlockedReason(partneredTrip()), /協力機構/);
  const stored = partneredTrip();
  assert.throws(() => bookingRules.checkBookingWrite({ actorUserId: 'U1', record: { ...stored, state: 'open' },
    existing: { data: stored, organization_id: 'ORG-A', owner_user_id: 'U9' }, roles: { opsOfExisting: true } }), /協力機構/);
  assert.throws(() => bookingRules.checkBookingWrite({ actorUserId: 'U1', record: { ...stored, state: 'rejected' },
    existing: { data: stored, organization_id: 'ORG-A', owner_user_id: 'U9' }, roles: { opsOfExisting: true } }), /協力機構/);
});
ok('承接機構退回自己那段而另一段有協力機構：協力機構升格為承接機構，退回的那段在需求池', () => {
  const r = L.releaseLeg(partneredTrip(), { legId: 'B1_outbound', organizationId: 'ORG-A', actorUserId: 'U1', at: AT });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.promoted, true);
  assert.equal(r.booking.organizationId, 'ORG-B');
  assert.deepEqual(r.booking.previousOrganizationIds, ['ORG-A']);
  const [out, ret] = r.booking.legs;
  assert.equal(L.legPoolStatus(out), 'in_pool'); assert.equal(out.releasedByOrganizationId, 'ORG-A');
  assert.equal(L.legPoolStatus(ret), 'primary'); assert.ok(!('partnerOrganizationId' in ret));
  assert.equal(L.legResponsibleOrganization(r.booking, ret), 'ORG-B');
  assert.equal(L.legResponsibleOrganization(r.booking, out), null);
});

console.log(`lifecycle: ${pass} passed`);
