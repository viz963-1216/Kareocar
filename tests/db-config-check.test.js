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

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'check-db-config.js');
const CONFIG_MODULE = path.join(ROOT, 'netlify', 'functions', '_db-config.js');

const { check, classify, normalizeContext, REASONS } = require(CLI);
const { resolveDbConfig } = require(CONFIG_MODULE);

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
const ALL_MARKERS = Object.values(M);

const VALID_REMOTE = `postgresql://care_ride_app.${M.user}:${M.pass}@db.${M.host}.example.com:6543/${M.db}?sslmode=require`;
const VALID_LOCAL = 'postgresql://care_ride_app@127.0.0.1:5432/careride_local?sslmode=disable';

let pass = 0;
const ok = (name) => { console.log('  PASS', name); pass += 1; };

/** 跑 CLI，回傳 { code, stdout, stderr }。不會丟出例外。 */
function runCli(env) {
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
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
  ], { encoding: 'utf8' });
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
  const env = { DATABASE_URL: VALID_REMOTE };
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
