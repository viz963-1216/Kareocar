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
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_benefit_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const rulesetFn = require('../../netlify/functions/v2-benefit-ruleset');
const assessFn = require('../../netlify/functions/v2-benefit-assess');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const loadFn = require('../../netlify/functions/v2-state-load');
const authorizationFn = require('../../netlify/functions/v2-benefit-authorization');
const cancelFn = require('../../netlify/functions/v2-cancel-booking');
const tripWriteFn = require('../../netlify/functions/v2-trip-write');
const scheduleFn = require('../../netlify/functions/v2-schedule-trips');
const executeFn = require('../../netlify/functions/v2-trip-execute');
const F = require('../../tests/_trip-fixtures');

const ORG = 'ORG-BEN-A';
const ORG_B = 'ORG-BEN-B';
const U = { root: 'USR-BEN-ROOT', req: 'USR-BEN-REQ', req2: 'USR-BEN-REQ2', dsp: 'USR-BEN-DSP', dspB: 'USR-BEN-DSPB', drv: 'USR-BEN-DRV' };
const DRIVER = 'DRV-BEN-1';
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
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    legs: [F.outboundLeg(id)], ...extra };
}

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values ('${ORG}','transport_provider','合成補助交通',true),
      ('${ORG_B}','transport_provider','合成補助交通 B',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886966000009','super_admin',true),
      ('${U.req}','合成需求者','+886966000001','none',true),
      ('${U.req2}','合成需求者二','+886966000002','none',true),
      ('${U.dsp}','合成調度','+886966000003','none',true),
      ('${U.dspB}','合成調度 B','+886966000004','none',true),
      ('${U.drv}','合成司機','+886966000005','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-BEN-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-BEN-REQ2','${U.req2}','ORG-REQ-001','requester','active'),
      ('M-BEN-DSP','${U.dsp}','${ORG}','dispatcher','active'),
      ('M-BEN-DSPB','${U.dspB}','${ORG_B}','dispatcher','active'),
      ('M-BEN-DRV','${U.drv}','${ORG}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values ('${DRIVER}','${U.drv}','${ORG}','on_duty',true);
  `);
  const cr = await call(mutateFn.handler, 'POST', U.req, { changes: [{ collection: 'careRecipients', id: RECIPIENT,
    record: { id: RECIPIENT, identity: { displayName: '合成長輩' }, addresses: { primary: '新北市板橋區文化路一段188號' } } },
  // 沒有住址的服務對象（#100：地區由住址判斷）
  { collection: 'careRecipients', id: `${RECIPIENT}-NOADDR`, record: { id: `${RECIPIENT}-NOADDR`, identity: { displayName: '合成沒住址' } } },
  // 預約端點要求需求者對服務對象有可預約的關係（#78）
  { collection: 'careRecipientRelations', id: `${RECIPIENT}-REL`,
    record: { id: `${RECIPIENT}-REL`, userId: U.req, recipientId: RECIPIENT, relationship: 'family', canBook: true, status: 'active' } }] });
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

  // #100：地區由伺服器從服務對象住址判斷，前端送來的不採用
  const asAddr = await assess(U.req, { recipientId: RECIPIENT, facts: { cmsLevel: 4, residenceCity: '臺東縣', residenceDistrict: '成功鎮' } });
  record('試算的地區用服務對象住址（不採用前端送來的）', asAddr.status === 200 && asAddr.data.assessment.facts.residenceCity === '新北市'
    && asAddr.data.assessment.facts.residenceDistrict === '板橋區', JSON.stringify(asAddr.data && asAddr.data.assessment.facts));
  const noAddr = await assess(U.req, { recipientId: `${RECIPIENT}-NOADDR`, facts: { cmsLevel: 4 } });
  record('服務對象沒有住址：請先補住址', noAddr.status === 400 && /住址/.test(noAddr.error.message), outcome(noAddr));
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
  const dspAssess = await assess(U.dsp, { recipientId: RECIPIENT, facts: { cmsLevel: 6 } });
  record('承接機構只能讀，不能替服務對象試算（#100）', dspAssess.status === 403, outcome(dspAssess));

  console.log('--- 正式核定額度（#23 第二部分）---');
  const authCall = (userId, body) => call(authorizationFn.handler, 'POST', userId, body);
  const authBody = (extra = {}) => ({ recipientId: RECIPIENT, programCode: 'transportation_primary', validFrom: '2026-01-01',
    approvedAmount: 1000, referenceNo: '合成核定 115-001', ...extra });
  const balance = async (id) => {
    const r = (await admin.query('select * from app.benefit_balance($1)', [id])).rows[0];
    return { reserved: Number(r.reserved), settled: Number(r.settled), available: Number(r.available), adjustment: Number(r.adjustment) };
  };
  const reservedFor = async (bookingId) => Number((await admin.query(
    'select coalesce(sum(reserved_delta), 0) as n from benefit_ledger where booking_id = $1', [bookingId])).rows[0].n);
  const reqAuth = await authCall(U.req, { action: 'save', authorization: authBody() });
  record('需求者不能自己登錄正式核定', reqAuth.status === 403, outcome(reqAuth));
  const otherOrg = await authCall(U.dspB, { action: 'save', organizationId: ORG_B, authorization: authBody() });
  record('沒有在服務這位服務對象的機構不能登錄', otherOrg.status === 403, outcome(otherOrg));
  const noRef = await authCall(U.dsp, { action: 'save', organizationId: ORG, authorization: authBody({ referenceNo: '' }) });
  record('沒有核定文號被拒', noRef.status === 400, outcome(noRef));
  const saved = await authCall(U.dsp, { action: 'save', organizationId: ORG, authorization: authBody() });
  const AUTH = saved.data && saved.data.authorizationId;
  record('服務中的機構調度員登錄核定 1000', saved.status === 200 && Boolean(AUTH) && (await balance(AUTH)).available === 1000, outcome(saved));

  // #98：平台沒有車資，現在的估算是整個月的額度；在每筆預約保留整月額度會讓第二筆就顯示「額度用完」。
  // 暫停「預約時保留、接送完成時結算」，帳本與核定照舊（之後有車資再啟用）。
  console.log('--- 暫停額度保留與結算（#98）---');
  await writeBooking(U.req, booking('BKG-BEN-L1'));
  record('建立預約不保留額度，可用額度維持 1000', (await reservedFor('BKG-BEN-L1')) === 0 && (await balance(AUTH)).available === 1000);
  await writeBooking(U.req, { ...(await bookingRow('BKG-BEN-L1')), pickupDate: '2099-01-02' });
  record('改日期重新估算也不保留', (await reservedFor('BKG-BEN-L1')) === 0);
  await writeBooking(U.req, booking('BKG-BEN-L2'));
  await writeBooking(U.req, booking('BKG-BEN-L3'));
  record('第二、三筆預約一樣不保留，可用額度不會被吃光', (await balance(AUTH)).available === 1000 && (await balance(AUTH)).reserved === 0);
  const cancelled = await call(cancelFn.handler, 'POST', U.req, { bookingId: 'BKG-BEN-L1', reasonCode: 'requester_no_longer_needed' });
  record('需求者取消照常成功，額度不變', cancelled.status === 200 && (await balance(AUTH)).available === 1000, outcome(cancelled));
  await writeBooking(U.req, booking('BKG-BEN-L4'));
  const expired = await writeBooking(U.req, { ...(await bookingRow('BKG-BEN-L4')), state: 'expired', status: 'expired', claimStatus: 'expired' });
  record('需求者讓預約過期照常成功，額度不變', expired.status === 200 && (await balance(AUTH)).available === 1000, outcome(expired));

  // 帳本函式保留給之後有車資時使用：直接呼叫確認仍然正確（保留取估算與可用額度較小者、不重複保留、釋放後歸零）
  await writeBooking(U.req, booking('BKG-BEN-L5'));
  const sql1 = async (q) => (await admin.query(q)).rows[0];
  const reserved1 = Number((await sql1(`select app.reserve_booking_benefit('BKG-BEN-L5', 'direct_test') as n`)).n);
  const reserved2 = Number((await sql1(`select app.reserve_booking_benefit('BKG-BEN-L5', 'direct_test') as n`)).n);
  record('保留函式仍可用：保留估算金額、不重複保留', reserved1 === 450 && reserved2 === 0 && (await reservedFor('BKG-BEN-L5')) === 450, `${reserved1} / ${reserved2}`);
  await admin.query(`select app.release_booking_benefit('BKG-BEN-L5', 'direct_test')`);
  await admin.query(`select app.release_booking_benefit('BKG-BEN-L5', 'direct_test')`);
  record('釋放函式仍可用：釋放後歸零、重複釋放不出錯', (await reservedFor('BKG-BEN-L5')) === 0 && (await balance(AUTH)).available === 1000);

  await call(claimFn.handler, 'POST', U.dsp, { bookingId: 'BKG-BEN-L2', organizationId: ORG });
  const rejected = await writeBooking(U.dsp, { ...(await bookingRow('BKG-BEN-L2')), state: 'rejected', status: 'rejected', claimStatus: 'rejected' });
  record('承接機構婉拒照常成功', rejected.status === 200, outcome(rejected));

  await call(claimFn.handler, 'POST', U.dsp, { bookingId: 'BKG-BEN-L3', organizationId: ORG });
  const TRIP = 'TRP-BEN-L3';
  const trip = F.makeTrip({ id: TRIP, organizationId: ORG, driverId: DRIVER, vehicleId: 'VEH-BEN-1', bookingId: 'BKG-BEN-L3',
    startAt: F.addMinutes(new Date().toISOString(), 10),
    extra: { bookingIds: ['BKG-BEN-L3'], bookingLegRefs: F.legRefsFor(['BKG-BEN-L3']) } });
  const tw = await call(scheduleFn.handler, 'POST', U.dsp, { trips: [trip] });
  record('（前提）排車並建立行程', tw.status === 200, outcome(tw));
  const tripState = async () => {
    const r = (await admin.query(`select data, organization_id, revision from app_state where collection = 'trips' and id = $1`, [TRIP])).rows[0];
    return { ...r.data, organizationId: r.organization_id, revision: r.revision };
  };
  for (let i = 0; i < 3; i++) await call(executeFn.handler, 'POST', U.drv, F.completeStep(await tripState(), U.drv, new Date().toISOString()).request);
  const proof = await call(executeFn.handler, 'POST', U.drv, F.addProof(await tripState(), U.drv, new Date().toISOString()).request);
  const settledRow = (await admin.query(
    `select coalesce(sum(settled_delta), 0) as s from benefit_ledger where booking_id = 'BKG-BEN-L3'`)).rows[0];
  record('行程完成照常，不結算額度', proof.status === 200 && proof.data.status === 'completed' && Number(settledRow.s) === 0, outcome(proof));
  const undo = await call(executeFn.handler, 'POST', U.drv, F.undoStep(await tripState(), U.drv, new Date().toISOString()).request);
  record('完成後修正（返回上一步）照常，額度不變', undo.status === 200 && (await balance(AUTH)).settled === 0 && (await balance(AUTH)).reserved === 0, outcome(undo));
  const noLedger = (await admin.query(`select count(*)::int n from benefit_ledger where booking_id is not null and booking_id <> 'BKG-BEN-L5'`)).rows[0].n;
  record('經端點操作的預約在帳本沒有任何保留或結算紀錄', noLedger === 0, `n=${noLedger}`);

  console.log('--- 調整、撤銷與權限 ---');
  const bal = await balance(AUTH);
  const tooLow = await authCall(U.dsp, { action: 'adjust', id: AUTH, organizationId: ORG, amount: -(1000 - bal.reserved - bal.settled + 1), reason: '合成調降測試' });
  record('調整後不能低於已保留＋已結算', tooLow.status === 400, outcome(tooLow));
  const raise = await authCall(U.root, { action: 'adjust', id: AUTH, amount: 500, reason: '合成追加核定' });
  record('平台管理者追加 500，可用額度增加', raise.status === 200 && (await balance(AUTH)).available === bal.available + 500, outcome(raise));
  for (const collection of ['benefitAuthorizations', 'benefitLedger', 'benefitAuthorizationEvents']) {
    const r = await call(mutateFn.handler, 'POST', U.root, { changes: [{ collection, id: 'X-2', record: { id: 'X-2' } }] });
    record(`${collection} 不能經一般寫入端點寫`, r.status === 403 && r.error.code === 'COLLECTION_FORBIDDEN', outcome(r));
  }
  const forgeLedger = await db.withUser(U.root, (c) => c.query(
    `insert into benefit_ledger (id, authorization_id, recipient_id, entry_type, amount, authorization_delta) values ('L-X', $1, $2, 'adjustment', 99999, 99999)`,
    [AUTH, RECIPIENT])).then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 不能直接寫帳本（連平台管理者都只能經受控函式）', forgeLedger === '42501', forgeLedger);
  const reqLoad2 = await load(U.req);
  const req2Load2 = await load(U.req2);
  record('需求者讀得到自己服務對象的核定與帳本', (reqLoad2.data.collections.benefitAuthorizations || []).some((a) => a.id === AUTH)
    && (reqLoad2.data.collections.benefitLedger || []).some((l) => l.authorizationId === AUTH && l.entryType === 'adjustment'));
  record('其他需求者與其他機構讀不到', !(req2Load2.data.collections.benefitAuthorizations || []).length
    && !((await load(U.dspB)).data.collections.benefitLedger || []).length);
  const revoked = await authCall(U.dsp, { action: 'revoke', id: AUTH, organizationId: ORG, reason: '合成撤銷' });
  record('沒有保留額度時可以撤銷核定', revoked.status === 200, outcome(revoked));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
