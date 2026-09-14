'use strict';
/**
 * 「新資料庫 + 舊程式」相容性。
 *
 * 部署順序是先套 migration、再部署程式，所以中間有一段時間線上跑的是舊版
 * netlify/functions（與舊版前端的請求形狀）配上已經套用 0008 的資料庫。
 *
 * 做法：用舊版的 handler（COMPAT_FUNCTIONS_DIR，由 run-compat-old-code.sh 從
 * origin/main 取出）對兩個資料庫各跑一次同一組操作：
 *   careride_compat_old  只有 0001–0007
 *   careride_compat_new       0001–0008
 *   careride_compat_rollback  0001–0008 → 移除 0008 並重新套用 0007
 * 把每一步的結果寫成 JSON，最後比對。old × new 只允許列出的預期差異；
 * old × rollback 必須完全相同。
 *
 *   node compat-old-code.test.js                    執行（PGDATABASE、COMPAT_FUNCTIONS_DIR、COMPAT_RESULT_FILE）
 *   node compat-old-code.test.js --compare a.json b.json
 *
 * 全部是合成資料；只允許本機隔離端點與固定測試庫名稱。
 */
const fs = require('node:fs');
const path = require('node:path');

// 0008 帶來、而且是刻意的行為差異
const EXPECTED_DIFFERENCES = {
  'driver-load-sees-own-trip': '0008 新增司機讀取政策：被指派司機讀得到自己的行程（舊庫讀不到）'
};

if (process.argv[2] === '--compare') {
  // --expect-identical：回復 0008 之後，舊程式的結果必須與從未套用時完全相同
  const exact = process.argv.includes('--expect-identical');
  const [a, b] = process.argv.slice(3).filter((x) => !x.startsWith('--')).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  let bad = 0;
  console.log(`比對 ${a.database} × ${b.database}${exact ? '（必須完全相同）' : ''}　舊程式：${a.functionsDir}`);
  const names = [...new Set([...Object.keys(a.steps), ...Object.keys(b.steps)])];
  for (const name of names) {
    const same = JSON.stringify(a.steps[name]) === JSON.stringify(b.steps[name]);
    const expected = !exact && Object.prototype.hasOwnProperty.call(EXPECTED_DIFFERENCES, name);
    const serverError = [a.steps[name], b.steps[name]].some((s) => s && s.status >= 500);
    const ok = !serverError && (same ? !expected : expected);
    if (!ok) bad++;
    const note = same ? (expected ? '（預期應有差異，但兩邊相同）' : '') : `（${expected ? `預期差異：${EXPECTED_DIFFERENCES[name]}` : '非預期差異'}）`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}  舊=${JSON.stringify(a.steps[name])}  新=${JSON.stringify(b.steps[name])} ${note}`);
  }
  console.log(`結果：${names.length - bad} 通過 / ${bad} 失敗`);
  process.exit(bad ? 1 : 0);
}

const host = process.env.PGHOST;
const dbName = process.env.PGDATABASE;
if (!['localhost', '127.0.0.1'].includes(host) || !['careride_compat_old', 'careride_compat_new', 'careride_compat_rollback'].includes(dbName)) {
  throw Error('Requires local endpoint and careride_compat_old/new/rollback database');
}
const functionsDir = path.resolve(process.env.COMPAT_FUNCTIONS_DIR || '');
const resultFile = process.env.COMPAT_RESULT_FILE;
if (!fs.existsSync(path.join(functionsDir, 'v2-state-load.js')) || !resultFile) {
  throw Error('COMPAT_FUNCTIONS_DIR must point to an old netlify/functions directory and COMPAT_RESULT_FILE must be set');
}
process.env.DATABASE_URL = `postgresql://care_ride_app@${host}:${process.env.PGPORT}/${dbName}?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-compat-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-compat-0123456789';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';

const { Pool } = require('pg');
const admin = new Pool({ host, port: Number(process.env.PGPORT), database: dbName, user: 'postgres' });
const oldFn = (name) => require(path.join(functionsDir, name));
const db = oldFn('_db');
const auth = oldFn('_auth-pg');
const load = oldFn('v2-state-load');
const mutate = oldFn('v2-state-mutate');

async function call(handler, method, token, body) {
  const res = await handler({ httpMethod: method, headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = {}; }
  return { status: res.statusCode, code: parsed.error ? parsed.error.code : null, data: parsed.data };
}
const ids = (r, c) => ((r.data && r.data.collections && r.data.collections[c]) || []).map((x) => x.id);

(async () => {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values
      ('ORG-CMP-A','transport_provider','合成承運 A',true), ('ORG-CMP-B','transport_provider','合成承運 B',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('USR-CMP-REQ','合成需求者','+886944000001','none',true), ('USR-CMP-DSP','合成調度 A','+886944000002','none',true),
      ('USR-CMP-DSPB','合成調度 B','+886944000003','none',true), ('USR-CMP-DRV','合成司機','+886944000004','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-CMP-REQ','USR-CMP-REQ','ORG-REQ-001','requester','active'), ('M-CMP-DSP','USR-CMP-DSP','ORG-CMP-A','dispatcher','active'),
      ('M-CMP-DSPB','USR-CMP-DSPB','ORG-CMP-B','dispatcher','active'), ('M-CMP-DRV','USR-CMP-DRV','ORG-CMP-A','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values ('DRV-CMP','USR-CMP-DRV','ORG-CMP-A','on_duty',true);
  `);
  const tok = {};
  for (const [k, uid] of Object.entries({ req: 'USR-CMP-REQ', dsp: 'USR-CMP-DSP', dspB: 'USR-CMP-DSPB', drv: 'USR-CMP-DRV' })) {
    tok[k] = await db.withoutUser((c) => auth.issueSessionToken(c, uid));
  }
  const booking = (id, extra = {}) => ({ id, state: 'open', claimStatus: 'open', status: 'open', requestedByUserId: 'USR-CMP-REQ',
    pickupDate: '2099-02-01', pickupTime: '10:00', pickupAddress: '新北市板橋區文化路一段188號', destination: '台北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: false, ...extra });
  const steps = {};

  const created = await call(mutate.handler, 'POST', tok.req, { changes: [
    { collection: 'bookings', id: 'BKG-CMP-1', record: booking('BKG-CMP-1') },
    { collection: 'bookings', id: 'BKG-CMP-2', record: booking('BKG-CMP-2') }] });
  steps['requester-create-bookings'] = { status: created.status, code: created.code };

  const dspLoad = await call(load.handler, 'GET', tok.dsp);
  const poolRow = ((dspLoad.data && dspLoad.data.pool) || []).find((x) => x.id === 'BKG-CMP-1');
  steps['dispatcher-load'] = { status: dspLoad.status, poolHasBooking: Boolean(poolRow),
    poolColumns: poolRow ? Object.keys(poolRow).sort() : null, pickupArea: poolRow ? poolRow.pickup_area : null };

  const oldClaim = await call(mutate.handler, 'POST', tok.dsp, { changes: [
    { collection: 'bookings', id: 'BKG-CMP-1', record: booking('BKG-CMP-1', { state: 'claimed', organizationId: 'ORG-CMP-A' }) }] });
  steps['dispatcher-claim-via-state-mutate'] = { status: oldClaim.status, code: oldClaim.code };

  const trip = { id: 'TRP-CMP-1', organizationId: 'ORG-CMP-A', driverId: 'DRV-CMP', vehicleId: 'VEH-CMP', status: 'scheduled',
    steps: [{ id: 'TRP-CMP-1_depart', type: 'depart', status: 'pending' }], pickupAddress: '台北市信義區松仁路1號' };
  const tripCreate = await call(mutate.handler, 'POST', tok.dsp, { changes: [{ collection: 'trips', id: 'TRP-CMP-1', record: trip }] });
  steps['dispatcher-create-trip'] = { status: tripCreate.status, code: tripCreate.code };

  const drvLoad = await call(load.handler, 'GET', tok.drv);
  steps['driver-load'] = { status: drvLoad.status };
  steps['driver-load-sees-own-trip'] = { sees: ids(drvLoad, 'trips').includes('TRP-CMP-1') };

  const drvWrite = await call(mutate.handler, 'POST', tok.drv, { changes: [
    { collection: 'trips', id: 'TRP-CMP-1', expectedRevision: 1, record: { ...trip, status: 'in_progress' } }] });
  steps['driver-write-via-state-mutate'] = { status: drvWrite.status, code: drvWrite.code };

  const dspBLoad = await call(load.handler, 'GET', tok.dspB);
  steps['other-org-dispatcher-load'] = { status: dspBLoad.status, seesTrip: ids(dspBLoad, 'trips').includes('TRP-CMP-1'),
    leaksAddress: JSON.stringify(dspBLoad.data && dspBLoad.data.collections || {}).includes('188號') };

  const reqCancelOpen = await call(mutate.handler, 'POST', tok.req, { changes: [
    { collection: 'bookings', id: 'BKG-CMP-2', record: booking('BKG-CMP-2', { state: 'cancelled', status: 'cancelled' }) }] });
  steps['requester-cancel-open-booking-via-state-mutate'] = { status: reqCancelOpen.status, code: reqCancelOpen.code };

  // 舊版前端的通知（例如派車、中斷）經 state-mutate 寫入，0008 之後照舊可寫；
  // 收件司機不論有沒有 0008 都讀不到（0008 只放行後端建立的通知）。
  const oldNotification = await call(mutate.handler, 'POST', tok.dsp, { changes: [
    { collection: 'notifications', id: 'NTF-CMP-1', record: { id: 'NTF-CMP-1', organizationId: 'ORG-CMP-A', recipientId: 'USR-CMP-DRV',
      channel: 'line', template: 'trip_interrupted', eventType: 'trip_interrupted', payload: { tripId: 'TRP-CMP-1' }, status: 'queued' } }] });
  steps['dispatcher-notification-via-state-mutate'] = { status: oldNotification.status, code: oldNotification.code };
  const drvAfterNotification = await call(load.handler, 'GET', tok.drv);
  steps['driver-reads-notification-written-by-dispatcher'] = { sees: ids(drvAfterNotification, 'notifications').includes('NTF-CMP-1') };

  const reqLoad = await call(load.handler, 'GET', tok.req);
  steps['requester-load'] = { status: reqLoad.status, bookings: ids(reqLoad, 'bookings').sort(), pool: (reqLoad.data && reqLoad.data.pool || []).length };

  const oldFunction = await admin.query(`select count(*)::int as n from pg_proc where proname = 'claim_app_state_booking'`);
  steps['claim-function-still-present'] = { present: oldFunction.rows[0].n === 1 };

  fs.writeFileSync(resultFile, JSON.stringify({ database: dbName, functionsDir, steps }, null, 2));
  console.log(`已寫入 ${resultFile}`);
  for (const [k, v] of Object.entries(steps)) console.log(`  ${k}: ${JSON.stringify(v)}`);
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.getPool().end(); await admin.end(); });
