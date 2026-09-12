'use strict';

/**
 * Postgres 連線層。
 *
 * ⚠️ DATABASE_URL 的使用者一定要是 care_ride_app，不能是 postgres。
 *    Postgres 的資料表擁有者預設繞過所有 RLS 政策——用 postgres 連線的話，
 *    supabase/migrations/0002 裡那 55 條政策一條都不會生效，而且不會有任何
 *    錯誤訊息。啟動時會檢查並直接拒絕啟動。
 */

const { Pool } = require('pg');

let pool = null;

function connectionString() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw Object.assign(new Error('Netlify 尚未設定 DATABASE_URL'), { code: 'CONFIG_MISSING' });
  }
  // 擋掉最容易犯、後果也最嚴重的設定錯誤
  if (/:\/\/postgres(?::|@)/.test(url)) {
    throw Object.assign(
      new Error('DATABASE_URL 不可使用 postgres 角色（會繞過所有 RLS 政策），請改用 care_ride_app'),
      { code: 'CONFIG_INVALID' });
  }
  return url;
}

function getPool() {
  if (!pool) {
    const url = connectionString();
    // 正式環境（Supabase）一律走 TLS。只有連線字串明確寫 sslmode=disable 時才
    // 關掉——那是給隔離測試用的本機 Postgres，它沒有啟用 SSL，硬要 TLS 會
    // 直接連不上。正式連線字串不會有這個參數，行為不變。
    const sslDisabled = /[?&]sslmode=disable(&|$)/.test(url);
    pool = new Pool({
      connectionString: url,
      // Netlify Function 是短生命週期的，連線池開小一點，交給 Supabase 的
      // pooler 做真正的匯聚。
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: sslDisabled ? false : { rejectUnauthorized: false }
    });
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

module.exports = { getPool, withUser, withoutUser, translateDbError };
