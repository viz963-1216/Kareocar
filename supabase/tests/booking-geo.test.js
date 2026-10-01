'use strict';
/**
 * 預約的伺服器計算欄位（#21）整合測試。
 *
 * 經過實際的 handler（state-mutate、state-load、geocode-check、organization-apply/review），
 * handler 以 care_ride_app 連線，RLS 與 0004 的需求池 view 全部生效。地址定位與路線用
 * _auth-fixture 的假實作（不連 Google），fx.geoCalls 記錄呼叫次數。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const { Pool } = require('pg');

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_geo_test') {
  throw Error('Requires dedicated local endpoint and careride_geo_test database');
}
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_geo_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_geo_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-geo-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-geo-0123456789';
const fx = require('./_auth-fixture');

const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_geo_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const applyFn = require('../../netlify/functions/v2-organization-apply');
const reviewFn = require('../../netlify/functions/v2-organization-review');
const loadFn = require('../../netlify/functions/v2-state-load');
const mutateFn = require('../../netlify/functions/v2-state-mutate');
const checkFn = require('../../netlify/functions/v2-geocode-check');

const U = { root: 'USR-GEO-ROOT', req: 'USR-GEO-REQ', op: 'USR-GEO-OP' };
const PICKUP = '新北市板橋區文化路一段188號';
const DEST = '臺北市中正區公園路20號';

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
const mutate = (userId, changes) => call(mutateFn.handler, 'POST', userId, { changes });
const putBooking = (userId, b) => mutate(userId, [{ collection: 'bookings', id: b.id, record: b }]);
const stored = async (id) => {
  const row = (await admin.query(`select data from app_state where collection = 'bookings' and id = $1`, [id])).rows[0];
  return row ? row.data : null;
};
const geocodeCount = () => fx.geoCalls.filter((c) => c[0] === 'geocode').length;

function booking(id, extra = {}) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1,
    requestedByUserId: U.req, name: '合成需求者', phone: '0911000001',
    pickupDate: '2099-01-01', pickupTime: '09:00',
    pickupAddress: PICKUP, destination: DEST,
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: true,
    ...extra
  };
}

(async () => {
  await admin.query(`
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.root}','合成平台管理者','+886933000009','super_admin',true),
      ('${U.req}','合成需求者','+886933000001','none',true),
      ('${U.op}','合成業者','+886933000002','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-GEO-REQ','${U.req}','ORG-REQ-001','requester','active'),
      ('M-GEO-OP','${U.op}','ORG-REQ-001','requester','active');
  `);
  const applied = await call(applyFn.handler, 'POST', U.op, { name: '合成交通', orgType: 'transport_provider' });
  const orgId = applied.data && applied.data.organization && applied.data.organization.id;
  const approved = await call(reviewFn.handler, 'POST', U.root, { organizationId: orgId, decision: 'approve' });
  record('（前提）核准一個業者機構', approved.status === 200, outcome(approved));

  console.log('--- 建立預約時由伺服器計算 ---');
  const forged = booking('BKG-GEO-1', {
    serverComputed: { addressHash: 'forged', distanceMeters: 1, pickup: { fuzzyAddress: '偽造' } },
    commercialSnapshots: [{ id: 'SNAP-1', quote: { status: 'quoted', estimatedFare: 99999, currency: 'TWD' } }]
  });
  const created = await putBooking(U.req, forged);
  record('需求者建立預約成功', created.status === 200, outcome(created));
  const s1 = await stored('BKG-GEO-1');
  const sc = s1 && s1.serverComputed;
  record('serverComputed 由伺服器產生（前端偽造的值被覆蓋）',
    sc && sc.addressHash !== 'forged' && sc.distanceMeters > 1 && sc.schemaVersion === 1, sc && sc.addressHash);
  record('模糊地址：行政區＋路段＋門牌去尾',
    sc && sc.pickup.fuzzyAddress === '新北市板橋區文化路一段1xx號附近'
      && sc.destination.fuzzyAddress === '臺北市中正區公園路2x號附近', sc && sc.pickup.fuzzyAddress);
  record('報價是伺服器的待定價，前端給的金額被丟掉',
    sc && sc.quote.status === 'pricing_pending' && sc.quote.estimatedFare === null
      && s1.commercialSnapshots[0].quote.estimatedFare === null && s1.commercialSnapshots[0].quote.status === 'pricing_pending');
  record('前端其他欄位照常保存', s1 && s1.commercialSnapshots[0].id === 'SNAP-1' && s1.name === '合成需求者');

  console.log('--- 修改預約 ---');
  let before = geocodeCount();
  const noAddrChange = await putBooking(U.req, { ...s1, aidNeed: '需要攙扶', version: 2, serverComputed: { addressHash: 'forged-again' } });
  const s1b = await stored('BKG-GEO-1');
  record('沒改地址：不重新定位，沿用原本的 serverComputed',
    noAddrChange.status === 200 && geocodeCount() === before && s1b.serverComputed.addressHash === sc.addressHash,
    `${outcome(noAddrChange)} geocode+${geocodeCount() - before}`);
  before = geocodeCount();
  const addrChange = await putBooking(U.req, { ...s1b, destination: '臺北市大安區信義路三段5號', version: 3 });
  const s1c = await stored('BKG-GEO-1');
  record('改了目的地：重新定位並更新模糊地址',
    addrChange.status === 200 && geocodeCount() - before === 2
      && s1c.serverComputed.destination.fuzzyAddress === '臺北市大安區信義路三段附近'
      && s1c.serverComputed.addressHash !== sc.addressHash,
    `${outcome(addrChange)} ${s1c.serverComputed.destination.fuzzyAddress}`);

  console.log('--- 地址找不到 ---');
  const badDest = await putBooking(U.req, booking('BKG-GEO-2', { destination: '不存在的地方' }));
  record('目的地找不到：400 ADDRESS_NOT_FOUND，並指出欄位',
    badDest.status === 400 && badDest.error.code === 'ADDRESS_NOT_FOUND'
      && JSON.stringify(badDest.error).includes('destination'), outcome(badDest));
  record('找不到地址時什麼都沒寫入', (await stored('BKG-GEO-2')) === null);
  const badBatch = await mutate(U.req, [
    { collection: 'bookings', id: 'BKG-GEO-3', record: booking('BKG-GEO-3') },
    { collection: 'bookings', id: 'BKG-GEO-4', record: booking('BKG-GEO-4', { pickupAddress: 'NOT-FOUND 路' }) }]);
  record('同一批裡有一筆找不到：整批不寫入',
    badBatch.status === 400 && (await stored('BKG-GEO-3')) === null, outcome(badBatch));
  const amendBad = await putBooking(U.req, { ...s1c, pickupAddress: '不存在路1號', version: 4 });
  record('修改成找不到的地址被拒，原資料不變',
    amendBad.status === 400 && (await stored('BKG-GEO-1')).pickupAddress === PICKUP, outcome(amendBad));

  console.log('--- 報價集合不能由前端寫 ---');
  const quoteWrite = await mutate(U.req, [{ collection: 'quoteSnapshots', id: 'Q-1', record: { id: 'Q-1', estimatedFare: 500 } }]);
  record('quoteSnapshots 寫入被拒（COLLECTION_FORBIDDEN）',
    quoteWrite.status === 403 && quoteWrite.error.code === 'COLLECTION_FORBIDDEN', outcome(quoteWrite));

  console.log('--- 需求池只露出模糊資訊 ---');
  const opLoad = await call(loadFn.handler, 'GET', U.op);
  const row = ((opLoad.data && opLoad.data.pool) || []).find((b) => b.id === 'BKG-GEO-1');
  record('核准業者在需求池看得到這筆預約', Boolean(row), outcome(opLoad));
  record('需求池有模糊地址、行政區、距離、車程、報價狀態', row
    && row.pickup_fuzzy_address === '新北市板橋區文化路一段1xx號附近'
    && row.pickup_district === '新北市板橋區'
    && row.destination_fuzzy_address === '臺北市大安區信義路三段附近'
    && Number.isInteger(row.distance_meters) && Number.isInteger(row.duration_seconds)
    && row.quote_status === 'pricing_pending', row && JSON.stringify(row));
  const leak = row ? JSON.stringify(row) : '';
  record('需求池沒有姓名、電話、完整地址、經緯度',
    row && !leak.includes('合成需求者') && !leak.includes('0911000001') && !leak.includes('一段188')
      && !leak.includes('信義路三段5號') && !/lat|lng/i.test(Object.keys(row).join(',')));

  console.log('--- 送出前的地址檢查 ---');
  const check = await call(checkFn.handler, 'POST', U.req, { pickupAddress: PICKUP, destination: DEST });
  record('地址檢查回傳模糊地址與距離',
    check.status === 200 && check.data.pickup.fuzzyAddress === '新北市板橋區文化路一段1xx號附近'
      && check.data.distanceMeters > 0 && check.data.pickup.lat === undefined, outcome(check));
  const checkBad = await call(checkFn.handler, 'POST', U.req, { pickupAddress: '不存在路', destination: DEST });
  record('地址檢查：找不到回 400 並指出 pickupAddress',
    checkBad.status === 400 && JSON.stringify(checkBad.error).includes('pickupAddress'), outcome(checkBad));
  const checkAnon = await call(checkFn.handler, 'POST', null, { pickupAddress: PICKUP, destination: DEST });
  record('沒登入不能用地址檢查', checkAnon.status === 401, outcome(checkAnon));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
