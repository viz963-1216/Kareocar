'use strict';
/**
 * 福利規則排程抓取、草稿、差異與審核（#24）的整合測試。
 *
 * 抓取經 _benefit-fetch 的窄介面，這裡注入假實作（不連政府網站）；告警經 _alerts 的窄介面，
 * 注入記錄呼叫的假實作。排程 handler、benefit-ruleset、benefit-assess 都是實際程式碼。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_bfetch_test') {
  throw Error('Requires dedicated local endpoint and careride_bfetch_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_bfetch_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_bfetch_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-bfetch-0123456789';
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_bfetch_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const fetcher = require('../../netlify/functions/_benefit-fetch');
const alerts = require('../../netlify/functions/_alerts');
const scheduled = require('../../netlify/functions/benefit-rules-fetch');
const rulesetFn = require('../../netlify/functions/v2-benefit-ruleset');
const assessFn = require('../../netlify/functions/v2-benefit-assess');
const mutateFn = require('../../netlify/functions/v2-state-mutate');

const U = { root: 'USR-BF-ROOT', req: 'USR-BF-REQ' };

// ---- 假的政府網站
const page = (amounts, cms = 2) => `<html><body><h2>長照服務給付額度表</h2><table><tr><th>交通接送（月）</th></tr>
<tr><td>第一區：${amounts[0]}元 第二區：${amounts[1]}元 第三區：${amounts[2]}元 第四區：${amounts[3]}元</td></tr></table>
<p>經評估符合長照需要等級${cms}級以上者</p><p>更新日期 ${Date.now()}</p></body></html>`;
const site = { html: page(['1,680', '1,840', '2,000', '2,400']), pdf: Buffer.from('%PDF-1.7 合成附表 v1'), down: null };
fetcher.setProvider({
  async fetchSource(url) {
    if (site.down && url.includes(site.down)) return { ok: false, status: 503, error: 'HTTP 503' };
    if (url.includes('1966.gov.tw')) return { ok: true, status: 200, body: Buffer.from(site.html), contentType: 'text/html' };
    return { ok: true, status: 200, body: site.pdf, contentType: 'application/pdf' };
  }
});
const sentAlerts = [];
alerts.setTransport(async (a) => { sentAlerts.push(a); });

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
async function call(handler, method, userId, body) {
  const res = await handler({
    httpMethod: method,
    headers: userId ? { host: '127.0.0.1', cookie: `cr_at=${fx.mintAccessToken(userId)}` } : { host: '127.0.0.1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const outcome = (r) => `${r.status} ${r.error ? `${r.error.code} ${r.error.message}` : 'ok'}`;
const runScheduled = async () => JSON.parse((await scheduled.handler({})).body);
const rulesets = async () => (await admin.query('select id, version, status, origin, diff, calculation, source_hash from benefit_rulesets order by created_at')).rows;
const approve = (id) => call(rulesetFn.handler, 'POST', U.root, { action: 'approve', id });
const assess = (facts) => call(assessFn.handler, 'POST', U.req, { recipientId: 'CR-BF-1', serviceDate: '2099-01-01', facts });

(async () => {
  await admin.query(`
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886988000009','super_admin',true),
      ('${U.req}','合成需求者','+886988000001','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values ('M-BF-REQ','${U.req}','ORG-REQ-001','requester','active');
  `);
  await call(mutateFn.handler, 'POST', U.req, { changes: [{ collection: 'careRecipients', id: 'CR-BF-1', record: { id: 'CR-BF-1', addresses: { primary: '臺東縣成功鎮中山路1號' } } }] });

  console.log('--- 第一次抓取：產生自動草稿 ---');
  const r1 = await runScheduled();
  const fetches1 = (await admin.query('select source_id, url, status, content_hash, fetched_at from benefit_source_fetches order by source_id')).rows;
  record('每次抓取都記錄來源網址、時間與內容雜湊', fetches1.length === 2 && fetches1.every((f) => f.status === 'ok' && /^[0-9a-f]{64}$/.test(f.content_hash) && f.url.startsWith('https://') && f.fetched_at));
  const rs1 = await rulesets();
  const draft1 = rs1[0];
  record('產生自動抓取草稿（解析出四區月額度與等級門檻）', r1.status === 'draft_created' && rs1.length === 1 && draft1.status === 'draft'
    && draft1.origin === 'auto_fetch' && draft1.calculation.monthlyAmountByZone['4'] === 2400 && draft1.calculation.cmsMin === 2, JSON.stringify(r1));
  record('草稿附差異與提醒：目前沒有核准版本、自付比例取自內建快照', draft1.diff.comparedWith === null && draft1.diff.changes.length > 0
    && draft1.diff.reviewNotes.some((n) => /內建快照/.test(n)));

  console.log('--- 內容沒變就不產生草稿 ---');
  site.html = page(['1,680', '1,840', '2,000', '2,400']); // 頁面上的更新日期變了，但規則內容沒變
  const r2 = await runScheduled();
  record('內容雜湊未改變時不產生新草稿', r2.status === 'unchanged' && (await rulesets()).length === 1, JSON.stringify(r2));
  record('沒產生草稿的抓取也有紀錄', (await admin.query('select count(*)::int n from benefit_source_fetches')).rows[0].n === 4);

  console.log('--- 核准後估算改用新版本 ---');
  const editAuto = await call(rulesetFn.handler, 'POST', U.root, { action: 'save_draft', id: draft1.id,
    ruleset: { code: 'transportation_primary', version: 'x', name: 'x', effectiveFrom: '2026-01-01' } });
  record('自動抓取的草稿不能手動修改', editAuto.status === 400 && /自動抓取/.test(editAuto.error.message), outcome(editAuto));
  const a1 = await approve(draft1.id);
  record('平台管理員核准自動草稿', a1.status === 200 && a1.data.ruleset.status === 'approved', outcome(a1));
  const est1 = await assess({ cmsLevel: 4, residenceCity: '臺東縣', identityCategory: 'general' });
  record('試算用核准版本計算（第 4 區 2400 × 79% = 1896）', est1.status === 200 && est1.data.assessment.estimatedSubsidy === 1896
    && est1.data.assessment.rulesetId === draft1.id, outcome(est1));

  console.log('--- 公告改版：新草稿附差異，核准後舊版本 superseded ---');
  site.html = page(['1,680', '1,840', '2,000', '2,500']);
  const r3 = await runScheduled();
  const draft2 = (await rulesets()).find((r) => r.status === 'draft');
  record('金額改變產生新草稿，差異只有第 4 區', r3.status === 'draft_created' && draft2
    && draft2.diff.changes.length === 1 && draft2.diff.changes[0].field === '第 4 區月額度'
    && draft2.diff.changes[0].from === 2400 && draft2.diff.changes[0].to === 2500
    && draft2.diff.comparedWith === (await rulesets())[0].version, JSON.stringify(draft2 && draft2.diff));
  record('草稿沿用已核准版本的自付比例', draft2.calculation.copayByZone['4'].general === 21 && /沿用已核准版本/.test(draft2.calculation.copaySource));
  const stillOld = await assess({ cmsLevel: 4, residenceCity: '臺東縣', identityCategory: 'general' });
  record('核准前估算仍用現行版本', stillOld.data.assessment.estimatedSubsidy === 1896);
  await approve(draft2.id);
  const statuses = Object.fromEntries((await rulesets()).map((r) => [r.id, r.status]));
  record('核准新版本後舊版本變 superseded', statuses[draft1.id] === 'superseded' && statuses[draft2.id] === 'approved', JSON.stringify(statuses));
  const est2 = await assess({ cmsLevel: 4, residenceCity: '臺東縣', identityCategory: 'general' });
  record('新的估算改用新版本（2500 × 79% = 1975）', est2.data.assessment.estimatedSubsidy === 1975 && est2.data.assessment.rulesetId === draft2.id);

  console.log('--- 附表 PDF 改版：草稿提醒人工核對自付比例 ---');
  site.pdf = Buffer.from('%PDF-1.7 合成附表 v2');
  const r4 = await runScheduled();
  const draft3 = (await rulesets()).find((r) => r.status === 'draft');
  record('附表改版產生草稿，提醒人工核對，金額差異為空', r4.status === 'draft_created' && draft3 && draft3.diff.changes.length === 0
    && draft3.diff.reviewNotes.some((n) => /附表 PDF 已改版/.test(n)), JSON.stringify(r4));
  await call(rulesetFn.handler, 'POST', U.root, { action: 'reject', id: draft3.id, note: '合成：附表尚未核對' });

  console.log('--- 抓取或解析失敗：告警，現行版本不變 ---');
  const approvedBefore = (await rulesets()).filter((r) => r.status === 'approved').map((r) => r.id);
  site.down = '1966.gov.tw';
  const r5 = await runScheduled();
  site.down = null;
  record('抓取失敗：送出告警', r5.status === 'fetch_failed' && sentAlerts.some((a) => a.kind === 'benefit_fetch_failed'), JSON.stringify(r5));
  const failedRow = (await admin.query(`select status, error from benefit_source_fetches where source_id = '1966' order by fetched_at desc limit 1`)).rows[0];
  record('失敗的抓取也記錄（含錯誤）', failedRow.status === 'failed' && /503/.test(failedRow.error));
  site.html = '<html><body><p>交通接送 請洽各縣市</p></body></html>';
  const r6 = await runScheduled();
  record('解析失敗：送出告警', r6.status === 'parse_failed' && sentAlerts.some((a) => a.kind === 'benefit_parse_failed'), JSON.stringify(r6));
  const after = await rulesets();
  record('失敗後現行版本不變、沒有新草稿', JSON.stringify(after.filter((r) => r.status === 'approved').map((r) => r.id)) === JSON.stringify(approvedBefore)
    && !after.some((r) => r.status === 'draft'));
  const alertAudit = (await admin.query(`select count(*)::int n from audit_events where event_type in ('alert.benefit_fetch_failed', 'alert.benefit_parse_failed')`)).rows[0].n;
  record('告警寫入稽核紀錄', alertAudit === 2, `n=${alertAudit}`);

  console.log('--- 權限 ---');
  const reqFetch = await call(rulesetFn.handler, 'POST', U.req, { action: 'fetch_now' });
  record('非平台管理者不能觸發抓取', reqFetch.status === 403, outcome(reqFetch));
  site.html = page(['1,680', '1,840', '2,000', '2,500']);
  const manual = await call(rulesetFn.handler, 'POST', U.root, { action: 'fetch_now' });
  record('平台管理者可以立即抓取；被駁回過的相同內容不會再產生草稿', manual.status === 200 && manual.data.status === 'unchanged'
    && !(await rulesets()).some((r) => r.status === 'draft'), outcome(manual));
  const forge = await db.withUser(U.req, (c) => c.query(`select app.create_auto_benefit_draft('{}'::jsonb)`)).then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 一般使用者不能建立自動草稿', forge === '42501', forge);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
