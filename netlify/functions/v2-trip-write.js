'use strict';

/**
 * POST /api/v2/trip-write  —— 調度端建立與修改行程
 *
 * body: { changes: [{ collection: 'trips', id, record, expectedRevision }] }（與 state-mutate 相同的
 * 形狀，前端的待送出佇列把 trips 分流到這裡）
 *
 * 規則在 _trip-rules.js：只有行程機構的負責人、調度員能寫；機構不能改；狀態照轉換表走
 * （已開始的行程不能取消）；司機、車輛、新關聯的預約都必須屬於行程的機構。
 * 司機執行自己的行程走 v2-trip-execute；需求者取消走 v2-cancel-booking。
 *
 * 指派、改派、取消時通知相關司機（notifications 資料表，見 0007）。
 * 取消行程時，同一筆交易內把排在這趟的去程／回程退回待排車，已排車的預約退回部分排車
 * （#76 決策「排好的退回部分排車」；規則在 js/lifecycle.js 的 unscheduleTripLegs）。
 *
 * 行程用 revision 做樂觀鎖。整批在同一筆交易裡，任何一筆不合規則就整批不寫入。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');
const { sanitize } = require('./_bookings');
const { checkTripWrite } = require('./_trip-rules');
const { resourceScope, notifyDrivers } = require('./_trips');
const lifecycle = require('../../js/lifecycle.js');

const MAX_CHANGES = 50;
const text = (v) => String(v === undefined || v === null ? '' : v).trim();

/** 這趟行程關聯的預約 ID */
function tripBookingIds(trip) {
  const ids = new Set();
  const add = (v) => { if (text(v)) ids.add(text(v)); };
  add(trip && trip.bookingId);
  for (const id of (trip && Array.isArray(trip.bookingIds) ? trip.bookingIds : [])) add(id);
  for (const ref of (trip && Array.isArray(trip.bookingLegRefs) ? trip.bookingLegRefs : [])) add(ref && ref.bookingId);
  return [...ids];
}

/** 取消行程：排在這趟的去程／回程退回待排車，並寫預約事件 */
async function unscheduleBookingsOfTrip(client, { tripId, trip, actorUserId, at }) {
  for (const bookingId of tripBookingIds(trip)) {
    const row = (await client.query(
      `select data, organization_id from bookings where id = $1 and not deleted for update`,
      [bookingId])).rows[0];
    if (!row) continue;
    const r = lifecycle.unscheduleTripLegs(row.data || {}, { tripId, at });
    if (!r.changed) continue;
    await client.query(`update bookings set data = $2 where id = $1`, [bookingId, JSON.stringify(r.booking)]);
    const event = { id: `bevt_${auth.randomHex(8)}`, bookingId, eventType: 'leg_unscheduled', action: 'unschedule',
      fromState: r.from, toState: r.to, actorUserId, organizationId: row.organization_id || null, tripId,
      source: 'trip_cancelled', bookingVersion: r.booking.version, metadata: { legIds: r.legIds }, createdAt: at };
    await client.query(
      `insert into app_state (collection, id, organization_id, booking_id, data) values ('bookingEvents', $1, $2, $3, $4)`,
      [event.id, row.organization_id || null, bookingId, JSON.stringify(event)]);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);
    const body = parseBody(event);
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!changes.length) throw auth.authError('VALIDATION_ERROR', '沒有可儲存的行程異動');
    if (changes.length > MAX_CHANGES) throw auth.authError('VALIDATION_ERROR', `單次最多 ${MAX_CHANGES} 筆行程`);

    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;

      const results = [];
      for (const change of changes) {
        if (text(change.collection) !== 'trips') throw auth.authError('COLLECTION_FORBIDDEN', '這支端點只處理行程');
        if (change.deleted === true) throw auth.authError('VALIDATION_ERROR', '行程不能刪除，請改為取消');
        const incoming = sanitize(change.record);
        const id = text(change.id || incoming.id);
        if (!id || id.length > 180) throw auth.authError('VALIDATION_ERROR', '行程 ID 無效');
        incoming.id = id;

        const existing = (await client.query(
          `select data, organization_id, revision from trips
            where id = $1 and not deleted
            for update`, [id])).rows[0] || null;
        const organizationId = existing ? existing.organization_id : (text(incoming.organizationId) || null);
        const canManage = admin || (Boolean(organizationId) && (await client.query(
          `select app.has_role_in($1, array['owner','dispatcher']) as ok`, [organizationId])).rows[0].ok === true);

        if (existing && change.expectedRevision !== undefined) {
          const seen = Math.max(0, Number(change.expectedRevision) || 0);
          if (Math.max(0, Number(existing.revision) || 0) !== seen) {
            throw auth.authError('TRIP_CONFLICT', '這筆行程已被其他人更新，請重新整理');
          }
        }

        let record;
        try {
          record = checkTripWrite({ record: incoming, existing, organizationId, canManage,
            scope: await resourceScope(client, incoming) });
        } catch (error) {
          throw auth.authError(error.code || 'VALIDATION_ERROR', error.message);
        }

        const upsert = await client.query(
          // 寫正式資料表（ADR 0005）；歸屬規則由觸發器處理
          `insert into trips (id, organization_id, data, revision)
             values ($1, $2, $3, 1)
           on conflict (id) do update
             set data = excluded.data, deleted = false,
                 revision = trips.revision + 1
           returning organization_id, version, revision, updated_at`,
          [id, organizationId, JSON.stringify(record)]);
        if (!upsert.rows.length) throw auth.authError('FORBIDDEN', `沒有權限寫入行程 ${id}`);
        const saved = upsert.rows[0];
        if (saved.organization_id !== organizationId) {
          // 觸發器把組織清掉代表呼叫者不是該組織的營運方；上面已檢查過，這裡是保險
          throw auth.authError('FORBIDDEN', `沒有權限寫入這個機構的行程`);
        }
        if (existing && text((existing.data || {}).status) !== 'cancelled' && text(record.status) === 'cancelled') {
          await unscheduleBookingsOfTrip(client, { tripId: id, trip: existing.data || {}, actorUserId: claims.userId,
            at: new Date().toISOString() });
        }
        await notifyDrivers(client, { id, record, before: existing ? existing.data || {} : null,
          organizationId, revision: saved.revision });
        results.push({ collection: 'trips', id, status: record.status || 'scheduled',
          version: saved.version, revision: saved.revision, updatedAt: saved.updated_at });
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'trip.batch_written',$2,'trip','batch','TRIP_WRITE',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         JSON.stringify({ count: results.length, trips: results.map((r) => `${r.id}:${r.status}`) })]);
      return { ok: true, results, count: results.length };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
