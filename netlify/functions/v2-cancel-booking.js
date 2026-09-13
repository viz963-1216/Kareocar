'use strict';

/**
 * POST /api/v2/cancel-booking  —— 需求者取消自己的預約
 *
 * body: { bookingId, reasonCode, reasonText }
 *
 * 由 app.cancel_app_state_booking（0008）在同一交易內處理預約與關聯行程：
 * 驗證擁有者與可取消狀態、逐筆鎖定並取消單人的 scheduled 行程、保留歷史關聯。
 * 任何一筆行程不能取消（已開始、已結束、共乘）就整筆回滾。
 */

const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const reasonCode = optionalText(body.reasonCode, 60);
  const reasonText = optionalText(body.reasonText, 500);

  const { rows } = await client.query(
    'select * from app.cancel_app_state_booking($1, $2, $3)', [bookingId, reasonCode, reasonText]);
  const cancelledTripIds = rows[0].out_cancelled_trip_ids || [];

  await writeAudit(client, {
    eventType: 'booking.cancelled_by_requester', actorUserId: claims.userId,
    entityType: 'booking', entityId: bookingId, details: { reasonCode, cancelledTripIds }
  });

  return { bookingId, cancelledTripIds };
});
