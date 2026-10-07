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
const fx = require('./_auth-fixture');
const F = require('../../tests/_trip-fixtures');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_privacy_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const consentFn = require('../../netlify/functions/v2-consent');
const settingsFn = require('../../netlify/functions/v2-platform-settings');
const bookingWriteFn = require('../../netlify/functions/v2-booking-write');
const loadFn = require('../../netlify/functions/v2-state-load');
const scheduled = require('../../netlify/functions/retention-anonymize');
const deletionFn = require('../../netlify/functions/v2-account-deletion');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const cancelFn = require('../../netlify/functions/v2-cancel-booking');
const supabaseAuth = require('../../netlify/functions/_supabase-auth');

const U = { root: 'USR-PRV-ROOT', req: 'USR-PRV-REQ', req2: 'USR-PRV-REQ2', req3: 'USR-PRV-REQ3' };

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
      ('${U.req2}','合成需求者二','+886977000002','none',true),
      ('${U.req3}','合成需求者三','+886977000003','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-PRV-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-PRV-REQ2','${U.req2}','ORG-REQ-001','requester','active'),
      ('M-PRV-REQ3','${U.req3}','ORG-REQ-001','requester','active');
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
  // 服務對象（#80）：OLD 只有過期的預約；MIX 有過期的也有未到期的預約
  const recipient = (id) => ({ collection: 'careRecipients', id, record: { id, status: 'active',
    identity: { displayName: `合成長輩${id}`, birthDate: '1940-05-01', gender: 'female' },
    contacts: { primaryPhone: '0955666777', emergencyContacts: [{ name: '合成緊急聯絡人', phone: '0955000111' }] },
    addresses: { primary: '新北市板橋區文化路一段188號', entries: [{ id: 'a1', address: '新北市板橋區文化路一段188號' }] },
    mobility: { wheelchairType: 'manual', walkingAbility: 'assisted', defaultAidNeed: '手動輪椅', defaultSpecialNeeds: '合成需求文字：怕冷' },
    servicePreferences: { notes: '合成備註：女兒會陪同', defaultPickupAddress: '新北市板橋區文化路一段188號' } } });
  const relation = (id, rid) => ({ collection: 'careRecipientRelations', id,
    record: { id, userId: U.req, recipientId: rid, relationship: 'family', canBook: true, canManageProfile: true, status: 'active' } });
  await call(mutateFn.handler, 'POST', U.req, { changes: [recipient('CR-PRV-OLD'), relation('CRR-PRV-OLD', 'CR-PRV-OLD'),
    recipient('CR-PRV-MIX'), relation('CRR-PRV-MIX', 'CR-PRV-MIX')] });
  await writeBooking(U.req, booking('BKG-PRV-OLD', { pickupDate: '2015-03-01', recipientId: 'CR-PRV-OLD',
    legs: [{ id: 'BKG-PRV-OLD_outbound', sequence: 1, direction: 'outbound', label: '去程', status: 'pending',
      requestedPickupAt: '2015-03-01T01:00:00.000Z', pickupAddress: '新北市板橋區文化路一段188號', destination: '臺北市中正區公園路20號',
      // 前端 makeLocationSnapshot 的形狀
      pickup: { addressText: '新北市板橋區文化路一段188號', city: '新北市', district: '板橋區', road: '文化路一段',
        accessNote: '合成：巷口上車', placeId: 'PLACE-X', lat: 25.0123, lng: 121.4567 },
      dropoff: { addressText: '臺北市中正區公園路20號', city: '', district: '', lat: 25.0401, lng: 121.5167 } }] }));
  // 通知內容與補助試算（#89）
  await admin.query(`insert into notifications (id, booking_id, recipient_user_id, template, payload, message_summary, status)
    values ('NTF-PRV-OLD', 'BKG-PRV-OLD', $1, 'booking_cancelled', $2::jsonb, '合成摘要：188號', 'sent')`,
    [U.req, JSON.stringify({ bookingId: 'BKG-PRV-OLD', reason: '合成原因：住 188號', pickupDate: '2015-03-01' })]);
  await admin.query(`insert into notifications (id, trip_id, recipient_user_id, template, payload, status)
    values ('NTF-PRV-TRIP', 'TRP-PRV-OLD', $1, 'trip_assigned', $2::jsonb, 'sent')`, [U.req, JSON.stringify({ tripId: 'TRP-PRV-OLD', note: '合成：188號' })]);
  await admin.query(`insert into benefit_assessments (id, care_recipient_id, cms_level, identity_category, facts, data)
    values ('BA-PRV-OLD', 'CR-PRV-OLD', '4', 'low_income', '{"cmsLevel": 4, "residenceCity": "新北市"}', '{"facts": {"cmsLevel": 4}}')`);
  await writeBooking(U.req, booking('BKG-PRV-OLD2', { pickupDate: '2015-04-01', recipientId: 'CR-PRV-MIX' }));
  await writeBooking(U.req, booking('BKG-PRV-MIXF', { pickupDate: '2099-04-01', recipientId: 'CR-PRV-MIX' }));
  // 預約修改紀錄：快照裡有修改前的姓名、電話、完整地址與自由文字
  const revision = (id, bookingId) => admin.query(
    `insert into app_state (collection, id, booking_id, data) values ('bookingRevisions', $1, $2, $3::jsonb)`,
    [id, bookingId, JSON.stringify({ id, bookingId, revisionNo: 1, reasonText: '合成修改原因：改到女兒家 188號', changedFields: ['pickupAddress'],
      snapshot: { editable: { name: '合成王小明', phone: '0911222333', pickupAddress: '新北市板橋區文化路一段188號', specialNeed: '合成自由文字' },
        locations: { pickup: { address: '新北市板橋區文化路一段188號', lat: 25.01, lng: 121.46 } }, serviceNeeds: { specialNeed: '合成自由文字' },
        state: 'open', bookingVersion: 1 } })]);
  await revision('BREV-PRV-OLD', 'BKG-PRV-OLD');
  await revision('BREV-PRV-FRESH', 'BKG-PRV-1');
  // 事件紀錄：修改前後的值、metadata 都可能有個資
  const event = (collection, id, links, data) => admin.query(
    `insert into app_state (collection, id, trip_id, booking_id, data) values ($1, $2, $3, $4, $5::jsonb)`,
    [collection, id, links.tripId || null, links.bookingId || null, JSON.stringify({ id, ...data })]);
  await event('bookingEvents', 'BEVT-PRV-OLD', { bookingId: 'BKG-PRV-OLD' }, { bookingId: 'BKG-PRV-OLD', eventType: 'amended',
    reasonText: '合成原因：改到 188號', metadata: { attemptedPickupAddress: '新北市板橋區文化路一段188號' } });
  await event('tripEvents', 'TEVT-PRV-OLD', { tripId: 'TRP-PRV-OLD' }, { tripId: 'TRP-PRV-OLD', eventType: 'proof_service_captured',
    metadata: { receiverName: '合成收受人' } });
  await event('careRecipientEvents', 'CREVT-PRV-OLD', {}, { recipientId: 'CR-PRV-OLD', eventType: 'updated', detail: '更新服務對象主檔',
    changes: [{ field: '手機', from: '0955666777', to: '0955666778' }] });
  // 從沒預約過的服務對象：建立超過保存期限才匿名化
  const zero = recipient('CR-PRV-ZERO').record;
  await admin.query(`insert into app_state (collection, id, owner_user_id, data, created_at) values ('careRecipients', 'CR-PRV-ZERO', $1, $2::jsonb, '2015-01-01')`,
    [U.req, JSON.stringify(zero)]);
  await call(mutateFn.handler, 'POST', U.req, { changes: [recipient('CR-PRV-NEWZERO')] });
  const oldBefore = (await row('bookings', 'BKG-PRV-OLD')).data;
  const trip = F.makeTrip({ id: 'TRP-PRV-OLD', organizationId: 'ORG-REQ-001', driverId: null, vehicleId: null, bookingId: 'BKG-PRV-OLD',
    startAt: '2015-03-01T01:00:00.000Z', extra: { status: 'completed', locationSamples: [{ lat: 25.01, lng: 121.46 }],
      serviceProofs: [{ id: 'P1', status: 'active', receiverName: '合成收受人', photo: { objectKey: 'k' }, stepId: 'x',
        note: '合成服務證明備註：交給鄰居', supersededReason: '合成更正原因：簽錯人' }],
      mutationReceipts: [{ key: 'proof_service:TRP-PRV-OLD:x:合成收受人:r1' }],
      pickupLocation: { address: '新北市板橋區文化路一段188號', lat: 25.01, lng: 121.46 },
      executionSnapshots: [{ id: 'SNAP1', needsSummary: '合成需求摘要', route: { pickupAddress: '新北市板橋區文化路一段188號' },
        resources: { driver: { id: 'DRV-X', userId: 'USR-X', name: '合成司機姓名', phone: '0988777666', status: 'on_duty' },
          vehicle: { id: 'VEH-X', plate: 'ABC-1234' } },
        passengers: [{ name: '合成乘客快照', phone: '0911222333',
          careRecipient: { displayName: '合成長輩快照', primaryPhone: '0955666777' },
          leg: { pickup: { address: '新北市板橋區文化路一段188號', lat: 25.01 } },
          locations: { pickup: { address: '新北市板橋區文化路一段188號' } } }] }] } });
  await admin.query(`insert into app_state (collection, id, data) values ('trips', 'TRP-PRV-OLD', $1::jsonb)`, [JSON.stringify(trip)]);
  const reqRun = await db.withUser(U.req, (c) => c.query('select * from app.anonymize_expired_records()')).then(() => 'allowed', (e) => e.code);
  record('一般使用者不能執行匿名化', reqRun === '42501', reqRun);
  const res = await scheduled.handler({});
  const body = JSON.parse(res.body);
  record('每日排程執行成功', res.statusCode === 200 && body.anonymized.bookings === 2 && body.anonymized.trips === 1
    && body.anonymized.bookingRevisions === 1 && body.anonymized.careRecipients === 2, res.body);
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
  record('到期行程：服務證明的自由文字、操作收據的收受人、地點座標、執行快照的乘客個資與路線清除',
    !JSON.stringify(tripAfter).includes('合成服務證明備註') && !JSON.stringify(tripAfter).includes('合成更正原因')
      && !JSON.stringify(tripAfter).includes('合成收受人') && !JSON.stringify(tripAfter).includes('121.46')
      && !JSON.stringify(tripAfter).includes('合成需求摘要')
      && !JSON.stringify(tripAfter).includes('合成乘客快照') && !JSON.stringify(tripAfter).includes('合成長輩快照')
      && !JSON.stringify(tripAfter).includes('0955666777') && !JSON.stringify(tripAfter).includes('188號')
      && tripAfter.serviceProofs[0].status === 'active' && tripAfter.executionSnapshots.length === 1, JSON.stringify(tripAfter.serviceProofs[0]));
  const revAfter = (await row('bookingRevisions', 'BREV-PRV-OLD')).data;
  record('到期預約的修改紀錄：快照的姓名、電話、地址、自由文字與修改原因清除，保留版本與修改欄位',
    !JSON.stringify(revAfter).includes('188號') && !JSON.stringify(revAfter).includes('0911222333')
      && !JSON.stringify(revAfter).includes('合成王小明') && !JSON.stringify(revAfter).includes('合成自由文字')
      && !JSON.stringify(revAfter).includes('合成修改原因') && revAfter.revisionNo === 1
      && JSON.stringify(revAfter.changedFields) === '["pickupAddress"]' && Boolean(revAfter.anonymizedAt), JSON.stringify(revAfter));
  record('未到期預約的修改紀錄不受影響', JSON.stringify((await row('bookingRevisions', 'BREV-PRV-FRESH')).data).includes('188號'));
  const crOld = (await row('careRecipients', 'CR-PRV-OLD')).data;
  record('所有預約都過期的服務對象：姓名、電話、地址、生日、需求文字清除，保留行政區與統計欄位',
    !JSON.stringify(crOld).includes('188號') && !JSON.stringify(crOld).includes('0955') && !JSON.stringify(crOld).includes('合成長輩')
      && !JSON.stringify(crOld).includes('1940-05-01') && !JSON.stringify(crOld).includes('合成需求文字')
      && !JSON.stringify(crOld).includes('合成備註') && !JSON.stringify(crOld).includes('合成緊急聯絡人')
      && crOld.addresses.district === '新北市板橋區' && crOld.identity.gender === 'female'
      && crOld.mobility.wheelchairType === 'manual' && crOld.status === 'active' && Boolean(crOld.anonymizedAt), JSON.stringify(crOld));
  record('從沒預約、建立超過保存期限的服務對象匿名化；剛建立的不動',
    !JSON.stringify((await row('careRecipients', 'CR-PRV-ZERO')).data).includes('0955666777')
      && (await row('careRecipients', 'CR-PRV-NEWZERO')).data.contacts.primaryPhone === '0955666777');
  const evAfter = await Promise.all([['bookingEvents', 'BEVT-PRV-OLD'], ['tripEvents', 'TEVT-PRV-OLD'], ['careRecipientEvents', 'CREVT-PRV-OLD']]
    .map(async ([c, i]) => (await row(c, i)).data));
  record('匿名化的預約、行程、服務對象的事件紀錄：metadata、修改前後的值、原因清除，保留事件類型',
    evAfter.every((e) => Boolean(e.anonymizedAt) && e.eventType) && !JSON.stringify(evAfter).includes('188號')
      && !JSON.stringify(evAfter).includes('合成收受人') && !JSON.stringify(evAfter).includes('0955666'), JSON.stringify(evAfter));
  const crMix = (await row('careRecipients', 'CR-PRV-MIX')).data;
  record('還有未到期預約的服務對象不被匿名化（它過期的那筆預約照常匿名化）',
    crMix.identity.displayName === '合成長輩CR-PRV-MIX' && crMix.contacts.primaryPhone === '0955666777' && !crMix.anonymizedAt
      && (await row('bookings', 'BKG-PRV-OLD2')).data.name === null && (await row('bookings', 'BKG-PRV-MIXF')).data.name === '合成王小明');
  const oldLeg = oldAfter.legs[0];
  record('到期預約的去程／回程地點只留行政區（#89）', !JSON.stringify(oldAfter.legs).includes('188號')
    && !JSON.stringify(oldAfter.legs).includes('25.0123') && !JSON.stringify(oldAfter.legs).includes('巷口')
    && !JSON.stringify(oldAfter.legs).includes('PLACE-X') && !JSON.stringify(oldAfter.legs).includes('文化路')
    && JSON.stringify(oldLeg.pickup) === JSON.stringify({ city: '新北市', district: '板橋區' })
    && JSON.stringify(oldLeg.dropoff) === JSON.stringify({ district: '台北市中正區' }) && oldLeg.status === 'pending', JSON.stringify(oldAfter.legs));
  const oldNtf = (await admin.query(`select payload, message_summary from notifications where id = 'NTF-PRV-OLD'`)).rows[0];
  record('到期預約的通知內容清除，只留關聯 ID（#89）', !JSON.stringify(oldNtf).includes('188號') && oldNtf.payload.bookingId === 'BKG-PRV-OLD'
    && !('reason' in oldNtf.payload) && oldNtf.message_summary === null, JSON.stringify(oldNtf));
  const tripNtf = (await admin.query(`select payload from notifications where id = 'NTF-PRV-TRIP'`)).rows[0];
  record('到期行程的通知（沒有預約 ID 的）內容也清除（#89）', JSON.stringify(tripNtf.payload) === JSON.stringify({ tripId: 'TRP-PRV-OLD' }), JSON.stringify(tripNtf));
  const ba = (await admin.query(`select cms_level, identity_category, facts, data from benefit_assessments where id = 'BA-PRV-OLD'`)).rows[0];
  record('匿名化的服務對象：補助試算的事實資料、長照等級、身分別清除（#89）', ba.cms_level === null && ba.identity_category === null
    && JSON.stringify(ba.facts) === '{}' && !('facts' in ba.data), JSON.stringify(ba));
  const snapRes = (await row('trips', 'TRP-PRV-OLD')).data.executionSnapshots[0].resources;
  record('到期行程執行快照的司機只留 ID 與狀態（#89）', !JSON.stringify(snapRes).includes('合成司機姓名')
    && !JSON.stringify(snapRes).includes('0988777666') && snapRes.driver.id === 'DRV-X' && snapRes.vehicle.plate === 'ABC-1234', JSON.stringify(snapRes));
  const fresh = (await row('bookings', 'BKG-PRV-1')).data;
  record('未到期資料不受影響', fresh.name === '合成王小明' && fresh.phone === '0911222333' && !fresh.anonymizedAt);
  const auditRows = (await admin.query(`select entity_type, entity_id, details from audit_events where event_type = 'retention.anonymized' order by entity_type`)).rows;
  record('每筆匿名化都寫稽核紀錄（含保存期限）：2 筆預約、1 趟行程、1 筆修改紀錄、2 位服務對象',
    auditRows.length === 6 && auditRows.every((a) => a.details.retentionYears === 3)
      && JSON.stringify(auditRows.map((a) => a.entity_type).sort()) === JSON.stringify(['booking', 'booking', 'booking_revision', 'care_recipient', 'care_recipient', 'trip']),
    JSON.stringify(auditRows.map((a) => `${a.entity_type}:${a.entity_id}`)));
  const again = await settings(U.root, { action: 'run_retention' });
  record('平台管理者手動執行：已匿名化的不會重複處理', again.status === 200 && again.data.anonymized.bookings === 0 && again.data.anonymized.trips === 0
    && again.data.anonymized.bookingRevisions === 0 && again.data.anonymized.careRecipients === 0, outcome(again));

  console.log('--- 刪除帳號與個資申請 ---');
  const del = (userId, body) => call(deletionFn.handler, 'POST', userId, body);
  for (const [doc, ver] of [['privacy_notice', '2026-10'], ['terms', '2027-01']]) await consent(U.req2, { action: 'accept', document: doc, version: ver });
  await call(mutateFn.handler, 'POST', U.req2, { changes: [{ collection: 'careRecipients', id: 'CR-DEL-1',
    record: { id: 'CR-DEL-1', identity: { displayName: '合成被刪除長輩' }, contacts: { primaryPhone: '0933000111' } } },
  // 預約端點要求需求者對服務對象有可預約的關係（#78）
  { collection: 'careRecipientRelations', id: 'CRR-DEL-1',
    record: { id: 'CRR-DEL-1', userId: U.req2, recipientId: 'CR-DEL-1', relationship: 'self', canBook: true, status: 'active' } }] });
  await writeBooking(U.req2, booking('BKG-DEL-F', { requestedByUserId: U.req2, recipientId: 'CR-DEL-1', name: '合成刪除者', phone: '0933000111' }));
  await writeBooking(U.req2, booking('BKG-DEL-P', { requestedByUserId: U.req2, recipientId: 'CR-DEL-1', name: '合成刪除者', phone: '0933000111', pickupDate: '2025-05-01' }));
  await revision('BREV-DEL-P', 'BKG-DEL-P');
  const delTrip = F.makeTrip({ id: 'TRP-DEL-P', organizationId: 'ORG-REQ-001', driverId: null, vehicleId: null, bookingId: 'BKG-DEL-P',
    startAt: '2025-05-01T01:00:00.000Z', extra: { status: 'completed',
      serviceProofs: [{ id: 'PD1', status: 'active', receiverName: '合成刪除者', stepId: 'x', note: '合成刪除者的證明備註' }] } });
  await admin.query(`insert into app_state (collection, id, booking_id, data) values ('trips', 'TRP-DEL-P', 'BKG-DEL-P', $1::jsonb)`, [JSON.stringify(delTrip)]);
  await admin.query(`insert into notifications (id, booking_id, recipient_user_id, template, payload, status)
    values ('NTF-DEL-P', 'BKG-DEL-P', $1, 'trip_cancelled', $2::jsonb, 'sent')`, [U.req3, JSON.stringify({ bookingId: 'BKG-DEL-P', reason: '合成刪除者的原因' })]);
  await event('tripEvents', 'TEVT-DEL-P', { tripId: 'TRP-DEL-P' }, { tripId: 'TRP-DEL-P', eventType: 'proof_service_captured', metadata: { receiverName: '合成刪除者' } });
  await event('careRecipientEvents', 'CREVT-DEL-1', {}, { recipientId: 'CR-DEL-1', eventType: 'updated', changes: [{ field: '手機', from: '0933000111', to: '0933000112' }] });
  const rootReq = await del(U.root, { action: 'request' });
  record('平台管理者不能經申請刪除自己', rootReq.status === 400, outcome(rootReq));
  const r1 = await del(U.req2, { action: 'request', reason: '不再使用' });
  const REQ = r1.data && r1.data.id;
  record('使用者提出刪除申請（pending）', r1.status === 200 && r1.data.status === 'pending', outcome(r1));
  const dupReq = await del(U.req2, { action: 'request' });
  record('同時只能有一件處理中的申請', dupReq.status === 400, outcome(dupReq));
  const otherView = (await call(loadFn.handler, 'GET', U.req)).data.collections.deletionRequests || [];
  const ownView = (await call(loadFn.handler, 'GET', U.req2)).data.collections.deletionRequests || [];
  record('本人看得到自己的申請，其他使用者看不到', ownView.some((d) => d.id === REQ) && !otherView.some((d) => d.id === REQ));
  const reqApprove = await del(U.req, { action: 'approve', id: REQ });
  record('非平台管理者不能核准', reqApprove.status === 403, outcome(reqApprove));
  const blockedApprove = await del(U.root, { action: 'approve', id: REQ });
  record('還有未結束的預約時不能核准', blockedApprove.status === 400 && /未結束的預約/.test(blockedApprove.error.message), outcome(blockedApprove));
  await call(cancelFn.handler, 'POST', U.req2, { bookingId: 'BKG-DEL-F', reasonCode: 'requester_no_longer_needed' });
  const rejectNoNote = await del(U.root, { action: 'reject', id: REQ, note: '' });
  record('駁回必須填寫原因', rejectNoNote.status === 400, outcome(rejectNoNote));

  // Auth 刪除失敗：整筆回滾，申請維持 pending
  const provider = supabaseAuth.getProvider();
  const realDelete = provider.deleteUser;
  provider.deleteUser = async () => { throw Object.assign(new Error('合成：Auth 服務暫停'), { code: 'AUTH_PROVIDER_UNAVAILABLE' }); };
  const failed = await del(U.root, { action: 'approve', id: REQ });
  provider.deleteUser = realDelete;
  const stillPending = (await admin.query('select status from deletion_requests where id = $1', [REQ])).rows[0].status;
  const stillActive = (await admin.query('select active, phone_e164 from users where id = $1', [U.req2])).rows[0];
  record('登入帳號刪除失敗時整筆回滾：申請仍處理中、帳號與資料未變', failed.status >= 500 && stillPending === 'pending'
    && stillActive.active === true && stillActive.phone_e164 === '+886977000002'
    && (await row('bookings', 'BKG-DEL-P')).data.name === '合成刪除者', outcome(failed));

  const approved = await del(U.root, { action: 'approve', id: REQ, note: '合成核准' });
  record('平台管理者核准並執行（completed）', approved.status === 200 && approved.data.status === 'completed'
    && approved.data.summary.bookings === 2 && approved.data.summary.careRecipients === 1, outcome(approved));
  record('Supabase Auth 帳號被刪除', fx.calls.some((c) => c[0] === 'deleteUser' && c[1] === U.req2));
  const delBooking = (await row('bookings', 'BKG-DEL-P')).data;
  record('該使用者的預約匿名化', delBooking.name === null && delBooking.phone === null && delBooking.pickupAddress === '新北市板橋區'
    && delBooking.pickupDate === '2025-05-01' && Boolean(delBooking.anonymizedAt));
  const delRev = (await row('bookingRevisions', 'BREV-DEL-P')).data;
  record('核准刪除：這位使用者預約的修改紀錄快照清除', !JSON.stringify(delRev).includes('188號') && !JSON.stringify(delRev).includes('合成王小明')
    && Boolean(delRev.anonymizedAt) && approved.data.summary.bookingRevisions === 1, JSON.stringify(approved.data && approved.data.summary));
  const delTripAfter = (await row('trips', 'TRP-DEL-P')).data;
  record('核准刪除：這位使用者預約的服務證明簽收人與備註清除', delTripAfter.serviceProofs[0].receiverName === null
    && !JSON.stringify(delTripAfter).includes('合成刪除者的證明備註'), JSON.stringify(delTripAfter.serviceProofs[0]));
  const delNtf = (await admin.query(`select payload from notifications where id = 'NTF-DEL-P'`)).rows[0];
  record('核准刪除：這位使用者預約的通知（寄給其他人的）內容清除（#89）', delNtf && !JSON.stringify(delNtf).includes('合成刪除者')
    && delNtf.payload.bookingId === 'BKG-DEL-P', JSON.stringify(delNtf));
  const delEvents = [(await row('tripEvents', 'TEVT-DEL-P')).data, (await row('careRecipientEvents', 'CREVT-DEL-1')).data];
  record('核准刪除：行程與服務對象的事件紀錄清除', !JSON.stringify(delEvents).includes('合成刪除者') && !JSON.stringify(delEvents).includes('0933000111'),
    JSON.stringify(delEvents));
  const perRow = (await admin.query(`select entity_type from audit_events where event_type = 'account.deletion_anonymized' and details->>'deletionRequestId' = $1`, [REQ])).rows
    .map((a) => a.entity_type).sort();
  record('核准刪除：預約、修改紀錄、行程、服務對象每一筆都寫稽核紀錄',
    JSON.stringify(perRow) === JSON.stringify(['booking', 'booking', 'booking_revision', 'care_recipient', 'trip']), JSON.stringify(perRow));
  const cr = (await admin.query(`select deleted, data from app_state where collection = 'careRecipients' and id = 'CR-DEL-1'`)).rows[0];
  record('服務對象清除內容並標記刪除', cr.deleted === true && !JSON.stringify(cr.data).includes('0933000111'));
  const u = (await admin.query('select active, display_name, phone_e164, email from users where id = $1', [U.req2])).rows[0];
  record('帳號停用並清除姓名、電話、Email', u.active === false && u.display_name === '（已刪除帳號）' && u.phone_e164 === null && u.email === null);
  const mem = (await admin.query('select status from memberships where user_id = $1', [U.req2])).rows;
  record('成員資格撤銷', mem.length > 0 && mem.every((m) => m.status === 'revoked'));
  const ntf = (await admin.query('select count(*)::int n from notifications where recipient_user_id = $1', [U.req2])).rows[0].n;
  record('寄給他的通知刪除', ntf === 0, `n=${ntf}`);
  const keptConsent = (await admin.query('select count(*)::int n from consent_records where user_id = $1', [U.req2])).rows[0].n;
  record('同意紀錄保留（法遵證明）', keptConsent === 2, `n=${keptConsent}`);
  const delAudit = (await admin.query(`select details from audit_events where event_type = 'account.deletion_completed' and entity_id = $1`, [REQ])).rows;
  record('刪除寫入稽核紀錄（含筆數）', delAudit.length === 1 && delAudit[0].details.bookings === 2 && delAudit[0].details.userId === U.req2);
  const afterLoad = await call(loadFn.handler, 'GET', U.req2);
  record('刪除後原本的登入立即失效', afterLoad.status === 401, outcome(afterLoad));
  const reapprove = await del(U.root, { action: 'approve', id: REQ });
  record('已完成的申請不能再處理', reapprove.status === 400, outcome(reapprove));
  const r3 = await del(U.req3, { action: 'request' });
  const rej = await del(U.root, { action: 'reject', id: r3.data.id, note: '合成：需先結清' });
  const rejRow = (await admin.query('select status, review_note from deletion_requests where id = $1', [r3.data.id])).rows[0];
  record('駁回並記錄原因', rej.status === 200 && rejRow.status === 'rejected' && rejRow.review_note === '合成：需先結清', outcome(rej));
  const r3b = await del(U.req3, { action: 'request' });
  const cancelled = await del(U.req3, { action: 'cancel', id: r3b.data.id });
  record('使用者可以撤回處理中的申請', cancelled.status === 200 && (await admin.query('select status from deletion_requests where id = $1', [r3b.data.id])).rows[0].status === 'cancelled', outcome(cancelled));
  const forgeDel = await call(mutateFn.handler, 'POST', U.req3, { changes: [{ collection: 'deletionRequests', id: 'X', record: { id: 'X', status: 'completed' } }] });
  record('刪除申請不能經一般寫入端點寫', forgeDel.status === 403, outcome(forgeDel));

  const failedResults = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failedResults.length} 通過 / ${failedResults.length} 失敗`);
  process.exitCode = failedResults.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
