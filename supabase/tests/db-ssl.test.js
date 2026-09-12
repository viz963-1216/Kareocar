'use strict';
/**
 * _db.js 的連線設定解析測試（主機、使用者、TLS）。
 *
 * 重點：斷言的是 **pg Client 最終的 connectionParameters**，不是 resolveDbConfig
 * 的回傳值。Codex 找到的缺口就是「檢查的主機」與「驅動實際使用的主機」可以
 * 不同——只驗回傳值看不出來。
 *
 * 需要真實的 pg 套件，所以放在 supabase/tests 而不是 tests/（後者必須在沒有
 * node_modules 的環境也能跑）。
 *
 * 全部使用寫死的合成連線字串，**不讀取也不修改正式 DATABASE_URL**、不連任何
 * 正式服務：resolveDbConfig 傳入參數時完全不碰 process.env。只有最後一項連線
 * 檢查會連上 run-isolated-review.sh 建立的本機測試庫。
 *
 * 建構 Client 不會發出任何連線。
 */
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { resolveDbConfig, pgClientConfig, poolOptions } = require('../../netlify/functions/_db');

const REMOTE_HOST = 'aws-0-ap-southeast-1.pooler.supabase.com';
const REMOTE = `postgresql://care_ride_app.synthref:synthetic@${REMOTE_HOST}:6543/postgres`;

let pass = 0;
const ok = (name) => { console.log('PASS', name); pass += 1; };

/** 走完 _db.js 的解析，回傳 pg 最終生效的連線參數。 */
function finalParams(url) {
  const cfg = resolveDbConfig(url);
  return new Client(pgClientConfig(cfg)).connectionParameters;
}

function expectRejected(url, pattern, label) {
  assert.throws(() => resolveDbConfig(url), (e) => {
    assert.equal(e.code, 'CONFIG_INVALID', `${label}：錯誤碼應為 CONFIG_INVALID`);
    assert.match(e.message, pattern, `${label}：錯誤訊息不符`);
    return true;
  }, `${label}：應該被拒絕`);
  ok(label);
}

(async () => {
  // ================================================ 1. 查詢參數覆寫主機（Codex 的重現）
  {
    const url = 'postgresql://care_ride_app@localhost/db?host=remote.example&sslmode=disable';

    // 先記錄：如果把原始字串交回驅動，pg 實際會連哪裡。
    const leaked = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
      .connectionParameters;
    console.log('      [記錄] 把原始 connectionString 交回 pg 時的實際參數：',
      JSON.stringify({ host: leaked.host, ssl: leaked.ssl }));
    assert.equal(leaked.host, 'remote.example',
      '前提確認：pg 的確會讓查詢參數 host 覆寫 URL 的 hostname');

    expectRejected(url, /覆寫連線身分或 TLS 設定的查詢參數/,
      '查詢參數 host 覆寫被拒絕（localhost 偽裝成本機、實際連遠端）');
  }

  // 其他覆寫參數逐一拒絕
  for (const p of ['hostaddr=10.0.0.1', 'port=1234', 'user=postgres', 'dbname=other',
    'password=x', 'ssl=true', 'sslrootcert=/tmp/ca.pem', 'options=-csearch_path%3Dx',
    'requiressl=0', 'service=prod']) {
    expectRejected(`${REMOTE}?${p}`, /覆寫連線身分或 TLS 設定的查詢參數/,
      `覆寫參數被拒絕：${p.split('=')[0]}`);
  }
  expectRejected(`${REMOTE}?pgbouncer=true`, /不支援的查詢參數/,
    '白名單之外的參數被拒絕（pgbouncer）');

  // ================================================ 2. SSL 參數的編碼與重複
  // %64 = 'd'：URLSearchParams 會解碼成 disable，遠端因此必須被拒。
  expectRejected(`${REMOTE}?sslmode=%64isable`, /不是本機隔離端點/,
    '百分比編碼的 sslmode=disable 在遠端一樣被拒（解碼行為一致）');

  {
    // 本機 + 百分比編碼的 disable：解碼後等同 disable，應允許明文。
    const cp = finalParams('postgresql://care_ride_app@127.0.0.1:5432/d?sslmode=%64isable');
    assert.equal(cp.ssl, false);
    assert.equal(cp.host, '127.0.0.1');
    ok('百分比編碼的 sslmode=disable 在本機端點允許明文');
  }

  expectRejected(`${REMOTE}?sslmode=require&sslmode=disable`, /多個不一致的 sslmode/,
    '重複且不一致的 sslmode 被拒絕');

  {
    // 重複但一致：視為同一個值，不算歧義。
    const cp = finalParams('postgresql://care_ride_app@localhost:5432/d?sslmode=disable&sslmode=disable');
    assert.equal(cp.ssl, false);
    ok('重複但一致的 sslmode 可接受');
  }

  expectRejected(`${REMOTE}?sslmode=banana`, /無法辨識/, '無法辨識的 sslmode 被拒絕');

  // ------------------------------------------------ 2b. 參數名稱大小寫（Codex 的重現）
  // 先確認前提：pg 自己對參數名稱是大小寫敏感的，?SSLMODE=... 不會被它當成 sslmode。
  {
    const leaked = new Client({
      connectionString: `${REMOTE}?SSLMODE=verify-full`,
      ssl: { rejectUnauthorized: false }
    }).connectionParameters;
    console.log('      [記錄] pg 對 ?SSLMODE=verify-full 的解析結果：',
      JSON.stringify({ ssl: leaked.ssl }));
    assert.notEqual(leaked.ssl, false,
      '前提確認：pg 不會把大寫的 SSLMODE 當成 sslmode');
  }

  expectRejected(`${REMOTE}?SSLMODE=verify-full`, /查詢參數名稱必須全小寫/,
    '大寫 SSLMODE 被拒絕（先前會通過白名單後被靜默忽略成 TLS 不驗證）');
  expectRejected(`${REMOTE}?SslMode=require`, /查詢參數名稱必須全小寫/,
    '混合大小寫 SslMode 被拒絕');
  expectRejected('postgresql://care_ride_app@localhost/d?sslmode=require&SSLMODE=disable',
    /查詢參數名稱必須全小寫/,
    '大小寫混合的重複 sslmode 被拒絕（先前不會判為衝突）');
  expectRejected(`${REMOTE}?APPLICATION_NAME=x`, /查詢參數名稱必須全小寫/,
    '大寫 APPLICATION_NAME 被拒絕');

  {
    // 同一個名稱、值大小寫不同：視為同一個模式，不算歧義。
    const cp = finalParams(`${REMOTE}?sslmode=require&sslmode=REQUIRE`);
    assert.notEqual(cp.ssl, false);
    ok('sslmode 值的大小寫差異視為同一個模式');
  }

  // ------------------------------------------------ 2c. connect_timeout
  for (const bad of ['abc', '-5', '1.5', '1e3', '', ' ', '0x10', 'Infinity', 'NaN']) {
    expectRejected(`${REMOTE}?connect_timeout=${encodeURIComponent(bad)}`,
      /connect_timeout=.*(無效|超出範圍)/,
      `connect_timeout=${JSON.stringify(bad)} 被拒絕`);
  }
  expectRejected(`${REMOTE}?connect_timeout=601`, /超出範圍/,
    'connect_timeout 超過上限（601 秒）被拒絕');
  expectRejected(`${REMOTE}?connect_timeout=5&connect_timeout=9`, /多個不一致的 connect_timeout/,
    '重複且不一致的 connect_timeout 被拒絕');

  // 最後真正交給 Pool 的值
  {
    const opts = poolOptions(resolveDbConfig(`${REMOTE}?connect_timeout=30`));
    assert.equal(opts.connectionTimeoutMillis, 30_000);
    assert.equal(new Pool(opts).options.connectionTimeoutMillis, 30_000);
    ok('connect_timeout=30 → Pool 的 connectionTimeoutMillis 為 30000');
  }
  {
    // 0 = 不設上限（libpq 語意），不可以被預設值蓋掉
    const opts = poolOptions(resolveDbConfig(`${REMOTE}?connect_timeout=0`));
    assert.equal(opts.connectionTimeoutMillis, 0);
    assert.equal(new Pool(opts).options.connectionTimeoutMillis, 0);
    ok('connect_timeout=0 → Pool 的 connectionTimeoutMillis 為 0（不設上限，未被預設值蓋掉）');
  }
  {
    // 沒帶參數時套用預設值
    const opts = poolOptions(resolveDbConfig(REMOTE));
    assert.equal(opts.connectionTimeoutMillis, 8_000);
    assert.equal(new Pool(opts).options.connectionTimeoutMillis, 8_000);
    ok('未指定 connect_timeout → Pool 沿用預設 8000ms');
  }
  {
    // Pool 拿到的主機／使用者／TLS 也必須是驗證過的值
    const opts = poolOptions(resolveDbConfig(`${REMOTE}?application_name=care-ride-ci`));
    const p = new Pool(opts);
    assert.equal(p.options.host, REMOTE_HOST);
    assert.equal(p.options.user, 'care_ride_app.synthref');
    assert.notEqual(p.options.ssl, false);
    assert.equal(p.options.application_name, 'care-ride-ci');
    assert.equal(p.options.connectionString, undefined,
      'Pool 不該拿到 connectionString，否則字串又能覆寫驗證過的值');
    ok('Pool 收到的主機／使用者／TLS／application_name 皆為驗證過的值，且不含 connectionString');
  }

  // ================================================ 3. verify-ca / verify-full
  for (const mode of ['verify-ca', 'verify-full']) {
    expectRejected(`${REMOTE}?sslmode=${mode}`, /還沒有實作憑證驗證語意/,
      `sslmode=${mode} 明確拒絕，不靜默降成 rejectUnauthorized: false`);
  }

  // ================================================ 4. 本機端點允許明文
  for (const [name, url] of [
    ['127.0.0.1', 'postgresql://care_ride_app@127.0.0.1:5432/careride_reset_test?sslmode=disable'],
    ['localhost', 'postgresql://care_ride_app@localhost:5432/careride_reset_test?sslmode=disable'],
    ['Unix socket', 'postgresql://care_ride_app@%2Ftmp%2Fcare-ride-ci:5432/careride_reset_test?sslmode=disable'],
    ['IPv6 ::1', 'postgresql://care_ride_app@[::1]:5432/careride_reset_test?sslmode=disable']
  ]) {
    const cp = finalParams(url);
    assert.equal(cp.ssl, false, `${name}：pg 最終設定應為明文`);
    assert.equal(cp.user, 'care_ride_app', `${name}：使用者應為 care_ride_app`);
    assert.equal(cp.database, 'careride_reset_test', `${name}：資料庫名稱不符`);
    assert.equal(cp.host, name === 'Unix socket' ? '/tmp/care-ride-ci'
      : name === 'IPv6 ::1' ? '::1' : name, `${name}：pg 最終使用的主機不符`);
    ok(`本機端點（${name}）：pg 最終參數為明文且主機／使用者／資料庫皆為驗證過的值`);
  }

  // ================================================ 5. 一般遠端保留 TLS
  for (const [label, url] of [
    ['無 sslmode', REMOTE],
    ['sslmode=require', `${REMOTE}?sslmode=require`],
    ['sslmode=prefer', `${REMOTE}?sslmode=prefer`],
    ['sslmode=allow', `${REMOTE}?sslmode=allow`]
  ]) {
    const cp = finalParams(url);
    assert.notEqual(cp.ssl, false, `${label}：遠端不可以是明文`);
    assert.ok(cp.ssl, `${label}：ssl 應為真值`);
    assert.equal(cp.host, REMOTE_HOST, `${label}：主機應為驗證過的遠端主機`);
    assert.equal(cp.user, 'care_ride_app.synthref', `${label}：pooler 使用者應原樣保留`);
    assert.equal(cp.port, 6543, `${label}：port 不符`);
    ok(`一般遠端（${label}）保留 TLS，主機與使用者為驗證過的值`);
  }

  expectRejected(`${REMOTE}?sslmode=disable`, /不是本機隔離端點/,
    '遠端 sslmode=disable 被拒絕');

  // ================================================ 6. postgres 角色
  expectRejected('postgresql://postgres:x@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
    /不可使用 postgres 角色/, 'postgres 角色被拒絕');
  expectRejected('postgresql://postgres.synthref:x@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
    /不可使用 postgres 角色/, 'pooler 形式的 postgres.<ref> 角色也被拒絕');

  // ================================================ 7. 其他輸入
  assert.throws(() => resolveDbConfig(''), (e) => e.code === 'CONFIG_MISSING');
  ok('空值回 CONFIG_MISSING');
  expectRejected('not a url', /不是合法的連線字串/, '非法連線字串被拒絕');
  expectRejected('mysql://care_ride_app@localhost/d', /scheme 必須是/, '非 postgres scheme 被拒絕');
  expectRejected('postgresql://@localhost/d', /必須指定連線使用者/, '沒有使用者被拒絕');

  // ================================================ 8. 真的連得上
  {
    const h = process.env.PGHOST;
    const url = `postgresql://care_ride_app@${h && h.startsWith('/') ? encodeURIComponent(h) : h}`
      + `:${process.env.PGPORT}/careride_reset_test?sslmode=disable`;
    const cfg = resolveDbConfig(url);
    const client = new Client(pgClientConfig(cfg));
    assert.equal(client.connectionParameters.ssl, false);
    await client.connect();
    try {
      const { rows } = await client.query('select current_user as who, current_database() as db');
      assert.equal(rows[0].who, 'care_ride_app');
      assert.equal(rows[0].db, 'careride_reset_test');
      ok('本機隔離端點以 care_ride_app 明文連線成功，主機／使用者／資料庫與驗證值一致');
    } finally {
      await client.end();
    }
  }

  console.log(`${pass} 連線設定情境通過`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
