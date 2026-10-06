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
    ['scheduled', 'partially_scheduled', 'unschedule', 'ops'],
    ['scheduled', 'cancelled', 'cancel', 'owner']
  ].map((edge) => Object.freeze(edge)));

  // 這些動作有專用端點（v2-claim-booking、v2-cancel-booking），一般的預約寫入不接受
  const DEDICATED_BOOKING_ACTIONS = Object.freeze(['claim', 'cancel']);
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
    TRIP_STATUSES, TRIP_STATUS_TRANSITIONS, TRIP_CORRECTION_TRANSITIONS,
    canTripTransition
  });
});
