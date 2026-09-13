'use strict';

/**
 * POST /api/v2/claim-booking  —— 承接公開需求
 *
 * body: { bookingId, organizationId }
 *
 * 呼叫 0007 建立、0008 補強的 app.claim_app_state_booking：
 *   - 呼叫者必須是該組織的 owner／dispatcher
 *   - 組織必須啟用中且為可承接的服務組織類型
 *   - SELECT ... FOR UPDATE 搶單；已被接走 → 409 BOOKING_CONFLICT
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

  await writeAudit(client, {
    eventType: 'booking.claimed', actorUserId: claims.userId, organizationId,
    entityType: 'booking', entityId: bookingId, details: { version: claimed.version }
  });

  return { bookingId: claimed.id, organizationId: claimed.organization_id, version: claimed.version };
});
