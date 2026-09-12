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

/** loopback 主機名。Unix socket 另外用「路徑開頭是 /」判斷。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function configError(message) {
  return Object.assign(new Error(message), { code: 'CONFIG_INVALID' });
}

/**
 * 這個連線是否指向本機隔離端點。
 * 只有本機端點才允許明文連線；其他一律必須走 TLS。
 */
function isLocalEndpoint(host) {
  if (!host) return true;                 // 沒有 host＝Unix socket
  if (host.startsWith('/')) return true;  // Unix socket 路徑
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * 從連線字串裡移除 sslmode。
 *
 * 這一步是必要的，不是整理格式：pg 會把 parse(connectionString) 的結果
 * Object.assign 覆蓋到傳進 Pool 的 config 上，所以連線字串裡的 sslmode 會
 * 蓋掉我們在這裡明確指定的 ssl。不拿掉的話，底下那個「遠端一律 TLS」的判斷
 * 就只是個註解，實際生效的是連線字串。
 */
function stripSslmode(url) {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const base = url.slice(0, at);
  const kept = url.slice(at + 1).split('&').filter((p) => !/^sslmode=/i.test(p));
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/**
 * 解析並驗證連線設定。
 *
 * 傳入 rawUrl 時完全不碰 process.env——測試就是這樣在不讀取正式 DATABASE_URL
 * 的情況下驗證這裡的判斷。
 */
function resolveDbConfig(rawUrl) {
  const url = String(rawUrl === undefined ? process.env.DATABASE_URL || '' : rawUrl).trim();
  if (!url) {
    throw Object.assign(new Error('Netlify 尚未設定 DATABASE_URL'), { code: 'CONFIG_MISSING' });
  }
  // 擋掉最容易犯、後果也最嚴重的設定錯誤
  if (/:\/\/postgres(?::|@)/.test(url)) {
    throw configError('DATABASE_URL 不可使用 postgres 角色（會繞過所有 RLS 政策），請改用 care_ride_app');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw configError('DATABASE_URL 不是合法的連線字串');
  }

  // Unix socket 的路徑是百分比編碼塞在 host 欄位；IPv6 會帶方括號。
  const host = decodeURIComponent(parsed.hostname).replace(/^\[/, '').replace(/\]$/, '');
  const sslmode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
  const local = isLocalEndpoint(host);

  if (sslmode === 'disable' && !local) {
    throw configError(
      `DATABASE_URL 要求停用 TLS（sslmode=disable），但主機「${host}」不是本機隔離端點。`
      + '遠端連線一律必須走 TLS；明文連線只允許用在本機隔離測試（Unix socket、localhost、127.0.0.1、::1）。');
  }

  return {
    connectionString: stripSslmode(url),
    // 只有「本機端點 + 明確要求 disable」才走明文。其他情況——包含遠端寫了
    // sslmode=prefer / allow 之類可能靜默降級成明文的設定——一律 TLS。
    ssl: sslmode === 'disable' && local ? false : { rejectUnauthorized: false },
    host,
    local
  };
}

function getPool() {
  if (!pool) {
    const cfg = resolveDbConfig();
    pool = new Pool({
      connectionString: cfg.connectionString,
      // Netlify Function 是短生命週期的，連線池開小一點，交給 Supabase 的
      // pooler 做真正的匯聚。
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: cfg.ssl
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

module.exports = { getPool, withUser, withoutUser, translateDbError, resolveDbConfig };
