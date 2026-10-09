'use strict';
/**
 * 預約與行程存在正式資料表 bookings／trips（ADR 0005，migration 0031），其他集合仍在 app_state。
 * 測試讀資料列時用 selectRow 決定要查哪張表；欄位名稱兩邊相同（預約沒有 revision，回 0）。
 */
const TYPED = new Set(['bookings', 'trips']);

async function selectRow(db, collection, id, columns) {
  if (TYPED.has(collection)) {
    const cols = columns.map((c) => (c === 'revision' && collection === 'bookings' ? '0 as revision' : c));
    return (await db.query(`select ${cols.join(', ')} from ${collection} where id = $1`, [id])).rows[0] || null;
  }
  return (await db.query(`select ${columns.join(', ')} from app_state where collection = $1 and id = $2`, [collection, id])).rows[0] || null;
}

module.exports = { TYPED, selectRow };
