'use strict';

/**
 * 寫行程的共用部分：v2-trip-write（修改行程）與 v2-schedule-trips（排車建立行程）都用。
 */

const { bookingIdsOf } = require('./_trip-rules');

const text = (v) => String(v === undefined || v === null ? '' : v).trim();

/** 行程的司機、車輛、關聯預約各屬於哪個機構（app.trip_resource_scope，見 0006）。 */
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

module.exports = { resourceScope, notifyDrivers, driverUserId };
