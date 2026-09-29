'use strict';

/**
 * 建置階段的 DATABASE_URL 唯讀檢查。
 *
 * 在 Netlify 建置時執行（netlify.toml 的 build command）。DATABASE_URL 設為
 * Secret，值無法從 UI／API／CLI 讀回，只有 Netlify 系統內執行的程式讀得到——
 * 所以只能由這裡檢查。
 *
 * ---------------------------------------------------------------------------
 * 這支檢查「只」驗證兩件事：
 *   1. 連線設定能不能被 resolveDbConfig 接受
 *   2. 非 production 的建置沒有指向正式 Supabase 專案
 *
 * 第 2 點靠非機密環境變數 PRODUCTION_SUPABASE_PROJECT_REF（正式專案的 ref）。
 * 比對的是專案 ref 而不是主機名，理由見 _db-config.js 的 referencesProject。
 * 行為：
 *   * context 精確等於 production：照常通過，只多印一行 production_target。
 *   * 其他 context（deploy-preview、branch-deploy、dev、other、unset）：
 *       - 本機端點：通過（不可能是正式專案）
 *       - 變數未設定：失敗（PROD_REF_UNSET）。沒有設定就無從判斷，寧可擋下。
 *       - 指向正式專案：失敗（NONPROD_TARGETS_PRODUCTION）
 *   * 變數有設定但格式不對：任何 context 都失敗（PROD_REF_INVALID）。
 *

 * 它不驗證、也不能用來宣稱：
 *   * 資料庫連得上（沒有建立 Pool、沒有發出任何連線）
 *   * RLS 政策如預期生效
 *   * 任何帳號、身分或權限正確
 *   * 任何業務流程通過驗收
 * ---------------------------------------------------------------------------
 *
 * 安全性：
 *   * 只 require ./_db-config（不相依 pg、不做 I/O），所以沒有 Pool 可以建。
 *   * 輸出只使用固定白名單詞彙。CONTEXT、參數名稱、reason 都經過白名單對映，
 *     不會把任意輸入反射到 stdout／stderr。
 *   * 永不輸出原始連線字串、密碼、主機名、資料庫名、port、使用者名，
 *     也永不輸出 error.message 或 error.stack。未知例外統一歸類為 UNKNOWN。
 */

const path = require('node:path');
const { resolveDbConfig, referencesProject, isValidProjectRef, CONFIG_REASONS } = require(
  path.join(__dirname, '..', 'netlify', 'functions', '_db-config.js'));

const PREFIX = 'DB_CONFIG_CHECK';

/** 只認這幾個 context，其他一律歸成 other／unset，不反射原值。 */
const KNOWN_CONTEXTS = Object.freeze(['production', 'deploy-preview', 'branch-deploy', 'dev']);

/** 正式專案防呆自己的拒絕分類。 */
const GUARD_REASONS = Object.freeze(['PROD_REF_INVALID', 'PROD_REF_UNSET', 'NONPROD_TARGETS_PRODUCTION']);

/** reason 的完整白名單：解析模組登記的分類、防呆的分類，加上一個統一的未知分類。 */
const REASONS = Object.freeze([...CONFIG_REASONS, ...GUARD_REASONS, 'UNKNOWN']);

function normalizeContext(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return 'unset';
  return KNOWN_CONTEXTS.includes(value) ? value : 'other';
}

/** 任何錯誤 → 白名單內的分類。不在白名單、或沒有 reason，一律 UNKNOWN。 */
function classify(error) {
  const reason = error && error.reason;
  return REASONS.includes(reason) ? reason : 'UNKNOWN';
}

/**
 * 執行檢查。回傳 { ok, lines }，由呼叫端決定怎麼輸出與退出。
 * 抽成函式是為了讓測試能注入會丟出未知例外的解析器。
 */
function check({ env = process.env, resolve = resolveDbConfig } = {}) {
  const context = normalizeContext(env.CONTEXT);
  const lines = [`${PREFIX} context=${context}`];

  let cfg;
  try {
    // 只傳字串進去；解析模組不會碰 process.env。
    cfg = resolve(String(env.DATABASE_URL == null ? '' : env.DATABASE_URL));
  } catch (error) {
    lines.push(`${PREFIX} result=FAIL reason=${classify(error)}`);
    lines.push(`${PREFIX} production_validated=no`);
    return { ok: false, lines };
  }

  // ---------------------------------------------------------- 正式專案防呆
  // ref 本身不是機密，但照樣不輸出：輸出只用固定詞彙。
  const rawRef = String(env.PRODUCTION_SUPABASE_PROJECT_REF == null
    ? '' : env.PRODUCTION_SUPABASE_PROJECT_REF).trim();
  const fail = (reason) => {
    lines.push(`${PREFIX} result=FAIL reason=${reason}`);
    lines.push(`${PREFIX} production_validated=no`);
    return { ok: false, lines };
  };
  if (rawRef && !isValidProjectRef(rawRef)) return fail('PROD_REF_INVALID');

  let productionTarget;
  if (!rawRef) productionTarget = cfg.local ? 'no' : 'unconfigured';
  else productionTarget = referencesProject(cfg, rawRef) ? 'yes' : 'no';

  if (context !== 'production') {
    if (productionTarget === 'unconfigured') return fail('PROD_REF_UNSET');
    if (productionTarget === 'yes') return fail('NONPROD_TARGETS_PRODUCTION');
  }

  // production_validated 只有在 CONTEXT 精確等於 production 且解析成功時才是 yes。
  const productionValidated = context === 'production' ? 'yes' : 'no';

  lines.push(`${PREFIX} result=PASS`);
  lines.push(`${PREFIX} endpoint=${cfg.local ? 'local' : 'remote'}`);
  lines.push(`${PREFIX} tls=${cfg.ssl === false ? 'plaintext-local' : 'encrypted-no-verify'}`);
  // params 的內容一定來自 _db-config 的固定白名單，不是使用者輸入。
  lines.push(`${PREFIX} params=${cfg.params && cfg.params.length ? cfg.params.join(',') : 'none'}`);
  lines.push(`${PREFIX} role_first_segment=ok`);
  lines.push(`${PREFIX} production_target=${productionTarget}`);
  lines.push(`${PREFIX} production_validated=${productionValidated}`);
  return { ok: true, lines };
}

if (require.main === module) {
  const { ok, lines } = check();
  for (const line of lines) console.log(line);
  if (!ok) {
    // 只印分類，不印任何細節。非零退出會讓這次 Netlify 建置失敗，
    // 因此該次建置不會發布；已發布的版本繼續在線上。
    console.error(`${PREFIX} 連線設定檢查未通過，中止建置。`
      + '原因分類見上方 reason；完整訊息刻意不輸出，因為它含有主機名與使用者名。'
      + 'NONPROD_TARGETS_PRODUCTION 表示非 production 的建置連到了正式資料庫；'
      + 'PROD_REF_UNSET 表示尚未設定 PRODUCTION_SUPABASE_PROJECT_REF。');
    process.exit(1);
  }
}

module.exports = { check, classify, normalizeContext, REASONS, GUARD_REASONS, KNOWN_CONTEXTS, PREFIX };
