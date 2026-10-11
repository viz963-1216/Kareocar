'use strict';

/**
 * POST /api/v2/booking-leg  —— 來回預約的一段退回需求池、收回（#112，ADR 0004）
 *
 * body: { action: 'release' | 'reclaim', bookingId, legId }
 *
 *   - release：承接機構把還沒排車的那一段退回需求池，別家在需求池看到「只有去程／只有回程」
 *   - reclaim：還沒有別家接之前，承接機構把那一段收回
 *
 * 呼叫者必須是預約承接機構的負責人或調度員。能不能退回、收回由 js/lifecycle.js 的
 * releaseLeg／reclaimLeg 判斷（與前端同一份）；伺服器用資料庫裡的預約計算，不採用前端送來的內容。
 * 鎖住預約、寫回、預約事件與稽核紀錄在同一筆交易。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, requireId, writeAudit } = require('./_business-rpc');
const lifecycle = require('../../js/lifecycle.js');

const ACTIONS = {
  release: { run: lifecycle.releaseLeg, eventType: 'leg_released', audit: 'booking.leg_released' },
  reclaim: { run: lifecycle.reclaimLeg, eventType: 'leg_reclaimed', audit: 'booking.leg_reclaimed' }
};

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const action = ACTIONS[String(body.action || '').trim()];
  if (!action) throw auth.authError('VALIDATION_ERROR', '動作只能是退回需求池或收回');
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const legId = requireId(body.legId, '去程／回程 ');

  // RLS：讀得到的只有自己承接、自己建立的預約
  const row = (await client.query(
    `select data, organization_id from bookings where id = $1 and not deleted for update`, [bookingId])).rows[0];
  const ops = row && row.organization_id
    && (await client.query(`select app.has_role_in($1, array['owner','dispatcher']) as ok`, [row.organization_id])).rows[0].ok === true;
  if (!ops) throw auth.authError('FORBIDDEN', '只有承接機構的負責人或調度員可以退回或收回其中一段');

  const at = new Date().toISOString();
  const before = { ...row.data, organizationId: row.organization_id };
  const r = action.run(before, { legId, organizationId: row.organization_id, actorUserId: claims.userId, at });
  if (!r.ok) throw auth.authError('VALIDATION_ERROR', r.error);

  const saved = (await client.query(
    `update bookings set data = $2 where id = $1 returning version`, [bookingId, JSON.stringify(r.booking)])).rows[0];
  const state = String(r.booking.state || '');
  await client.query(
    `insert into app_state (collection, id, organization_id, booking_id, data) values ('bookingEvents', $1, $2, $3, $4)`,
    [`bevt_${auth.randomHex(8)}`, row.organization_id, bookingId, JSON.stringify({
      bookingId, eventType: action.eventType, action: action.eventType, fromState: state, toState: state,
      actorUserId: claims.userId, organizationId: row.organization_id, reasonCode: null, reasonText: '', source: 'booking_leg_endpoint',
      bookingVersion: saved.version,
      metadata: { legId: r.leg.id, direction: r.leg.direction || null, label: r.leg.label || null },
      createdAt: at
    })]);
  await writeAudit(client, {
    eventType: action.audit, actorUserId: claims.userId, organizationId: row.organization_id,
    entityType: 'booking', entityId: bookingId, details: { legId: r.leg.id, direction: r.leg.direction || null }
  });

  return { bookingId, legId: r.leg.id, poolStatus: lifecycle.legPoolStatus(r.leg), version: saved.version };
});
