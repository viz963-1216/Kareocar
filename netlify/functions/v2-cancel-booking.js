'use strict';

/**
 * POST /api/v2/cancel-booking  —— 需求者取消自己的預約
 *
 * body: { bookingId, reasonCode, reasonText }
 *
 * 由 app.cancel_app_state_booking（baseline 第 8 部分）在同一交易內處理預約與關聯行程：
 * 驗證擁有者與可取消狀態、逐筆鎖定並取消單人的 scheduled 行程、保留歷史關聯。
 * 任何一筆行程不能取消（已開始、已結束、共乘）就整筆回滾。
 *
 * 同一交易內排入站內通知（notifications 集合、status = queued），取消失敗就沒有
 * 通知；通知 ID 由預約與行程決定，重試不會重複。這裡不呼叫任何簡訊或外部服務。
 */

const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const reasonCode = optionalText(body.reasonCode, 60);
  const reasonText = optionalText(body.reasonText, 500);

  // 通知承接機構與協力機構（#114）：要在取消之前（取消後承接機構與協力關係都會解除）
  const current = (await client.query(
    `select organization_id, data from bookings where id = $1 and not deleted`, [bookingId])).rows[0];
  if (current && current.organization_id) {
    const orgs = [current.organization_id, ...new Set(((current.data && current.data.legs) || [])
      .filter((l) => l && l.poolStatus === 'partner' && l.partnerOrganizationId).map((l) => l.partnerOrganizationId))];
    await client.query('select app.notify_booking_orgs($1, $2, $3::jsonb, $4)',
      [bookingId, 'booking_cancelled_ops', JSON.stringify({ reasonCode }), orgs]);
  }

  const { rows } = await client.query(
    'select * from app.cancel_app_state_booking($1, $2, $3)', [bookingId, reasonCode, reasonText]);
  const cancelledTripIds = rows[0].out_cancelled_trip_ids || [];
  const notificationIds = rows[0].out_notification_ids || [];

  await writeAudit(client, {
    eventType: 'booking.cancelled_by_requester', actorUserId: claims.userId,
    entityType: 'booking', entityId: bookingId, details: { reasonCode, cancelledTripIds, notificationIds }
  });

  return { bookingId, cancelledTripIds, notificationIds };
});
