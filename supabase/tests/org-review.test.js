'use strict';
/**
 * 機構申請與平台管理員審核（#20）的整合測試。
 *
 * 所有斷言都經過實際的 netlify/functions handler（organization-apply、organization-review、
 * state-load、state-mutate、claim-booking），handler 以 care_ride_app 連線，RLS 與 0003 的
 * 受控函式、觸發器全部生效。postgres 連線只用來建立身分 fixture 與讀取資料庫實際狀態。
 *
 * 只允許本機隔離端點與固定測試庫名稱，不會連到正式或預覽資料庫。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_org_test') {
  throw Error('Requires dedicated local endpoint and careride_org_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_org_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_org_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-org-0123456789';
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_org_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const applyFn = require('../../netlify/functions/v2-organization-apply');
const reviewFn = require('../../netlify/functions/v2-organization-review');
const ltcFn = require('../../netlify/functions/v2-ltc-contracts');
const loadFn = require('../../netlify/functions/v2-state-load');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const claimFn = require('../../netlify/functions/v2-claim-booking');

const U = { root: 'USR-ORG-ROOT', req: 'USR-ORG-REQ', app1: 'USR-ORG-APP1', app2: 'USR-ORG-APP2' };

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
const outcome = (r) => `${r.status} ${r.error ? r.error.code : 'ok'}`;
const apply = (userId, body) => call(applyFn.handler, 'POST', userId, body);
const review = (userId, organizationId, decision, note) => call(reviewFn.handler, 'POST', userId, { organizationId, decision, note });
const load = (userId) => call(loadFn.handler, 'GET', userId);
const claim = (userId, bookingId, organizationId) => call(claimFn.handler, 'POST', userId, { bookingId, organizationId });
const poolIds = (r) => ((r.data && r.data.pool) || []).map((b) => b.id);
const orgRow = async (id) => (await admin.query('select * from organizations where id = $1', [id])).rows[0];
const audits = async (orgId, type) => (await admin.query(
  'select actor_user_id, details from audit_events where organization_id = $1 and event_type = $2 order by created_at',
  [orgId, type])).rows;

function openBooking(id) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: '合成市合成路 1 號', destination: '合成醫院',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true
  };
}

(async () => {
  await admin.query(`
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886922000009','super_admin',true),
      ('${U.req}','合成需求者','+886922000001','none',true),
      ('${U.app1}','合成申請者一','+886922000002','none',true),
      ('${U.app2}','合成申請者二','+886922000003','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-ORG-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-ORG-APP1','${U.app1}','ORG-REQ-001','requester','active'),
      ('M-ORG-APP2','${U.app2}','ORG-REQ-001','requester','active');
  `);
  const created = await call(bookingWriteFn.handler, 'POST', U.req, { changes: [
    { collection: 'bookings', id: 'BKG-ORG-1', record: openBooking('BKG-ORG-1') },
    { collection: 'bookings', id: 'BKG-ORG-2', record: openBooking('BKG-ORG-2') }] });
  record('（前提）需求者建立兩筆公開預約', created.status === 200, outcome(created));

  console.log('--- 申請 ---');
  const a1 = await apply(U.app1, { name: '合成交通一', orgType: 'transport_provider', taxId: '12345678',
    contactPhone: '02-1234-5678', contactName: '王聯絡', documentsNote: '公路總局營業登記 合成-001' });
  const org1 = a1.data && a1.data.organization && a1.data.organization.id;
  record('需求者可以送出機構申請', a1.status === 200 && Boolean(org1), outcome(a1));
  const row1 = await orgRow(org1);
  record('新機構是 pending，申請資料與申請人都有記錄',
    row1 && row1.review_status === 'pending' && row1.applied_by_user_id === U.app1
      && row1.application.documentsNote === '公路總局營業登記 合成-001');
  const own1 = (await admin.query(`select role, status from memberships where user_id = $1 and organization_id = $2`, [U.app1, org1])).rows;
  record('申請人成為該機構的負責人', own1.length === 1 && own1[0].role === 'owner' && own1[0].status === 'active');
  record('申請寫入稽核紀錄', (await audits(org1, 'organization.applied')).length === 1);

  const again = await apply(U.app1, { name: '再申請一次', orgType: 'transport_provider' });
  record('同一人已有審核中的申請，不能再申請', again.status === 400 && again.error.code === 'VALIDATION_ERROR', outcome(again));
  const badType = await apply(U.app2, { name: '類型錯誤', orgType: 'requester_hub' });
  record('機構類型只能是服務組織', badType.status === 400, outcome(badType));
  const noLogin = await apply(null, { name: '沒登入', orgType: 'transport_provider' });
  record('沒登入不能申請', noLogin.status === 401, outcome(noLogin));
  const rootApply = await apply(U.root, { name: '管理者申請', orgType: 'transport_provider' });
  record('平台管理者不走申請流程', rootApply.status === 403, outcome(rootApply));

  console.log('--- 審核前：讀不到需求池、不能接案 ---');
  const pending = await load(U.app1);
  record('pending 機構負責人：state-load 的需求池是空的', pending.status === 200 && poolIds(pending).length === 0, `pool=${poolIds(pending).length}`);
  const ownView = (pending.data.collections.organizations || []).find((o) => o.id === org1);
  record('負責人看得到自己機構的審核狀態', ownView && ownView.reviewStatus === 'pending');
  const claimPending = await claim(U.app1, 'BKG-ORG-1', org1);
  record('pending 機構不能接案', claimPending.status === 403 && claimPending.error.code === 'FORBIDDEN', outcome(claimPending));
  record('接案被拒後預約仍未被承接',
    (await admin.query(`select organization_id from bookings where id='BKG-ORG-1'`)).rows[0].organization_id === null);

  console.log('--- 只有平台管理員能審核 ---');
  const selfApprove = await review(U.app1, org1, 'approve');
  record('機構負責人不能核准自己的申請', selfApprove.status === 403, outcome(selfApprove));
  const requesterApprove = await review(U.req, org1, 'approve');
  record('需求者不能審核', requesterApprove.status === 403, outcome(requesterApprove));
  let direct;
  try {
    direct = await db.withUser(U.app1, (c) => c.query(`update organizations set review_status = 'approved' where id = $1`, [org1]));
  } catch (error) { direct = error; }
  record('負責人直接改 review_status（繞過 API）被觸發器擋下', direct instanceof Error && direct.code === '42501', direct && (direct.code || direct.rowCount));
  let nameEdit;
  try {
    nameEdit = await db.withUser(U.app1, (c) => c.query(`update organizations set contact_phone = '02-0000-0000' where id = $1`, [org1]));
  } catch (error) { nameEdit = error; }
  record('負責人改自己機構的一般欄位不受影響', !(nameEdit instanceof Error) && nameEdit.rowCount === 1, nameEdit && (nameEdit.code || nameEdit.rowCount));
  record('審核狀態仍是 pending', (await orgRow(org1)).review_status === 'pending');

  console.log('--- 核准 ---');
  const approve = await review(U.root, org1, 'approve');
  const approvedRow = await orgRow(org1);
  record('平台管理員核准', approve.status === 200 && approve.data.reviewStatus === 'approved', outcome(approve));
  record('記錄審核人與時間', approvedRow.reviewed_by_user_id === U.root && approvedRow.reviewed_at !== null);
  const approvedAudit = await audits(org1, 'organization.reviewed');
  record('核准寫入稽核紀錄（審核人、前後狀態）', approvedAudit.length === 1 && approvedAudit[0].actor_user_id === U.root
    && approvedAudit[0].details.from === 'pending' && approvedAudit[0].details.to === 'approved');
  const approvedLoad = await load(U.app1);
  record('核准後負責人看得到需求池', poolIds(approvedLoad).includes('BKG-ORG-1'), `pool=${poolIds(approvedLoad).join(',')}`);
  const claimApproved = await claim(U.app1, 'BKG-ORG-1', org1);
  record('核准後可以接案', claimApproved.status === 200, outcome(claimApproved));

  console.log('--- 停權 ---');
  const suspendNoNote = await review(U.root, org1, 'suspend', '');
  record('停權沒填原因被拒', suspendNoNote.status === 400, outcome(suspendNoNote));
  const suspend = await review(U.root, org1, 'suspend', '合成：文件到期');
  record('停權', suspend.status === 200 && suspend.data.reviewStatus === 'suspended', outcome(suspend));
  const suspendedLoad = await load(U.app1);
  record('停權後讀不到需求池', poolIds(suspendedLoad).length === 0, `pool=${poolIds(suspendedLoad).length}`);
  const claimSuspended = await claim(U.app1, 'BKG-ORG-2', org1);
  record('停權後不能接案', claimSuspended.status === 403, outcome(claimSuspended));
  const suspendedView = (suspendedLoad.data.collections.organizations || []).find((o) => o.id === org1);
  record('負責人看得到停權狀態與原因', suspendedView && suspendedView.reviewStatus === 'suspended' && suspendedView.reviewNote === '合成：文件到期');
  const reinstate = await review(U.root, org1, 'approve');
  record('恢復（重新核准）', reinstate.status === 200 && reinstate.data.reviewStatus === 'approved', outcome(reinstate));
  record('恢復後又看得到需求池', poolIds(await load(U.app1)).includes('BKG-ORG-2'));

  console.log('--- 駁回與不允許的轉換 ---');
  const a2 = await apply(U.app2, { name: '合成照護二', orgType: 'care_facility' });
  const org2 = a2.data && a2.data.organization && a2.data.organization.id;
  record('第二個申請', a2.status === 200 && Boolean(org2), outcome(a2));
  const suspendPending = await review(U.root, org2, 'suspend', '不該成功');
  record('pending 不能直接停權', suspendPending.status === 400, outcome(suspendPending));
  const reject = await review(U.root, org2, 'reject', '合成：缺少立案證明');
  record('駁回', reject.status === 200 && reject.data.reviewStatus === 'rejected', outcome(reject));
  const rejectAgain = await review(U.root, org2, 'reject', '再駁回一次');
  record('已駁回不能再駁回', rejectAgain.status === 400, outcome(rejectAgain));
  const rejectedLoad = await load(U.app2);
  record('被駁回的機構讀不到需求池', poolIds(rejectedLoad).length === 0);
  const notFound = await review(U.root, 'ORG-DOES-NOT-EXIST', 'approve');
  record('不存在的機構回 404', notFound.status === 404, outcome(notFound));
  const hub = await review(U.root, 'ORG-REQ-001', 'suspend', '不該成功');
  record('需求者組織不能被審核', hub.status === 404, outcome(hub));
  const allReviews = await admin.query(`select count(*)::int n from audit_events where event_type = 'organization.reviewed'`);
  record('每一次成功的審核決定都有一筆稽核紀錄（核准、停權、恢復、駁回 = 4）', allReviews.rows[0].n === 4, `n=${allReviews.rows[0].n}`);

  console.log('--- 長照特約（#99）---');
  const ltc = (userId, body) => call(ltcFn.handler, 'POST', userId, body);
  const contract = (extra = {}) => ({ organizationId: org1, city: '新北市', contractNo: '合成新北長照特約 115-001',
    validFrom: '2026-01-01', validTo: '2027-12-31', ...extra });
  const ownerSave = await ltc(U.app1, { action: 'save', contract: contract() });
  record('機構負責人不能自己標記長照特約', ownerSave.status === 403, outcome(ownerSave));
  const directInsert = await db.withUser(U.root, (c) => c.query(
    `insert into ltc_contracts (id, organization_id, city, contract_no, valid_from) values ('LTC-X', $1, '新北市', 'X', '2026-01-01')`, [org1]))
    .then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 連平台管理者都不能直接寫，只能經受控函式', directInsert === '42501', directInsert);
  const badCity = await ltc(U.root, { action: 'save', contract: contract({ city: '火星市' }) });
  const noNo = await ltc(U.root, { action: 'save', contract: contract({ contractNo: '' }) });
  const badRange = await ltc(U.root, { action: 'save', contract: contract({ validFrom: '2027-01-01', validTo: '2026-01-01' }) });
  const hubContract = await ltc(U.root, { action: 'save', contract: contract({ organizationId: 'ORG-REQ-001' }) });
  record('縣市不合法、沒有契約字號、期間顛倒、需求者群組：都被拒', [badCity, noNo, badRange, hubContract].every((r) => r.status === 400),
    [badCity, noNo, badRange, hubContract].map(outcome).join(' / '));
  const saved1 = await ltc(U.root, { action: 'save', contract: contract({ city: '臺北市', contractNo: '合成北市特約' }) });
  const saved2 = await ltc(U.root, { action: 'save', contract: contract() });
  const LTC2 = saved2.data && saved2.data.id;
  record('平台管理者可以新增多筆（臺北市寫成台北市也認得）', saved1.status === 200 && saved2.status === 200 && Boolean(LTC2)
    && (await admin.query(`select count(*)::int n from ltc_contracts where organization_id = $1`, [org1])).rows[0].n === 2, `${outcome(saved1)} / ${outcome(saved2)}`);
  const active = async (orgId, city, date) => (await admin.query('select app.ltc_contract_active($1, $2, $3::date) as ok', [orgId, city, date])).rows[0].ok;
  record('有效判斷：縣市與日期都在範圍內才算', await active(org1, '新北市', '2026-10-08') === true && await active(org1, '臺北市', '2026-10-08') === true
    && await active(org1, '桃園市', '2026-10-08') === false && await active(org1, '新北市', '2028-01-01') === false
    && await active(org1, '新北市', '2025-12-31') === false && await active('ORG-REQ-001', '新北市', '2026-10-08') === false);
  const ownerLoad = await load(U.app1);
  const ownerSees = (ownerLoad.data.collections.ltcContracts || []).filter((x) => x.organizationId === org1);
  record('機構負責人看得到自己機構的長照特約', ownerSees.length === 2 && ownerSees.some((x) => x.city === '新北市' && x.contractNo === '合成新北長照特約 115-001'));
  record('其他人看不到', !((await load(U.app2)).data.collections.ltcContracts || []).length && !((await load(U.req)).data.collections.ltcContracts || []).length);
  const edited = await ltc(U.root, { action: 'save', contract: { ...contract({ validTo: '2026-06-30' }), id: LTC2 } });
  record('修改有效期間後，過期就不算數', edited.status === 200 && await active(org1, '新北市', '2026-10-08') === false, outcome(edited));
  const ownerRemove = await ltc(U.app1, { action: 'remove', id: LTC2 });
  const removed = await ltc(U.root, { action: 'remove', id: LTC2 });
  record('只有平台管理者能移除', ownerRemove.status === 403 && removed.status === 200
    && (await admin.query(`select count(*)::int n from ltc_contracts where id = $1`, [LTC2])).rows[0].n === 0, `${outcome(ownerRemove)} / ${outcome(removed)}`);
  const ltcAudits = (await admin.query(`select event_type, details from audit_events where event_type like 'ltc_contract.%' order by created_at`)).rows;
  record('每次新增、修改、移除都寫稽核紀錄（3 次新增修改 + 1 次移除）', ltcAudits.length === 4
    && ltcAudits.filter((a) => a.event_type === 'ltc_contract.saved').length === 3 && ltcAudits.some((a) => a.event_type === 'ltc_contract.removed'),
    JSON.stringify(ltcAudits.map((a) => a.event_type)));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
