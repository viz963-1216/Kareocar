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
ok('一般預約寫入：承接機構可以退回、不受理、逾期、排車，排好的可以退回部分排車', () => {
  assert.deepEqual(sorted(L.bookingWriteTransitions('ops')), {
    claimed: ['claimed', 'expired', 'open', 'partially_scheduled', 'rejected', 'scheduled'],
    partially_scheduled: ['partially_scheduled', 'scheduled'],
    scheduled: ['partially_scheduled', 'scheduled']
  });
});
ok('接案與取消有專用端點，一般預約寫入不接受', () => {
  for (const role of ['owner', 'ops']) {
    const t = L.bookingWriteTransitions(role);
    assert.ok(!(t.open || []).includes('claimed'), role);
    for (const tos of Object.values(t)) assert.ok(!tos.includes('cancelled'), role);
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
ok('排車：平台指定給其他機構的段，以指定的機構為準', () => {
  const b = claimedBooking([legOf('B1', 'outbound', 1, { assignedOrganizationId: 'ORG-B' })]);
  assert.equal(L.legResponsibleOrganization(b, b.legs[0]), 'ORG-B');
  assert.equal(L.scheduleBookingLeg(b, { tripId: 'T1', organizationId: 'ORG-A', at: AT }).ok, false);
});

console.log(`lifecycle: ${pass} passed`);
