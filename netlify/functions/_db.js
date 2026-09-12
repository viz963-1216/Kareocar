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

/**
 * 連線字串裡允許出現的查詢參數。白名單，不是黑名單。
 *
 * 為什麼要白名單：libpq 風格的查詢參數可以覆寫連線字串本身的內容。
 * `postgresql://care_ride_app@localhost/db?host=remote.example` 會連到
 * remote.example，不是 localhost——只檢查 URL 的 hostname 會被這樣繞過。
 * 與其一個個列舉危險參數（漏一個就破功），不如只放行明確支援的。
 *
 * supabase/README.md 記載的正式連線字串沒有任何查詢參數，所以這個白名單
 * 不影響正式設定。
 */
const SUPPORTED_PARAMS = new Set(['sslmode', 'application_name', 'connect_timeout']);

/** 會覆寫連線身分或 TLS 的參數，錯誤訊息要講得更具體。 */
const OVERRIDE_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'user', 'dbname', 'password', 'passfile',
  'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword',
  'sslnegotiation', 'requiressl', 'options', 'service'
]);

/** 目前支援的 sslmode。verify-* 另外處理。 */
const TLS_MODES = new Set(['', 'require', 'prefer', 'allow']);
const VERIFY_MODES = new Set(['verify-ca', 'verify-full']);

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
 * 解析並驗證連線設定，回傳可以直接交給 pg 的**離散欄位**。
 *
 * 為什麼不回傳 connectionString：pg 會把 parse(connectionString) 的結果
 * Object.assign 覆蓋到傳入的 config 上。只要把原始字串交回驅動，字串裡的
 * host / user / sslmode 就會蓋掉這裡驗證過的值——「檢查的主機」與「驅動實際
 * 連的主機」可以是兩個不同的東西。改成回傳離散欄位之後，驗證過的值就是
 * 實際生效的值。
 *
 * 傳入 rawUrl 時完全不碰 process.env——測試就是這樣在不讀取正式 DATABASE_URL
 * 的情況下驗證這裡的判斷。
 */
function resolveDbConfig(rawUrl) {
  const url = String(rawUrl === undefined ? process.env.DATABASE_URL || '' : rawUrl).trim();
  if (!url) {
    throw Object.assign(new Error('Netlify 尚未設定 DATABASE_URL'), { code: 'CONFIG_MISSING' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw configError('DATABASE_URL 不是合法的連線字串');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw configError(`DATABASE_URL 的 scheme 必須是 postgres:// 或 postgresql://，收到「${parsed.protocol}」`);
  }

  // ---------------------------------------------------------------- 查詢參數
  // 用 URLSearchParams 一次處理百分比編碼與重複參數，不做字串正規表示式，
  // 避免「檢查時的解碼」與「驅動解析時的解碼」不一致。
  const names = new Set();
  for (const name of parsed.searchParams.keys()) names.add(name.toLowerCase());

  const rejected = [...names].filter((n) => !SUPPORTED_PARAMS.has(n));
  if (rejected.length) {
    const overrides = rejected.filter((n) => OVERRIDE_PARAMS.has(n));
    throw configError(
      (overrides.length
        ? `DATABASE_URL 帶了會覆寫連線身分或 TLS 設定的查詢參數：${overrides.join('、')}。`
          + '這些參數會讓實際連線的主機／使用者／TLS 與驗證過的值不同，一律拒絕。'
        : `DATABASE_URL 帶了不支援的查詢參數：${rejected.join('、')}。`)
      + `目前只支援 ${[...SUPPORTED_PARAMS].join('、')}。`);
  }

  // 重複的 sslmode：值相同視為同一個，值不同就是有歧義，拒絕。
  const sslmodes = parsed.searchParams.getAll('sslmode').map((v) => String(v).trim().toLowerCase());
  if (new Set(sslmodes).size > 1) {
    throw configError(`DATABASE_URL 有多個不一致的 sslmode：${sslmodes.join('、')}。請只保留一個。`);
  }
  const sslmode = sslmodes[0] || '';

  // ---------------------------------------------------------------- 身分
  // Unix socket 的路徑是百分比編碼塞在 host 欄位；IPv6 會帶方括號。
  const host = decodeURIComponent(parsed.hostname).replace(/^\[/, '').replace(/\]$/, '');
  const user = decodeURIComponent(parsed.username || '');
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || undefined;
  const port = parsed.port ? Number(parsed.port) : undefined;

  // Supabase pooler 的使用者是 <role>.<project-ref>，所以要比對第一段，
  // 不能只比對整串——postgres.abcdefgh 一樣是 postgres 角色。
  if (!user) {
    throw configError('DATABASE_URL 必須指定連線使用者（care_ride_app）');
  }
  if (user.split('.')[0].toLowerCase() === 'postgres') {
    throw configError(
      `DATABASE_URL 不可使用 postgres 角色（會繞過所有 RLS 政策），收到「${user}」，請改用 care_ride_app`);
  }

  // ---------------------------------------------------------------- TLS
  const local = isLocalEndpoint(host);
  let ssl;
  if (sslmode === 'disable') {
    if (!local) {
      throw configError(
        `DATABASE_URL 要求停用 TLS（sslmode=disable），但主機「${host}」不是本機隔離端點。`
        + '遠端連線一律必須走 TLS；明文連線只允許用在本機隔離測試'
        + '（Unix socket、localhost、127.0.0.1、::1）。');
    }
    ssl = false;
  } else if (VERIFY_MODES.has(sslmode)) {
    // 這一層目前沒有實作憑證驗證語意（沒有 CA 來源、沒有主機名比對設定），
    // 靜默降成 rejectUnauthorized: false 等於假裝做了驗證，所以明確拒絕。
    throw configError(
      `DATABASE_URL 的 sslmode=${sslmode} 目前不支援：這一層還沒有實作憑證驗證語意，`
      + '接受它等於把「要驗證憑證」靜默降級成不驗證。'
      + `目前支援的 sslmode 為 ${[...TLS_MODES].filter(Boolean).join('、')}（或不指定，預設加密不驗證憑證），`
      + '以及僅限本機隔離測試的 disable。');
  } else if (TLS_MODES.has(sslmode)) {
    // 既有行為，未改動：加密但不驗證憑證。
    ssl = { rejectUnauthorized: false };
  } else {
    throw configError(
      `DATABASE_URL 的 sslmode=${sslmode} 無法辨識。`
      + `支援：${[...TLS_MODES].filter(Boolean).join('、')}、disable（僅本機隔離測試）。`);
  }

  const applicationName = parsed.searchParams.get('application_name') || undefined;
  const connectTimeout = parsed.searchParams.get('connect_timeout');

  return {
    host, port, user, password, database, ssl, local,
    application_name: applicationName,
    connectionTimeoutMillis: connectTimeout ? Number(connectTimeout) * 1000 : undefined
  };
}

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

function getPool() {
  if (!pool) {
    const cfg = resolveDbConfig();
    pool = new Pool({
      ...pgClientConfig(cfg),
      // Netlify Function 是短生命週期的，連線池開小一點，交給 Supabase 的
      // pooler 做真正的匯聚。
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: cfg.connectionTimeoutMillis ?? 8_000
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

module.exports = { getPool, withUser, withoutUser, translateDbError, resolveDbConfig, pgClientConfig };
