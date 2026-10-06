'use strict';

/**
 * 預約寫入的伺服器規則（v2-booking-write 使用；離線測試 tests/booking-rules.test.js）。
 *
 * 前端仍是「本機先改、再整筆送出」，伺服器不重做整套預約流程，而是檢查：
 *   - 誰可以把預約從哪個狀態改到哪個狀態（需求者本人、承接機構的負責人或調度員、平台管理者）
 *   - 由伺服器決定的欄位一律沿用資料庫裡的值（需求者、承接人、取消紀錄等）
 *   - 進入排車後，需求者不能再改時間與地址
 *
 * 接案走 v2-claim-booking、需求者取消走 v2-cancel-booking，這裡一律不接受。
 * 承接機構退回公開池、不受理、或需求者重大修改需重新承接時，呼叫端在同一交易內
 * 呼叫 app.revoke_booking_organization，原機構立即失去存取。
 */

// 狀態轉換與前端共用同一份（js/lifecycle.js）
const lifecycle = require('../../js/lifecycle.js');

const STATES = lifecycle.BOOKING_STATES;
// 需求者本人
const OWNER_TRANSITIONS = lifecycle.bookingWriteTransitions('owner');
// 承接機構的負責人、調度員
const OPS_TRANSITIONS = lifecycle.bookingWriteTransitions('ops');
// 轉到這些狀態時原承接機構失去存取
const REVOKE_STATES = new Set(lifecycle.BOOKING_REVOKE_STATES);

// 只能由伺服器或專用流程寫的欄位：一律沿用資料庫裡的值
const SERVER_OWNED = [
  'requestedByUserId', 'claimedByUserId', 'claimedAt', 'previousOrganizationIds',
  'cancelledAt', 'cancelledByUserId', 'cancelReasonCode', 'cancelReasonText', 'cancelledTripIds'
];
// 進入排車後需求者不能改的內容
const REQUESTER_LOCKED = [
  'pickupDate', 'pickupTime', 'pickupAddress', 'destination', 'returnDate', 'returnTime',
  'tripType', 'passengerCount', 'wheelchairSlots', 'name', 'phone'
];

const stateOf = (record) => {
  const s = String((record && record.state) || '').trim();
  return s || 'open';
};

function ruleError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 檢查一筆預約寫入，回傳要存的資料與後續動作。
 *
 * @param {object}  p
 * @param {string}  p.actorUserId
 * @param {object}  p.record     前端送來的資料
 * @param {object?} p.existing   資料庫裡的那一列（{ data, organization_id, owner_user_id }），新增時為 null
 * @param {object}  p.roles      { admin, ownsExisting, opsOfExisting, opsOfClaimedOrg }
 * @returns {{ record: object, revoke: boolean }}
 */
function checkBookingWrite({ actorUserId, record, existing, roles }) {
  const out = { ...record };
  const toState = stateOf(out);
  if (!STATES.includes(toState)) throw ruleError('VALIDATION_ERROR', `預約狀態不合法：${toState}`);
  if (toState === 'cancelled' && !(existing && stateOf(existing.data) === 'cancelled')) {
    throw ruleError('VALIDATION_ERROR', '取消預約請使用取消功能');
  }

  if (!existing) {
    const orgId = String(out.organizationId || '').trim() || null;
    if (orgId) {
      // 機構自行建立（例如電話預約）：必須是該機構的負責人或調度員，直接是已承接
      if (!(roles.admin || roles.opsOfClaimedOrg)) throw ruleError('FORBIDDEN', '沒有權限替這個機構建立預約');
      if (toState !== 'claimed') throw ruleError('VALIDATION_ERROR', '機構建立的預約必須是已承接狀態');
      if (out.requestedByUserId && out.requestedByUserId !== actorUserId && !roles.admin) {
        throw ruleError('VALIDATION_ERROR', '不能替其他帳號建立預約');
      }
      out.claimedByUserId = actorUserId;
    } else {
      if (toState !== 'open') throw ruleError('VALIDATION_ERROR', '新預約必須是公開待接狀態，接案請使用接案功能');
      if (out.requestedByUserId && out.requestedByUserId !== actorUserId && !roles.admin) {
        throw ruleError('VALIDATION_ERROR', '不能替其他帳號建立預約');
      }
      out.requestedByUserId = out.requestedByUserId || actorUserId;
      out.claimedByUserId = null;
      out.claimedAt = null;
    }
    for (const k of ['cancelledAt', 'cancelledByUserId', 'cancelReasonCode', 'cancelReasonText', 'cancelledTripIds', 'previousOrganizationIds']) {
      delete out[k];
    }
    return { record: out, revoke: false };
  }

  const before = existing.data || {};
  const fromState = stateOf(before);
  if (!roles.admin) {
    const allowed = new Set([
      ...(roles.ownsExisting ? (OWNER_TRANSITIONS[fromState] || [fromState]) : []),
      ...(roles.opsOfExisting ? (OPS_TRANSITIONS[fromState] || [fromState]) : [])
    ]);
    if (!allowed.has(toState)) {
      throw ruleError('VALIDATION_ERROR', `預約目前是 ${fromState}，不能改成 ${toState}`);
    }
    if (roles.ownsExisting && !roles.opsOfExisting && !['open', 'claimed'].includes(fromState)) {
      const changed = REQUESTER_LOCKED.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(out[k] ?? null));
      if (changed.length) {
        throw ruleError('VALIDATION_ERROR', `預約已進入排車或結案，不能修改：${changed.join('、')}`);
      }
    }
  }

  for (const k of SERVER_OWNED) {
    if (k in before) out[k] = before[k]; else delete out[k];
  }
  const revoke = Boolean(existing.organization_id) && REVOKE_STATES.has(toState);
  out.organizationId = revoke ? null : (existing.organization_id || null);
  if (revoke) {
    out.claimedByUserId = null;
    out.claimedAt = null;
  }
  return { record: out, revoke };
}

module.exports = { checkBookingWrite, OWNER_TRANSITIONS, OPS_TRANSITIONS, SERVER_OWNED, REQUESTER_LOCKED };
