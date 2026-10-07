/**
 * 預約與行程的狀態轉換：前端與伺服器共用的唯一一份。
 *
 * 瀏覽器以 <script src="js/lifecycle.js"> 載入（window.CareRideLifecycle），
 * Netlify Functions 以 require('../../js/lifecycle.js') 載入。以前兩邊各有一份、
 * 靠註解「與前端相同」同步，已經出現過不一致；改這裡就是兩邊一起改。
 *
 * 只放純資料與純函式：不讀 DOM、不讀資料庫、不依賴任何其他檔案。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CareRideLifecycle = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOOKING_STATES = Object.freeze(['open', 'claimed', 'partially_scheduled', 'scheduled', 'rejected', 'cancelled', 'expired']);

  // 每一條轉換：[從, 到, 動作, 誰]
  //   owner：需求者本人；ops：承接機構的負責人或調度員
  const BOOKING_EDGES = Object.freeze([
    ['open', 'claimed', 'claim', 'ops'],
    ['open', 'expired', 'expire', 'owner'],
    ['open', 'cancelled', 'cancel', 'owner'],
    ['claimed', 'open', 'release', 'ops'],
    ['claimed', 'open', 'amend', 'owner'],           // 重大修改：原承接失效、重新公開
    ['claimed', 'expired', 'expire', 'ops'],          // 退回公開池時已超過接案期限
    ['claimed', 'rejected', 'reject', 'ops'],
    ['claimed', 'partially_scheduled', 'schedule', 'ops'],
    ['claimed', 'scheduled', 'schedule', 'ops'],
    ['claimed', 'cancelled', 'cancel', 'owner'],
    ['partially_scheduled', 'scheduled', 'schedule', 'ops'],
    ['partially_scheduled', 'cancelled', 'cancel', 'owner'],
    ['scheduled', 'cancelled', 'cancel', 'owner']
  ].map((edge) => Object.freeze(edge)));

  // 這些動作有專用端點（v2-claim-booking、v2-cancel-booking、v2-schedule-trips），一般的預約寫入不接受。
  // 排車只能走 command（ADR 0003），否則會寫出「已排車卻沒有行程」的預約
  const DEDICATED_BOOKING_ACTIONS = Object.freeze(['claim', 'cancel', 'schedule']);
  // 各角色可以「不改狀態、只改內容」的狀態
  const BOOKING_EDITABLE = Object.freeze({
    owner: Object.freeze(['open', 'claimed']),
    ops: Object.freeze(['claimed', 'partially_scheduled', 'scheduled'])
  });
  // 轉到這些狀態時，原承接機構失去存取
  const BOOKING_REVOKE_STATES = Object.freeze(['open', 'rejected', 'expired']);

  /** 這個動作從這個狀態可以到哪些狀態（不分角色）。 */
  function bookingTargets(from, action) {
    return BOOKING_EDGES.filter(([f, , a]) => f === from && a === action).map(([, t]) => t);
  }

  /**
   * 一般預約寫入（v2-booking-write）時，這個角色可以把預約從哪個狀態改到哪些狀態。
   * 回傳 { 從: [到…] }，包含「不改狀態」本身；專用端點負責的動作不在裡面。
   */
  function bookingWriteTransitions(role) {
    const table = {};
    for (const from of BOOKING_EDITABLE[role] || []) table[from] = [from];
    for (const [from, to, action, who] of BOOKING_EDGES) {
      if (who !== role || DEDICATED_BOOKING_ACTIONS.includes(action)) continue;
      (table[from] = table[from] || [from]).includes(to) || table[from].push(to);
    }
    return table;
  }

  // ---------------------------------------------------------------- 預約的去程／回程（leg）排車
  const BOOKING_LEG_STATUS = Object.freeze({ PENDING: 'pending', SCHEDULED: 'scheduled', CANCELLED: 'cancelled' });
  // 去程／回程裡只由排車（scheduleBookingLeg）寫入的欄位；一般預約寫入一律沿用資料庫的值
  const LEG_SCHEDULING_FIELDS = Object.freeze(['status', 'tripId', 'scheduledOrganizationId', 'scheduledAt']);
  const legsOf = (booking) => (booking && Array.isArray(booking.legs) ? booking.legs : []);

  /** 下一個還沒排車的 leg（依 sequence）。 */
  function nextPendingLeg(booking) {
    return legsOf(booking).filter((l) => l.status === BOOKING_LEG_STATUS.PENDING)
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))[0] || null;
  }
  /** 這個 leg 由哪個機構負責：平台指定的機構、已排車的機構，否則是預約的承接機構。 */
  function legResponsibleOrganization(booking, leg) {
    return (leg && (leg.assignedOrganizationId || leg.scheduledOrganizationId)) || (booking && booking.organizationId) || null;
  }

  /**
   * 把預約的一個 leg 排進行程。不改傳入的物件，回傳新的預約。
   *
   * 前端（建立行程前預先檢查）與伺服器（v2-schedule-trips 實際寫入）用同一個函式，
   * 所以兩邊對「能不能排、排完預約變成什麼樣子」的判斷一定一致。
   *
   * @param {object} booking
   * @param {{ legId?: string, tripId: string, organizationId?: string, at: string }} p
   * @returns {{ ok: true, booking, leg, from, to } | { ok: false, error: string }}
   */
  function scheduleBookingLeg(booking, { legId, tripId, organizationId, at }) {
    if (!booking) return { ok: false, error: '找不到預約' };
    const from = String(booking.state || '').trim() || 'open';
    if (!['claimed', 'partially_scheduled'].includes(from)) return { ok: false, error: `預約目前為 ${from}，不能排車` };
    if (!booking.organizationId) return { ok: false, error: '預約尚未有承接機構' };
    if (!tripId) return { ok: false, error: '排車缺少行程' };
    const next = JSON.parse(JSON.stringify(booking));
    const leg = (legId && legsOf(next).find((l) => l.id === legId)) || (!legId && nextPendingLeg(next)) || null;
    if (!leg) return { ok: false, error: '沒有待排車的去程或回程' };
    const responsible = legResponsibleOrganization(next, leg);
    if (!responsible) return { ok: false, error: `${leg.label || '這一段'}還沒有承接機構` };
    if (organizationId && responsible !== organizationId) return { ok: false, error: `${leg.label || '這一段'}的承接機構與行程的機構不同` };
    if (leg.status !== BOOKING_LEG_STATUS.PENDING) return { ok: false, error: `${leg.label || '這一段'}已經排車或不能再排車` };
    if (!leg.requestedPickupAt || Number.isNaN(new Date(leg.requestedPickupAt).getTime())) {
      return { ok: false, error: `${leg.label || '這一段'}缺少有效的接送時間` };
    }

    leg.status = BOOKING_LEG_STATUS.SCHEDULED;
    leg.tripId = tripId;
    leg.scheduledOrganizationId = organizationId || responsible;
    leg.scheduledAt = at;
    const all = legsOf(next).length > 0 && legsOf(next).every((l) => l.status === BOOKING_LEG_STATUS.SCHEDULED);
    const to = all ? 'scheduled' : 'partially_scheduled';
    if (!bookingTargets(from, 'schedule').includes(to)) return { ok: false, error: `預約目前為 ${from}，不能改成 ${to}` };
    next.state = to;
    next.updatedAt = at;
    next.stateChangedAt = at;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    if (all) next.scheduledAt = at;
    // 舊版欄位（畫面與通知還在用）
    const firstScheduled = legsOf(next).find((l) => l.status === BOOKING_LEG_STATUS.SCHEDULED && l.tripId);
    next.status = to;
    next.claimStatus = 'claimed';
    next.tripId = (firstScheduled && firstScheduled.tripId) || (all ? next.tripId : null) || null;
    return { ok: true, booking: next, leg, from, to };
  }

  const TRIP_STATUSES = Object.freeze(['scheduled', 'in_progress', 'interrupted', 'completed', 'cancelled', 'aborted']);
  // 一般流程（已開始的行程不能取消，要用中斷；結束的行程不能再改狀態）
  const TRIP_STATUS_TRANSITIONS = Object.freeze({
    scheduled: Object.freeze(['in_progress', 'cancelled']),
    in_progress: Object.freeze(['interrupted', 'completed']),
    interrupted: Object.freeze(['in_progress', 'aborted']),
    completed: Object.freeze([]),
    cancelled: Object.freeze([]),
    aborted: Object.freeze([])
  });
  // 司機返回上一步、調度修正已完成的行程
  const TRIP_CORRECTION_TRANSITIONS = Object.freeze({
    in_progress: Object.freeze(['scheduled']),
    completed: Object.freeze(['in_progress'])
  });

  /** 行程能不能從 from 改到 to；correction 為 true 時用修正的轉換表。不改狀態一律可以。 */
  function canTripTransition(from, to, { correction = false } = {}) {
    if (from === to) return TRIP_STATUSES.includes(from);
    const table = correction ? TRIP_CORRECTION_TRANSITIONS : TRIP_STATUS_TRANSITIONS;
    return Boolean(table[from] && table[from].includes(to));
  }

  return Object.freeze({
    BOOKING_STATES, BOOKING_EDGES, BOOKING_REVOKE_STATES,
    bookingTargets, bookingWriteTransitions,
    BOOKING_LEG_STATUS, LEG_SCHEDULING_FIELDS, nextPendingLeg, legResponsibleOrganization, scheduleBookingLeg,
    TRIP_STATUSES, TRIP_STATUS_TRANSITIONS, TRIP_CORRECTION_TRANSITIONS,
    canTripTransition
  });
});
