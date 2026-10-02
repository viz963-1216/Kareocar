'use strict';
/**
 * 同意紀錄與保存期限匿名化（#26 第一部分）的整合測試。
 *
 * 經過實際的 handler（consent、platform-settings、booking-write、state-load）與每日排程
 * （retention-anonymize），handler 以 care_ride_app 連線，RLS 與 0010 的受控函式全部生效。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_privacy_test') {
  throw Error('Requires dedicated local endpoint and careride_privacy_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_privacy_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_privacy_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-privacy-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-privacy-0123456789';
const fx = require('./_auth-fixture');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_privacy_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const consentFn = require('../../netlify/functions/v2-consent');
const settingsFn = require('../../netlify/functions/v2-platform-settings');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const loadFn = require('../../netlify/functions/v2-state-load');
const scheduled = require('../../netlify/functions/retention-anonymize');

const U = { root: 'USR-PRV-ROOT', req: 'USR-PRV-REQ', req2: 'USR-PRV-REQ2' };

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}
async function call(handler, method, userId, body) {
  const res = await handler({
    httpMethod: method,
    headers: userId ? { host: '127.0.0.1', cookie: `cr_at=${fx.mintAccessToken(userId)}`, 'user-agent': 'synthetic-test' } : { host: '127.0.0.1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = { raw: res.body }; }
  return { status: res.statusCode, ...parsed };
}
const outcome = (r) => `${r.status} ${r.error ? `${r.error.code} ${r.error.message}` : 'ok'}`;
const consent = (userId, body) => call(consentFn.handler, 'POST', userId, body);
const settings = (userId, body) => call(settingsFn.handler, 'POST', userId, body);
const writeBooking = (userId, rec) => call(bookingWriteFn.handler, 'POST', userId, { changes: [{ collection: 'bookings', id: rec.id, record: rec }] });
const row = async (collection, id) => (await admin.query('select data from app_state where collection = $1 and id = $2', [collection, id])).rows[0];
const docs = (privacy, terms) => ({ privacy_notice: { version: privacy, url: 'https://example.org/privacy' }, terms: { version: terms, url: 'https://example.org/terms' } });
function booking(id, extra = {}) {
  return { id, state: 'open', claimStatus: 'open', status: 'open', requestedByUserId: U.req, name: '合成王小明', phone: '0911222333',
    pickupDate: '2099-01-01', pickupTime: '09:00', pickupAddress: '新北市板橋區文化路一段188號', destination: '臺北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true, specialNeed: '合成自由文字：住三樓無電梯', ...extra };
}

(async () => {
  await admin.query(`
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886977000009','super_admin',true),
      ('${U.req}','合成需求者','+886977000001','none',true),
      ('${U.req2}','合成需求者二','+886977000002','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-PRV-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-PRV-REQ2','${U.req2}','ORG-REQ-001','requester','active');
  `);

  console.log('--- 同意紀錄 ---');
  const before = await writeBooking(U.req, booking('BKG-PRV-0'));
  record('條款尚未發布（版本 null）時不要求同意，可以建立預約', before.status === 200, outcome(before));
  const notAdmin = await settings(U.req, { action: 'set_documents', documents: docs('v1', 'v1') });
  record('非平台管理者不能發布條款版本', notAdmin.status === 403, outcome(notAdmin));
  const published = await settings(U.root, { action: 'set_documents', documents: docs('2026-10', '2026-10') });
  record('平台管理者發布個資告知與服務條款', published.status === 200 && published.data.legalDocuments.terms.version === '2026-10', outcome(published));
  const status1 = await consent(U.req, { action: 'status' });
  record('需求者的同意狀態：兩份都還沒同意', status1.status === 200 && JSON.stringify(status1.data.missing) === JSON.stringify(['privacy_notice', 'terms']), outcome(status1));
  const loaded = await call(loadFn.handler, 'GET', U.req);
  record('state-load 帶出待同意清單，前端據此要求同意', JSON.stringify(loaded.data.consent.missing) === JSON.stringify(['privacy_notice', 'terms']));
  const blocked = await writeBooking(U.req, booking('BKG-PRV-1'));
  record('沒同意就不能建立預約（403 CONSENT_REQUIRED），也沒有寫入', blocked.status === 403 && blocked.error.code === 'CONSENT_REQUIRED' && !(await row('bookings', 'BKG-PRV-1')), outcome(blocked));
  const amendOld = await writeBooking(U.req, { ...(await row('bookings', 'BKG-PRV-0')).data, pickupTime: '10:00' });
  record('既有預約的修改不受影響', amendOld.status === 200, outcome(amendOld));
  const wrongVersion = await consent(U.req, { action: 'accept', document: 'terms', version: '2025-01' });
  record('同意舊版本被拒', wrongVersion.status === 400, outcome(wrongVersion));
  await consent(U.req, { action: 'accept', document: 'privacy_notice', version: '2026-10' });
  const accepted = await consent(U.req, { action: 'accept', document: 'terms', version: '2026-10' });
  record('同意兩份目前版本後沒有待同意項目', accepted.status === 200 && accepted.data.missing.length === 0, outcome(accepted));
  const recs = (await admin.query('select document, version, accepted_at, user_agent from consent_records where user_id = $1 order by document', [U.req])).rows;
  record('同意紀錄保存文件、版本、時間', recs.length === 2 && recs.every((r) => r.version === '2026-10' && r.accepted_at && r.user_agent === 'synthetic-test'));
  const audit = (await admin.query(`select count(*)::int n from audit_events where event_type = 'consent.accepted' and actor_user_id = $1`, [U.req])).rows[0].n;
  record('每次同意都寫稽核紀錄', audit === 2, `n=${audit}`);
  const allowed = await writeBooking(U.req, booking('BKG-PRV-1'));
  record('同意後可以建立預約', allowed.status === 200, outcome(allowed));
  await settings(U.root, { action: 'set_documents', documents: docs('2026-10', '2027-01') });
  const status2 = await consent(U.req, { action: 'status' });
  const blockedAgain = await writeBooking(U.req, booking('BKG-PRV-2'));
  record('服務條款改版後要求重新同意（只有改版的那份）', JSON.stringify(status2.data.missing) === JSON.stringify(['terms'])
    && blockedAgain.status === 403, outcome(blockedAgain));
  await consent(U.req, { action: 'accept', document: 'terms', version: '2027-01' });
  record('重新同意後又可以建立預約', (await writeBooking(U.req, booking('BKG-PRV-2'))).status === 200);
  const peek = await db.withUser(U.req2, (c) => c.query('select * from consent_records')).then((r) => r.rowCount, (e) => e.code);
  record('其他使用者讀不到別人的同意紀錄', peek === 0, String(peek));
  const forge = await db.withUser(U.req2, (c) => c.query(`insert into consent_records (id, user_id, document, version) values ('C-X', $1, 'terms', '2027-01')`, [U.req2]))
    .then(() => 'allowed', (e) => e.code);
  record('[資料庫層] 不能直接寫同意紀錄', forge === '42501', forge);

  console.log('--- 保存期限設定 ---');
  const def = await settings(U.root, { action: 'get' });
  record('保存期限預設 5 年', def.status === 200 && def.data.retentionYears === 5, outcome(def));
  const bad = await settings(U.root, { action: 'set_retention', years: 0 });
  record('保存期限不合法被拒（0 年）', bad.status === 400, outcome(bad));
  const reqSet = await settings(U.req, { action: 'set_retention', years: 1 });
  record('非平台管理者不能改保存期限', reqSet.status === 403, outcome(reqSet));
  const set3 = await settings(U.root, { action: 'set_retention', years: 3 });
  record('平台管理者把保存期限改成 3 年', set3.status === 200 && set3.data.retentionYears === 3, outcome(set3));

  console.log('--- 到期資料匿名化 ---');
  // 一筆 2015 年的預約與行程（已過期），一筆 2099 年的預約（未到期）
  await writeBooking(U.req, booking('BKG-PRV-OLD', { pickupDate: '2015-03-01' }));
  const oldBefore = (await row('bookings', 'BKG-PRV-OLD')).data;
  const trip = F.makeTrip({ id: 'TRP-PRV-OLD', organizationId: 'ORG-REQ-001', driverId: null, vehicleId: null, bookingId: 'BKG-PRV-OLD',
    startAt: '2015-03-01T01:00:00.000Z', extra: { status: 'completed', locationSamples: [{ lat: 25.01, lng: 121.46 }],
      serviceProofs: [{ id: 'P1', status: 'active', receiverName: '合成收受人', photo: { objectKey: 'k' }, stepId: 'x' }] } });
  await admin.query(`insert into app_state (collection, id, data) values ('trips', 'TRP-PRV-OLD', $1::jsonb)`, [JSON.stringify(trip)]);
  const reqRun = await db.withUser(U.req, (c) => c.query('select * from app.anonymize_expired_records()')).then(() => 'allowed', (e) => e.code);
  record('一般使用者不能執行匿名化', reqRun === '42501', reqRun);
  const res = await scheduled.handler({});
  const body = JSON.parse(res.body);
  record('每日排程執行成功', res.statusCode === 200 && body.anonymized.bookings === 1 && body.anonymized.trips === 1, res.body);
  const oldAfter = (await row('bookings', 'BKG-PRV-OLD')).data;
  record('到期預約：姓名、電話、完整地址、自由文字清除', oldAfter.name === null && oldAfter.phone === null
    && oldAfter.pickupAddress === '新北市板橋區' && oldAfter.destination === '臺北市中正區' && !('specialNeed' in oldAfter)
    && !JSON.stringify(oldAfter).includes('188號') && !JSON.stringify(oldAfter).includes('0911222333'), oldAfter.pickupAddress);
  record('到期預約：座標與模糊地址移除，保留行政區', !('lat' in oldAfter.serverComputed.pickup) && !('fuzzyAddress' in oldAfter.serverComputed.pickup)
    && oldAfter.serverComputed.pickup.district === '新北市板橋區');
  record('到期預約：日期、距離、車程、補助估算保留', oldAfter.pickupDate === '2015-03-01'
    && oldAfter.serverComputed.distanceMeters === oldBefore.serverComputed.distanceMeters
    && oldAfter.serverComputed.durationSeconds === oldBefore.serverComputed.durationSeconds
    && JSON.stringify(oldAfter.serverComputed.benefit) === JSON.stringify(oldBefore.serverComputed.benefit) && Boolean(oldAfter.anonymizedAt));
  const tripAfter = (await row('trips', 'TRP-PRV-OLD')).data;
  record('到期行程：乘客姓名、電話、地址、定位軌跡、服務證明收受人與照片清除', !('locationSamples' in tripAfter)
    && tripAfter.passengers.every((p) => p.name === '' && p.phone === '') && tripAfter.serviceProofs[0].receiverName === null
    && !('photo' in tripAfter.serviceProofs[0]) && tripAfter.date === '2015-03-01' && tripAfter.status === 'completed');
  const fresh = (await row('bookings', 'BKG-PRV-1')).data;
  record('未到期資料不受影響', fresh.name === '合成王小明' && fresh.phone === '0911222333' && !fresh.anonymizedAt);
  const auditRows = (await admin.query(`select entity_type, entity_id, details from audit_events where event_type = 'retention.anonymized' order by entity_type`)).rows;
  record('每筆匿名化都寫稽核紀錄（含保存期限）', auditRows.length === 2 && auditRows.every((a) => a.details.retentionYears === 3),
    JSON.stringify(auditRows.map((a) => a.entity_id)));
  const again = await settings(U.root, { action: 'run_retention' });
  record('平台管理者手動執行：已匿名化的不會重複處理', again.status === 200 && again.data.anonymized.bookings === 0 && again.data.anonymized.trips === 0, outcome(again));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
