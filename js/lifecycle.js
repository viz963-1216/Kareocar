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
    ['scheduled', 'partially_scheduled', 'unschedule', 'ops'], // 調度取消行程：這趟的去程／回程退回待排車
    ['partially_scheduled', 'cancelled', 'cancel', 'owner'],
    ['scheduled', 'cancelled', 'cancel', 'owner']
  ].map((edge) => Object.freeze(edge)));

  // 這些動作有專用端點（v2-claim-booking、v2-cancel-booking、v2-schedule-trips），一般的預約寫入不接受。
  // 排車只能走 command（ADR 0003），否則會寫出「已排車卻沒有行程」的預約；
  // 退回部分排車只在調度取消行程時由伺服器做（v2-trip-write），否則會寫出「待排車卻還掛著行程」的預約
  const DEDICATED_BOOKING_ACTIONS = Object.freeze(['claim', 'cancel', 'schedule', 'unschedule']);
  // 進入排車之後的預約狀態；只由排車 command 與取消行程改變
  const BOOKING_SCHEDULING_STATES = Object.freeze(['partially_scheduled', 'scheduled']);
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

  // ---------------------------------------------------------------- 去程／回程在需求池的狀態（ADR 0004）
  // primary：承接機構負責；in_pool：在需求池等別家接；partner：協力機構負責；unclaimed：沒有機構承接
  const LEG_POOL_STATUS = Object.freeze({ PRIMARY: 'primary', IN_POOL: 'in_pool', PARTNER: 'partner', UNCLAIMED: 'unclaimed' });
  // 只由退回／接單一段／收回等專用端點寫入的欄位；一般預約寫入一律沿用資料庫的值
  const LEG_POOL_FIELDS = Object.freeze(['poolStatus', 'partnerOrganizationId', 'partnerOrganizationName', 'partnerOrganizationPhone',
    'partnerClaimedAt', 'partnerClaimedByUserId', 'releasedAt', 'releasedByUserId', 'releasedByOrganizationId', 'unclaimedAt']);
  const legPoolStatus = (leg) => (leg && leg.poolStatus) || LEG_POOL_STATUS.PRIMARY;
  const legLabel = (leg) => (leg && leg.label) || '這一段';

  /**
   * 下一個還沒排車、由這個機構負責的 leg（依 sequence）。沒指定機構時：協力機構讀到的預約（partnerView）
   * 看協力機構自己那段，其他看承接機構負責的段。在需求池或沒有機構承接的段都不算。
   */
  function nextPendingLeg(booking, organizationId) {
    const org = organizationId || (booking && booking.partnerView ? booking.partnerOrganizationId : booking && booking.organizationId) || null;
    return legsOf(booking).filter((l) => l.status === BOOKING_LEG_STATUS.PENDING
        && ![LEG_POOL_STATUS.IN_POOL, LEG_POOL_STATUS.UNCLAIMED].includes(legPoolStatus(l))
        && legResponsibleOrganization(booking, l) === org)
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))[0] || null;
  }
  /**
   * 這個 leg 由哪個機構負責：已排車的機構；協力機構；在需求池或沒有機構承接時沒有；否則是承接機構。
   * （平台指定機構已移除，#110）
   */
  function legResponsibleOrganization(booking, leg) {
    if (leg && leg.scheduledOrganizationId) return leg.scheduledOrganizationId;
    const pool = legPoolStatus(leg);
    if (pool === LEG_POOL_STATUS.PARTNER) return (leg && leg.partnerOrganizationId) || null;
    if (pool === LEG_POOL_STATUS.IN_POOL || pool === LEG_POOL_STATUS.UNCLAIMED) return null;
    return (booking && booking.organizationId) || null;
  }

  function clearPoolFields(leg) {
    for (const k of LEG_POOL_FIELDS) delete leg[k];
  }

  /**
   * 承接機構把來回預約中還沒排車的一段退回需求池（#112）。不改傳入的物件，回傳新的預約。
   * 規則：需求者同意分段載送、是來回、預約在承接中、那一段由呼叫的承接機構負責且還沒排車、
   * 另一段不在需求池（兩段都要退回請用整筆退回）。
   *
   * @param {{ legId: string, organizationId: string, actorUserId: string, at: string }} p
   * @returns {{ ok: true, booking, leg } | { ok: false, error: string }}
   */
  function releaseLeg(booking, { legId, organizationId, actorUserId, at }) {
    if (!booking) return { ok: false, error: '找不到預約' };
    if (String(booking.tripType || '單程') !== '來回') return { ok: false, error: '只有來回預約可以退回其中一段' };
    if (booking.splitLegConsent !== true) return { ok: false, error: '需求者沒有同意分段載送，不能只退回其中一段' };
    const state = String(booking.state || '').trim() || 'open';
    if (!['claimed', 'partially_scheduled'].includes(state) || !booking.organizationId) {
      return { ok: false, error: '預約不在承接中，不能退回其中一段' };
    }
    const next = JSON.parse(JSON.stringify(booking));
    const leg = legsOf(next).find((l) => l.id === legId);
    // 協力機構退回自己那段（#114）：那段回到需求池，協力機構不再負責
    if (leg && organizationId && legPoolStatus(leg) === LEG_POOL_STATUS.PARTNER && leg.partnerOrganizationId === organizationId) {
      if (leg.status !== BOOKING_LEG_STATUS.PENDING) return { ok: false, error: `${legLabel(leg)}已經排車，請先取消行程再退回需求池` };
      clearPoolFields(leg);
      leg.poolStatus = LEG_POOL_STATUS.IN_POOL;
      leg.releasedAt = at;
      leg.releasedByUserId = actorUserId || null;
      leg.releasedByOrganizationId = organizationId;
      next.updatedAt = at;
      next.version = Math.max(1, Number(next.version) || 1) + 1;
      return { ok: true, booking: next, leg, byPartner: true };
    }
    if (!organizationId || organizationId !== booking.organizationId) return { ok: false, error: '只有承接機構，或負責這一段的協力機構，可以退回這一段' };
    if (!leg) return { ok: false, error: '找不到這一段' };
    if (legPoolStatus(leg) === LEG_POOL_STATUS.IN_POOL) return { ok: false, error: `${legLabel(leg)}已經在需求池` };
    if (legPoolStatus(leg) !== LEG_POOL_STATUS.PRIMARY) return { ok: false, error: `${legLabel(leg)}不是由承接機構負責` };
    if (leg.status !== BOOKING_LEG_STATUS.PENDING) return { ok: false, error: `${legLabel(leg)}已經排車或已取消，不能退回需求池` };
    if (legsOf(next).some((l) => l.id !== leg.id && legPoolStatus(l) === LEG_POOL_STATUS.IN_POOL)) {
      return { ok: false, error: '另一段已經在需求池；兩段都不載請用整筆退回' };
    }
    leg.poolStatus = LEG_POOL_STATUS.IN_POOL;
    leg.releasedAt = at;
    leg.releasedByUserId = actorUserId || null;
    leg.releasedByOrganizationId = organizationId;
    next.updatedAt = at;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    // 升格（#115）：另一段由協力機構負責時，協力機構成為新的承接機構，確保每筆預約一定有承接機構
    const partnerLeg = legsOf(next).find((l) => l.id !== leg.id && legPoolStatus(l) === LEG_POOL_STATUS.PARTNER);
    if (partnerLeg) {
      const newOrg = partnerLeg.partnerOrganizationId;
      const claimedBy = partnerLeg.partnerClaimedByUserId || null;
      clearPoolFields(partnerLeg);
      next.previousOrganizationIds = [...(Array.isArray(next.previousOrganizationIds) ? next.previousOrganizationIds : []), organizationId];
      next.organizationId = newOrg;
      next.claimedByUserId = claimedBy;
      next.claimedAt = at;
      return { ok: true, booking: next, leg, promoted: true, newOrganizationId: newOrg, promotedLeg: partnerLeg };
    }
    return { ok: true, booking: next, leg };
  }

  /**
   * 承接機構把還在需求池、還沒有別家接的那一段收回（#112）；過期沒有機構承接的段也可以收回自己載（#116）。
   * 不改傳入的物件。
   */
  function reclaimLeg(booking, { legId, organizationId, at }) {
    if (!booking) return { ok: false, error: '找不到預約' };
    if (!organizationId || organizationId !== booking.organizationId) return { ok: false, error: '只有承接機構可以收回' };
    const next = JSON.parse(JSON.stringify(booking));
    const leg = legsOf(next).find((l) => l.id === legId);
    if (!leg) return { ok: false, error: '找不到這一段' };
    if (![LEG_POOL_STATUS.IN_POOL, LEG_POOL_STATUS.UNCLAIMED].includes(legPoolStatus(leg))) return { ok: false, error: `${legLabel(leg)}不在需求池，不能收回` };
    clearPoolFields(leg);
    next.updatedAt = at;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    return { ok: true, booking: next, leg };
  }

  /**
   * 別家接送機構從需求池接下一段，成為那一段的協力機構（#113）。不改傳入的物件。
   * 資料庫的 app.claim_booking_leg 以同樣的規則鎖定預約後寫入（兩家同時接只有一家成功）；
   * 這裡是前端顯示與測試用的同一套規則。
   */
  function claimLeg(booking, { legId, organizationId, organizationName, organizationPhone, actorUserId, at }) {
    if (!booking) return { ok: false, error: '找不到預約' };
    const state = String(booking.state || '').trim() || 'open';
    if (!['claimed', 'partially_scheduled'].includes(state) || !booking.organizationId) {
      return { ok: false, error: '預約不在承接中，不能接下其中一段' };
    }
    if (!organizationId || organizationId === booking.organizationId) return { ok: false, error: '承接機構不能接下自己退回的段，請用收回' };
    const next = JSON.parse(JSON.stringify(booking));
    const leg = legsOf(next).find((l) => l.id === legId);
    if (!leg) return { ok: false, error: '找不到這一段' };
    if (legPoolStatus(leg) === LEG_POOL_STATUS.PARTNER) return { ok: false, error: `${legLabel(leg)}已經有其他機構接下` };
    if (legPoolStatus(leg) !== LEG_POOL_STATUS.IN_POOL) return { ok: false, error: `${legLabel(leg)}不在需求池` };
    clearPoolFields(leg);
    leg.poolStatus = LEG_POOL_STATUS.PARTNER;
    leg.partnerOrganizationId = organizationId;
    leg.partnerOrganizationName = organizationName || '';
    leg.partnerOrganizationPhone = organizationPhone || '';
    leg.partnerClaimedAt = at;
    leg.partnerClaimedByUserId = actorUserId || null;
    next.updatedAt = at;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    return { ok: true, booking: next, leg };
  }

  // 這一段的時間與地點（回程的上下車對調）；需求者改了這些，協力機構那段的內容就不一樣了
  function legTimePlace(booking, leg) {
    const b = booking || {};
    return leg && leg.direction === 'return'
      ? [b.returnDate, b.returnTime, b.destination, b.pickupAddress]
      : [b.pickupDate, b.pickupTime, b.pickupAddress, b.destination];
  }

  /**
   * 需求者修改預約後，哪些協力機構負責的段要解除協力關係（#114）：那段被拿掉（例如改成單程），
   * 或那段的時間、地點改了。只改服務需求不解除。回傳 [{ legId, label, organizationId, removed }]。
   */
  function partnerLegsToDissolve(before, after) {
    const nextLegs = new Map(legsOf(after).map((l) => [l && l.id, l]));
    return legsOf(before)
      .filter((l) => legPoolStatus(l) === LEG_POOL_STATUS.PARTNER && l.partnerOrganizationId)
      .filter((l) => !nextLegs.has(l.id) || String(after.tripType || '單程') !== '來回'
        || JSON.stringify(legTimePlace(before, l)) !== JSON.stringify(legTimePlace(after, l)))
      .map((l) => ({ legId: l.id, label: legLabel(l), organizationId: l.partnerOrganizationId,
        removed: !nextLegs.has(l.id) || String(after.tripType || '單程') !== '來回' }));
  }

  /** 解除這些段的協力關係：那段回到需求池（由需求者修改造成，不記退回的機構）。不改傳入的物件。 */
  function dissolvePartnerLegs(booking, legIds, { actorUserId, at }) {
    const next = JSON.parse(JSON.stringify(booking));
    const ids = new Set(legIds);
    for (const leg of legsOf(next)) {
      if (!leg || !ids.has(leg.id) || legPoolStatus(leg) !== LEG_POOL_STATUS.PARTNER) continue;
      clearPoolFields(leg);
      leg.poolStatus = LEG_POOL_STATUS.IN_POOL;
      leg.releasedAt = at;
      leg.releasedByUserId = actorUserId || null;
      leg.releasedByOrganizationId = null;
    }
    return next;
  }

  // 單一段的接案期限（#116）：與整筆預約相同的提前量（前端 BOOKING_EXPIRY_POLICY.leadMinutes）
  const LEG_POOL_LEAD_MINUTES = 30;
  /**
   * 在需求池的那一段可以接到什麼時候：那段接送時間前 30 分鐘；退回時已經過了這個時間，就到接送時間為止。
   * 資料庫的需求池檢視與過期排程（app.expire_pool_legs）用同樣的算法。
   */
  function legPoolDeadline(leg) {
    const pickup = leg && leg.requestedPickupAt ? new Date(leg.requestedPickupAt).getTime() : NaN;
    if (!Number.isFinite(pickup)) return null;
    const released = leg.releasedAt ? new Date(leg.releasedAt).getTime() : NaN;
    const normal = pickup - LEG_POOL_LEAD_MINUTES * 60000;
    return new Date(!Number.isFinite(released) || normal > released ? normal : pickup).toISOString();
  }

  /** 過了期限都沒有機構接的那一段標示「沒有機構承接」（#116）；另一段與預約狀態不變。不改傳入的物件。 */
  function markLegUnclaimed(booking, { legId, at }) {
    if (!booking) return { ok: false, error: '找不到預約' };
    const next = JSON.parse(JSON.stringify(booking));
    const leg = legsOf(next).find((l) => l.id === legId);
    if (!leg) return { ok: false, error: '找不到這一段' };
    if (legPoolStatus(leg) !== LEG_POOL_STATUS.IN_POOL) return { ok: false, error: `${legLabel(leg)}不在需求池` };
    leg.poolStatus = LEG_POOL_STATUS.UNCLAIMED;
    leg.unclaimedAt = at;
    next.updatedAt = at;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    return { ok: true, booking: next, leg };
  }

  /** 有協力機構負責其中一段時，承接機構不能整筆退回或不受理（#115）。回傳原因，可以時回傳 null。 */
  function wholeReleaseBlockedReason(booking) {
    return legsOf(booking).some((l) => legPoolStatus(l) === LEG_POOL_STATUS.PARTNER)
      ? '有協力機構負責其中一段，不能整筆退回或不受理；請退回自己負責的那段（協力機構會升格為承接機構）'
      : null;
  }

  /** 整筆退回需求池、不受理時：去程／回程回到由（下一家）承接機構負責。不改傳入的物件。 */
  function clearLegPool(booking) {
    const next = JSON.parse(JSON.stringify(booking));
    for (const leg of legsOf(next)) if (leg && typeof leg === 'object') clearPoolFields(leg);
    return next;
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
    if (legPoolStatus(leg) === LEG_POOL_STATUS.IN_POOL) return { ok: false, error: `${legLabel(leg)}在需求池，不能排車` };
    const responsible = legResponsibleOrganization(next, leg);
    if (!responsible) return { ok: false, error: `${leg.label || '這一段'}還沒有承接機構` };
    if (organizationId && responsible !== organizationId) return { ok: false, error: `${leg.label || '這一段'}由其他機構負責，不能排進這趟行程` };
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

  /**
   * 調度取消一趟行程時，把排在這趟的去程／回程退回待排車（#76 決策「排好的退回部分排車」）。
   * 不改傳入的物件。沒有排在這趟的預約回傳 changed: false。
   *
   * @returns {{ changed: false } | { changed: true, booking, from, to, legIds }}
   */
  function unscheduleTripLegs(booking, { tripId, at }) {
    const onTrip = legsOf(booking).filter((l) => l.status === BOOKING_LEG_STATUS.SCHEDULED && l.tripId === tripId);
    if (!booking || !tripId || !onTrip.length) return { changed: false };
    const from = String(booking.state || '').trim() || 'open';
    const next = JSON.parse(JSON.stringify(booking));
    const ids = new Set(onTrip.map((l) => l.id));
    for (const leg of legsOf(next)) {
      if (!ids.has(leg.id)) continue;
      leg.status = BOOKING_LEG_STATUS.PENDING;
      leg.tripId = null;
      leg.scheduledOrganizationId = null;
      leg.scheduledAt = null;
    }
    const to = from === 'scheduled' ? (bookingTargets(from, 'unschedule')[0] || from) : from;
    next.state = to;
    next.status = to;
    next.updatedAt = at;
    if (to !== from) next.stateChangedAt = at;
    next.scheduledAt = null;
    next.version = Math.max(1, Number(next.version) || 1) + 1;
    const firstScheduled = legsOf(next).find((l) => l.status === BOOKING_LEG_STATUS.SCHEDULED && l.tripId);
    next.tripId = (firstScheduled && firstScheduled.tripId) || null;
    return { changed: true, booking: next, from, to, legIds: [...ids] };
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
    BOOKING_STATES, BOOKING_EDGES, BOOKING_REVOKE_STATES, BOOKING_SCHEDULING_STATES,
    bookingTargets, bookingWriteTransitions,
    BOOKING_LEG_STATUS, LEG_SCHEDULING_FIELDS, nextPendingLeg, legResponsibleOrganization, scheduleBookingLeg, unscheduleTripLegs,
    LEG_POOL_STATUS, LEG_POOL_FIELDS, legPoolStatus, releaseLeg, reclaimLeg, claimLeg, clearLegPool,
    partnerLegsToDissolve, dissolvePartnerLegs, wholeReleaseBlockedReason, legPoolDeadline, markLegUnclaimed,
    TRIP_STATUSES, TRIP_STATUS_TRANSITIONS, TRIP_CORRECTION_TRANSITIONS,
    canTripTransition
  });
});
