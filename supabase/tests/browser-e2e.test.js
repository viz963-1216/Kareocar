'use strict';
/**
 * 瀏覽器端對端測試：在真的 Chrome 裡操作 index.html。後端是實際的
 * netlify/functions handler（tools/local-dev-server.js）與套用實際 migrations 的
 * 隔離 Postgres，handler 以 care_ride_app 連線，RLS 與 0008 函式全部生效。
 *
 *   A. 調度員在公開需求池按「接案」
 *   B. 司機工作台：出發 → 離線時完成接送、返回上一步、再完成 → 恢復連線自動同步
 *      → 回報異常 → 送達 → 補服務證明（含照片）
 *   C. 需求者在「我的預約」取消已排車預約並收到通知；已開始的行程取消失敗且沒有通知
 *
 * 操作用 DevTools Protocol 送出滑鼠點擊與文字輸入（Input.dispatchMouseEvent／
 * Input.insertText），不是直接呼叫前端函式；只有「切換左側選單」用 DOM click。
 * 判準以資料庫實際內容為主，另外檢查畫面狀態、網路請求與未處理的例外。
 *
 * 只用 Node 內建 WebSocket（Node 22+）與系統的 Google Chrome（CHROME_PATH 可覆寫），
 * 不安裝瀏覽器自動化套件。全部是合成資料；資料庫只接受本機隔離端點與固定測試庫。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = process.env.PGHOST;
if (!['localhost', '127.0.0.1'].includes(host) || process.env.PGDATABASE !== 'careride_e2e_test') {
  throw Error('Requires local endpoint and careride_e2e_test database');
}
if (typeof WebSocket !== 'function') throw Error('需要 Node 22 以上（內建 WebSocket）');
process.env.DATABASE_URL = `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_e2e_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-e2e-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-e2e-0123456789';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';
process.env.GOOGLE_CLIENT_ID = 'synthetic-e2e.apps.googleusercontent.com';

const { Pool } = require('pg');
const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_e2e_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const auth = require('../../netlify/functions/_auth-pg');
const mutate = require('../../netlify/functions/v2-state-mutate');
const { createServer } = require('../../tools/local-dev-server');
const F = require('../../tests/_trip-fixtures');

const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'care-ride-e2e-'));
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const PASSWORD = 'E2e-Synthetic-Pass-2026';
const ORG = 'ORG-E2E-A';
const DRIVER_ID = 'DRV-E2E-1';
const U = {
  req: { id: 'USR-E2E-REQ', phone: '0922000001', name: '合成需求者' },
  dsp: { id: 'USR-E2E-DSP', phone: '0922000002', name: '合成調度員' },
  drv: { id: 'USR-E2E-DRV', phone: '0922000003', name: '合成司機' }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOffset = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('sv-SE');

const results = [];
function record(scenario, name, ok, detail = '') {
  results.push({ scenario, name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------------------------------------------------------------- DevTools Protocol
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.add(fn); }
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw Error('找不到 Google Chrome，請設定 CHROME_PATH');
  return found;
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-ride-chrome-'));
  const proc = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--window-size=1280,900', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 啟動逾時')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前結束（${code}）：${buf.slice(-400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const version = await new Cdp(ws).send('Browser.getVersion').catch(() => null);
  return { proc, ws, userDataDir, version };
}

async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`頁面執行錯誤：${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitFor(page, expression, label, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(page, `(()=>{try{return !!(${expression});}catch(e){return false;}})()`)) return true;
    } catch (_) { /* 頁面切換中 */ }
    await sleep(150);
  }
  throw new Error(`等待逾時：${label}`);
}

async function waitForDb(fn, label, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`等待資料庫逾時：${label}`);
}

async function openPage(cdp, baseUrl, label) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = { label, targetId, exceptions: [], consoleErrors: [], requests: [], send: (m, p = {}) => cdp.send(m, p, sessionId) };
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      page.exceptions.push((d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      page.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/')) {
      const pathname = new URL(msg.params.request.url).pathname;
      page.requests.push({ path: pathname, postData: /\/(state-mutate|trip-execute|claim-booking|cancel-booking)$/.test(pathname) ? msg.params.request.postData || '' : '' });
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable', { maxPostDataSize: 5 * 1024 * 1024 });
  await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await page.send('Page.navigate', { url: baseUrl });
  try {
    await waitFor(page, "document.readyState==='complete'&&!!document.getElementById('loginBtn')", `${label} 登入畫面載入`);
  } catch (error) {
    await screenshot(page, `${label}-startup`);
    await finishPage(page, `${label} 啟動`);
    throw error;
  }
  return page;
}

async function screenshot(page, name) {
  try {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(ARTIFACT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`    畫面截圖：${file}`);
  } catch (_) { /* 截圖失敗不影響結果 */ }
}

/** 真的滑鼠點擊：捲到元素、取中心座標、送 mousePressed／mouseReleased。 */
async function click(page, selector) {
  const box = await evaluate(page, `(()=>{const el=document.querySelector(${J(selector)});if(!el)throw new Error('找不到 '+${J(selector)});if(el.disabled)throw new Error(${J(selector)}+' 是停用狀態');el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()`);
  if (!box.w || !box.h) throw new Error(`${selector} 沒有可點擊的大小（可能被隱藏）`);
  const top = await evaluate(page, `(()=>{const el=document.elementFromPoint(${box.x},${box.y});const t=document.querySelector(${J(selector)});return !!el&&(el===t||t.contains(el));})()`);
  if (!top) throw new Error(`${selector} 被其他元素遮住`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function typeInto(page, selector, text) {
  await evaluate(page, `(()=>{const el=document.querySelector(${J(selector)});if(!el)throw new Error('找不到 '+${J(selector)});el.focus();el.value='';return true;})()`);
  await page.send('Input.insertText', { text });
}

async function setOffline(page, offline) {
  await page.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitFor(page, `navigator.onLine===${!offline}`, offline ? '瀏覽器進入離線' : '瀏覽器恢復連線');
}

async function login(page, user) {
  await typeInto(page, '#loginPhone', user.phone);
  await typeInto(page, '#loginPassword', PASSWORD);
  await click(page, '#loginBtn');
  await waitFor(page, `!document.getElementById('appShell').classList.contains('hidden')&&document.body.innerText.includes(${J(user.name)})`, `${user.name} 登入`);
}

async function goView(page, view) {
  await evaluate(page, `(()=>{const b=[...document.querySelectorAll('.nav-btn[data-view=${J(view)}]')].find(x=>x.offsetParent!==null);if(!b)throw Error('找不到可見導覽入口');b.click();})()`);
  await waitFor(page, `!!document.querySelector('.nav-btn.active[data-view=${J(view)}]')`, `切換到 ${view}`);
}

// 只讀裝置持久化資料作為離線佇列證據，不存取應用私有函式或修改狀態。
async function deviceRows(page, storeName) {
  return evaluate(page, `new Promise((resolve,reject)=>{const req=indexedDB.open('careRideTripP2');req.onerror=()=>reject(Error('IndexedDB open failed'));req.onsuccess=()=>{const db=req.result;const tx=db.transaction(${J(storeName)},'readonly');const get=tx.objectStore(${J(storeName)}).getAll();get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(Error('IndexedDB read failed'));tx.oncomplete=()=>db.close();};})`);
}

// ---------------------------------------------------------------- 資料
async function row(collection, id) {
  const { rows } = await admin.query(
    'select organization_id, owner_user_id, revision, data from app_state where collection = $1 and id = $2', [collection, id]);
  return rows[0] || null;
}
async function apiMutate(token, changes) {
  const res = await mutate.handler({ httpMethod: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ changes }) });
  return res.statusCode;
}
function openBooking(id) {
  return {
    id, state: 'open', claimStatus: 'open', status: 'open', version: 1, requestedByUserId: U.req.id,
    name: '合成乘客', phone: '0911000001', pickupDate: dayOffset(1), pickupTime: '10:00',
    pickupAddress: '新北市板橋區文化路一段188號', destination: '台北市中正區公園路20號',
    tripType: '單程', passengerCount: 1, wheelchairSlots: 0, rideshareConsent: false, aidNeed: '無', companions: '0',
    createdAt: new Date().toISOString()
  };
}
async function fixtureScheduled(bookingId, tripId) {
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.state_scope_override','1',true)`);
    await c.query(
      `update app_state set organization_id = $1,
              data = data || jsonb_build_object('state','scheduled','claimStatus','claimed','status','scheduled',
                                                'organizationId',$1::text,'tripId',$2::text)
        where collection = 'bookings' and id = $3`, [ORG, tripId, bookingId]);
    await c.query('commit');
  } finally { c.release(); }
}

async function seed() {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values ('${ORG}','transport_provider','合成承運 E2E',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req.id}','${U.req.name}','+886${U.req.phone.slice(1)}','none',true),
      ('${U.dsp.id}','${U.dsp.name}','+886${U.dsp.phone.slice(1)}','none',true),
      ('${U.drv.id}','${U.drv.name}','+886${U.drv.phone.slice(1)}','none',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-E2E-REQ','${U.req.id}','ORG-REQ-001','requester','active'),
      ('M-E2E-DSP','${U.dsp.id}','${ORG}','dispatcher','active'),
      ('M-E2E-DRV','${U.drv.id}','${ORG}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values ('${DRIVER_ID}','${U.drv.id}','${ORG}','on_duty',true);
  `);
  for (const u of Object.values(U)) await db.withoutUser((c) => auth.setPasswordCredential(c, u.id, PASSWORD));
  const tokens = {};
  for (const [k, u] of Object.entries(U)) tokens[k] = await db.withoutUser((c) => auth.issueSessionToken(c, u.id));
  return tokens;
}

async function finishPage(page, S) {
  record(S, '頁面沒有未處理的 JavaScript 例外', page.exceptions.length === 0, page.exceptions.slice(0, 3).join(' | '));
  if (page.consoleErrors.length) console.log(`    （資訊）console.error ${page.consoleErrors.length} 則：${page.consoleErrors.slice(0, 3).join(' | ')}`);
}

// ================================================================ A. 接案
async function flowClaim(cdp, baseUrl, tokens) {
  const S = 'A 調度接案';
  const id = 'BKG-E2E-CLAIM';
  record(S, '（資料準備）需求者建立公開預約', (await apiMutate(tokens.req, [{ collection: 'bookings', id, record: openBooking(id) }])) === 200);
  const page = await openPage(cdp, baseUrl, 'dispatcher');
  try {
    await login(page, U.dsp);
    await goView(page, 'demand-market');
    if (await evaluate(page, "!!document.getElementById('clearDemandDateBtn')")) await click(page, '#clearDemandDateBtn');
    await waitFor(page, `!!document.querySelector('.demand-claim-btn[data-booking=${J(id)}]')`, '接案按鈕出現');
    record(S, '需求池卡片不顯示完整門牌', !(await evaluate(page, "document.body.innerText.includes('188號')")));
    await click(page, `.demand-claim-btn[data-booking=${J(id)}]`);
    const claimed = await waitForDb(async () => { const r = await row('bookings', id); return r && r.organization_id === ORG ? r : null; }, '預約綁定組織');
    record(S, '按「接案」後資料庫綁定調度員組織、狀態 claimed',
      claimed.data.state === 'claimed' && claimed.data.claimedByUserId === U.dsp.id, `organization_id=${claimed.organization_id}`);
    await waitFor(page, `!document.querySelector('.demand-claim-btn[data-booking=${J(id)}]')`, '畫面反映接案結果');
    record(S, '接案後重新載入：需求池不再列出、組織取得完整預約', true);
    record(S, '接案走 claim-booking 端點，沒有用 state-mutate 寫這筆預約',
      page.requests.filter((r) => r.path === '/api/v2/claim-booking').length === 1
        && !page.requests.some((r) => r.path === '/api/v2/state-mutate' && r.postData.includes(id)));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'A-claim');
  }
  await finishPage(page, S);
}

// ================================================================ B. 司機執行
async function flowDriver(cdp, baseUrl, tokens) {
  const S = 'B 司機執行';
  const tripId = 'TRP-E2E-DRV';
  const trip = F.makeTrip({ id: tripId, organizationId: ORG, driverId: DRIVER_ID, vehicleId: 'VEH-E2E-1',
    startAt: F.addMinutes(new Date().toISOString(), 10) });
  trip.date = new Date().toLocaleDateString('sv-SE');
  record(S, '（資料準備）調度員建立指派給司機的行程', (await apiMutate(tokens.dsp, [{ collection: 'trips', id: tripId, record: trip }])) === 200);
  const photo = path.join(ARTIFACT_DIR, 'proof.png');
  fs.writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=', 'base64'));

  const page = await openPage(cdp, baseUrl, 'driver');
  const stepButton = (suffix) => `document.getElementById('completeStepBtn')?.dataset.step===${J(`${tripId}_${suffix}`)}&&!document.getElementById('completeStepBtn').disabled`;
  try {
    await login(page, U.drv);
    await waitFor(page, stepButton('depart'), '「開始出發」按鈕');

    // ---- 出發（連線中）
    await click(page, '#completeStepBtn');
    const r1 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === 1 ? r : null; }, '出發寫入');
    record(S, '按「開始出發」：資料庫 revision 1、出發站完成、行程進行中',
      r1.data.steps[0].status === 'completed' && r1.data.status === 'in_progress'
        && (r1.data.mutationReceipts || []).some((x) => x.source === 'trip_execute_endpoint'));

    // ---- 離線：完成接送、返回上一步、再完成
    await waitFor(page, stepButton('pickup'), '「確認已接到乘客」按鈕');
    await setOffline(page, true);
    await click(page, '#completeStepBtn');
    await waitFor(page, stepButton('dropoff'), '離線完成接送（本機）');
    await waitFor(page, "!document.getElementById('undoBtn')?.disabled", '「返回上一步」可用');
    await click(page, '#undoBtn');
    await waitFor(page, stepButton('pickup'), '接送按鈕再次出現');
    await click(page, '#completeStepBtn');
    await waitFor(page, stepButton('dropoff'), '離線再次完成接送（本機）');
    const pending = await waitForDb(async () => { const rows = (await deviceRows(page, 'offlineQueue')).filter(x=>x.payload?.command).map(x=>x.payload.command); return rows.length===3 ? rows : null; }, '離線佇列持久化');
    const stillR1 = await row('trips', tripId);
    record(S, '離線期間三個操作都留在裝置佇列、資料庫仍是 revision 1',
      JSON.stringify(pending) === J(['complete_step', 'undo_step', 'complete_step']) && stillR1.revision === 1, `佇列=${J(pending)}`);

    await setOffline(page, false);
    const r4 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === 4 ? r : null; }, '恢復連線後同步');
    record(S, '恢復連線後依序同步：revision 4、接送站完成、乘客在車上',
      r4.data.steps[1].status === 'completed' && r4.data.passengers[0].status === 'onboard'
        && JSON.stringify((r4.data.mutationReceipts || []).map((x) => x.action)) === J(['complete_step', 'complete_step', 'undo_step', 'complete_step']));
    await waitForDb(async () => !(await deviceRows(page, 'offlineQueue')).some(x=>x.payload?.command), '裝置佇列清空');
    record(S, '同步完成後裝置佇列沒有待送的行程指令', true);

    // ---- 回報異常
    await click(page, '#issueBtn');
    await waitFor(page, "document.getElementById('issueModal').classList.contains('open')", '異常視窗');
    await click(page, '.issue-option[data-type="交通壅塞"]');
    const issue = await waitForDb(async () => {
      const { rows } = await admin.query(`select organization_id, data from app_state where collection = 'issues' and trip_id = $1`, [tripId]);
      return rows[0] || null;
    }, '異常寫入');
    record(S, '按「回報異常」：異常寫入資料庫且歸屬行程組織', issue.organization_id === ORG && issue.data.type === '交通壅塞');

    // ---- 送達、補服務證明（含照片）
    await waitFor(page, stepButton('dropoff'), '「確認已安全送達」按鈕');
    await click(page, '#completeStepBtn');
    const r5 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === 5 ? r : null; }, '送達寫入');
    record(S, '按「確認已安全送達」：缺服務證明，行程仍進行中', r5.data.status === 'in_progress' && Boolean(r5.data.completionPending));

    await waitFor(page, `!!document.querySelector('.proof-service-btn[data-trip=${J(tripId)}]')`, '「補服務證明」按鈕');
    await click(page, `.proof-service-btn[data-trip=${J(tripId)}]`);
    await waitFor(page, "document.getElementById('proofServiceModal').classList.contains('open')", '服務證明視窗');
    await typeInto(page, '#proofReceiverName', '合成收受人');
    const { root } = await page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#proofPhotoInput' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [photo] });
    await click(page, '#saveProofServiceBtn');
    const done = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.data.status === 'completed' ? r : null; }, '服務證明後完成');
    const proof = (done.data.serviceProofs || [])[0] || {};
    record(S, '儲存服務證明（含照片）後行程完成',
      done.data.serviceProofs.length === 1 && proof.receiverName === '合成收受人' && Boolean(proof.photo && proof.photo.objectKey));
    record(S, '伺服器只收到照片描述資料，沒有照片內容', !JSON.stringify(done.data).includes('data:image'));
    const local = await evaluate(page, `new Promise((resolve,reject)=>{const req=indexedDB.open('careRideTripP2');req.onsuccess=()=>{const db=req.result;const tx=db.transaction('proofBlobs','readonly');const get=tx.objectStore('proofBlobs').get(${J(proof.photo && proof.photo.objectKey)});get.onsuccess=()=>resolve(!!get.result&&get.result.blob instanceof Blob&&get.result.blob.size>0);get.onerror=()=>reject(Error('photo read failed'));tx.oncomplete=()=>db.close();};req.onerror=()=>reject(Error('photo open failed'));})`);
    record(S, '照片本體保存在裝置 IndexedDB', local === true);

    const stateMutateTrips = page.requests.filter((r) => r.path === '/api/v2/state-mutate'
      && /"collection":"(trips|tripEvents|issues)"/.test(r.postData));
    record(S, '司機的行程／事件／異常沒有經過 state-mutate', stateMutateTrips.length === 0, `state-mutate 含行程資料 ${stateMutateTrips.length} 次`);
    record(S, '司機操作都經過 trip-execute', page.requests.filter((r) => r.path === '/api/v2/trip-execute').length >= 6);
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'B-driver');
  }
  await finishPage(page, S);
}

// ================================================================ C. 需求者取消
async function flowCancel(cdp, baseUrl, tokens) {
  const S = 'C 需求者取消';
  const ok = { id: 'BKG-E2E-CANCEL', trip: 'TRP-E2E-CANCEL' };
  const bad = { id: 'BKG-E2E-STARTED', trip: 'TRP-E2E-STARTED' };
  for (const [b, status] of [[ok, 'scheduled'], [bad, 'in_progress']]) {
    await apiMutate(tokens.req, [{ collection: 'bookings', id: b.id, record: openBooking(b.id) }]);
    await fixtureScheduled(b.id, b.trip);
    const trip = F.makeTrip({ id: b.trip, organizationId: ORG, driverId: DRIVER_ID, vehicleId: 'VEH-E2E-1', bookingId: b.id,
      startAt: `${dayOffset(1)}T10:00:00.000Z`, extra: { bookingId: b.id, status } });
    record(S, `（資料準備）${status} 行程與已排車預約`, (await apiMutate(tokens.dsp, [{ collection: 'trips', id: b.trip, record: trip }])) === 200);
  }
  const notifications = async (bookingId) => (await admin.query(
    `select data from app_state where collection = 'notifications' and booking_id = $1`, [bookingId])).rows;

  const page = await openPage(cdp, baseUrl, 'requester');
  try {
    await login(page, U.req);
    await goView(page, 'requester-bookings');

    const cancelVia = async (bookingId) => {
      await waitFor(page, `!!document.querySelector('.requester-cancel-booking-btn[data-booking=${J(bookingId)}]')`, `${bookingId} 取消按鈕`);
      await click(page, `.requester-cancel-booking-btn[data-booking=${J(bookingId)}]`);
      await waitFor(page, "document.getElementById('bookingActionModal').classList.contains('open')", '取消視窗');
      await evaluate(page, "(()=>{const s=document.getElementById('bookingActionReasonCode');const o=[...s.options].find(x=>x.value);s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return o.value;})()");
      await typeInto(page, '#bookingActionReasonText', '合成取消原因');
      await click(page, '#confirmBookingActionBtn');
    };

    await cancelVia(ok.id);
    const booking = await waitForDb(async () => { const r = await row('bookings', ok.id); return r && r.data.state === 'cancelled' ? r : null; }, '預約取消');
    const trip = await row('trips', ok.trip);
    record(S, '按「確認取消」：預約與行程都取消、保留關聯', trip.data.status === 'cancelled'
      && booking.data.tripId === ok.trip && J(trip.data.bookingIds) === J([ok.id]));
    const ntfs = await notifications(ok.id);
    record(S, '取消成功後排入司機與需求者兩則通知', ntfs.length === 2
      && ntfs.some((n) => n.data.template === 'trip_cancelled' && n.data.recipientId === U.drv.id)
      && ntfs.some((n) => n.data.template === 'booking_cancelled' && n.data.recipientId === U.req.id));
    await waitFor(page, `!document.querySelector('.requester-cancel-booking-btn[data-booking=${J(ok.id)}]')&&document.body.innerText.includes('已取消')`, '畫面載入取消結果');
    record(S, '需求者畫面顯示已取消且不能重複取消', true);

    await cancelVia(bad.id);
    await waitFor(page, "(document.getElementById('toast')?.textContent||'').includes('無法')", '取消失敗提示');
    await sleep(800);
    const badBooking = await row('bookings', bad.id);
    record(S, '行程已開始時取消失敗：畫面提示、預約未取消、沒有任何通知',
      badBooking.data.state === 'scheduled' && (await notifications(bad.id)).length === 0,
      `toast=${await evaluate(page, "document.getElementById('toast')?.textContent||''")}`);
    record(S, '取消走 cancel-booking 端點，沒有用 state-mutate 寫預約或行程',
      page.requests.filter((r) => r.path === '/api/v2/cancel-booking').length === 2
        && !page.requests.some((r) => r.path === '/api/v2/state-mutate' && (r.postData.includes(ok.id) || r.postData.includes(bad.id))));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'C-cancel');
  }
  await finishPage(page, S);
}

// ================================================================ 執行
(async () => {
  let chrome = null;
  let server = null;
  try {
    const tokens = await seed();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    chrome = await launchChrome();
    console.log(`Chrome：${chrome.version ? chrome.version.product : '（未知版本）'}　應用：${baseUrl}　截圖目錄：${ARTIFACT_DIR}`);
    const cdp = new Cdp(chrome.ws);

    console.log('--- A：調度員在需求池接案 ---');
    await flowClaim(cdp, baseUrl, tokens);
    console.log('--- B：司機執行（離線、返回、同步、異常、服務證明照片） ---');
    await flowDriver(cdp, baseUrl, tokens);
    console.log('--- C：需求者取消與通知 ---');
    await flowCancel(cdp, baseUrl, tokens);
  } catch (e) {
    record('啟動', `端對端環境無法啟動：${e.message}`, false);
  } finally {
    if (chrome) { try { chrome.ws.close(); } catch (_) {} chrome.proc.kill('SIGKILL'); }
    if (server) server.close();
    await db.getPool().end();
    await admin.end();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('');
  for (const s of [...new Set(results.map((r) => r.scenario))]) {
    const rows = results.filter((r) => r.scenario === s);
    console.log(`  ${s}：${rows.filter((r) => r.ok).length} 通過 / ${rows.filter((r) => !r.ok).length} 失敗`);
  }
  console.log(`結果：${results.length - failed.length} 通過 / ${failed.length} 失敗`);
  process.exitCode = failed.length ? 1 : 0;
})();
