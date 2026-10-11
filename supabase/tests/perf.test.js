'use strict';
/**
 * 效能測試（#125，ADR 0005）：預約與行程搬到正式資料表之前先量基準，搬完（#133）再比較。
 *
 * 資料由 perf/seed.sql 產生（30 家機構、2000 位需求者、12000 筆預約、6000 趟行程）。
 * 量測：
 *   - 載入資料（v2-state-load）：需求者、調度、司機三種身分
 *   - 需求池、權限過濾後的單筆預約讀取、服務對象還沒完成的預約（care_ride_app ＋ RLS）
 *   - 到期匿名化（交易內執行後回滾，不改資料）
 * 每項跑數次取中位數，SQL 項目另外記錄查詢計畫用到的節點與索引。
 * 這一階段只記錄、不因數字失敗；結果寫到 PERF_OUT（預設 perf/results.json）。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const fs = require('fs');
const path = require('path');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_perf_test') {
  throw Error('Requires dedicated local endpoint and careride_perf_test database');
}
process.env.DATABASE_URL = `postgresql://care_ride_app@${isSocket ? encodeURIComponent(host) : host}:${process.env.PGPORT}/careride_perf_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-perf-0123456789';
const { driver } = require('./_pg-driver');
const fx = require('./_auth-fixture');
const { Pool } = require('pg');
const db = require('../../netlify/functions/_db');
const loadFn = require('../../netlify/functions/v2-state-load');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_perf_test', user: 'postgres' });
const RUNS = Number(process.env.PERF_RUNS || 5);
const OUT = process.env.PERF_OUT || path.join(__dirname, 'perf', 'results.json');

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const round = (n) => Math.round(n * 10) / 10;

async function timed(fn) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { medianMs: round(median(times)), minMs: round(Math.min(...times)), runs: RUNS };
}

/** 查詢計畫摘要：用到的節點類型、資料表與索引（不同機器之間比較穩定的部分）。 */
function planSummary(plan) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    out.push([n['Node Type'], n['Relation Name'], n['Index Name']].filter(Boolean).join(' '));
    (n.Plans || []).forEach(walk);
  };
  walk(plan && plan[0] && plan[0].Plan);
  return out;
}

async function explainAs(userId, sql, params = []) {
  return db.withUser(userId, async (client) => {
    const r = await client.query(`explain (analyze, format json) ${sql}`, params);
    // 真正的 pg 回傳已解析的 JSON；psql 替身拿不到完整的計畫（只在 CI 記錄）
    const raw = r.rows[0] && Object.values(r.rows[0])[0];
    if (!raw) return ['（這個驅動取不到查詢計畫）'];
    try { return planSummary(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (_) { return ['（這個驅動取不到查詢計畫）']; }
  });
}

const results = [];
async function measure(name, fn, plan) {
  const t = await timed(fn);
  const row = { name, ...t, ...(plan ? { plan: await plan() } : {}) };
  results.push(row);
  console.log(`  ${name.padEnd(28)} 中位數 ${String(t.medianMs).padStart(8)} ms（最快 ${t.minMs} ms，${t.runs} 次）`);
  if (row.plan) console.log(`    計畫：${row.plan.join(' → ')}`);
}

async function load(userId) {
  const res = await loadFn.handler({ httpMethod: 'GET',
    headers: { host: '127.0.0.1', cookie: `cr_at=${fx.mintAccessToken(userId)}` } });
  if (res.statusCode !== 200) throw Error(`state-load ${userId} 回 ${res.statusCode}：${res.body.slice(0, 200)}`);
}

(async () => {
  const counts = (await admin.query(
    `select 'bookings' as collection, count(*)::int n from bookings
      union all select 'careRecipients', count(*)::int from app_state where collection = 'careRecipients'
      union all select 'trips', count(*)::int from trips order by 1`)).rows;
  console.log(`驅動：${driver}；資料：${counts.map((c) => `${c.collection} ${c.n}`).join('、')}`);

  console.log('--- 載入資料（v2-state-load）---');
  await measure('載入資料：需求者', () => load('USR-PR-1'));
  await measure('載入資料：調度', () => load('USR-PD-1'));
  await measure('載入資料：司機', () => load('USR-PV-1'));

  console.log('--- 查詢（care_ride_app ＋ RLS）---');
  const POOL_SQL = 'select * from app_state_booking_pool order by pickup_at nulls last limit 500';
  await measure('需求池', () => db.withUser('USR-PD-1', (c) => c.query(POOL_SQL)), () => explainAs('USR-PD-1', POOL_SQL));
  const ONE_SQL = `select data from bookings where id = $1`;
  await measure('單筆預約讀取（承接機構）', () => db.withUser('USR-PD-5', (c) => c.query(ONE_SQL, ['BKG-P-5'])),
    () => explainAs('USR-PD-5', ONE_SQL, ['BKG-P-5']));
  const REFRESH_SQL = 'select * from app.recipient_refreshable_bookings($1)';
  await measure('服務對象還沒完成的預約', () => db.withUser('USR-PR-1', (c) => c.query(REFRESH_SQL, ['CR-P-1'])),
    () => explainAs('USR-PR-1', REFRESH_SQL, ['CR-P-1']));

  console.log('--- 排程（交易內執行後回滾）---');
  await measure('到期匿名化（全部到期）', async () => {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select * from app.anonymize_expired_records(current_date + 365 * 10)`);
    } finally { await c.query('rollback'); c.release(); }
  });

  const report = { generatedAt: new Date().toISOString(), driver, runs: RUNS, counts, measurements: results };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n結果已寫到 ${path.relative(process.cwd(), OUT)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
