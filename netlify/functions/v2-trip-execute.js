'use strict';

/**
 * POST /api/v2/trip-execute  —— 被指派司機執行行程
 *
 * body: { tripId, action, expectedRevision, payload }
 *
 * action：start | interrupt | complete | step | proof
 * 允許的狀態轉換、payload 鍵與只改哪些欄位，全部由 app.execute_app_state_trip
 * （0008）決定。組織、指派司機／車輛與其他欄位都不能經由這裡修改。
 *
 * 錯誤：非指派司機 403、找不到 404、revision 不符 409 TRIP_CONFLICT、
 *       非法動作／欄位／狀態轉換 400 VALIDATION_ERROR。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, requireId, writeAudit } = require('./_business-rpc');

const ACTIONS = new Set(['start', 'interrupt', 'complete', 'step', 'proof']);

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const tripId = requireId(body.tripId, '行程 ID ');
  const action = String(body.action || '').trim();
  if (!ACTIONS.has(action)) throw auth.authError('VALIDATION_ERROR', '不支援的執行動作');
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw auth.authError('VALIDATION_ERROR', 'expectedRevision 必須是非負整數');
  }
  const payload = body.payload === undefined ? {} : body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw auth.authError('VALIDATION_ERROR', 'payload 必須是物件');
  }

  const { rows } = await client.query(
    'select * from app.execute_app_state_trip($1, $2, $3, $4::jsonb)',
    [tripId, action, body.expectedRevision, JSON.stringify(payload)]);
  const result = rows[0];

  await writeAudit(client, {
    eventType: `trip.execute.${action}`, actorUserId: claims.userId,
    entityType: 'trip', entityId: tripId, details: { revision: result.revision, status: result.status }
  });

  return { tripId: result.trip_id, revision: result.revision, status: result.status };
});
