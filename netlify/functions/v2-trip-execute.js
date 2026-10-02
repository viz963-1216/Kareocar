'use strict';

/**
 * POST /api/v2/trip-execute  —— 被指派司機執行行程
 *
 * body: {
 *   tripId, command, idempotencyKey,
 *   expectedRevision, expectedStepId,   // complete_step／undo_step／proof_service
 *   trip,                               // 同上：指令完成後的行程執行欄位
 *   samples, liveNavigation,            // location_sample
 *   issue,                              // report_issue
 *   events                              // 這個指令在裝置上產生的行程事件
 * }
 *
 * command：complete_step | undo_step | proof_service | location_sample | report_issue
 * 對應前端 Trip 的既有司機操作；逐欄驗證規則在 _trip-execution-rules.js，
 * 寫入與核心條件在 app.apply_driver_trip_execution（baseline 第 8 部分）。
 *
 * 流程在同一筆交易內：鎖定行程 → 驗證 → 寫入。驗證失敗整筆回滾。
 *
 * 錯誤：非指派司機 403、找不到 404、revision 不符／站點已變 409 TRIP_CONFLICT、
 *       非法指令／欄位／狀態轉換 400 VALIDATION_ERROR。
 * 重送：同一個 idempotencyKey（或同一筆異常 ID）已處理過 → 200，duplicate: true。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, requireId, writeAudit } = require('./_business-rpc');
const rules = require('./_trip-execution-rules');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const tripId = requireId(body.tripId, '行程 ID ');
  const command = String(body.command || '').trim();
  if (!rules.COMMANDS.has(command)) throw auth.authError('VALIDATION_ERROR', '不支援的執行動作');

  const locked = (await client.query('select * from app.lock_driver_trip($1)', [tripId])).rows[0];
  const plan = rules.planExecution({
    command,
    body,
    current: {
      tripId,
      data: locked.trip_data,
      revision: locked.trip_revision,
      organizationId: locked.trip_organization_id,
      blockingIssueIds: locked.blocking_issue_ids || []
    },
    actorUserId: claims.userId
  });

  const key = String(body.idempotencyKey).trim();
  if (plan.duplicate) {
    return { tripId, revision: locked.trip_revision, status: locked.trip_data.status || 'scheduled', duplicate: true };
  }

  const { rows } = await client.query(
    'select * from app.apply_driver_trip_execution($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)',
    [tripId, command, Number.isInteger(body.expectedRevision) ? body.expectedRevision : null, key,
     JSON.stringify(plan.patch), JSON.stringify(plan.events), plan.issue ? JSON.stringify(plan.issue) : null]);
  const result = rows[0];

  // 定位是高頻遙測，每筆都寫稽核會淹沒真正的操作紀錄
  if (command !== 'location_sample' && !result.out_duplicate) {
    await writeAudit(client, {
      eventType: `trip.execute.${command}`, actorUserId: claims.userId,
      organizationId: locked.trip_organization_id, entityType: 'trip', entityId: tripId,
      details: { revision: result.out_revision, status: result.out_status, idempotencyKey: key,
                 issueId: plan.issue ? plan.issue.id : null }
    });
  }

  // 行程完成：通知每一筆預約的需求者（司機讀不到預約，由 definer 函式查收件人）
  if (!result.out_duplicate && result.out_status === 'completed' && (locked.trip_data.status || '') !== 'completed') {
    const data = locked.trip_data || {};
    const bookingIds = new Set([...(Array.isArray(data.bookingIds) ? data.bookingIds : []), data.bookingId].filter(Boolean));
    for (const bookingId of bookingIds) {
      await client.query('select app.notify_booking_requester($1, $2, $3::jsonb, $4, $5)', [
        bookingId, 'trip_completed', JSON.stringify({ tripId }), 'trip_execute_endpoint', `completed:${tripId}:${bookingId}`]);
    }
  }

  return { tripId: result.out_trip_id, revision: result.out_revision, status: result.out_status, duplicate: result.out_duplicate };
});
