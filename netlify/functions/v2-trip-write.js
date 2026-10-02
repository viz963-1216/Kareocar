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
 *
 * 行程用 revision 做樂觀鎖。整批在同一筆交易裡，任何一筆不合規則就整批不寫入。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');
const { sanitize } = require('./_bookings');
const { checkTripWrite, bookingIdsOf } = require('./_trip-rules');

const MAX_CHANGES = 50;
const text = (v) => String(v === undefined || v === null ? '' : v).trim();

async function resourceScope(client, record) {
  const { rows } = await client.query('select * from app.trip_resource_scope($1, $2, $3)',
    [text(record.driverId) || null, text(record.vehicleId) || null, bookingIdsOf(record)]);
  return {
    driver: rows.find((r) => r.kind === 'driver') || null,
    vehicle: rows.find((r) => r.kind === 'vehicle') || null,
    bookings: new Map(rows.filter((r) => r.kind === 'booking' && r.active).map((r) => [r.id, r]))
  };
}

async function driverUserId(client, driverId) {
  if (!driverId) return null;
  const { rows } = await client.query('select user_id from drivers where id = $1', [driverId]);
  return rows[0] ? rows[0].user_id : null;
}

/** 司機的通知：指派、改派（原司機與新司機）、行程取消。 */
async function notifyDrivers(client, { id, record, before, organizationId, revision }) {
  const enqueue = (userId, template, payload, key) => client.query(
    'select app.enqueue_notification($1, $2, $3, $4, $5, $5, $6::jsonb, $7, $8)',
    [userId, organizationId, text(record.bookingId) || null, id, template,
     JSON.stringify({ tripId: id, tripCode: record.code || '', ...payload }), 'trip_write_endpoint', key]);
  const newDriver = text(record.driverId);
  const oldDriver = before ? text(before.driverId) : '';
  const status = text(record.status) || 'scheduled';
  if (status === 'cancelled' && (!before || text(before.status) !== 'cancelled')) {
    const userId = await driverUserId(client, newDriver || oldDriver);
    if (userId) await enqueue(userId, 'trip_cancelled', {}, `trip_cancelled:${id}`);
    return;
  }
  if (newDriver === oldDriver) return;
  const newUser = await driverUserId(client, newDriver);
  if (newUser) await enqueue(newUser, 'trip_assigned', {}, `trip_assigned:${id}:${newDriver}:${revision}`);
  const oldUser = await driverUserId(client, oldDriver);
  if (oldUser && oldUser !== newUser) await enqueue(oldUser, 'trip_unassigned', {}, `trip_unassigned:${id}:${oldDriver}:${revision}`);
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
          `select data, organization_id, revision from app_state
            where collection = 'trips' and id = $1 and not deleted
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
          `insert into app_state (collection, id, organization_id, trip_id, booking_id, data, revision)
             values ('trips', $1, $2, $1, $3, $4, 1)
           on conflict (collection, id) do update
             set data = excluded.data, deleted = false,
                 booking_id = coalesce(excluded.booking_id, app_state.booking_id),
                 revision = app_state.revision + 1
           returning organization_id, version, revision, updated_at`,
          [id, organizationId, text(record.bookingId) || null, JSON.stringify(record)]);
        if (!upsert.rows.length) throw auth.authError('FORBIDDEN', `沒有權限寫入行程 ${id}`);
        const saved = upsert.rows[0];
        if (saved.organization_id !== organizationId) {
          // 觸發器把組織清掉代表呼叫者不是該組織的營運方；上面已檢查過，這裡是保險
          throw auth.authError('FORBIDDEN', `沒有權限替這個機構建立行程`);
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
