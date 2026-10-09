'use strict';

/**
 * 預約的伺服器計算欄位，給 v2-booking-write 使用。
 */

const geo = require('./_geo');

// 這些欄位絕對不進資料庫，即使前端不小心送上來
const NEVER_STORE = ['password', 'passwordHash', 'passwordUpdatedAt', 'credential',
  'credentialHash', 'salt', 'sessionToken', 'accessToken', 'refreshToken', 'idToken'];

function sanitize(record) {
  const out = { ...(record && typeof record === 'object' ? record : {}) };
  for (const key of NEVER_STORE) delete out[key];
  return out;
}

/**
 * 預約的伺服器計算欄位（serverComputed：定位、模糊地址、距離、車程、報價）只由伺服器產生。
 * 前端送上來的同名欄位一律忽略：地址沒變就沿用資料庫裡的值，地址是新的或改過就重新
 * 定位與計算；找不到地址時整批拒絕（ADDRESS_NOT_FOUND）。
 * 前端放在 commercialSnapshots 裡的報價金額也一律換成伺服器的報價。
 */
async function applyServerBookingFields(client, id, record) {
  const hash = geo.addressKey(record.pickupAddress, record.destination);
  const stored = (await client.query(
    `select data->'serverComputed' as sc from bookings where id = $1`, [id])).rows[0];
  const current = stored && stored.sc && typeof stored.sc === 'object' ? stored.sc : null;
  record.serverComputed = current && current.addressKey === hash
    ? current
    : await geo.computeBookingGeo(record.pickupAddress, record.destination);
  if (Array.isArray(record.commercialSnapshots)) {
    record.commercialSnapshots = record.commercialSnapshots.map((snap) => (snap && typeof snap === 'object'
      ? { ...snap, quote: { ...(snap.quote || {}), ...geo.serverQuote() } } : snap));
  }
}

module.exports = { applyServerBookingFields, sanitize };
