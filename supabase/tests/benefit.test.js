'use strict';
/**
 * 補助規則版本與伺服器試算（#23 第一部分）的整合測試。
 *
 * 經過實際的 handler（benefit-ruleset、benefit-assess、booking-write、claim-booking、state-mutate、
 * state-load），handler 以 care_ride_app 連線，RLS 與 0008 的受控函式全部生效。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_benefit_test') {
  throw Error('Requires dedicated local endpoint and careride_benefit_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_benefit_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_benefit_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-benefit-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-benefit-0123456789';
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_benefit_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const rulesetFn = require('../../netlify/functions/v2-benefit-ruleset');
const assessFn = require('../../netlify/functions/v2-benefit-assess');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const loadFn = require('../../netlify/functions/v2-state-load');

const ORG = 'ORG-BEN-A';
const U = { root: 'USR-BEN-ROOT', req: 'USR-BEN-REQ', req2: 'USR-BEN-REQ2', dsp: 'USR-BEN-DSP' };
const RECIPIENT = 'CR-BEN-1';

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
const rulesetCall = (userId, body) => call(rulesetFn.handler, 'POST', userId, body);
const assess = (userId, body) => call(assessFn.handler, 'POST', userId, body);
const writeBooking = (userId, rec) => call(bookingWriteFn.handler, 'POST', userId, { changes: [{ collection: 'bookings', id: rec.id, record: rec }] });
const load = (userId) => call(loadFn.handler, 'GET', userId);
const statuses = async () => Object.fromEntries((await admin.query('select version, status from benefit_rulesets order by version')).rows.map((r) => [r.version, r.status]));
const bookingRow = async (id) => (await admin.query(`select data from app_state where collection = 'bookings' and id = $1`, [id])).rows[0].data;

const SOURCE = { agency: '衛生福利部', title: '合成長照交通補助公告', url: 'https://example.gov.tw/ltc', checkedAt: '2026-09-01' };
const draft = (version, amount, extra = {}) => ({ code: 'transportation_primary', version, name: `合成規則 ${version}`,
  effectiveFrom: '2026-01-01', conditions: { cmsLevels: [2, 3, 4, 5, 6, 7, 8] },
  calculation: { mode: 'fixed_amount', amount }, source: SOURCE, ...extra });
function booking(id, extra = {}) {
  return { id, state: 'open', claimStatus: 'open', status: 'open', requestedByUserId: U.req, recipientId: RECIPIENT,
    name: '合成需求者', phone: '0911000001', pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: '新北市板橋區文化路一段188號', destination: '臺北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true, ...extra };
}

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values ('${ORG}','transport_provider','合成補助交通',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886966000009','super_admin',true),
      ('${U.req}','合成需求者','+886966000001','none',true),
      ('${U.req2}','合成需求者二','+886966000002','none',true),
      ('${U.dsp}','合成調度','+886966000003','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-BEN-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-BEN-REQ2','${U.req2}','ORG-REQ-001','requester','active'),
      ('M-BEN-DSP','${U.dsp}','${ORG}','dispatcher','active');
  `);
  const cr = await call(mutateFn.handler, 'POST', U.req, { changes: [{ collection: 'careRecipients', id: RECIPIENT,
    record: { id: RECIPIENT, identity: { displayName: '合成長輩' } } }] });
  record('（前提）需求者建立服務對象', cr.status === 200, outcome(cr));

  console.log('--- 規則版本：草稿、核准、取代、駁回 ---');
  const notAdmin = await rulesetCall(U.req, { action: 'save_draft', ruleset: draft('2026.1', 300) });
  record('非平台管理者不能建立規則', notAdmin.status === 403, outcome(notAdmin));
  const d1 = await rulesetCall(U.root, { action: 'save_draft', ruleset: draft('2026.1', 300) });
  const r1 = d1.data && d1.data.ruleset;
  record('平台管理者建立草稿', d1.status === 200 && r1 && r1.status === 'draft', outcome(d1));
  const dup = await rulesetCall(U.root, { action: 'save_draft', ruleset: draft('2026.1', 999) });
  record('同一個版本號不能重複建立', dup.status === 400, outcome(dup));
  const noSource = await rulesetCall(U.root, { action: 'save_draft', ruleset: draft('2026.0', 100, { source: {} }) });
  const approveNoSource = await rulesetCall(U.root, { action: 'approve', id: noSource.data.ruleset.id });
  record('沒有來源資料的草稿不能核准', approveNoSource.status === 400 && /來源/.test(approveNoSource.error.message), outcome(approveNoSource));
  const reqApprove = await rulesetCall(U.req, { action: 'approve', id: r1.id });
  record('非平台管理者不能核准', reqApprove.status === 403, outcome(reqApprove));
  const a1 = await rulesetCall(U.root, { action: 'approve', id: r1.id });
  record('核准第一個版本', a1.status === 200 && a1.data.ruleset.status === 'approved', outcome(a1));
  const editApproved = await rulesetCall(U.root, { action: 'save_draft', id: r1.id, ruleset: draft('2026.1', 999) });
  record('已核准的版本不能修改', editApproved.status === 400 && (await statuses())['2026.1'] === 'approved', outcome(editApproved));
  const rejectNoNote = await rulesetCall(U.root, { action: 'reject', id: noSource.data.ruleset.id, note: '' });
  record('駁回必須填寫原因', rejectNoNote.status === 400, outcome(rejectNoNote));
  const rej = await rulesetCall(U.root, { action: 'reject', id: noSource.data.ruleset.id, note: '合成：缺少公告來源' });
  record('駁回草稿', rej.status === 200 && rej.data.ruleset.status === 'rejected', outcome(rej));

  console.log('--- 試算與預約估算 ---');
  const other = await assess(U.req2, { recipientId: RECIPIENT, facts: { cmsLevel: 4 } });
  record('別人不能替這位服務對象試算', other.status === 403, outcome(other));
  const as1 = await assess(U.req, { recipientId: RECIPIENT, serviceDate: '2099-01-01', facts: { cmsLevel: '4', residenceCity: '新北市' } });
  const assessment = as1.data && as1.data.assessment;
  record('需求者試算：伺服器依核准版本計算並記錄版本 ID', as1.status === 200 && assessment.status === 'eligible_estimate'
    && assessment.estimatedSubsidy === 300 && assessment.rulesetId === r1.id && assessment.rulesetVersion === '2026.1', outcome(as1));
  const stored = (await admin.query('select ruleset_id, estimated_subsidy, created_by_user_id from benefit_assessments where id = $1', [assessment.id])).rows[0];
  record('試算存進資料表', stored && stored.ruleset_id === r1.id && Number(stored.estimated_subsidy) === 300 && stored.created_by_user_id === U.req);

  const forged = booking('BKG-BEN-1', {
    serverComputed: { benefit: { estimatedSubsidy: 99999, rulesetId: 'forged' } },
    commercialSnapshots: [{ id: 'SNAP-1', benefit: { estimatedSubsidy: 99999, status: 'eligible_estimate' }, quote: {} }]
  });
  const created = await writeBooking(U.req, forged);
  const b1 = await bookingRow('BKG-BEN-1');
  record('建立預約：補助由伺服器估算並記錄規則版本 ID', created.status === 200 && b1.serverComputed.benefit.estimatedSubsidy === 300
    && b1.serverComputed.benefit.rulesetId === r1.id && b1.serverComputed.benefit.sourceAssessmentId === assessment.id, outcome(created));
  record('前端送上的補助金額被忽略（快照也換成伺服器的結果）', b1.commercialSnapshots[0].benefit.estimatedSubsidy === 300
    && b1.commercialSnapshots[0].benefit.rulesetId === r1.id);

  const as2 = await assess(U.req, { recipientId: RECIPIENT, facts: {} });
  record('資料不足的試算：insufficient_data', as2.status === 200 && as2.data.assessment.status === 'insufficient_data', outcome(as2));
  await assess(U.req, { recipientId: RECIPIENT, facts: { cmsLevel: 4 } });

  console.log('--- 核准新版本：舊版本變 superseded，新估算用新版本 ---');
  const d2 = await rulesetCall(U.root, { action: 'save_draft', ruleset: draft('2026.2', 450) });
  const a2 = await rulesetCall(U.root, { action: 'approve', id: d2.data.ruleset.id });
  const st = await statuses();
  record('核准新版本後舊版本變 superseded', a2.status === 200 && a2.data.supersededId === r1.id
    && st['2026.1'] === 'superseded' && st['2026.2'] === 'approved', JSON.stringify(st));
  const approvedCount = (await admin.query(`select count(*)::int n from benefit_rulesets where status = 'approved'`)).rows[0].n;
  record('任一時點只有一個 approved', approvedCount === 1, `n=${approvedCount}`);
  let dbGuard;
  try { await admin.query(`update benefit_rulesets set status = 'approved' where version = '2026.1'`); dbGuard = 'allowed'; }
  catch (e) { dbGuard = e.code; }
  record('資料庫層也擋下第二個 approved（唯一索引）', dbGuard === '23505', dbGuard);
  const b1After = await bookingRow('BKG-BEN-1');
  record('既有預約的估算不被改寫（仍是舊版本 300）', b1After.serverComputed.benefit.estimatedSubsidy === 300 && b1After.serverComputed.benefit.rulesetId === r1.id);
  await writeBooking(U.req, booking('BKG-BEN-2'));
  const b2 = await bookingRow('BKG-BEN-2');
  record('新預約改用新版本（450）', b2.serverComputed.benefit.estimatedSubsidy === 450 && b2.serverComputed.benefit.rulesetId === d2.data.ruleset.id,
    JSON.stringify(b2.serverComputed.benefit.rulesetVersion));
  await writeBooking(U.req, { ...(await bookingRow('BKG-BEN-1')), pickupDate: '2099-02-01' });
  const b1Moved = await bookingRow('BKG-BEN-1');
  record('改了預約日期才重新估算（改用新版本）', b1Moved.serverComputed.benefit.estimatedSubsidy === 450);
  await writeBooking(U.req, { ...(await bookingRow('BKG-BEN-2')), pickupTime: '10:00' });
  record('其他修改沿用原本的估算', (await bookingRow('BKG-BEN-2')).serverComputed.benefit.computedAt === b2.serverComputed.benefit.computedAt);

  console.log('--- 寫入權限與讀取 ---');
  for (const collection of ['benefitRulesets', 'benefitAssessments', 'benefitRulesetEvents', 'benefitAssessmentEvents', 'benefitLatestEstimateRuns']) {
    const r = await call(mutateFn.handler, 'POST', U.root, { changes: [{ collection, id: 'X-1', record: { id: 'X-1', status: 'approved' } }] });
    record(`${collection} 不能經一般寫入端點寫`, r.status === 403 && r.error.code === 'COLLECTION_FORBIDDEN', outcome(r));
  }
  const direct = await db.withUser(U.root, (c) => c.query(`insert into benefit_rulesets (id, code, version) values ('R-X','x','1')`))
    .then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 連平台管理者都不能直接 INSERT 規則（只能經受控函式）', direct === '42501', direct);
  const directAssess = await db.withUser(U.req, (c) => c.query(`update benefit_assessments set estimated_subsidy = 99999`))
    .then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 需求者不能改試算金額', directAssess === '42501', directAssess);

  const reqLoad = await load(U.req);
  const req2Load = await load(U.req2);
  record('需求者讀得到規則版本（四種狀態）與自己的試算', (reqLoad.data.collections.benefitRulesets || []).length === 3
    && (reqLoad.data.collections.benefitAssessments || []).some((a) => a.id === assessment.id));
  record('其他需求者讀不到這位服務對象的試算', !(req2Load.data.collections.benefitAssessments || []).some((a) => a.recipientId === RECIPIENT));
  const claim = await call(claimFn.handler, 'POST', U.dsp, { bookingId: 'BKG-BEN-2', organizationId: ORG });
  const dspLoad = await load(U.dsp);
  const seen = (dspLoad.data.collections.bookings || []).find((x) => x.id === 'BKG-BEN-2');
  record('承接後調度員讀到伺服器算出的補助金額', claim.status === 200 && seen && seen.serverComputed.benefit.estimatedSubsidy === 450, outcome(claim));
  record('承接機構讀得到服務對象的試算（服務中）', (dspLoad.data.collections.benefitAssessments || []).some((a) => a.recipientId === RECIPIENT));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
