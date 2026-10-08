'use strict';

/**
 * 調度端寫行程的伺服器規則（v2-trip-write 使用；離線測試 tests/trip-rules.test.js）。
 *
 * 司機執行自己的行程走 v2-trip-execute，不經過這裡。這裡檢查：
 *   - 只有行程機構的負責人、調度員（或平台管理者）能建立、修改行程
 *   - 行程的機構建立後不能改
 *   - 新行程一律從 scheduled 開始；狀態只能照前端的轉換表走
 *     （已開始的行程不能取消，請用中斷；結束的行程不能再改狀態）
 *   - 指派的司機、車輛、新關聯的預約都必須屬於行程的機構
 */

// 狀態轉換與前端共用同一份（js/lifecycle.js）
const { TRIP_STATUS_TRANSITIONS } = require('../../js/lifecycle.js');
const SCHEDULABLE_BOOKING_STATES = new Set(['claimed', 'partially_scheduled', 'scheduled']);

const ruleError = (code, message) => Object.assign(new Error(message), { code });
const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const statusOf = (r) => text(r && r.status) || 'scheduled';

/**
 * 行程掛上預約的所有寫法：bookingIds、bookingId、去程／回程引用、停靠點與乘客上的預約。
 * 回傳「預約」與「預約:段」兩種鍵，用來判斷這次寫入有沒有新掛上預約或新的一段。
 */
function bookingRefsOf(record) {
  const keys = new Set(bookingIdsOf(record));
  for (const r of (Array.isArray(record && record.bookingLegRefs) ? record.bookingLegRefs : [])) {
    if (text(r && r.bookingId)) { keys.add(text(r.bookingId)); keys.add(`${text(r.bookingId)}:${text(r.legId)}`); }
  }
  for (const list of [record && record.steps, record && record.passengers]) {
    for (const x of (Array.isArray(list) ? list : [])) if (text(x && x.bookingId)) keys.add(text(x.bookingId));
  }
  return keys;
}

/** 行程關聯的所有預約 ID（bookingId 與 bookingIds）。 */
function bookingIdsOf(record) {
  const ids = new Set(Array.isArray(record && record.bookingIds) ? record.bookingIds.map(text).filter(Boolean) : []);
  if (text(record && record.bookingId)) ids.add(text(record.bookingId));
  return [...ids];
}

/**
 * @param {object}  p
 * @param {object}  p.record      前端送來的行程
 * @param {object?} p.existing    資料庫裡的那一列（{ data, organization_id }），新增時為 null
 * @param {string}  p.organizationId 行程的機構（新增時取自 record，修改時取自資料庫）
 * @param {boolean} p.canManage   呼叫者是該機構的負責人、調度員或平台管理者
 * @param {object}  p.scope       app.trip_resource_scope 的結果：{ driver, vehicle, bookings: Map }
 * @param {boolean} [p.viaScheduleCommand] 由排車 command（v2-schedule-trips）呼叫；只有它能把預約排進行程（ADR 0003）
 * @returns {object} 要存的行程
 */
function checkTripWrite({ record, existing, organizationId, canManage, scope, viaScheduleCommand = false }) {
  if (!organizationId) throw ruleError('VALIDATION_ERROR', '行程必須屬於一個機構');
  if (!canManage) throw ruleError('FORBIDDEN', '只有行程所屬機構的負責人或調度員可以修改行程');
  const out = { ...record, organizationId };
  const to = statusOf(out);
  if (!(to in TRIP_STATUS_TRANSITIONS)) throw ruleError('VALIDATION_ERROR', `行程狀態不合法：${to}`);

  const before = existing ? existing.data || {} : null;
  if (!before) {
    if (to !== 'scheduled') throw ruleError('VALIDATION_ERROR', '新行程必須是已排定狀態');
  } else {
    const from = statusOf(before);
    if (from !== to && !TRIP_STATUS_TRANSITIONS[from].includes(to)) {
      if (to === 'cancelled' && ['in_progress', 'interrupted'].includes(from)) {
        throw ruleError('VALIDATION_ERROR', '行程已開始，不能取消；請改用中斷，再由調度決定是否終止');
      }
      throw ruleError('VALIDATION_ERROR', `行程目前是 ${from}，不能改成 ${to}`);
    }
  }

  const driverId = text(out.driverId);
  if (driverId && (!before || text(before.driverId) !== driverId)) {
    const d = scope.driver;
    if (!d || d.organization_id !== organizationId) throw ruleError('VALIDATION_ERROR', '指派的司機不屬於此機構');
    if (d.active === false) throw ruleError('VALIDATION_ERROR', '指派的司機已停用');
  }
  const vehicleId = text(out.vehicleId);
  if (vehicleId && (!before || text(before.vehicleId) !== vehicleId)) {
    const v = scope.vehicle;
    // 沒有車輛主檔的舊資料照舊接受；有主檔就必須是同一個機構的
    if (v && v.organization_id !== organizationId) throw ruleError('VALIDATION_ERROR', '指派的車輛不屬於此機構');
  }

  if (!viaScheduleCommand) {
    const had = before ? bookingRefsOf(before) : new Set();
    for (const key of bookingRefsOf(out)) {
      if (!had.has(key)) throw ruleError('VALIDATION_ERROR', '把預約排進行程請使用排車功能');
    }
  }
  const had = new Set(before ? bookingIdsOf(before) : []);
  for (const id of bookingIdsOf(out)) {
    if (had.has(id)) continue;
    const b = scope.bookings.get(id);
    const owned = b && b.organization_id === organizationId;
    if (!owned) throw ruleError('VALIDATION_ERROR', `預約 ${id} 不屬於此機構，不能排進行程`);
    if (!SCHEDULABLE_BOOKING_STATES.has(b.state)) throw ruleError('VALIDATION_ERROR', `預約 ${id} 目前不能排車（${b.state || 'open'}）`);
  }
  return out;
}

module.exports = { checkTripWrite, bookingIdsOf, TRIP_STATUS_TRANSITIONS };
