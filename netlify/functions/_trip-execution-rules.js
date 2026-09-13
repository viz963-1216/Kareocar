'use strict';

/**
 * 司機執行行程的伺服器端驗證（POST /api/v2/trip-execute）。
 *
 * 前端的司機操作（完成停靠點、返回上一步、服務證明、定位、回報異常）仍在裝置上
 * 先算出結果，才能離線操作；同步時把「這個指令做完之後，行程執行相關欄位長什麼
 * 樣子」連同指令送上來。這裡拿資料庫裡鎖定中的目前版本逐欄比對，只接受該指令
 * 在現行產品規則下可能產生的變化，其他一律拒絕：
 *
 *   - 只能動執行相關的鍵（TRIP_PATCH_KEYS）；組織、指派司機／車輛、預約關聯、
 *     服務證明規則等根本不在清單裡
 *   - 停靠點數量、順序、身分、地址、聯絡人、排程不能改
 *   - complete_step 只能完成「目前」那一站；undo_step 只能還原最後完成的那一站
 *   - 乘客狀態必須等於由停靠點推得的結果（與前端 rebuildTripPassengerProjection 相同）
 *   - 服務證明只能新增（proof_service）或因返回上一步而標記 superseded（undo_step）
 *   - 資源區段不能換成別的司機／車輛
 *   - 完成行程必須符合完成條件：停靠點全完成、乘客全離車、服務證明、無未結案重大異常
 *
 * 核心條件（指派司機、冪等鍵、revision、允許的鍵、狀態轉換、事件類型與操作人）
 * 在 app.apply_driver_trip_execution 裡會再驗一次，不單靠這支檔案。
 *
 * 這支檔案不做 I/O，所以可以在 tests/ 的離線套件裡直接測。
 */

const auth = require('./_auth-pg');

const COMMANDS = new Set(['complete_step', 'undo_step', 'proof_service', 'location_sample', 'report_issue']);
const REVISIONED = new Set(['complete_step', 'undo_step', 'proof_service']);

// 與 index.html 的 TRIP_EXECUTION_POLICY 相同；時間差容忍裝置時鐘略快
const POLICY = Object.freeze({ startEarlyMinutes: 60, completedCorrectionWindowMinutes: 15, clockSkewMinutes: 5 });
const LOCATION_SAMPLE_LIMIT = 240;
const MAX_SNAPSHOT_CHARS = 1_000_000;

const TRIP_PATCH_KEYS = Object.freeze([
  'status', 'stateChangedAt', 'startedAt', 'completedAt', 'currentStepIndex', 'completionPending',
  'steps', 'passengers', 'serviceProofs', 'resourceSegments', 'actualMetrics',
  'lastInvariantCheck', 'invariantViolation', 'updatedAt'
]);
const TRIP_PATCH_REQUIRED = Object.freeze(['status', 'steps', 'passengers', 'serviceProofs', 'currentStepIndex', 'updatedAt']);

const STATUS_PAIRS = Object.freeze({
  complete_step: ['scheduled>in_progress', 'scheduled>completed', 'in_progress>in_progress', 'in_progress>completed'],
  undo_step: ['in_progress>in_progress', 'in_progress>scheduled', 'completed>in_progress'],
  proof_service: ['in_progress>in_progress', 'in_progress>completed', 'completed>completed']
});

const STOP_STATUSES = ['pending', 'arrived', 'servicing', 'completed'];
const STOP_TIME_KEYS = ['arrivedAt', 'serviceStartedAt', 'passengerBoardedAt', 'passengerDroppedOffAt', 'departedAt', 'completedAt', 'actualAt'];
const STOP_LOCKED_KEYS = ['id', 'type', 'title', 'name', 'destination', 'contacts', 'note'];
const STOP_SCHEDULE_KEYS = ['sequence', 'scheduledAt', 'scheduledArrivalAt', 'scheduledDepartureAt'];
const STOP_LINK_KEYS = ['bookingId', 'bookingLegId', 'passengerId'];
const STOP_KNOWN_KEYS = new Set([...STOP_LOCKED_KEYS, ...STOP_SCHEDULE_KEYS, ...STOP_LINK_KEYS, ...STOP_TIME_KEYS, 'status', 'schemaVersion']);

const PASSENGER_STATUSES = ['waiting', 'onboard', 'dropped_off', 'cancelled', 'no_show', 'emergency_exit'];
const PASSENGER_TERMINAL = ['dropped_off', 'cancelled', 'no_show', 'emergency_exit'];
const PASSENGER_LOCKED_KEYS = ['id', 'bookingId', 'bookingLegId', 'recipientId', 'name', 'phone', 'seatUnits', 'wheelchairUnits'];
const PASSENGER_TIME_KEYS = ['boardedAt', 'droppedOffAt', 'cancelledAt', 'updatedAt'];
const PASSENGER_KNOWN_KEYS = new Set([...PASSENGER_LOCKED_KEYS, ...PASSENGER_TIME_KEYS, 'status', 'pickupStepId', 'dropoffStepId', 'schemaVersion']);

const PROOF_LOCKED_KEYS = ['id', 'tripId', 'stepId', 'bookingId', 'bookingLegId', 'passengerId', 'receiverName',
  'receiverRole', 'note', 'driverConfirmed', 'actorUserId', 'gps', 'photo'];
const PROOF_SUPERSEDE_KEYS = ['supersededAt', 'supersededByUserId', 'supersededReason', 'supersededByCorrectionEventId'];
const PROOF_KNOWN_KEYS = new Set([...PROOF_LOCKED_KEYS, ...PROOF_SUPERSEDE_KEYS, 'status', 'capturedAt', 'schemaVersion', 'sequence']);
const PHOTO_KEYS = new Set(['name', 'type', 'size', 'storage', 'objectKey', 'legacyInline']);
const GPS_KEYS = new Set(['lat', 'lng', 'accuracyMeters', 'capturedAt', 'source']);

const SEGMENT_KNOWN_KEYS = new Set(['id', 'schemaVersion', 'driverId', 'vehicleId', 'assignedAt', 'startedAt', 'endedAt', 'endedReason', 'issueId', 'source']);
const SEGMENT_END_REASONS = ['completed', 'interrupted', 'cancelled', 'aborted', 'closed'];

const SAMPLE_KEYS = new Set(['id', 'schemaVersion', 'at', 'lat', 'lng', 'deviceId', 'sessionId', 'serverRecordedAt',
  'accuracyMeters', 'speedMps', 'heading', 'actorUserId']);

const ISSUE_KEYS = new Set(['id', 'schemaVersion', 'organizationId', 'tripId', 'stepId', 'driverId', 'type', 'note', 'severity',
  'requiresDispatch', 'status', 'createdAt', 'updatedAt', 'ackSlaMinutes', 'ackDueAt', 'acknowledgedAt', 'acknowledgedBy',
  'handlingAt', 'handlingBy', 'resolvedAt', 'resolvedBy', 'resolutionCode', 'resolutionNote']);
const ISSUE_SEVERITIES = ['info', 'warning', 'critical', 'emergency'];

// ------------------------------------------------------------------ 小工具
const fail = (message) => { throw auth.authError('VALIDATION_ERROR', message); };
const conflict = (message) => { throw auth.authError('TRIP_CONFLICT', message); };

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const present = (v) => v !== undefined && v !== null;
const arr = (v) => (Array.isArray(v) ? v : []);
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isIsoOrNull = (v) => !present(v) || isIso(v);
const shortText = (v, max) => typeof v === 'string' && v.length <= max;
const minutesBetween = (later, earlier) => (Date.parse(later) - Date.parse(earlier)) / 60000;

/** jsonb 會重排物件鍵的順序，所以比對用排序過鍵的標準形式；undefined 與 null 視為相同。 */
function canonical(v) {
  if (!present(v)) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (present(v[k])) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function notInFuture(at, now, label) {
  if (!isIso(at)) fail(`${label}時間格式不符`);
  if (minutesBetween(at, now.toISOString()) > POLICY.clockSkewMinutes) fail(`${label}時間晚於伺服器時間，請檢查裝置時間`);
}

function assertKnownKeys(obj, known, existing, label) {
  for (const k of Object.keys(obj)) {
    if (known.has(k)) continue;
    if (existing && k in existing && same(existing[k], obj[k])) continue;
    fail(`${label}不允許新增或修改欄位 ${String(k).slice(0, 40)}`);
  }
  if (existing) {
    for (const k of Object.keys(existing)) {
      if (!known.has(k) && present(existing[k]) && !(k in obj)) fail(`${label}不能移除欄位 ${String(k).slice(0, 40)}`);
    }
  }
}

// ------------------------------------------------------------------ 停靠點
const stepCompleted = (s) => isPlainObject(s) && (s.status === 'completed' || present(s.completedAt) || present(s.actualAt));
const firstPendingIndex = (steps) => { const i = steps.findIndex((s) => !stepCompleted(s)); return i < 0 ? steps.length : i; };
const expectedStopStatus = (s) => (present(s.completedAt) ? 'completed' : present(s.serviceStartedAt) ? 'servicing' : present(s.arrivedAt) ? 'arrived' : 'pending');

function checkStopIdentity(o, n, index, ctx) {
  const label = `停靠點 ${o.id || index + 1} `;
  if (!isPlainObject(n)) fail(`${label}格式不符`);
  assertKnownKeys(n, STOP_KNOWN_KEYS, o, label);
  for (const k of STOP_LOCKED_KEYS) if (!same(o[k], n[k])) fail(`${label}的 ${k} 不能修改`);
  for (const k of STOP_SCHEDULE_KEYS) {
    if (present(o[k])) { if (!same(o[k], n[k])) fail(`${label}的 ${k} 不能修改`); continue; }
    if (!present(n[k])) continue;
    // 前端 normalizeTripStopRuntime 會替舊資料補齊這幾欄，只接受由既有值推得的結果
    const fills = k === 'sequence' ? [index + 1] : [o.scheduledAt, o.scheduledArrivalAt, o.scheduledDepartureAt].filter(present);
    if (!fills.some((v) => same(v, n[k]))) fail(`${label}的 ${k} 不能修改`);
  }
  for (const k of STOP_LINK_KEYS) {
    if (present(o[k])) { if (!same(o[k], n[k])) fail(`${label}的 ${k} 不能修改`); continue; }
    if (!present(n[k])) continue;
    const ok = k === 'bookingId' ? arr(ctx.old.bookingIds).includes(n[k])
      : k === 'bookingLegId' ? arr(ctx.old.bookingLegRefs).some((r) => isPlainObject(r) && r.legId === n[k])
        : arr(ctx.next.passengers).some((p) => isPlainObject(p) && p.id === n[k]);
    if (!ok) fail(`${label}的 ${k} 不能修改`);
  }
  if ('schemaVersion' in n && present(n.schemaVersion) && !Number.isInteger(n.schemaVersion)) fail(`${label}schemaVersion 格式不符`);
  if (!STOP_STATUSES.includes(n.status)) fail(`${label}狀態不合法`);
  for (const k of STOP_TIME_KEYS) if (!isIsoOrNull(n[k])) fail(`${label}的 ${k} 時間格式不符`);
  if (n.status !== expectedStopStatus(n)) fail(`${label}狀態與時間欄位不一致`);
}

/** 沒被這個指令處理的停靠點：執行時間不能改；只接受 normalize 用 completedAt 補齊舊資料。 */
function stopRuntimeUnchanged(o, n) {
  if (stepCompleted(o) !== stepCompleted(n)) return false;
  const fill = o.completedAt || o.actualAt || null;
  for (const k of STOP_TIME_KEYS) {
    if (present(o[k])) { if (!same(o[k], n[k])) return false; continue; }
    if (present(n[k]) && n[k] !== fill) return false;
  }
  return true;
}

function checkSteps(ctx, changedIndex, changedCheck) {
  const oSteps = arr(ctx.old.steps);
  const nSteps = ctx.next.steps;
  if (!Array.isArray(nSteps) || !oSteps.length || nSteps.length !== oSteps.length) fail('停靠點數量不能改變');
  oSteps.forEach((o, i) => {
    checkStopIdentity(o, nSteps[i], i, ctx);
    if (i === changedIndex) changedCheck(o, nSteps[i]);
    else if (!stopRuntimeUnchanged(o, nSteps[i])) fail(`只能處理指定的停靠點，不能變更停靠點 ${o.id || i + 1}`);
  });
  if (ctx.next.currentStepIndex !== firstPendingIndex(nSteps)) fail('currentStepIndex 與停靠點狀態不一致');
}

// ------------------------------------------------------------------ 乘客
function linkedStop(p, steps, type) {
  const key = type === 'pickup' ? 'pickupStepId' : 'dropoffStepId';
  return steps.find((s) => s.id === p[key])
    || steps.find((s) => s.type === type && ((p.bookingId && s.bookingId === p.bookingId) || (!p.bookingId && s.passengerId === p.id)))
    || null;
}

function checkPassengers(ctx, { direction }) {
  const oList = arr(ctx.old.passengers);
  const nList = ctx.next.passengers;
  const steps = ctx.next.steps;
  if (!Array.isArray(nList)) fail('乘客資料格式不符');
  if (oList.length) {
    if (nList.length !== oList.length) fail('乘客人數不能改變');
  } else {
    // 舊資料沒有乘客清單時，前端 normalizeTripPassengers 會依預約建立
    if (nList.length > Math.max(1, arr(ctx.old.bookingIds).length)) fail('乘客人數不能改變');
  }
  nList.forEach((p, i) => {
    const o = oList[i] || null;
    const label = `乘客 ${(o && o.id) || i + 1} `;
    if (!isPlainObject(p)) fail(`${label}格式不符`);
    assertKnownKeys(p, PASSENGER_KNOWN_KEYS, o, label);
    if (o) {
      for (const k of PASSENGER_LOCKED_KEYS) if (present(o[k]) && !same(o[k], p[k])) fail(`${label}的 ${k} 不能修改`);
    } else {
      if (typeof p.id !== 'string' || !p.id.startsWith(`tpax_${ctx.tripId}_`)) fail(`${label}ID 不合法`);
      if (present(p.bookingId) && !arr(ctx.old.bookingIds).includes(p.bookingId)) fail(`${label}預約關聯不合法`);
    }
    for (const k of ['pickupStepId', 'dropoffStepId']) {
      if (present(p[k]) && !steps.some((s) => s.id === p[k])) fail(`${label}的 ${k} 不合法`);
    }
    for (const k of PASSENGER_TIME_KEYS) if (!isIsoOrNull(p[k])) fail(`${label}的 ${k} 時間格式不符`);
    if (!PASSENGER_STATUSES.includes(p.status)) fail(`${label}狀態不合法`);

    const oldStatus = o ? o.status : 'waiting';
    if (['no_show', 'emergency_exit', 'cancelled'].includes(oldStatus)) {
      if (p.status !== oldStatus) fail(`${label}狀態不能由司機變更`);
      return;
    }
    const pickup = linkedStop(p, steps, 'pickup');
    const dropoff = linkedStop(p, steps, 'dropoff');
    if (pickup || dropoff) {
      const expected = dropoff && (dropoff.passengerDroppedOffAt || dropoff.completedAt) ? 'dropped_off'
        : pickup && (pickup.passengerBoardedAt || pickup.completedAt) ? 'onboard' : 'waiting';
      if (p.status !== expected) fail(`${label}狀態與停靠點不一致`);
      return;
    }
    // 沒有對應停靠點的舊資料：只允許依指令方向前進或後退一格
    const order = ['waiting', 'onboard', 'dropped_off'];
    const delta = order.indexOf(p.status) - order.indexOf(oldStatus);
    const allowed = direction === 'forward' ? [0, 1] : direction === 'backward' ? [0, -1] : [0];
    if (order.indexOf(p.status) < 0 || !allowed.includes(delta)) fail(`${label}狀態變化不合法`);
  });
}

// ------------------------------------------------------------------ 服務證明
function checkGps(gps, label) {
  if (!present(gps)) return;
  if (!isPlainObject(gps)) fail(`${label}GPS 格式不符`);
  for (const k of Object.keys(gps)) if (!GPS_KEYS.has(k)) fail(`${label}GPS 含不允許的欄位`);
  if (typeof gps.lat !== 'number' || gps.lat < -90 || gps.lat > 90 || typeof gps.lng !== 'number' || gps.lng < -180 || gps.lng > 180) {
    fail(`${label}GPS 座標不合法`);
  }
  if (present(gps.accuracyMeters) && typeof gps.accuracyMeters !== 'number') fail(`${label}GPS 精度格式不符`);
  if (!isIsoOrNull(gps.capturedAt) || (present(gps.source) && !shortText(gps.source, 40))) fail(`${label}GPS 格式不符`);
}

function checkPhoto(photo, label) {
  if (!present(photo)) return;
  // 照片本體只存在裝置的 IndexedDB；伺服器只收描述資料，不收 base64 內容
  if (!isPlainObject(photo)) fail(`${label}照片格式不符`);
  for (const k of Object.keys(photo)) if (!PHOTO_KEYS.has(k)) fail(`${label}照片含不允許的欄位（不接受照片內容本身）`);
  if (!shortText(photo.objectKey, 180) || !photo.objectKey) fail(`${label}照片缺少物件參照`);
  if (present(photo.name) && !shortText(photo.name, 120)) fail(`${label}照片名稱過長`);
  if (present(photo.type) && !shortText(photo.type, 60)) fail(`${label}照片類型格式不符`);
  if (present(photo.storage) && !shortText(photo.storage, 40)) fail(`${label}照片儲存位置格式不符`);
  if (present(photo.size) && typeof photo.size !== 'number') fail(`${label}照片大小格式不符`);
  if (photo.legacyInline === true) fail(`${label}不接受內嵌照片`);
}

function checkProofs(ctx, { supersedeStepId = null, allowAppend = false }) {
  const oList = arr(ctx.old.serviceProofs);
  const nList = ctx.next.serviceProofs;
  if (!Array.isArray(nList)) fail('服務證明格式不符');
  if (nList.length < oList.length) fail('服務證明不能刪除');
  const appended = nList.length - oList.length;
  if (appended > (allowAppend ? 1 : 0)) fail(allowAppend ? '一次只能新增一份服務證明' : '這個操作不能新增服務證明');
  if (allowAppend && appended !== 1) fail('缺少新的服務證明');

  oList.forEach((o, i) => {
    const n = nList[i];
    const label = `服務證明 ${o.id || i + 1} `;
    if (!isPlainObject(n) || n.id !== o.id) fail('服務證明順序不能改變');
    assertKnownKeys(n, PROOF_KNOWN_KEYS, o, label);
    for (const k of PROOF_LOCKED_KEYS) {
      if (present(o[k])) {
        if (same(o[k], n[k])) continue;
        // 舊版內嵌照片會被 normalizeTripProofs 補上描述欄位，照片內容本身不變
        if (k === 'photo' && isPlainObject(o.photo) && o.photo.dataUrl && isPlainObject(n.photo) && n.photo.dataUrl === o.photo.dataUrl) continue;
        fail(`${label}的 ${k} 不能修改`);
      } else if (present(n[k])) fail(`${label}的 ${k} 不能修改`);
    }
    if (present(o.capturedAt) ? !same(o.capturedAt, n.capturedAt) : !isIsoOrNull(n.capturedAt)) fail(`${label}的 capturedAt 不能修改`);
    for (const k of ['schemaVersion', 'sequence']) if (present(n[k]) && !Number.isInteger(n[k])) fail(`${label}的 ${k} 格式不符`);

    const wasActive = o.status !== 'superseded';
    if (supersedeStepId && wasActive && o.stepId === supersedeStepId) {
      if (n.status !== 'superseded') fail('返回上一步時，該站的服務證明必須標記為已被修正');
      if (!isIso(n.supersededAt) || n.supersededByUserId !== ctx.actorUserId || n.supersededReason !== 'undo_last_stop') {
        fail(`${label}的修正紀錄不合法`);
      }
      if (present(n.supersededByCorrectionEventId) && !shortText(n.supersededByCorrectionEventId, 180)) fail(`${label}的修正紀錄不合法`);
      return;
    }
    if ((n.status || 'active') !== (o.status || 'active')) fail(`${label}的狀態不能修改`);
    for (const k of PROOF_SUPERSEDE_KEYS) {
      if (present(o[k])) { if (!same(o[k], n[k])) fail(`${label}的 ${k} 不能修改`); } else if (present(n[k]) && n[k] !== '') fail(`${label}的 ${k} 不能修改`);
    }
  });

  if (!appended) return null;
  const p = nList[nList.length - 1];
  const label = '新的服務證明 ';
  if (!isPlainObject(p)) fail(`${label}格式不符`);
  assertKnownKeys(p, PROOF_KNOWN_KEYS, null, label);
  if (!shortText(p.id, 180) || !p.id || oList.some((o) => o.id === p.id)) fail(`${label}ID 不合法`);
  if (p.tripId !== ctx.tripId) fail(`${label}不屬於此行程`);
  const step = arr(ctx.old.steps).find((s) => s.id === p.stepId);
  if (!step || step.type !== 'dropoff' || !stepCompleted(step)) fail('服務證明只能綁定已完成的送達停靠點');
  for (const k of STOP_LINK_KEYS) if (present(p[k]) && !same(p[k], step[k])) fail(`${label}的 ${k} 與停靠點不一致`);
  if (typeof p.receiverName !== 'string' || !p.receiverName.trim() || p.receiverName.length > 80) fail('請填寫實際收受／確認人');
  if (present(p.receiverRole) && !shortText(p.receiverRole, 40)) fail(`${label}收受人角色格式不符`);
  if (present(p.note) && !shortText(p.note, 500)) fail(`${label}備註過長`);
  if (p.actorUserId !== ctx.actorUserId) fail(`${label}的操作人必須是本人`);
  if (p.driverConfirmed !== true) fail(`${label}缺少司機確認`);
  if ((p.status || 'active') !== 'active') fail(`${label}狀態不合法`);
  for (const k of PROOF_SUPERSEDE_KEYS) if (present(p[k]) && p[k] !== '') fail(`${label}不能帶修正紀錄`);
  notInFuture(p.capturedAt, ctx.now, '服務證明');
  checkGps(p.gps, label);
  checkPhoto(p.photo, label);
  return p;
}

// ------------------------------------------------------------------ 資源區段
function checkSegments(ctx) {
  const oList = arr(ctx.old.resourceSegments);
  const nList = ctx.next.resourceSegments;
  if (nList === undefined) return;
  if (!Array.isArray(nList)) fail('資源區段格式不符');
  if (nList.length < oList.length || nList.length > oList.length + 1) fail('資源區段不能刪除或一次新增多段');
  const tripDriver = ctx.old.driverId;
  const tripVehicle = ctx.old.vehicleId;
  nList.forEach((n, i) => {
    const o = oList[i] || null;
    const label = `資源區段 ${(o && o.id) || i + 1} `;
    if (!isPlainObject(n)) fail(`${label}格式不符`);
    assertKnownKeys(n, SEGMENT_KNOWN_KEYS, o, label);
    if (o) {
      if (present(o.id) && n.id !== o.id) fail('資源區段順序不能改變');
      if (present(o.startedAt)) {
        for (const k of ['driverId', 'vehicleId', 'assignedAt', 'source', 'startedAt']) if (!same(o[k], n[k])) fail(`${label}的 ${k} 不能修改`);
      } else {
        // 尚未開始的區段，前端 ensureTripResourceSegment 開始行程時會以目前指派重寫
        if (![o.driverId, tripDriver].includes(n.driverId) || ![o.vehicleId, tripVehicle].includes(n.vehicleId)) fail(`${label}不能換成其他司機或車輛`);
        if (!isIsoOrNull(n.startedAt)) fail(`${label}的 startedAt 格式不符`);
      }
      if (present(o.endedAt) && (!same(o.endedAt, n.endedAt) || !same(o.endedReason, n.endedReason))) fail(`${label}已結束，不能重新開啟`);
      if (present(o.issueId) && !same(o.issueId, n.issueId)) fail(`${label}的 issueId 不能修改`);
      if (!present(o.issueId) && present(n.issueId)) fail(`${label}的 issueId 不能修改`);
    } else {
      if (!shortText(n.id, 180) || !n.id) fail(`${label}ID 不合法`);
      if (n.driverId !== tripDriver || n.vehicleId !== tripVehicle) fail('新的資源區段必須是本趟指派的司機與車輛');
      if (present(n.issueId)) fail(`${label}的 issueId 不能由司機設定`);
    }
    for (const k of ['assignedAt', 'startedAt', 'endedAt']) if (!isIsoOrNull(n[k])) fail(`${label}的 ${k} 時間格式不符`);
    if (present(n.endedReason) && !SEGMENT_END_REASONS.includes(n.endedReason)) fail(`${label}的結束原因不合法`);
    if (present(n.source) && !shortText(n.source, 40)) fail(`${label}的來源格式不符`);
  });
}

// ------------------------------------------------------------------ 完成條件
function proofPolicyOf(old) {
  const had = isPlainObject(old.proofPolicy);
  const legacyCompleted = !had && old.status === 'completed' && !arr(old.serviceProofs).length;
  return {
    requiredPerDropoff: legacyCompleted ? false : (had ? old.proofPolicy.requiredPerDropoff !== false : true),
    requireGps: had && Boolean(old.proofPolicy.requireGps),
    requirePhoto: had && Boolean(old.proofPolicy.requirePhoto)
  };
}

function completionReasons(ctx) {
  const t = ctx.next;
  const reasons = [];
  if (!t.steps.every(stepCompleted)) reasons.push('尚有未完成停靠點');
  if (arr(t.passengers).some((p) => !PASSENGER_TERMINAL.includes(p.status))) reasons.push('仍有乘客未完成離車');
  const policy = proofPolicyOf(ctx.old);
  if (policy.requiredPerDropoff) {
    const missing = t.steps.filter((s) => s.type === 'dropoff' && stepCompleted(s)).filter((step) => !arr(t.serviceProofs).some((p) =>
      isPlainObject(p) && p.status !== 'superseded' && p.stepId === step.id
      && isIso(p.capturedAt) && isIso(step.completedAt) && Date.parse(p.capturedAt) >= Date.parse(step.completedAt)
      && (!policy.requireGps || present(p.gps)) && (!policy.requirePhoto || present(p.photo))));
    if (missing.length) reasons.push(`尚缺 ${missing.length} 個送達停靠點的服務證明`);
  }
  if (ctx.blockingIssueIds.length) reasons.push(`尚有 ${ctx.blockingIssueIds.length} 筆重大／需調度異常未結案`);
  if (isPlainObject(ctx.old.pendingHandover) && ctx.old.pendingHandover.active) reasons.push('資源交接尚未完成');
  return reasons;
}

function checkTripLevel(ctx, { command }) {
  const oldStatus = ctx.old.status || 'scheduled';
  const n = ctx.next;
  if (!(STATUS_PAIRS[command] || []).includes(`${oldStatus}>${n.status}`)) fail(`行程狀態不可由 ${oldStatus} 轉為 ${n.status}`);
  if (n.status === 'completed' && oldStatus !== 'completed') {
    const reasons = completionReasons(ctx);
    if (reasons.length) fail(`尚未符合完成條件：${reasons.join('；')}`);
  }
  if (n.status === 'completed') {
    if (oldStatus === 'completed' ? !same(ctx.old.completedAt, n.completedAt) : !isIso(n.completedAt)) fail('completedAt 不合法');
  } else if (present(n.completedAt)) fail('未完成的行程不能有 completedAt');

  if (n.status === 'scheduled') {
    if (present(n.startedAt)) fail('尚未開始的行程不能有 startedAt');
  } else if (present(ctx.old.startedAt)) {
    if (!same(ctx.old.startedAt, n.startedAt)) fail('startedAt 不能修改');
  } else if (!isIsoOrNull(n.startedAt)) fail('startedAt 格式不符');

  if (!isIso(n.updatedAt)) fail('updatedAt 格式不符');
  if (present(n.stateChangedAt) && !isIso(n.stateChangedAt)) fail('stateChangedAt 格式不符');
  for (const k of ['completionPending', 'actualMetrics', 'lastInvariantCheck', 'invariantViolation']) {
    if (present(n[k]) && !isPlainObject(n[k])) fail(`${k} 格式不符`);
    if (present(n[k]) && JSON.stringify(n[k]).length > 20000) fail(`${k} 過大`);
  }
  checkSegments(ctx);
}

// ------------------------------------------------------------------ 各指令
function planCompleteStep(ctx) {
  const oSteps = arr(ctx.old.steps);
  const idx = firstPendingIndex(oSteps);
  if (idx >= oSteps.length) fail('沒有可完成的停靠點');
  if (ctx.expectedStepId && ctx.expectedStepId !== oSteps[idx].id) conflict('目前執行站點已改變，請重新整理');
  const oldStatus = ctx.old.status || 'scheduled';
  if (!['scheduled', 'in_progress'].includes(oldStatus)) fail('此行程目前狀態不能執行停靠點');

  checkSteps(ctx, idx, (o, n) => {
    if (!stepCompleted(n) || n.status !== 'completed' || !isIso(n.completedAt) || n.actualAt !== n.completedAt) fail('目前停靠點必須標記為已完成');
    const need = o.type === 'depart' ? ['departedAt']
      : ['arrivedAt', 'serviceStartedAt', 'departedAt', ...(o.type === 'pickup' ? ['passengerBoardedAt'] : []), ...(o.type === 'dropoff' ? ['passengerDroppedOffAt'] : [])];
    for (const k of need) if (!isIso(n[k])) fail(`目前停靠點缺少 ${k}`);
    for (const k of STOP_TIME_KEYS) if (present(o[k]) && !same(o[k], n[k])) fail(`目前停靠點既有的 ${k} 不能修改`);
    notInFuture(n.completedAt, ctx.now, '停靠點完成');
    if (oldStatus === 'scheduled') {
      const first = oSteps[0];
      const scheduled = first && (first.scheduledAt || first.scheduledDepartureAt || first.scheduledArrivalAt);
      if (isIso(scheduled) && minutesBetween(n.completedAt, scheduled) < -POLICY.startEarlyMinutes) {
        fail(`尚未到行程可執行時間（最早可提前 ${POLICY.startEarlyMinutes} 分鐘）`);
      }
    }
  });
  checkPassengers(ctx, { direction: 'forward' });
  checkProofs(ctx, {});
  checkTripLevel(ctx, { command: 'complete_step' });
}

function planUndoStep(ctx) {
  const oSteps = arr(ctx.old.steps);
  const oldStatus = ctx.old.status || 'scheduled';
  if (!['in_progress', 'completed'].includes(oldStatus)) fail('此行程目前狀態不能返回上一步');
  const idx = (oldStatus === 'completed' ? oSteps.length : firstPendingIndex(oSteps)) - 1;
  if (idx < 0 || !stepCompleted(oSteps[idx])) fail('沒有可返回的步驟');
  if (ctx.expectedStepId && ctx.expectedStepId !== oSteps[idx].id) conflict('可返回的停靠點已改變，請重新整理');

  notInFuture(ctx.next.updatedAt, ctx.now, '返回上一步');
  if (oldStatus === 'completed') {
    if (!isIso(ctx.old.completedAt)) fail('行程缺少完成時間，不能安全修正');
    const age = minutesBetween(ctx.next.updatedAt, ctx.old.completedAt);
    if (age < 0) fail('操作時間早於行程完成時間，請檢查裝置時間');
    if (age > POLICY.completedCorrectionWindowMinutes) {
      fail(`完成後修正期限已超過 ${POLICY.completedCorrectionWindowMinutes} 分鐘，請由調度以正式修正流程處理`);
    }
  }
  const target = idx === 0 ? 'scheduled' : 'in_progress';
  if (ctx.next.status !== target) fail(`返回上一步後行程狀態應為 ${target}`);

  checkSteps(ctx, idx, (o, n) => {
    if (n.status !== 'pending' || STOP_TIME_KEYS.some((k) => present(n[k]))) fail('返回的停靠點必須清除執行時間');
  });
  checkPassengers(ctx, { direction: 'backward' });
  checkProofs(ctx, { supersedeStepId: oSteps[idx].id });
  if (present(ctx.next.completionPending)) fail('返回上一步後不應保留待完成標記');
  checkTripLevel(ctx, { command: 'undo_step' });
}

function planProofService(ctx) {
  const oldStatus = ctx.old.status || 'scheduled';
  if (!['in_progress', 'completed'].includes(oldStatus)) fail('此行程目前狀態不能建立服務證明');
  checkSteps(ctx, -1, () => {});
  checkPassengers(ctx, { direction: 'none' });
  checkProofs(ctx, { allowAppend: true });
  checkTripLevel(ctx, { command: 'proof_service' });
}

function planLocationSample(ctx, body) {
  const samples = body.samples;
  if (!Array.isArray(samples) || !samples.length || samples.length > 20) fail('定位資料格式不符');
  const merged = arr(ctx.old.locationSamples).filter(isPlainObject);
  const known = new Set(merged.map((s) => s.id));
  for (const s of samples) {
    if (!isPlainObject(s)) fail('定位資料格式不符');
    for (const k of Object.keys(s)) if (!SAMPLE_KEYS.has(k)) fail('定位資料含不允許的欄位');
    if (!shortText(s.id, 180) || !s.id) fail('定位資料缺少 ID');
    if (typeof s.lat !== 'number' || s.lat < -90 || s.lat > 90 || typeof s.lng !== 'number' || s.lng < -180 || s.lng > 180) fail('GPS 座標不合法');
    for (const k of ['accuracyMeters', 'speedMps', 'heading']) if (present(s[k]) && typeof s[k] !== 'number') fail('定位資料格式不符');
    for (const k of ['deviceId', 'sessionId']) if (present(s[k]) && !shortText(s[k], 120)) fail('定位資料格式不符');
    if (present(s.serverRecordedAt)) fail('定位資料不能自帶伺服器時間');
    if (s.actorUserId !== ctx.actorUserId) fail('定位資料的操作人必須是本人');
    notInFuture(s.at, ctx.now, '定位');
    if (!known.has(s.id)) { merged.push(s); known.add(s.id); }
  }
  const patch = { locationSamples: merged.slice(-LOCATION_SAMPLE_LIMIT) };
  if (body.liveNavigation !== undefined) {
    if (present(body.liveNavigation) && !isPlainObject(body.liveNavigation)) fail('導航資料格式不符');
    if (JSON.stringify(body.liveNavigation || null).length > 20000) fail('導航資料過大');
    patch.liveNavigation = body.liveNavigation || null;
  }
  return patch;
}

/** 與 index.html 的 classifyIssueSeverity 相同。嚴重度影響能否完成行程，不能由裝置自行降級。 */
function classifyIssueSeverity(type = '') {
  const text = String(type || '');
  if (/突發送醫/.test(text)) return 'emergency';
  if (/交通事故|車輛故障|車輛設備異常|病患身體不適/.test(text)) return 'critical';
  if (/乘客尚未準備|無法聯絡|地址有誤|臨時取消|陪同人員未到|輪椅|交通壅塞|道路封閉|施工|無法臨停|停車/.test(text)) return 'warning';
  return 'info';
}

function planReportIssue(ctx, body) {
  const issue = body.issue;
  if (!isPlainObject(issue)) fail('異常資料格式不符');
  for (const k of Object.keys(issue)) if (!ISSUE_KEYS.has(k)) fail('異常資料含不允許的欄位');
  if (!shortText(issue.id, 180) || !issue.id) fail('異常資料缺少 ID');
  if (issue.tripId !== ctx.tripId || issue.driverId !== ctx.old.driverId) fail('異常資料與行程不符');
  if (present(issue.organizationId) && issue.organizationId !== ctx.organizationId) fail('異常資料與行程不符');
  if (typeof issue.type !== 'string' || !issue.type.trim() || issue.type.length > 120) fail('請選擇或輸入異常類型');
  if (present(issue.note) && !shortText(issue.note, 1000)) fail('異常說明過長');
  if (present(issue.stepId) && !arr(ctx.old.steps).some((s) => s.id === issue.stepId)) fail('異常的停靠點不屬於此行程');
  const severity = classifyIssueSeverity(issue.type);
  const requiresDispatch = ['critical', 'emergency'].includes(severity) || /車輛|交通事故|突發送醫/.test(issue.type);
  if (!ISSUE_SEVERITIES.includes(issue.severity) || issue.severity !== severity || issue.requiresDispatch !== requiresDispatch) {
    fail('異常嚴重度與類型不一致');
  }
  if (issue.status !== 'open') fail('新回報的異常必須是待接手狀態');
  notInFuture(issue.createdAt, ctx.now, '異常回報');
  if (!isIsoOrNull(issue.updatedAt) || !isIsoOrNull(issue.ackDueAt)) fail('異常資料時間格式不符');
  if (present(issue.ackSlaMinutes) && (!Number.isInteger(issue.ackSlaMinutes) || issue.ackSlaMinutes < 1 || issue.ackSlaMinutes > 1440)) fail('異常 SLA 格式不符');
  for (const k of ['acknowledgedAt', 'acknowledgedBy', 'handlingAt', 'handlingBy', 'resolvedAt', 'resolvedBy', 'resolutionCode']) {
    if (present(issue[k])) fail('新回報的異常不能帶處理紀錄');
  }
  if (present(issue.resolutionNote) && issue.resolutionNote !== '') fail('新回報的異常不能帶處理紀錄');
  return issue;
}

function checkEvents(events, tripId, actorUserId) {
  if (events === undefined) return [];
  if (!Array.isArray(events) || events.length > 50) fail('事件格式不符');
  for (const e of events) {
    if (!isPlainObject(e) || !shortText(e.id, 180) || !e.id || e.tripId !== tripId || typeof e.eventType !== 'string') fail('事件格式不符');
    if (e.actorUserId !== actorUserId) fail('事件的操作人必須是本人');
    if (JSON.stringify(e).length > 50000) fail('事件資料過大');
  }
  return events;
}

/**
 * @param {object} args
 * @param {string} args.command
 * @param {object} args.body            請求本體
 * @param {object} args.current         { tripId, data, revision, organizationId, blockingIssueIds }
 * @param {string} args.actorUserId
 * @param {Date}   [args.now]
 * @returns {{duplicate: true} | {duplicate: false, patch: object, events: object[], issue: object|null}}
 */
function planExecution({ command, body, current, actorUserId, now = new Date() }) {
  if (!COMMANDS.has(command)) fail('不支援的執行動作');
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!key || key.length > 180) fail('缺少冪等鍵');
  const old = isPlainObject(current.data) ? current.data : {};
  const ctx = {
    tripId: current.tripId, old, actorUserId, now,
    organizationId: current.organizationId || null,
    blockingIssueIds: arr(current.blockingIssueIds),
    expectedStepId: typeof body.expectedStepId === 'string' ? body.expectedStepId : null
  };

  if (REVISIONED.has(command)) {
    // 冪等優先於 revision：第一次其實成功、只是回應遺失時，重送要回報「已處理」
    if (arr(old.mutationReceipts).some((x) => isPlainObject(x) && x.key === key)) return { duplicate: true };
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) fail('expectedRevision 必須是非負整數');
    if (body.expectedRevision !== current.revision) conflict('行程已被其他操作更新，請重新整理');
    if ((old.status || 'scheduled') === 'interrupted') fail('此行程已中斷，需由調度處理並恢復後才能繼續執行');

    const snapshot = body.trip;
    if (!isPlainObject(snapshot)) fail('缺少行程執行資料');
    if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_CHARS) fail('行程執行資料過大');
    for (const k of Object.keys(snapshot)) if (!TRIP_PATCH_KEYS.includes(k)) fail(`不允許修改的欄位：${String(k).slice(0, 40)}`);
    for (const k of TRIP_PATCH_REQUIRED) if (!(k in snapshot)) fail(`行程執行資料缺少 ${k}`);
    ctx.next = snapshot;

    if (command === 'complete_step') planCompleteStep(ctx);
    else if (command === 'undo_step') planUndoStep(ctx);
    else planProofService(ctx);
    return { duplicate: false, patch: snapshot, events: checkEvents(body.events, ctx.tripId, actorUserId), issue: null };
  }

  if (command === 'location_sample') {
    return { duplicate: false, patch: planLocationSample(ctx, body), events: checkEvents(body.events, ctx.tripId, actorUserId), issue: null };
  }
  return { duplicate: false, patch: {}, events: checkEvents(body.events, ctx.tripId, actorUserId), issue: planReportIssue(ctx, body) };
}

module.exports = { planExecution, classifyIssueSeverity, COMMANDS, TRIP_PATCH_KEYS, POLICY };
