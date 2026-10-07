'use strict';

/**
 * POST /api/v2/schedule-trips  —— 排車：建立行程並把預約排進去，一筆交易
 *
 * body: {
 *   trips: [行程紀錄…],                 // 前端算好的停靠點、時間、乘客；每趟的 bookingLegRefs 列出排進來的預約 leg
 *   dispatchPlanId?: string,            // 套用自動排車建議時：方案必須是 confirmed，成功後標成 applied
 *   expectedVersions?: { 預約ID: 版本 } // 前端看到的預約版本（資料列的 version）；不一樣就拒絕，請調度重新整理
 * }
 *
 * 以前排車是前端改完整份資料後，預約、行程、事件分三個端點、三筆交易送出；行程那一步失敗時，
 * 伺服器上會留下「已排車卻沒有行程」的預約。現在一個請求、一筆交易：任何一筆不合規則就全部不寫入。
 *
 * - 行程：與 v2-trip-write 相同的規則（_trip-rules：機構、司機、車輛、預約都要屬於行程的機構）
 * - 預約：由伺服器用 js/lifecycle.js 的 scheduleBookingLeg 計算排車後的樣子（與前端同一個函式），
 *   前端送來的預約內容一律不採用
 * - 事件：預約的 leg_scheduled、行程的 trip_created 由伺服器產生
 * - 通知：預約第一次進入排車時通知需求者；指派的司機收到通知
 *
 * 排車權限依預約的承接機構判斷；某一段被平台指定給其他機構時目前不支援（那個機構讀不到這筆預約）。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');
const { sanitize } = require('./_bookings');
const { checkTripWrite, bookingIdsOf } = require('./_trip-rules');
const { resourceScope, notifyDrivers } = require('./_trips');
const lifecycle = require('../../js/lifecycle.js');

const MAX_TRIPS = 20;
const MAX_LEGS = 60;
const TRIP_EVENT_SCHEMA_VERSION = 1;
const SCHEDULED = new Set(['partially_scheduled', 'scheduled']);
const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const fail = (code, message) => { throw auth.authError(code, message); };

/** 每趟行程排進來的 leg：[{ bookingId, legId }]，必須與 bookingIds 一致。 */
function legRefsOf(trip) {
  const refs = Array.isArray(trip.bookingLegRefs) ? trip.bookingLegRefs : [];
  const out = refs.map((r) => ({ bookingId: text(r && r.bookingId), legId: text(r && r.legId) || null }));
  if (out.some((r) => !r.bookingId)) fail('VALIDATION_ERROR', `行程 ${trip.id} 的預約資料不完整`);
  const fromRefs = [...new Set(out.map((r) => r.bookingId))].sort();
  const fromIds = bookingIdsOf(trip).sort();
  if (JSON.stringify(fromRefs) !== JSON.stringify(fromIds)) fail('VALIDATION_ERROR', `行程 ${trip.id} 的預約清單前後不一致`);
  return out;
}

function tripEvent(tripId, sequence, eventType, { at, actorUserId, reason, metadata }) {
  return {
    id: `tevt_${auth.randomHex(8)}`, schemaVersion: TRIP_EVENT_SCHEMA_VERSION, tripId, sequence, eventType, at,
    actorUserId, clientRecordedAt: null, serverRecordedAt: at, deviceId: null, deviceIdSource: 'server', sessionId: null,
    stepId: null, reason, metadata, targetEventIds: []
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);
    const body = parseBody(event);
    const trips = Array.isArray(body.trips) ? body.trips.map((t) => sanitize(t)) : [];
    const dispatchPlanId = text(body.dispatchPlanId) || null;
    const expectedVersions = body.expectedVersions && typeof body.expectedVersions === 'object' ? body.expectedVersions : {};
    if (!trips.length) fail('VALIDATION_ERROR', '沒有要建立的行程');
    if (trips.length > MAX_TRIPS) fail('VALIDATION_ERROR', `一次最多建立 ${MAX_TRIPS} 趟行程`);

    // 先檢查請求本身：每趟的 leg、同一個 leg 不能出現兩次
    const seenLegs = new Set();
    const plan = trips.map((trip) => {
      trip.id = text(trip.id);
      if (!trip.id || trip.id.length > 180) fail('VALIDATION_ERROR', '行程 ID 無效');
      const refs = legRefsOf(trip);
      for (const r of refs) {
        const key = `${r.bookingId}:${r.legId || ''}`;
        if (seenLegs.has(key)) fail('VALIDATION_ERROR', '同一段預約不能排進兩趟行程');
        seenLegs.add(key);
      }
      return { trip, refs };
    });
    if (seenLegs.size > MAX_LEGS) fail('VALIDATION_ERROR', `一次最多排 ${MAX_LEGS} 段預約`);

    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;
      const isOps = async (organizationId) => admin || (Boolean(organizationId) && (await client.query(
        `select app.has_role_in($1, array['owner','dispatcher']) as ok`, [organizationId])).rows[0].ok === true);
      const at = new Date().toISOString();

      // 自動排車建議：鎖住方案，必須是已確認、同一個機構
      let planRow = null;
      if (dispatchPlanId) {
        planRow = (await client.query(
          `select data, organization_id from app_state where collection = 'dispatchPlans' and id = $1 and not deleted for update`,
          [dispatchPlanId])).rows[0] || null;
        if (!planRow) fail('NOT_FOUND', '找不到排車建議，請重新產生');
        if (text(planRow.data && planRow.data.status) !== 'confirmed') fail('BOOKING_CONFLICT', '排車建議已套用或已失效，請重新產生');
      }

      // 預約：依 id 排序後鎖住，避免兩個調度同時排車時互相等待
      const bookingIds = [...new Set(plan.flatMap((p) => p.refs.map((r) => r.bookingId)))].sort();
      const bookings = new Map();
      for (const id of bookingIds) {
        const row = (await client.query(
          `select data, organization_id, version from app_state where collection = 'bookings' and id = $1 and not deleted for update`,
          [id])).rows[0];
        if (!row) fail('NOT_FOUND', `找不到預約 ${id}，或你沒有權限排這筆預約`);
        if (!(await isOps(row.organization_id))) fail('FORBIDDEN', `沒有權限排預約 ${id}`);
        // 前端拿到的版本是資料列的 version（v2-state-load 用它覆蓋），每次寫入由觸發器 +1
        if (id in expectedVersions) {
          const seen = Number(expectedVersions[id]);
          const actual = Number(row.version);
          if (seen !== actual) fail('BOOKING_CONFLICT', '預約已被其他人更新，請重新整理後再排車');
        }
        bookings.set(id, { before: row.data || {}, current: row.data || {}, organizationId: row.organization_id, events: [] });
      }

      const savedTrips = [];
      for (const { trip, refs } of plan) {
        const organizationId = text(trip.organizationId) || null;
        if (planRow && organizationId !== planRow.organization_id) fail('VALIDATION_ERROR', '行程的機構與排車建議不同');
        const exists = (await client.query(
          `select 1 from app_state where collection = 'trips' and id = $1`, [trip.id])).rows.length > 0;
        if (exists) fail('TRIP_CONFLICT', `行程 ${trip.id} 已經存在，請重新整理`);

        let record;
        try {
          record = checkTripWrite({ record: trip, existing: null, organizationId, viaScheduleCommand: true,
            canManage: await isOps(organizationId), scope: await resourceScope(client, trip) });
        } catch (error) {
          fail(error.code || 'VALIDATION_ERROR', error.message);
        }

        for (const ref of refs) {
          const b = bookings.get(ref.bookingId);
          const r = lifecycle.scheduleBookingLeg(b.current, { legId: ref.legId, tripId: trip.id, organizationId, at });
          if (!r.ok) fail('BOOKING_CONFLICT', `預約 ${ref.bookingId}：${r.error}`);
          b.current = r.booking;
          b.events.push({
            id: `bevt_${auth.randomHex(8)}`, bookingId: ref.bookingId, eventType: 'leg_scheduled', action: 'schedule',
            fromState: r.from, toState: r.to, actorUserId: claims.userId, organizationId, tripId: trip.id,
            reasonCode: null, reasonText: '', source: dispatchPlanId ? 'dispatch_plan' : 'manual_trip',
            bookingVersion: r.booking.version,
            metadata: { legId: r.leg.id, direction: r.leg.direction || null, label: r.leg.label || null, allLegsScheduled: r.to === 'scheduled' },
            createdAt: at
          });
        }

        const saved = (await client.query(
          `insert into app_state (collection, id, organization_id, trip_id, booking_id, data, revision)
             values ('trips', $1, $2, $1, $3, $4, 1)
           returning organization_id, revision`,
          [trip.id, organizationId, text(record.bookingId) || null, JSON.stringify(record)])).rows[0];
        if (!saved || saved.organization_id !== organizationId) fail('FORBIDDEN', '沒有權限替這個機構建立行程');

        const events = [tripEvent(trip.id, 1, 'trip_created', {
          at, actorUserId: claims.userId, reason: dispatchPlanId ? 'dispatch_plan' : 'manual_trip',
          metadata: { status: 'scheduled', driverId: record.driverId || null, vehicleId: record.vehicleId || null, dispatchPlanId }
        })];
        if (record.activeExecutionSnapshotId) {
          events.push(tripEvent(trip.id, 2, 'trip_execution_snapshot_captured', {
            at, actorUserId: claims.userId, reason: '行程建立時凍結執行資料',
            metadata: { snapshotId: record.activeExecutionSnapshotId }
          }));
        }
        for (const e of events) {
          await client.query(
            `insert into app_state (collection, id, organization_id, trip_id, data) values ('tripEvents', $1, $2, $3, $4)`,
            [e.id, organizationId, trip.id, JSON.stringify(e)]);
        }
        await notifyDrivers(client, { id: trip.id, record, before: null, organizationId, revision: saved.revision });
        savedTrips.push({ id: trip.id, revision: saved.revision });
      }

      const savedBookings = [];
      for (const [id, b] of bookings) {
        await client.query(
          `update app_state set data = $2 where collection = 'bookings' and id = $1`, [id, JSON.stringify(b.current)]);
        for (const e of b.events) {
          await client.query(
            `insert into app_state (collection, id, organization_id, booking_id, data) values ('bookingEvents', $1, $2, $3, $4)`,
            [e.id, b.organizationId, id, JSON.stringify(e)]);
        }
        if (!SCHEDULED.has(text(b.before.state)) && SCHEDULED.has(text(b.current.state))) {
          await client.query('select app.notify_booking_requester($1, $2, $3::jsonb, $4, $5)', [
            id, 'booking_scheduled', JSON.stringify({ tripId: b.current.tripId || null }),
            'schedule_trips_endpoint', `scheduled:${id}:${b.current.tripId || ''}`]);
        }
        savedBookings.push({ id, state: b.current.state });
      }

      if (planRow) {
        const planData = { ...planRow.data, status: 'applied', appliedAt: at, appliedByUserId: claims.userId,
          appliedTripIds: savedTrips.map((t) => t.id), appliedCount: savedTrips.length };
        await client.query(`update app_state set data = $2 where collection = 'dispatchPlans' and id = $1`,
          [dispatchPlanId, JSON.stringify(planData)]);
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'trip.scheduled',$2,'trip','batch','SCHEDULE_TRIPS',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         JSON.stringify({ trips: savedTrips.map((t) => t.id), bookings: savedBookings.map((b) => `${b.id}:${b.state}`), dispatchPlanId })]);
      return { trips: savedTrips, bookings: savedBookings, dispatchPlanId };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
