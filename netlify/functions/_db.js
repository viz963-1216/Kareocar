'use strict';

/**
 * Postgres 連線層。
 *
 * ⚠️ DATABASE_URL 的使用者一定要是 care_ride_app，不能是 postgres。
 *    Postgres 的資料表擁有者預設繞過所有 RLS 政策——用 postgres 連線的話，
 *    baseline migration 裡那 55 條政策一條都不會生效，而且不會有任何
 *    錯誤訊息。啟動時會檢查並直接拒絕啟動。
 */

const { Pool } = require('pg');
// 連線字串的解析與驗證住在 _db-config.js：那個檔案不相依 pg、不做任何 I/O，
// 所以建置階段的檢查腳本可以只載入它，連不上資料庫也沒有 Pool 可以建。
const { resolveDbConfig } = require('./_db-config');

let pool = null;

/** resolveDbConfig 的結果轉成 pg 的 client/pool 設定。刻意不含 connectionString。 */
function pgClientConfig(cfg) {
  const out = {
    host: cfg.host,
    user: cfg.user,
    database: cfg.database,
    ssl: cfg.ssl
  };
  if (cfg.port !== undefined) out.port = cfg.port;
  if (cfg.password !== undefined) out.password = cfg.password;
  if (cfg.application_name !== undefined) out.application_name = cfg.application_name;
  return out;
}

/**
 * 交給 pg Pool 的最終設定。抽出來是為了讓測試能斷言「真正送進 Pool 的值」，
 * 而不是在測試裡重寫一份同樣的組裝邏輯。
 */
function poolOptions(cfg) {
  return {
    ...pgClientConfig(cfg),
    // Netlify Function 是短生命週期的，連線池開小一點，交給 Supabase 的
    // pooler 做真正的匯聚。
    max: 2,
    idleTimeoutMillis: 10_000,
    // connect_timeout=0 的語意是「不設上限」，所以只有 undefined 才套用預設值。
    connectionTimeoutMillis: cfg.connectionTimeoutMillis ?? 8_000
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(poolOptions(resolveDbConfig()));
    pool.on('error', (err) => console.error('[db] idle client error', err));
  }
  return pool;
}

/**
 * 以某個使用者的身分執行一段資料庫操作。
 *
 * set_config 的第三個參數是 true（只在這筆交易內有效）。用 false 的話，
 * 身分會殘留在連線池裡，下一個借到同一條連線的請求就會頂著別人的身分跑——
 * 那是很難察覺的跨使用者資料外洩。
 *
 * userId 傳 null 代表「尚未登入」：RLS 之下幾乎什麼都讀不到，只有登入流程
 * 用的 security definer 函式可以呼叫。
 */
async function withUser(userId, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId == null ? '' : String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線已壞，忽略 */ }
    throw error;
  } finally {
    client.release();
  }
}

/** 尚未登入時使用（註冊、登入本身）。 */
function withoutUser(fn) {
  return withUser(null, fn);
}

/** Postgres 的錯誤碼轉成前端已經在處理的錯誤碼。 */
function translateDbError(error) {
  const pgCode = error && error.code;
  if (pgCode === '42501') return Object.assign(new Error(error.message), { code: 'FORBIDDEN' });
  if (pgCode === '55006') return Object.assign(new Error(error.message), { code: 'BOOKING_CONFLICT' });
  if (pgCode === '23505') return Object.assign(new Error('資料已存在'), { code: 'ACCOUNT_EXISTS' });
  if (pgCode === 'P0002') return Object.assign(new Error(error.message), { code: 'NOT_FOUND' });
  return error;
}

module.exports = {
  getPool, withUser, withoutUser, translateDbError,
  resolveDbConfig, pgClientConfig, poolOptions
};
