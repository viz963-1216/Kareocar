'use strict';
/**
 * tools/check-db-config.js 與 netlify/functions/_db-config.js 的離線測試。
 *
 * 不需要資料庫、不需要 node_modules、不連網——_db-config.js 刻意不相依 pg，
 * 這支測試也順便驗證這件事。
 *
 * 所有連線字串都是合成的，而且刻意在密碼、主機名、資料庫名、使用者名、參數
 * 名稱裡塞進可辨識的標記字串，然後斷言 stdout／stderr 一個標記都沒有出現。
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { armExitWatchdog } = require('./_exit-watchdog');

// 這支測試會開 30 幾個子行程。任何一個卡住都不該把整個套件拖到 job timeout，
// 所以每個子行程都設硬性逾時，超時直接 SIGKILL。
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_MAX_BUFFER = 1 << 20;

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'check-db-config.js');
const CONFIG_MODULE = path.join(ROOT, 'netlify', 'functions', '_db-config.js');

const { check, classify, normalizeContext, REASONS, GUARD_REASONS } = require(CLI);
const { resolveDbConfig, referencesProject, isValidProjectRef } = require(CONFIG_MODULE);

// 這些字串只要出現在任何輸出裡就是洩漏
const M = {
  user: 'ZZUSERMARKERZZ',
  pass: 'ZZPASSMARKERZZ',
  host: 'ZZHOSTMARKERZZ',
  db: 'ZZDBMARKERZZ',
  // 參數名稱的標記必須是小寫，否則會先撞到 PARAM_CASE 而不是 PARAM_UNSUPPORTED
  param: 'zzparammarkerzz',
  message: 'ZZMESSAGEMARKERZZ'
};
const ALL_MARKERS = [...Object.values(M), 'zzprodrefmarkerzz', 'zzstagingrefmarkerzz'];

const VALID_REMOTE = `postgresql://care_ride_app.${M.user}:${M.pass}@db.${M.host}.example.com:6543/${M.db}?sslmode=require`;
const VALID_LOCAL = 'postgresql://care_ride_app@127.0.0.1:5432/careride_local?sslmode=disable';

// 合成的專案 ref（小寫英數字，與真實 Supabase ref 同形）。PROD 當正式、STAGING 當其他專案。
const PROD_REF = 'zzprodrefmarkerzz';
const STAGING_REF = 'zzstagingrefmarkerzz';
// 同一區的 pooler 主機名是共用的，專案只在使用者名後綴
const POOLER_HOST = 'aws-0-ap-southeast-1.pooler.supabase.com';
const PROD_POOLER = `postgresql://care_ride_app.${PROD_REF}:${M.pass}@${POOLER_HOST}:6543/postgres?sslmode=require`;
const STAGING_POOLER = `postgresql://care_ride_app.${STAGING_REF}:${M.pass}@${POOLER_HOST}:6543/postgres?sslmode=require`;
const PROD_DIRECT = `postgresql://care_ride_app:${M.pass}@db.${PROD_REF}.supabase.co:5432/postgres?sslmode=require`;
const STAGING_DIRECT = `postgresql://care_ride_app:${M.pass}@db.${STAGING_REF}.supabase.co:5432/postgres?sslmode=require`;

let pass = 0;
const ok = (name) => { console.log('  PASS', name); pass += 1; };

// 子行程會繼承這裡的環境。開發機若剛好設了正式 ref，「未設定」的案例就測不到，
// 所以先從父行程清掉，每個案例需要時再明確帶入。
delete process.env.PRODUCTION_SUPABASE_PROJECT_REF;

/** 跑 CLI，回傳 { code, stdout, stderr }。不會丟出例外。 */
function runCli(env) {
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: CHILD_MAX_BUFFER
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || '')
    };
  }
}

function assertNoLeak(label, ...texts) {
  const blob = texts.join('\n');
  for (const marker of ALL_MARKERS) {
    assert.ok(!blob.includes(marker), `${label}：輸出洩漏了標記 ${marker}`);
  }
}

/** 每一行都必須符合固定詞彙，不可以出現任意反射內容。 */
const LINE_SHAPES = [
  /^DB_CONFIG_CHECK context=(production|deploy-preview|branch-deploy|dev|other|unset)$/,
  /^DB_CONFIG_CHECK result=PASS$/,
  /^DB_CONFIG_CHECK result=FAIL reason=[A-Z_]+$/,
  /^DB_CONFIG_CHECK endpoint=(local|remote)$/,
  /^DB_CONFIG_CHECK tls=(plaintext-local|encrypted-no-verify)$/,
  /^DB_CONFIG_CHECK params=(none|[a-z_,]+)$/,
  /^DB_CONFIG_CHECK role_first_segment=ok$/,
  /^DB_CONFIG_CHECK production_target=(yes|no|unconfigured)$/,
  /^DB_CONFIG_CHECK production_validated=(yes|no)$/
];

function assertLineShapes(label, lines) {
  for (const line of lines) {
    assert.ok(LINE_SHAPES.some((re) => re.test(line)), `${label}：輸出格式不在白名單內 → ${line}`);
  }
}

// --------------------------------------------------------------------------
console.log('--- 純解析模組不相依 pg、不做 I/O ---');
{
  // 在乾淨的子行程裡只載入 _db-config.js，確認沒有任何 node_modules 被載入。
  const out = execFileSync(process.execPath, ['-e',
    `require(${JSON.stringify(CONFIG_MODULE)});`
    + 'const bad=Object.keys(require.cache).filter(k=>k.includes("node_modules"));'
    + 'console.log(bad.length?"LOADED:"+bad.join(","):"CLEAN");'
  ], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: CHILD_MAX_BUFFER });
  assert.equal(out.trim(), 'CLEAN');
  ok('只載入 _db-config.js 時不會載入任何 node_modules（包含 pg）');

  const source = require('node:fs').readFileSync(CONFIG_MODULE, 'utf8');
  for (const forbidden of ["require('pg')", 'require("pg")', 'node:fs', 'node:net', 'node:http']) {
    assert.ok(!source.includes(forbidden), `_db-config.js 不應出現 ${forbidden}`);
  }
  assert.ok(!/\brequire\s*\(/.test(source), '_db-config.js 不應 require 任何東西');
  ok('_db-config.js 完全沒有 require，不可能連網或讀寫檔案');
}

// --------------------------------------------------------------------------
console.log('--- 有效設定 ---');
{
  const r = runCli({ CONTEXT: 'production', DATABASE_URL: VALID_REMOTE });
  const lines = r.stdout.trim().split('\n');
  assert.equal(r.code, 0, '有效設定的退出碼應為 0');
  assertLineShapes('有效遠端設定', lines);
  assert.ok(lines.includes('DB_CONFIG_CHECK result=PASS'));
  assert.ok(lines.includes('DB_CONFIG_CHECK endpoint=remote'));
  assert.ok(lines.includes('DB_CONFIG_CHECK tls=encrypted-no-verify'));
  assert.ok(lines.includes('DB_CONFIG_CHECK params=sslmode'));
  assert.ok(lines.includes('DB_CONFIG_CHECK production_validated=yes'));
  assertNoLeak('有效遠端設定', r.stdout, r.stderr);
  ok('有效遠端設定：PASS、exit 0、production_validated=yes、無標記洩漏');
}
{
  const r = runCli({ CONTEXT: 'production', DATABASE_URL: VALID_LOCAL });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('endpoint=local'));
  assert.ok(r.stdout.includes('tls=plaintext-local'));
  ok('本機明文設定：PASS，分類為 local / plaintext-local');
}
{
  const r = runCli({
    CONTEXT: 'production',
    DATABASE_URL: 'postgresql://care_ride_app@db.example.com:6543/d?sslmode=require'
      + '&application_name=care-ride&connect_timeout=15'
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('params=sslmode,application_name,connect_timeout'),
    'params 應列出白名單內實際出現的三個');
  ok('三個支援參數都出現時 params 正確列出');
}
{
  const r = runCli({ CONTEXT: 'production', DATABASE_URL: 'postgresql://care_ride_app@db.example.com/d' });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('params=none'));
  ok('沒有查詢參數時 params=none');
}

// --------------------------------------------------------------------------
console.log('--- Secret 缺失或讀不到 ---');
for (const [label, env] of [
  ['完全未設定', { CONTEXT: 'production' }],
  ['空字串', { CONTEXT: 'production', DATABASE_URL: '' }],
  ['只有空白', { CONTEXT: 'production', DATABASE_URL: '   ' }]
]) {
  const r = runCli({ ...env, DATABASE_URL: env.DATABASE_URL });
  assert.equal(r.code, 1, `${label}：必須 FAIL（exit 1），不可放行`);
  assert.ok(r.stdout.includes('result=FAIL reason=MISSING'), `${label}：reason 應為 MISSING`);
  assert.ok(r.stdout.includes('production_validated=no'));
  ok(`Secret ${label} → FAIL / reason=MISSING / exit 1`);
}

// --------------------------------------------------------------------------
console.log('--- 每一類拒絕條件 ---');
const REJECTIONS = [
  ['INVALID_URL', 'definitely not a url'],
  ['BAD_SCHEME', `mysql://care_ride_app@db.${M.host}.example.com/d`],
  ['MISSING_USER', 'postgresql://@db.example.com/d'],
  ['ROLE_POSTGRES', `postgresql://postgres:${M.pass}@db.${M.host}.example.com/d`],
  ['ROLE_POSTGRES', `postgresql://postgres.${M.user}@db.example.com/d`],
  ['PARAM_CASE', `postgresql://care_ride_app@db.example.com/d?SSLMODE=require`],
  ['PARAM_OVERRIDE', `postgresql://care_ride_app@localhost/d?host=${M.host}.example.com&sslmode=disable`],
  ['PARAM_UNSUPPORTED', `postgresql://care_ride_app@db.example.com/d?${M.param}=1`],
  ['PARAM_AMBIGUOUS', 'postgresql://care_ride_app@db.example.com/d?sslmode=require&sslmode=prefer'],
  ['SSLMODE_VERIFY_UNSUPPORTED', 'postgresql://care_ride_app@db.example.com/d?sslmode=verify-full'],
  ['SSLMODE_VERIFY_UNSUPPORTED', 'postgresql://care_ride_app@db.example.com/d?sslmode=verify-ca'],
  ['SSLMODE_UNRECOGNIZED', 'postgresql://care_ride_app@db.example.com/d?sslmode=banana'],
  ['PLAINTEXT_REMOTE', `postgresql://care_ride_app@db.${M.host}.example.com/d?sslmode=disable`],
  ['CONNECT_TIMEOUT_INVALID', 'postgresql://care_ride_app@db.example.com/d?connect_timeout=abc'],
  ['CONNECT_TIMEOUT_INVALID', 'postgresql://care_ride_app@db.example.com/d?connect_timeout=601'],
  ['CONNECT_TIMEOUT_INVALID', 'postgresql://care_ride_app@db.example.com/d?connect_timeout=5&connect_timeout=9']
];
for (const [reason, url] of REJECTIONS) {
  const r = runCli({ CONTEXT: 'production', DATABASE_URL: url });
  assert.equal(r.code, 1, `${reason}：退出碼應為 1`);
  assert.ok(r.stdout.includes(`result=FAIL reason=${reason}`),
    `${reason}：實際輸出 → ${r.stdout.trim().replace(/\n/g, ' | ')}`);
  assertLineShapes(reason, r.stdout.trim().split('\n'));
  assertNoLeak(reason, r.stdout, r.stderr);
  ok(`拒絕分類 ${reason} 正確且無標記洩漏`);
}

// 確認白名單覆蓋了解析模組登記的每一個 reason
{
  const covered = new Set(REJECTIONS.map(([r]) => r));
  covered.add('MISSING');
  for (const r of GUARD_REASONS) covered.add(r);   // 下方「正式專案防呆」逐一測試
  const missing = REASONS.filter((r) => r !== 'UNKNOWN' && !covered.has(r));
  assert.deepEqual(missing, [], `這些拒絕分類沒有測試覆蓋：${missing.join('、')}`);
  ok('解析模組登記的每一個拒絕分類都有測試覆蓋');
}

// --------------------------------------------------------------------------
console.log('--- 未知例外統一分類，不輸出 message／stack ---');
{
  const boom = () => {
    const error = new Error(`爆炸了 ${M.message}`);
    error.reason = `NOT_IN_WHITELIST_${M.param}`;   // 惡意／未登記的 reason
    throw error;
  };
  const r = check({ env: { CONTEXT: 'production', DATABASE_URL: 'irrelevant' }, resolve: boom });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('DB_CONFIG_CHECK result=FAIL reason=UNKNOWN'),
    '未登記的 reason 必須被歸成 UNKNOWN，不能反射原值');
  assertLineShapes('未知例外', r.lines);
  assertNoLeak('未知例外', r.lines.join('\n'));
  ok('未知例外 → reason=UNKNOWN，不反射原 reason、不輸出 message');
}
{
  // 連 reason 都沒有的例外
  const r = check({
    env: { CONTEXT: 'production', DATABASE_URL: 'irrelevant' },
    resolve: () => { throw new Error(M.message); }
  });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('DB_CONFIG_CHECK result=FAIL reason=UNKNOWN'));
  assertNoLeak('無 reason 的例外', r.lines.join('\n'));
  ok('沒有 reason 的例外也歸成 UNKNOWN');
}
{
  assert.equal(classify(null), 'UNKNOWN');
  assert.equal(classify({ reason: 'MISSING' }), 'MISSING');
  assert.equal(classify({ reason: `${M.param}` }), 'UNKNOWN');
  ok('classify() 只回白名單內的分類');
}

// --------------------------------------------------------------------------
console.log('--- CONTEXT 的處理 ---');
{
  assert.equal(normalizeContext('production'), 'production');
  assert.equal(normalizeContext('deploy-preview'), 'deploy-preview');
  assert.equal(normalizeContext('branch-deploy'), 'branch-deploy');
  assert.equal(normalizeContext('dev'), 'dev');
  assert.equal(normalizeContext(undefined), 'unset');
  assert.equal(normalizeContext(''), 'unset');
  assert.equal(normalizeContext(M.param), 'other');
  assert.equal(normalizeContext('Production'), 'other', '大小寫不同不算 production');
  assert.equal(normalizeContext(' production '), 'production', '前後空白會被去掉');
  ok('normalizeContext 只回白名單，未知值歸成 other，不反射原值');
}
for (const [ctx, expectContext, expectValidated] of [
  ['production', 'production', 'yes'],
  ['deploy-preview', 'deploy-preview', 'no'],
  ['branch-deploy', 'branch-deploy', 'no'],
  ['dev', 'dev', 'no'],
  [undefined, 'unset', 'no'],
  ['Production', 'other', 'no']
]) {
  const env = { DATABASE_URL: VALID_REMOTE, PRODUCTION_SUPABASE_PROJECT_REF: PROD_REF };
  if (ctx !== undefined) env.CONTEXT = ctx;
  const r = runCli(ctx === undefined ? { ...env, CONTEXT: '' } : env);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(`context=${expectContext}`),
    `CONTEXT=${String(ctx)} 應輸出 context=${expectContext}`);
  assert.ok(r.stdout.includes(`production_validated=${expectValidated}`),
    `CONTEXT=${String(ctx)} 應輸出 production_validated=${expectValidated}`);
  assertNoLeak(`context ${String(ctx)}`, r.stdout, r.stderr);
  ok(`CONTEXT=${String(ctx)} → context=${expectContext} / production_validated=${expectValidated}`);
}
{
  // 非 production context 解析失敗一樣要擋建置
  const r = runCli({ CONTEXT: 'deploy-preview', DATABASE_URL: `postgresql://care_ride_app@db.example.com/d?${M.param}=1` });
  assert.equal(r.code, 1, '非 production context 失敗也必須 exit 1');
  assert.ok(r.stdout.includes('result=FAIL reason=PARAM_UNSUPPORTED'));
  assert.ok(r.stdout.includes('production_validated=no'));
  ok('非 production context 解析失敗同樣 exit 1（一樣擋建置）');
}


// --------------------------------------------------------------------------
console.log('--- 正式專案防呆（PRODUCTION_SUPABASE_PROJECT_REF）---');
{
  assert.equal(isValidProjectRef(PROD_REF), true);
  for (const bad of ['', 'short', 'Has-Upper', 'a.b.c.d.e.f.g.h', 'abc/defghij', ' spaced ref ']) {
    assert.equal(isValidProjectRef(bad), false, `「${bad}」不應是合法 ref`);
  }
  ok('isValidProjectRef 只接受小寫英數字');

  const r = (url) => resolveDbConfig(url);
  assert.equal(referencesProject(r(PROD_POOLER), PROD_REF), true, 'pooler：ref 在使用者名後綴');
  assert.equal(referencesProject(r(PROD_DIRECT), PROD_REF), true, '直連：ref 在主機名標籤');
  assert.equal(referencesProject(r(STAGING_POOLER), PROD_REF), false, '同區 pooler、不同專案不算');
  assert.equal(referencesProject(r(STAGING_DIRECT), PROD_REF), false);
  assert.equal(referencesProject(r(VALID_LOCAL), PROD_REF), false, '本機端點不可能是正式專案');
  assert.equal(referencesProject(
    r(`postgresql://care_ride_app.x${PROD_REF}@${POOLER_HOST}/d`), PROD_REF), false, '後綴要完全相等，不是包含');
  assert.equal(referencesProject(
    r(`postgresql://care_ride_app@db.${PROD_REF}x.supabase.co/d`), PROD_REF), false, '主機名標籤要完全相等');
  assert.equal(referencesProject(r(PROD_POOLER), 'Bad.Ref'), false, '不合法的 ref 一律 false');
  ok('referencesProject：pooler 看使用者名後綴、直連看主機名標籤、同區共用主機名不誤判');
}

const NON_PROD_CONTEXTS = ['deploy-preview', 'branch-deploy', 'dev', 'Production', undefined];
const ctxEnv = (ctx) => (ctx === undefined ? { CONTEXT: '' } : { CONTEXT: ctx });
const ctxLabel = (ctx) => (ctx === undefined ? 'unset' : ctx);

for (const ctx of NON_PROD_CONTEXTS) {
  for (const [label, url] of [['pooler', PROD_POOLER], ['直連', PROD_DIRECT]]) {
    const res = runCli({ ...ctxEnv(ctx), DATABASE_URL: url, PRODUCTION_SUPABASE_PROJECT_REF: PROD_REF });
    assert.equal(res.code, 1, `${ctxLabel(ctx)} 以${label}指向正式專案必須 exit 1`);
    assert.ok(res.stdout.includes('result=FAIL reason=NONPROD_TARGETS_PRODUCTION'),
      `${ctxLabel(ctx)}/${label}：實際輸出 → ${res.stdout.trim().replace(/\n/g, ' | ')}`);
    assert.ok(res.stdout.includes('production_validated=no'));
    assert.ok(res.stderr.includes('NONPROD_TARGETS_PRODUCTION'), 'stderr 應說明原因分類');
    assertLineShapes(`${ctxLabel(ctx)}/${label}`, res.stdout.trim().split('\n'));
    assertNoLeak(`${ctxLabel(ctx)}/${label}`, res.stdout, res.stderr);
  }
  ok(`context=${ctxLabel(ctx)} 指向正式專案（pooler 與直連）→ NONPROD_TARGETS_PRODUCTION / exit 1`);
}

for (const ctx of NON_PROD_CONTEXTS) {
  const res = runCli({ ...ctxEnv(ctx), DATABASE_URL: STAGING_POOLER, PRODUCTION_SUPABASE_PROJECT_REF: PROD_REF });
  assert.equal(res.code, 0, `${ctxLabel(ctx)} 指向其他專案應通過`);
  assert.ok(res.stdout.includes('production_target=no'));
  assertLineShapes(`staging ${ctxLabel(ctx)}`, res.stdout.trim().split('\n'));
  assertNoLeak(`staging ${ctxLabel(ctx)}`, res.stdout, res.stderr);
}
ok('非 production context 指向同區 pooler 的其他專案 → PASS / production_target=no');

for (const [label, url, target] of [['pooler', PROD_POOLER, 'yes'], ['直連', PROD_DIRECT, 'yes'],
  ['其他專案', STAGING_POOLER, 'no']]) {
  const res = runCli({ CONTEXT: 'production', DATABASE_URL: url, PRODUCTION_SUPABASE_PROJECT_REF: PROD_REF });
  assert.equal(res.code, 0, `production 以${label}應照常通過`);
  assert.ok(res.stdout.includes(`production_target=${target}`));
  assert.ok(res.stdout.includes('production_validated=yes'));
  assertNoLeak(`production ${label}`, res.stdout, res.stderr);
}
ok('production context 照常通過，production_target 只是資訊');

// 未設定 ref
for (const ctx of NON_PROD_CONTEXTS) {
  for (const unset of [undefined, '', '   ']) {
    const env = { ...ctxEnv(ctx), DATABASE_URL: STAGING_POOLER, PRODUCTION_SUPABASE_PROJECT_REF: unset };
    if (unset === undefined) delete env.PRODUCTION_SUPABASE_PROJECT_REF;
    const res = runCli(env);
    assert.equal(res.code, 1, `${ctxLabel(ctx)} 未設定 ref 時必須擋下（無從判斷）`);
    assert.ok(res.stdout.includes('result=FAIL reason=PROD_REF_UNSET'));
    assertNoLeak(`unset ${ctxLabel(ctx)}`, res.stdout, res.stderr);
  }
}
ok('非 production context 未設定 ref（未設、空字串、空白）→ PROD_REF_UNSET / exit 1');
{
  // runCli 會繼承父行程的環境；明確清掉，確保測到的是「未設定」
  const env = { CONTEXT: 'deploy-preview', DATABASE_URL: VALID_LOCAL, PRODUCTION_SUPABASE_PROJECT_REF: '' };
  const res = runCli(env);
  assert.equal(res.code, 0, '本機端點不可能是正式專案，未設定 ref 也放行');
  assert.ok(res.stdout.includes('production_target=no'));
  ok('非 production context 連本機端點、未設定 ref → PASS');
}
{
  const res = runCli({ CONTEXT: 'production', DATABASE_URL: PROD_POOLER, PRODUCTION_SUPABASE_PROJECT_REF: '' });
  assert.equal(res.code, 0, 'production 未設定 ref 不擋，現有正式建置不受影響');
  assert.ok(res.stdout.includes('production_target=unconfigured'));
  ok('production context 未設定 ref → PASS / production_target=unconfigured');
}

// 格式錯誤的 ref：任何 context 都擋
for (const ctx of ['production', 'deploy-preview']) {
  const res = runCli({ CONTEXT: ctx, DATABASE_URL: STAGING_POOLER,
    PRODUCTION_SUPABASE_PROJECT_REF: `db.${M.host}.supabase.co` });
  assert.equal(res.code, 1, `${ctx}：格式錯誤的 ref 必須擋下`);
  assert.ok(res.stdout.includes('result=FAIL reason=PROD_REF_INVALID'));
  assertNoLeak(`invalid ref ${ctx}`, res.stdout, res.stderr);
}
ok('ref 格式錯誤（例如誤填主機名）→ 任何 context 都 PROD_REF_INVALID / exit 1，且不反射輸入');

// 解析失敗優先於防呆：沿用原本的分類
{
  const res = runCli({ CONTEXT: 'deploy-preview', DATABASE_URL: '', PRODUCTION_SUPABASE_PROJECT_REF: PROD_REF });
  assert.ok(res.stdout.includes('result=FAIL reason=MISSING'));
  ok('連線字串本身無效時仍回報原本的解析分類');
}

// --------------------------------------------------------------------------
console.log('--- 解析模組本身的回傳欄位 ---');
{
  const cfg = resolveDbConfig(VALID_REMOTE);
  assert.equal(cfg.local, false);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
  assert.equal(cfg.sslmode, 'require');
  assert.deepEqual(cfg.params, ['sslmode']);
  ok('resolveDbConfig 回傳 sslmode 與 params 供檢查使用（不影響連線行為）');
}

// --------------------------------------------------------------------------
console.log('');
console.log(`結果：${pass} 通過 / 0 失敗`);

// 測試主體到此結束。如果行程還不肯走，5 秒後把還活著的資源印出來再強制結束，
// 不要重演「15 分鐘沒有任何輸出然後被 job timeout 砍掉」。
armExitWatchdog(5000, 'db-config-check');
