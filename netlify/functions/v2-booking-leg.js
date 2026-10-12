'use strict';

/**
 * POST /api/v2/booking-leg  —— 來回預約的一段退回需求池、收回、接下（#112、#113，ADR 0004）
 *
 * body: { action: 'release' | 'reclaim' | 'claim', bookingId, legId, organizationId? }
 *
 *   - release：承接機構把還沒排車的那一段退回需求池，別家在需求池看到「只有去程／只有回程」
 *     另一段由協力機構負責時，協力機構升格為承接機構（#115，app.release_leg_promote_partner）
 *   - reclaim：還沒有別家接之前，承接機構把那一段收回
 *   - release 由協力機構呼叫時（#114）：協力機構讀不到整筆預約，由 app.release_partner_leg 退回自己那段、通知承接機構
 *   - claim：別家接送機構（organizationId）接下在需求池的那一段，成為協力機構。接案前它讀不到這筆預約，
 *     所以由 security definer 的 app.claim_booking_leg 鎖定預約、判斷（規則同 lifecycle.claimLeg）、
 *     寫入、記預約事件並通知需求者與承接機構；兩家同時接只有一家成功（409 BOOKING_CONFLICT）
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

async function claim(client, body, claims) {
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const legId = requireId(body.legId, '去程／回程 ');
  const organizationId = requireId(body.organizationId, '接案機構 ');
  const r = (await client.query('select * from app.claim_booking_leg($1, $2, $3)', [bookingId, legId, organizationId])).rows[0];
  await writeAudit(client, {
    eventType: 'booking.leg_partner_claimed', actorUserId: claims.userId, organizationId,
    entityType: 'booking', entityId: bookingId, details: { legId, primaryOrganizationId: r.primary_organization_id }
  });
  return { bookingId, legId, poolStatus: lifecycle.LEG_POOL_STATUS.PARTNER, partnerOrganizationId: organizationId, version: r.version };
}

async function releaseByPartner(client, bookingId, legId, claims) {
  const r = (await client.query('select * from app.release_partner_leg($1, $2)', [bookingId, legId])).rows[0];
  await writeAudit(client, {
    eventType: 'booking.leg_partner_released', actorUserId: claims.userId, organizationId: r.primary_organization_id,
    entityType: 'booking', entityId: bookingId, details: { legId }
  });
  return { bookingId, legId, poolStatus: lifecycle.LEG_POOL_STATUS.IN_POOL, version: r.version };
}

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  if (String(body.action || '').trim() === 'claim') return claim(client, body, claims);
  const action = ACTIONS[String(body.action || '').trim()];
  if (!action) throw auth.authError('VALIDATION_ERROR', '動作只能是退回需求池、收回或接下這一段');
  const bookingId = requireId(body.bookingId, '預約 ID ');
  const legId = requireId(body.legId, '去程／回程 ');

  // RLS：讀得到的只有自己承接、自己建立的預約
  const row = (await client.query(
    `select data, organization_id from bookings where id = $1 and not deleted for update`, [bookingId])).rows[0];
  const ops = row && row.organization_id
    && (await client.query(`select app.has_role_in($1, array['owner','dispatcher']) as ok`, [row.organization_id])).rows[0].ok === true;
  if (!ops && action === ACTIONS.release) return releaseByPartner(client, bookingId, legId, claims);
  if (!ops) throw auth.authError('FORBIDDEN', '只有承接機構的負責人或調度員可以退回或收回其中一段');

  const at = new Date().toISOString();
  const before = { ...row.data, organizationId: row.organization_id };
  const r = action.run(before, { legId, organizationId: row.organization_id, actorUserId: claims.userId, at });
  if (!r.ok) throw auth.authError('VALIDATION_ERROR', r.error);

  // 升格（#115）：另一段由協力機構負責時，協力機構成為新的承接機構。一般更新不能把承接機構改成別家，
  // 由 app.release_leg_promote_partner 在同一筆交易裡做（規則同 lifecycle.releaseLeg），並記事件、通知
  if (r.promoted) {
    const p = (await client.query('select * from app.release_leg_promote_partner($1, $2)', [bookingId, legId])).rows[0];
    await writeAudit(client, {
      eventType: 'booking.leg_partner_promoted', actorUserId: claims.userId, organizationId: row.organization_id,
      entityType: 'booking', entityId: bookingId, details: { legId, newOrganizationId: p.organization_id }
    });
    return { bookingId, legId, poolStatus: lifecycle.LEG_POOL_STATUS.IN_POOL, promoted: true,
      organizationId: p.organization_id, version: p.version };
  }
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
