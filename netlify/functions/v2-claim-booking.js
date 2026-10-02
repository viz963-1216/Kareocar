'use strict';

/**
 * POST /api/v2/claim-booking  —— 承接公開需求
 *
 * body: { bookingId, organizationId }
 *
 * 呼叫 app.claim_app_state_booking（baseline 第 8 部分）：
 *   - 呼叫者必須是該組織的 owner／dispatcher
 *   - 組織必須啟用中且為可承接的服務組織類型
 *   - SELECT ... FOR UPDATE 搶單；已被接走 → 409 BOOKING_CONFLICT
 *   - 同一交易內通知需求者（booking_claimed）
 *
 * 前端送來的 expectedVersion 目前不參與判斷：搶單的正確性由資料庫鎖保證。
 */

const { runAuthenticated, requireId, writeAudit } = require('./_business-rpc');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const organizationId = requireId(body.organizationId, '承接組織 ');

  const { rows } = await client.query(
    'select * from app.claim_app_state_booking($1, $2)', [bookingId, organizationId]);
  const claimed = rows[0];

  // 通知需求者：已有服務單位承接（只帶機構名稱）
  const org = (await client.query('select name from organizations where id = $1', [organizationId])).rows[0];
  await client.query('select app.notify_booking_requester($1, $2, $3::jsonb, $4, $5)', [
    bookingId, 'booking_claimed', JSON.stringify({ organizationName: org ? org.name : '' }),
    'claim_booking_endpoint', `claimed:${bookingId}:${claimed.version}`]);

  await writeAudit(client, {
    eventType: 'booking.claimed', actorUserId: claims.userId, organizationId,
    entityType: 'booking', entityId: bookingId, details: { version: claimed.version }
  });

  return { bookingId: claimed.id, organizationId: claimed.organization_id, version: claimed.version };
});
