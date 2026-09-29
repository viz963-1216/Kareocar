'use strict';

/**
 * 連線字串的解析與驗證。**刻意不相依 pg，也不做任何 I/O。**
 *
 * 為什麼要獨立成一個模組：`tools/check-db-config.js` 會在 Netlify 建置階段
 * 讀取環境變數並呼叫這裡的 resolveDbConfig。那支腳本只 require 這個檔案，
 * 所以 pg 根本不會被載入——「不建立 Pool、不連資料庫」是結構上做不到的，
 * 不是靠自律。也因此建置時不需要 npm install。
 *
 * 這個檔案只用 Node 內建能力（URL / Map / Set / String / Number /
 * decodeURIComponent / Object.assign）：不 require pg、不開連線、不連網、
 * 不讀寫檔案。改動這個檔案時請維持這個性質。
 *
 * 邏輯是從 _db.js 原樣搬過來的，規則沒有改動。唯一的新增是每個錯誤都帶一個
 * 機器可讀的 `reason` 分類——建置檢查只能輸出這個分類，不能輸出 message，
 * 因為 message 內含主機名與使用者名。
 */

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
 * 正式設定相容性尚待確認：supabase/README.md 記載的連線字串形式沒有查詢
 * 參數，但沒有人核對過正式環境變數的實際內容。若正式字串帶了這裡沒列的
 * 參數，部署後會以 CONFIG_INVALID 明確拒絕啟動（而不是靜默降級）。
 */
const SUPPORTED_PARAMS = new Set(['sslmode', 'application_name', 'connect_timeout']);

/** connect_timeout 的上限（秒）。0 代表不設上限，語意與 libpq 一致。 */
const CONNECT_TIMEOUT_MAX_SECONDS = 600;

/** 會覆寫連線身分或 TLS 的參數，錯誤訊息要講得更具體。 */
const OVERRIDE_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'user', 'dbname', 'password', 'passfile',
  'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword',
  'sslnegotiation', 'requiressl', 'options', 'service'
]);

/** 目前支援的 sslmode。verify-* 另外處理。 */
const TLS_MODES = new Set(['', 'require', 'prefer', 'allow']);
const VERIFY_MODES = new Set(['verify-ca', 'verify-full']);

/**
 * 所有可能的拒絕原因。建置檢查只會輸出這個集合裡的字串，不會輸出 message。
 * 新增拒絕條件時一定要同時在這裡登記，否則檢查會把它歸成 UNKNOWN。
 */
const CONFIG_REASONS = Object.freeze([
  'MISSING', 'INVALID_URL', 'BAD_SCHEME',
  'PARAM_CASE', 'PARAM_OVERRIDE', 'PARAM_UNSUPPORTED', 'PARAM_AMBIGUOUS',
  'MISSING_USER', 'ROLE_POSTGRES',
  'SSLMODE_VERIFY_UNSUPPORTED', 'SSLMODE_UNRECOGNIZED', 'PLAINTEXT_REMOTE',
  'CONNECT_TIMEOUT_INVALID'
]);

function configError(message, reason) {
  return Object.assign(new Error(message), { code: 'CONFIG_INVALID', reason });
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
    throw Object.assign(new Error('Netlify 尚未設定 DATABASE_URL'),
      { code: 'CONFIG_MISSING', reason: 'MISSING' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw configError('DATABASE_URL 不是合法的連線字串', 'INVALID_URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw configError(
      `DATABASE_URL 的 scheme 必須是 postgres:// 或 postgresql://，收到「${parsed.protocol}」`,
      'BAD_SCHEME');
  }

  // ---------------------------------------------------------------- 查詢參數
  // 名稱先正規化再驗證與取值。先前是「用小寫比對白名單、卻用大小寫敏感的
  // getAll('sslmode') 取值」，結果 ?SSLMODE=verify-full 通過白名單之後被靜默
  // 忽略，而 ?sslmode=require&SSLMODE=disable 也不會被判為衝突。
  //
  // libpq 的關鍵字全為小寫，所以非小寫的名稱一律明確拒絕，不猜使用者的意圖。
  const params = new Map();          // 小寫名稱 -> 原始值陣列
  const badCase = [];
  for (const [rawName, value] of parsed.searchParams) {
    const name = rawName.toLowerCase();
    if (rawName !== name && !badCase.includes(rawName)) badCase.push(rawName);
    if (!params.has(name)) params.set(name, []);
    params.get(name).push(value);
  }
  if (badCase.length) {
    throw configError(
      `DATABASE_URL 的查詢參數名稱必須全小寫（libpq 關鍵字都是小寫）：收到 ${badCase.join('、')}。`
      + '大小寫混用會讓驗證與取值對不上，一律拒絕而不是靜默忽略。', 'PARAM_CASE');
  }

  const rejected = [...params.keys()].filter((n) => !SUPPORTED_PARAMS.has(n));
  if (rejected.length) {
    const overrides = rejected.filter((n) => OVERRIDE_PARAMS.has(n));
    throw configError(
      (overrides.length
        ? `DATABASE_URL 帶了會覆寫連線身分或 TLS 設定的查詢參數：${overrides.join('、')}。`
          + '這些參數會讓實際連線的主機／使用者／TLS 與驗證過的值不同，一律拒絕。'
        : `DATABASE_URL 帶了不支援的查詢參數：${rejected.join('、')}。`)
      + `目前只支援 ${[...SUPPORTED_PARAMS].join('、')}。`,
      overrides.length ? 'PARAM_OVERRIDE' : 'PARAM_UNSUPPORTED');
  }

  // 重複參數：值相同視為同一個，值不同就是有歧義，一律拒絕。
  // sslmode 的值比對不分大小寫（require 與 REQUIRE 是同一個模式）。
  const valueOf = (name) => {
    const raw = params.get(name);
    if (!raw) return undefined;
    const normalized = raw.map((v) => (name === 'sslmode'
      ? String(v).trim().toLowerCase() : String(v).trim()));
    if (new Set(normalized).size > 1) {
      throw configError(
        `DATABASE_URL 有多個不一致的 ${name}：${normalized.join('、')}。請只保留一個。`,
        name === 'connect_timeout' ? 'CONNECT_TIMEOUT_INVALID' : 'PARAM_AMBIGUOUS');
    }
    return normalized[0];
  };

  const sslmode = valueOf('sslmode') || '';
  const applicationName = valueOf('application_name') || undefined;

  // connect_timeout：libpq 是「秒」，0 代表不設上限。只接受非負整數秒數，
  // 非數字／負值／小數／科學記號／超過上限都明確拒絕，不讓它變成 NaN。
  let connectionTimeoutMillis;       // undefined = 使用預設值
  const rawTimeout = valueOf('connect_timeout');
  if (rawTimeout !== undefined) {
    if (!/^\d+$/.test(rawTimeout)) {
      throw configError(
        `DATABASE_URL 的 connect_timeout=${rawTimeout} 無效：只接受非負整數秒數`
        + `（0 代表不設上限，最大 ${CONNECT_TIMEOUT_MAX_SECONDS}）。`, 'CONNECT_TIMEOUT_INVALID');
    }
    const seconds = Number(rawTimeout);
    if (!Number.isFinite(seconds) || seconds > CONNECT_TIMEOUT_MAX_SECONDS) {
      throw configError(
        `DATABASE_URL 的 connect_timeout=${rawTimeout} 超出範圍：`
        + `上限為 ${CONNECT_TIMEOUT_MAX_SECONDS} 秒（0 代表不設上限）。`, 'CONNECT_TIMEOUT_INVALID');
    }
    connectionTimeoutMillis = seconds * 1000;   // 0 -> 0，pg 視為不設上限
  }

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
    throw configError('DATABASE_URL 必須指定連線使用者（care_ride_app）', 'MISSING_USER');
  }
  if (user.split('.')[0].toLowerCase() === 'postgres') {
    throw configError(
      `DATABASE_URL 不可使用 postgres 角色（會繞過所有 RLS 政策），收到「${user}」，請改用 care_ride_app`,
      'ROLE_POSTGRES');
  }

  // ---------------------------------------------------------------- TLS
  const local = isLocalEndpoint(host);
  let ssl;
  if (sslmode === 'disable') {
    if (!local) {
      throw configError(
        `DATABASE_URL 要求停用 TLS（sslmode=disable），但主機「${host}」不是本機隔離端點。`
        + '遠端連線一律必須走 TLS；明文連線只允許用在本機隔離測試'
        + '（Unix socket、localhost、127.0.0.1、::1）。', 'PLAINTEXT_REMOTE');
    }
    ssl = false;
  } else if (VERIFY_MODES.has(sslmode)) {
    // 這一層目前沒有實作憑證驗證語意（沒有 CA 來源、沒有主機名比對設定），
    // 靜默降成 rejectUnauthorized: false 等於假裝做了驗證，所以明確拒絕。
    throw configError(
      `DATABASE_URL 的 sslmode=${sslmode} 目前不支援：這一層還沒有實作憑證驗證語意，`
      + '接受它等於把「要驗證憑證」靜默降級成不驗證。'
      + `目前支援的 sslmode 為 ${[...TLS_MODES].filter(Boolean).join('、')}（或不指定，預設加密不驗證憑證），`
      + '以及僅限本機隔離測試的 disable。', 'SSLMODE_VERIFY_UNSUPPORTED');
  } else if (TLS_MODES.has(sslmode)) {
    // 既有行為，未改動：加密但不驗證憑證。
    ssl = { rejectUnauthorized: false };
  } else {
    throw configError(
      `DATABASE_URL 的 sslmode=${sslmode} 無法辨識。`
      + `支援：${[...TLS_MODES].filter(Boolean).join('、')}、disable（僅本機隔離測試）。`,
      'SSLMODE_UNRECOGNIZED');
  }

  return {
    host, port, user, password, database, ssl, local,
    application_name: applicationName,
    connectionTimeoutMillis,
    // 以下兩個純粹是給建置檢查用的描述性欄位，不影響連線行為。
    // params 的內容一定來自 SUPPORTED_PARAMS 這個固定白名單。
    sslmode,
    params: [...SUPPORTED_PARAMS].filter((n) => params.has(n))
  };
}

/**
 * Supabase 專案 ref 的形式：小寫英數字。實際長度是 20，這裡放寬一點，
 * 但不接受任何分隔字元——ref 會被拿去跟主機名標籤、使用者名後綴逐段比對，
 * 帶點或斜線的值會讓比對語意變得模糊。
 */
const PROJECT_REF_PATTERN = /^[a-z0-9]{8,40}$/;

function isValidProjectRef(ref) {
  return PROJECT_REF_PATTERN.test(String(ref == null ? '' : ref));
}

/**
 * resolveDbConfig 的結果是否指向指定的 Supabase 專案。
 *
 * 為什麼不直接比對主機名：Transaction pooler 的主機名是整個區域共用的
 * （aws-0-ap-southeast-1.pooler.supabase.com），正式與 Staging 若在同一區，
 * 主機名完全相同，專案只寫在使用者名的後綴（care_ride_app.<ref>）。
 * 直連則是 db.<ref>.supabase.co。所以兩處都要看：
 *   * 主機名的任一標籤等於 ref
 *   * 使用者名第一個點之後的部分等於 ref
 * 本機端點（Unix socket、loopback）不可能是遠端專案，一律 false。
 */
function referencesProject(cfg, ref) {
  if (!cfg || cfg.local || !isValidProjectRef(ref)) return false;
  const target = String(ref);
  const hostLabels = String(cfg.host || '').toLowerCase().split('.');
  if (hostLabels.includes(target)) return true;
  const user = String(cfg.user || '').toLowerCase();
  const dot = user.indexOf('.');
  return dot !== -1 && user.slice(dot + 1) === target;
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

module.exports = {
  resolveDbConfig, isLocalEndpoint, isValidProjectRef, referencesProject,
  SUPPORTED_PARAMS, OVERRIDE_PARAMS, TLS_MODES, VERIFY_MODES,
  CONNECT_TIMEOUT_MAX_SECONDS, CONFIG_REASONS
};
