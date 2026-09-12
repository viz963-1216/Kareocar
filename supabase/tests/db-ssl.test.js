'use strict';
/**
 * _db.js 的 TLS 判斷測試。
 *
 * 需要真實的 pg 套件（要檢查驅動怎麼處理連線字串裡的 SSL 參數），所以放在
 * supabase/tests 而不是 tests/ ——後者必須在沒有 node_modules 的環境也能跑。
 *
 * 這支測試全部用寫死的合成連線字串，**不讀取也不修改正式 DATABASE_URL**：
 * resolveDbConfig 傳入參數時完全不碰 process.env。最後一項連線檢查用的是
 * run-isolated-review.sh 建立的本機測試庫。
 */
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { resolveDbConfig } = require('../../netlify/functions/_db');

const LOCAL_TCP = 'postgresql://care_ride_app@127.0.0.1:5432/careride_reset_test?sslmode=disable';
const LOCAL_SOCKET = 'postgresql://care_ride_app@%2Ftmp%2Fcare-ride-ci:5432/careride_reset_test?sslmode=disable';
const LOCAL_NAMED = 'postgresql://care_ride_app@localhost:5432/careride_reset_test?sslmode=disable';
const LOCAL_IPV6 = 'postgresql://care_ride_app@[::1]:5432/careride_reset_test?sslmode=disable';
const REMOTE = 'postgresql://care_ride_app:synthetic@db.synthetic-project.supabase.co:5432/postgres';
const REMOTE_DISABLE = `${REMOTE}?sslmode=disable`;
const REMOTE_PREFER = `${REMOTE}?sslmode=prefer`;

let pass = 0;
const ok = (name) => { console.log('PASS', name); pass += 1; };

/** pg 實際解析出來的 ssl 設定（建構 Client 不會連線）。 */
const resolvedSsl = (connectionString, ssl) =>
  new Client({ connectionString, ssl }).connectionParameters.ssl;

(async () => {
  // ---------------------------------------------------------------- 本機明文
  for (const [name, url] of [
    ['127.0.0.1', LOCAL_TCP], ['localhost', LOCAL_NAMED],
    ['Unix socket', LOCAL_SOCKET], ['IPv6 ::1', LOCAL_IPV6]
  ]) {
    const cfg = resolveDbConfig(url);
    assert.equal(cfg.local, true, `${name} 應判定為本機端點`);
    assert.equal(cfg.ssl, false, `${name} + sslmode=disable 應走明文`);
    assert.ok(!/sslmode/i.test(cfg.connectionString), `${name} 的連線字串應已移除 sslmode`);
    assert.equal(resolvedSsl(cfg.connectionString, cfg.ssl), false,
      `${name}：pg 解析後仍應是明文`);
    ok(`本機端點（${name}）允許明文，且 pg 解析結果一致`);
  }

  // ---------------------------------------------------------------- 遠端保留 TLS
  {
    const cfg = resolveDbConfig(REMOTE);
    assert.equal(cfg.local, false);
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
    assert.notEqual(resolvedSsl(cfg.connectionString, cfg.ssl), false,
      '一般遠端連線的 pg 解析結果不可以是明文');
    ok('一般遠端連線保留 TLS');
  }

  // ---------------------------------------------------------------- 遠端 disable 被拒
  assert.throws(() => resolveDbConfig(REMOTE_DISABLE), (e) => {
    assert.equal(e.code, 'CONFIG_INVALID');
    assert.match(e.message, /不是本機隔離端點/);
    return true;
  }, '遠端 sslmode=disable 必須被拒絕');
  ok('遠端 sslmode=disable 被拒絕（CONFIG_INVALID）');

  // -------------------------------------------- 連線字串參數不得覆寫 Pool 設定
  {
    // 先記錄 pg 驅動的實際行為：如果連線字串裡的 sslmode 會蓋掉明確傳入的
    // ssl，那 _db.js 不移除 sslmode 的話，「遠端一律 TLS」就無法由程式保證。
    const leaked = resolvedSsl(REMOTE_DISABLE, { rejectUnauthorized: false });
    console.log('      [記錄] pg 對「連線字串 sslmode=disable + ssl 物件」的解析結果：',
      JSON.stringify(leaked));

    // 不論驅動行為如何，_db.js 走過一遍之後都必須是 TLS。
    const cfg = resolveDbConfig(REMOTE_PREFER);
    assert.ok(!/sslmode/i.test(cfg.connectionString));
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
    assert.notEqual(resolvedSsl(cfg.connectionString, cfg.ssl), false,
      '遠端 sslmode=prefer 經 _db.js 處理後不可降級成明文');
    ok('遠端 sslmode=prefer 不會降級成明文（sslmode 已從連線字串移除）');
  }

  // ---------------------------------------------------------------- 既有防線
  assert.throws(() => resolveDbConfig('postgresql://postgres:x@db.synthetic.supabase.co:5432/postgres'),
    (e) => e.code === 'CONFIG_INVALID');
  ok('postgres 角色仍然被拒絕');

  assert.throws(() => resolveDbConfig(''), (e) => e.code === 'CONFIG_MISSING');
  assert.throws(() => resolveDbConfig('not a url'), (e) => e.code === 'CONFIG_INVALID');
  ok('空值與非法連線字串分別回 CONFIG_MISSING / CONFIG_INVALID');

  // ---------------------------------------------------------------- 真的連得上
  {
    const host = process.env.PGHOST;
    const url = host && host.startsWith('/')
      ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_reset_test?sslmode=disable`
      : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_reset_test?sslmode=disable`;
    const cfg = resolveDbConfig(url);
    const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
    await client.connect();
    try {
      const { rows } = await client.query('select current_user as who');
      assert.equal(rows[0].who, 'care_ride_app');
      ok('本機隔離端點以 care_ride_app 明文連線成功');
    } finally {
      await client.end();
    }
  }

  console.log(`${pass} TLS 設定情境通過`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
