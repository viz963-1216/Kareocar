'use strict';
/**
 * 瀏覽器端對端測試：在真的 Chrome 裡操作 index.html。後端是實際的
 * netlify/functions handler（tools/local-dev-server.js）與套用實際 migrations 的
 * 隔離 Postgres，handler 以 care_ride_app 連線，RLS 與 security definer 函式全部生效。
 *
 *   A. 調度員在公開需求池按「接案」
 *   B. 司機工作台：出發 → 離線時完成接送、返回上一步、再完成 → 恢復連線自動同步
 *      → 回報異常 → 送達 → 補服務證明（含照片）
 *   C. 需求者在「我的預約」取消已排車預約並收到通知；已開始的行程取消失敗且沒有通知
 *   D. 調度員在畫面上從預約建立行程：預約與行程經 schedule-trips 一筆交易寫入
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
// 假的 Supabase Auth 與測試簽章金鑰。本機伺服器與 function 跑在同一個行程，所以登入畫面
// 送出的帳密會由這個替身驗證、function 端以正式的 JWT 驗證程式驗 cookie 裡的 token
const fx = require('./_auth-fixture');
const { selectRow } = require('./_state-tables');

const { Pool } = require('pg');
const admin = new Pool({ host, port: Number(process.env.PGPORT), database: 'careride_e2e_test', user: 'postgres' });
const db = require('../../netlify/functions/_db');
const mutate = require('../../netlify/functions/v2-state-mutate');
const bookingWrite = require('../../netlify/functions/v2-booking-write');
const tripWrite = require('../../netlify/functions/v2-trip-write');
const claimBooking = require('../../netlify/functions/v2-claim-booking');
const benefitRuleset = require('../../netlify/functions/v2-benefit-ruleset');
const { BUNDLED_COPAY } = require('../../netlify/functions/_benefit-fetch');
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
  drv: { id: 'USR-E2E-DRV', phone: '0922000003', name: '合成司機' },
  root: { id: 'USR-E2E-ROOT', phone: '0922000009', name: '合成平台管理者' }
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
  const page = { label, targetId, exceptions: [], consoleErrors: [], cspViolations: [], requests: [], stateLoads: [], send: (m, p = {}) => cdp.send(m, p, sessionId) };
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      page.exceptions.push((d.exception && d.exception.description) || d.text);
    }
    // CSP 違規：瀏覽器把「Refused to execute / load ... Content Security Policy」記在 Log 網域，
    // 不會出現在 console API。跨重新整理累積，所以不會漏掉 reload 前的違規。
    if (msg.method === 'Log.entryAdded' && /Content Security Policy/i.test(msg.params.entry.text || '')) {
      page.cspViolations.push(String(msg.params.entry.text).slice(0, 300));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      page.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Network.loadingFinished' && page.pendingStateLoads && page.pendingStateLoads.has(msg.params.requestId)) {
      page.pendingStateLoads.delete(msg.params.requestId);
      page.stateLoads.push(msg.params.requestId);
    }
    if (msg.method === 'Network.responseReceived' && new URL(msg.params.response.url).pathname === '/api/v2/state-load') {
      (page.pendingStateLoads = page.pendingStateLoads || new Set()).add(msg.params.requestId);
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/')) {
      const pathname = new URL(msg.params.request.url).pathname;
      page.requests.push({ path: pathname, postData: /\/(state-mutate|trip-execute|claim-booking|cancel-booking|booking-write|trip-write|schedule-trips)$/.test(pathname) ? msg.params.request.postData || '' : '' });
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  // 另外以頁面事件收集（每次載入重新掛上），兩種來源取聯集
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source:
    "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push((e.violatedDirective||'')+' '+(e.blockedURI||'inline')));" });
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

/**
 * 真的滑鼠點擊：捲到元素、等畫面穩定、確認座標上最上層就是它，再送滑鼠事件。
 *
 * 兩個時序因素（CI run 34767209152、34795291931 的截圖與訊息）：
 *   - html 設了 scroll-behavior:smooth，scrollIntoView 以動畫捲動
 *   - 登入後背景載入、行程初始化、同步會重新 render，按鈕節點被整個換掉；
 *     拿著舊節點量到的是 0×0 或舊位置
 * 所以每個畫格重新查詢 selector，節點相同且位置連續兩格不變才取座標。
 * 穩定後仍被蓋住就失敗並回報遮擋元素，不改用 DOM click 繞過。
 */
async function click(page, selector) {
  const box = await evaluate(page, `(async()=>{const sel=${J(selector)};const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));let node=null,last=null,stable=0,replaced=0,scrolled=false;for(let i=0;i<240&&stable<2;i++){const el=document.querySelector(sel);if(!el){node=null;stable=0;await frame();continue;}if(node&&el!==node)replaced++;if(el!==node){node=el;scrolled=false;stable=0;}if(!scrolled){el.scrollIntoView({block:'center',inline:'center'});scrolled=true;}await frame();if(!el.isConnected){stable=0;continue;}const r=el.getBoundingClientRect();const k=[r.left,r.top,r.width,r.height].map(v=>Math.round(v)).join(',');stable=(k===last&&r.width>0&&r.height>0)?stable+1:0;last=k;}const el=document.querySelector(sel);if(!el)throw new Error('找不到 '+sel);if(el.disabled)throw new Error(sel+' 是停用狀態');const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,stable:stable>=2,replaced,scrollY:Math.round(scrollY)};})()`);
  if (!box.stable) throw new Error(`${selector} 等待 240 個畫格仍未穩定（節點被替換 ${box.replaced} 次，最後大小 ${Math.round(box.w)}×${Math.round(box.h)}）`);
  const hit = await evaluate(page, `(()=>{const el=document.elementFromPoint(${box.x},${box.y});const t=document.querySelector(${J(selector)});const d=n=>n?(n.tagName.toLowerCase()+(n.id?'#'+n.id:'')+(typeof n.className==='string'&&n.className.trim()?'.'+n.className.trim().split(/\\s+/).join('.'):'')):'（座標在視窗外）';return {ok:!!el&&!!t&&(el===t||t.contains(el)),by:d(el),parent:el&&el.parentElement?d(el.parentElement):''};})()`);
  if (!hit.ok) {
    await screenshot(page, `${page.label}-blocked-${selector.replace(/[^a-z0-9]+/gi, '_')}`);
    throw new Error(`${selector} 被其他元素遮住：${hit.by}（父元素 ${hit.parent}；座標 ${Math.round(box.x)},${Math.round(box.y)}；scrollY=${box.scrollY}；等待期間節點被替換 ${box.replaced} 次）`);
  }
  if (box.replaced) console.log(`    （資訊）${page.label} 點擊 ${selector} 前節點被重新 render 替換 ${box.replaced} 次`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function typeInto(page, selector, text) {
  await evaluate(page, `(()=>{const el=document.querySelector(${J(selector)});if(!el)throw new Error('找不到 '+${J(selector)});el.focus();el.value='';return true;})()`);
  await page.send('Input.insertText', { text });
}

/**
 * 背景同步會重畫整個畫面（輸入框失焦、捲動回到頂端）。表單操作用這兩個：
 * 填完確認值真的在輸入框裡，點擊被捲出畫面就再試。
 */
async function typeConfirmed(page, selector, text) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await typeInto(page, selector, text);
    await sleep(250);
    if (await evaluate(page, `(document.querySelector(${J(selector)})||{}).value===${J(text)}`)) return;
  }
  throw new Error(`${selector} 填不進去`);
}
/** 點了要等到某個結果（例如視窗打開）；背景重畫把按鈕換掉時點擊會落空，沒出現就再點 */
async function clickUntil(page, selector, expression, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickRetry(page, selector);
    try { await waitFor(page, expression, label, 5000); return; } catch (e) { if (attempt >= 3) throw e; }
  }
}
async function clickRetry(page, selector) {
  for (let attempt = 1; ; attempt++) {
    try { await click(page, selector); return; }
    catch (e) { if (attempt >= 3) throw e; await sleep(800); }
  }
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
  // token 只在 HttpOnly cookie：頁面的 JavaScript 讀不到，也沒有存進 Web Storage
  const exposed = await evaluate(page, `(()=>{const hits=[];if(/(^|;\\s*)cr_(at|rt)=/.test(document.cookie))hits.push('document.cookie');
    for(const s of [localStorage,sessionStorage])for(let i=0;i<s.length;i++){const v=String(s.getItem(s.key(i))||'');if(/eyJ[\\w-]+\\.eyJ/.test(v))hits.push(s.key(i));}return hits;})()`);
  record('登入', `${user.name}：頁面 JavaScript 讀不到登入 token`, exposed.length === 0, exposed.join(', '));
}

/** 瀏覽器最近一次成功載入的 state-load 回應內容（瀏覽器實際收到的，不是測試另外呼叫）。 */
async function latestStateLoad(page, afterCount = 0) {
  await waitFor(page, 'true', '等待回應');
  const started = Date.now();
  while (page.stateLoads.length <= afterCount && Date.now() - started < 25000) await sleep(150);
  if (page.stateLoads.length <= afterCount) throw new Error('瀏覽器沒有完成新的 state-load');
  const { body } = await page.send('Network.getResponseBody', { requestId: page.stateLoads[page.stateLoads.length - 1] });
  return JSON.parse(body).data;
}

/** 重新整理頁面：以伺服器 session 恢復登入，不重新輸入帳密。 */
async function reloadAs(page, user) {
  const before = page.stateLoads.length;
  await page.send('Page.reload', { ignoreCache: true });
  await waitFor(page, `!document.getElementById('appShell').classList.contains('hidden')&&document.body.innerText.includes(${J(user.name)})`, `${user.name} 重新整理後恢復登入`);
  return before;
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
  return selectRow(admin, collection, id, ['organization_id', 'owner_user_id', 'revision', 'data']);
}
async function apiMutate(token, changes) {
  // 預約走 booking-write、行程走 trip-write（與前端的分流相同）
  const handler = changes.every((c) => c.collection === 'bookings') ? bookingWrite.handler
    : changes.every((c) => c.collection === 'trips') ? tripWrite.handler : mutate.handler;
  const res = await handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', cookie: `cr_at=${token}` }, body: JSON.stringify({ changes }) });
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
    // 資料庫擁有者的寫入不套用歸屬規則（0031），直接指定承接機構
    await c.query(
      `update bookings set organization_id = $1,
              data = data || jsonb_build_object('state','scheduled','claimStatus','claimed','status','scheduled',
                                                'organizationId',$1::text,'tripId',$2::text)
        where id = $3`, [ORG, tripId, bookingId]);
    await c.query('commit');
  } finally { c.release(); }
}

/**
 * 狀態 fixture：直接寫入一趟含預約的行程。排車只能走 v2-schedule-trips（ADR 0003），
 * 行程端點不再接受新的預約；這裡只準備取消情境的資料。
 */
async function fixtureTrip(trip) {
  const c = await admin.connect();
  try {
    await c.query('begin');
    // 資料庫擁有者的寫入不套用歸屬規則（0031），直接指定機構
    await c.query(`insert into trips (id, organization_id, data, revision) values ($1, $2, $3, 1)`, [trip.id, ORG, JSON.stringify(trip)]);
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

async function seed() {
  await admin.query(`
    insert into organizations (id, org_type, name, active) values ('${ORG}','transport_provider','合成承運 E2E',true);
    insert into users (id, display_name, phone_e164, platform_role, active) values
      ('${U.req.id}','${U.req.name}','+886${U.req.phone.slice(1)}','none',true),
      ('${U.dsp.id}','${U.dsp.name}','+886${U.dsp.phone.slice(1)}','none',true),
      ('${U.drv.id}','${U.drv.name}','+886${U.drv.phone.slice(1)}','none',true),
      ('${U.root.id}','${U.root.name}','+886${U.root.phone.slice(1)}','super_admin',true);
    insert into memberships (id, user_id, organization_id, role, status) values
      ('M-E2E-REQ','${U.req.id}','ORG-REQ-001','requester','active'),
      ('M-E2E-DSP','${U.dsp.id}','${ORG}','dispatcher','active'),
      ('M-E2E-DRV','${U.drv.id}','${ORG}','driver','active');
    insert into drivers (id, user_id, organization_id, duty_status, active) values ('${DRIVER_ID}','${U.drv.id}','${ORG}','on_duty',true);
  `);
  for (const u of Object.values(U)) fx.addUser(u.id, u.phone, PASSWORD);
  const tokens = {};
  for (const [k, u] of Object.entries(U)) tokens[k] = fx.mintAccessToken(u.id, { expInSeconds: 6 * 3600 });
  return tokens;
}

async function finishPage(page, S) {
  await screenshot(page, page.label);
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${page.label}-errors.json`), J({
    exceptions: page.exceptions, consoleErrors: page.consoleErrors, cspViolations: page.cspViolations,
    requests: page.requests.map(({ path }) => ({ path }))
  }));
  record(S, '頁面沒有未處理的 JavaScript 例外', page.exceptions.length === 0, page.exceptions.slice(0, 3).join(' | '));
  let pageViolations = [];
  try { pageViolations = (await evaluate(page, 'window.__cspViolations||[]')) || []; } catch (_) { /* 頁面已關閉時略過 */ }
  const csp = [...page.cspViolations, ...pageViolations];
  record(S, '過程中沒有 CSP 違規', csp.length === 0, csp.slice(0, 3).join(' | '));
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
    {
      let shown = true;
      try { await waitFor(page, "document.body.innerText.includes('文化路一段1xx號附近')", '需求池卡片出現模糊地址', 8000); }
      catch (_) { shown = false; }
      let detail = '';
      if (!shown) {
        const loaded = await latestStateLoad(page, 0).catch((e) => ({ error: e.message }));
        const poolRow = ((loaded && loaded.pool) || []).find((r) => r.id === id);
        const text = await evaluate(page, "(document.querySelector('main')||document.body).innerText.slice(0,600)");
        detail = `stateLoads=${page.stateLoads.length} poolRow=${J(poolRow)} text=${J(text)}`;
      }
      record(S, '需求池卡片顯示伺服器算的模糊地址（路段＋門牌去尾）', shown, detail);
      // 等卡片渲染出模糊地址之後再檢查，否則畫面還沒渲染時這項會白白通過
      record(S, '需求池卡片不顯示完整門牌', shown && !(await evaluate(page, "document.body.innerText.includes('188號')")));
    }
    await click(page, `.demand-claim-btn[data-booking=${J(id)}]`);
    const claimed = await waitForDb(async () => { const r = await row('bookings', id); return r && r.organization_id === ORG ? r : null; }, '預約綁定組織');
    record(S, '按「接案」後資料庫綁定調度員組織、狀態 claimed',
      claimed.data.state === 'claimed' && claimed.data.claimedByUserId === U.dsp.id, `organization_id=${claimed.organization_id}`);
    await waitFor(page, `!document.querySelector('.demand-claim-btn[data-booking=${J(id)}]')`, '畫面反映接案結果');
    record(S, '接案後重新載入：需求池不再列出、組織取得完整預約', true);
    record(S, '接案走 claim-booking 端點，沒有用 state-mutate 寫這筆預約',
      page.requests.filter((r) => r.path === '/api/v2/claim-booking').length === 1
        && !page.requests.some((r) => r.path === '/api/v2/state-mutate' && r.postData.includes(id)));

    const dspBefore = await reloadAs(page, U.dsp);
    const dspData = await latestStateLoad(page, dspBefore);
    const dspBooking = (dspData.collections.bookings || []).find((b) => b.id === id);
    await goView(page, 'demand-market');
    record(S, '調度員重新整理後：取得完整預約（claimed、組織 A），需求池與畫面都不再列出',
      Boolean(dspBooking) && dspBooking.state === 'claimed' && dspBooking.organizationId === ORG
        && !(dspData.pool || []).some((r) => r.id === id)
        && !(await evaluate(page, `!!document.querySelector('.demand-claim-btn[data-booking=${J(id)}]')`)));

    const reqPage = await openPage(cdp, baseUrl, 'requester-after-claim');
    try {
      await login(reqPage, U.req);
      const reqData = await latestStateLoad(reqPage, 0);
      const reqBooking = (reqData.collections.bookings || []).find((b) => b.id === id);
      const dbRow = await row('bookings', id);
      record(S, '需求者載入後看到的預約狀態與組織，與調度端、資料庫一致',
        Boolean(reqBooking) && reqBooking.state === dbRow.data.state && reqBooking.organizationId === dbRow.organization_id
          && reqBooking.state === dspBooking.state && reqBooking.organizationId === dspBooking.organizationId,
        reqBooking ? `state=${reqBooking.state} organizationId=${reqBooking.organizationId}` : '需求者載入結果沒有此預約');
      await goView(reqPage, 'requester-bookings');
      let orgShown = true;
      try { await waitFor(reqPage, "document.body.innerText.includes('合成承運 E2E')", '我的預約顯示承接單位名稱', 8000); }
      catch (_) { orgShown = false; }
      const reqOrg = (reqData.collections.organizations || []).find((o) => o.id === ORG);
      let notified = true;
      try {
        await goView(reqPage, 'requester-home');
        await waitFor(reqPage, "document.body.innerText.includes('已有接送機構承接你的預約')", '首頁顯示承接通知', 8000);
      } catch (_) { notified = false; }
      record(S, '需求者首頁的最新通知顯示「已有接送機構承接你的預約」', notified);
      await goView(reqPage, 'requester-bookings');
      record(S, '需求者的「我的預約」顯示承接單位名稱，而且只拿到名稱',
        orgShown && Boolean(reqOrg) && !('taxId' in reqOrg) && !('contactPhone' in reqOrg), JSON.stringify(reqOrg));
    } finally {
      await finishPage(reqPage, S);
    }
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
    // 載入時補的歷史基準事件不是司機的操作，不能排進待上傳（以前會一直顯示「還有 2 筆操作等待上傳」）
    await sleep(1500);
    const phantom = await evaluate(page, "(document.querySelector('.offline-execution-banner')||{}).innerText||''");
    record(S, '司機還沒操作前，畫面不顯示等待上傳', !phantom, phantom.replace(/\n/g, ' '));
    const base = (await row('trips', tripId)).revision;
    const rev = (n) => base + n;

    // ---- 出發（連線中）
    await click(page, '#completeStepBtn');
    const r1 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === rev(1) ? r : null; }, '出發寫入');
    record(S, '按「開始出發」：資料庫 revision +1、出發站完成、行程進行中',
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
    const pending = await waitForDb(async () => { const rows = (await deviceRows(page, 'offlineQueue')).filter((x) => x.payload?.command && !['synced', 'rejected'].includes(x.status)).map((x) => x.payload.command); return rows.length === 3 ? rows : null; }, '離線佇列持久化（未同步的指令）');
    const stillR1 = await row('trips', tripId);
    record(S, '離線期間三個操作都留在裝置佇列、資料庫仍停在出發後的 revision',
      JSON.stringify(pending) === J(['complete_step', 'undo_step', 'complete_step']) && stillR1.revision === rev(1), `佇列=${J(pending)}`);

    await setOffline(page, false);
    const r4 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === rev(4) ? r : null; }, '恢復連線後同步');
    record(S, '恢復連線後依序同步：revision +3、接送站完成、乘客在車上',
      r4.data.steps[1].status === 'completed' && r4.data.passengers[0].status === 'onboard'
        && JSON.stringify((r4.data.mutationReceipts || []).map((x) => x.action)) === J(['complete_step', 'complete_step', 'undo_step', 'complete_step']));
    await waitForDb(async () => !(await deviceRows(page, 'offlineQueue')).some((x) => x.payload?.command && !['synced', 'rejected'].includes(x.status)), '裝置佇列清空');
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
    const r5 = await waitForDb(async () => { const r = await row('trips', tripId); return r && r.revision === rev(5) ? r : null; }, '送達寫入');
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

    // ---- 重新整理：行程以伺服器為準、同裝置照片仍可讀
    const drvBefore = await reloadAs(page, U.drv);
    const drvData = await latestStateLoad(page, drvBefore);
    const reloadedTrip = (drvData.collections.trips || []).find((t) => t.id === tripId);
    const dbAfter = await row('trips', tripId);
    record(S, '重新整理後司機載入的行程與資料庫一致（已完成、revision、服務證明）',
      Boolean(reloadedTrip) && reloadedTrip.status === 'completed' && reloadedTrip.revision === dbAfter.revision
        && (reloadedTrip.serviceProofs || []).length === 1 && reloadedTrip.serviceProofs[0].photo.objectKey === proof.photo.objectKey,
      reloadedTrip ? `status=${reloadedTrip.status} revision=${reloadedTrip.revision}` : '司機載入結果沒有此行程');
    const localAfterReload = await evaluate(page, `new Promise((resolve,reject)=>{const req=indexedDB.open('careRideTripP2');req.onsuccess=()=>{const db=req.result;const tx=db.transaction('proofBlobs','readonly');const get=tx.objectStore('proofBlobs').get(${J(proof.photo && proof.photo.objectKey)});get.onsuccess=()=>resolve(!!get.result&&get.result.blob instanceof Blob&&get.result.blob.size>0);get.onerror=()=>reject(Error('photo read failed'));tx.oncomplete=()=>db.close();};req.onerror=()=>reject(Error('photo open failed'));})`);
    const pendingAfterReload = (await deviceRows(page, 'offlineQueue')).filter((x) => x.payload?.command && !['synced', 'rejected'].includes(x.status));
    record(S, '重新整理後同裝置照片仍可讀、沒有殘留待送指令', localAfterReload === true && pendingAfterReload.length === 0,
      `photo=${localAfterReload} pending=${pendingAfterReload.length}`);

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
    const ok = await fixtureTrip(trip).then(() => true, (e) => { console.log(e.message); return false; });
    record(S, `（資料準備）${status} 行程與已排車預約`, ok);
  }
  // 取消端點產生的通知（notifications 資料表，0007）；形狀沿用 { data: { template, recipientId } }
  const notifications = async (bookingId) => (await admin.query(
    `select template, recipient_user_id from notifications where booking_id = $1 and source = 'cancel_booking_endpoint'`, [bookingId])).rows
    .map((r) => ({ data: { template: r.template, recipientId: r.recipient_user_id } }));

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

    const badBefore = J([await row('bookings', bad.id), await row('trips', bad.trip)]);
    await cancelVia(bad.id);
    await waitFor(page, "(document.getElementById('toast')?.textContent||'').includes('行程已開始或已結束')", '取消失敗提示（明確原因）');
    const badAfter = J([await row('bookings', bad.id), await row('trips', bad.trip)]);
    const toast = await evaluate(page, "document.getElementById('toast')?.textContent||''");
    record(S, '行程已開始時取消失敗：畫面顯示明確原因、預約與行程資料列完全不變、沒有任何通知',
      badAfter === badBefore && (await notifications(bad.id)).length === 0
        && (await evaluate(page, "document.getElementById('bookingActionModal').classList.contains('open')")),
      `toast=${toast}`);
    record(S, '取消走 cancel-booking 端點，沒有用 state-mutate 寫預約或行程',
      page.requests.filter((r) => r.path === '/api/v2/cancel-booking').length === 2
        && !page.requests.some((r) => r.path === '/api/v2/state-mutate' && (r.postData.includes(ok.id) || r.postData.includes(bad.id))));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'C-cancel');
  }
  await finishPage(page, S);
}

// ================================================================ D. 調度在畫面上排車
async function flowSchedule(cdp, baseUrl, tokens) {
  const S = 'D 調度排車';
  const id = 'BKG-E2E-SCHED';
  // 避開 C 情境留給同一位司機的行程（明天 10:00 進行中），否則司機在那個時段確實沒空
  const date = dayOffset(2);
  const vehicleId = 'VEH-E2E-SCHED';
  const booking = { ...openBooking(id), pickupDate: date, pickupTime: '14:00',
    legs: [{ id: `${id}_outbound`, schemaVersion: 1, sequence: 1, direction: 'outbound', label: '去程', status: 'pending',
      requestedPickupAt: `${date}T14:00:00.000Z`, pickup: null, dropoff: null, tripId: null, scheduledOrganizationId: null, scheduledAt: null }] };
  record(S, '（資料準備）需求者建立預約', (await apiMutate(tokens.req, [{ collection: 'bookings', id, record: booking }])) === 200);
  const claimed = await claimBooking.handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', cookie: `cr_at=${tokens.dsp}` },
    body: J({ bookingId: id, organizationId: ORG }) });
  record(S, '（資料準備）調度接案', claimed.statusCode === 200, claimed.body);
  record(S, '（資料準備）機構的車輛', (await apiMutate(tokens.dsp, [{ collection: 'vehicles', id: vehicleId, record: {
    id: vehicleId, organizationId: ORG, plate: 'E2E-0001', model: '合成車', capacity: 4, wheelchairSlots: 1, accessible: true,
    status: 'available', fleetId: null, retiredAt: null, retiredByUserId: null } }])) === 200);

  // 排車不看司機現在有沒有執勤：未執勤的司機也能排未來的行程（只有「不可排車」不能排）
  await admin.query(`update drivers set duty_status = 'off_duty' where id = $1`, [DRIVER_ID]);
  const page = await openPage(cdp, baseUrl, 'dispatcher-schedule');
  try {
    await login(page, U.dsp);
    await goView(page, 'dispatch-home');
    await evaluate(page, `(()=>{const d=document.getElementById('operationDateInput');d.value=${J(date)};d.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await click(page, `.booking-create-trip-btn[data-booking=${J(id)}]`);
    await waitFor(page, "document.getElementById('createTripModal').classList.contains('open')&&!!document.getElementById('newDriver').value&&!!document.getElementById('newVehicle').value",
      '建立行程視窗帶入司機與車輛');
    await click(page, '#saveTripBtn');
    const scheduled = await waitForDb(async () => { const r = await row('bookings', id); return r && r.data.state === 'scheduled' ? r : null; }, '預約變成已排車');
    const tripId = scheduled.data.legs[0].tripId;
    const trip = tripId ? await row('trips', tripId) : null;
    record(S, '按「建立行程」後預約已排車，行程寫入且屬於調度的機構', Boolean(trip) && trip.organization_id === ORG
      && scheduled.data.tripId === tripId, `tripId=${tripId}`);
    record(S, '司機未執勤也能排行程給他', Boolean(trip) && trip.data.driverId === DRIVER_ID, trip && trip.data.driverId);
    record(S, '排車只呼叫一次 schedule-trips', page.requests.filter((r) => r.path === '/api/v2/schedule-trips').length === 1);
    record(S, '預約與行程沒有另外經過 booking-write／trip-write',
      !page.requests.some((r) => ['/api/v2/booking-write', '/api/v2/trip-write'].includes(r.path) && r.postData.includes(id)));
    await waitFor(page, "!document.getElementById('createTripModal').classList.contains('open')", '建立行程視窗關閉');
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'D-schedule');
  } finally {
    await admin.query(`update drivers set duty_status = 'on_duty' where id = $1`, [DRIVER_ID]);
  }
  await finishPage(page, S);
}

// ================================================================ E. 替家人預約（#82）
async function flowFamily(cdp, baseUrl, tokens) {
  const S = 'E 替家人預約';
  const fam = { name: '合成家人王媽媽', phone: '0933111222', address: '新北市板橋區中山路一段161號', aid: '手動輪椅', special: '需協助上下車' };
  const destination = '台北市中正區常德街1號';
  const page = await openPage(cdp, baseUrl, 'requester-family');
  try {
    await login(page, U.req);
    await goView(page, 'account');
    await clickUntil(page, '#addFamilyBtn', "document.getElementById('careRecipientEditModal').classList.contains('open')", '新增家人視窗開啟');
    await typeInto(page, '#crNameInput', fam.name);
    await typeInto(page, '#crPhoneInput', fam.phone);
    await typeInto(page, '#crAddressInput', fam.address);
    await typeInto(page, '#crDefaultAidInput', fam.aid);
    await typeInto(page, '#crDefaultSpecialInput', fam.special);
    await click(page, '#saveCareRecipientBtn');
    await waitFor(page, `document.querySelector('#familyList')&&document.querySelector('#familyList').innerText.includes(${J(fam.name)})`, '我的家人列出新家人');
    const recipient = await waitForDb(async () => {
      const { rows } = await admin.query(`select id, owner_user_id, data from app_state where collection = 'careRecipients' and data->'identity'->>'displayName' = $1`, [fam.name]);
      return rows[0] || null;
    }, '家人寫入資料庫');
    const relation = await waitForDb(async () => {
      const { rows } = await admin.query(`select owner_user_id, data from app_state where collection = 'careRecipientRelations' and data->>'recipientId' = $1`, [recipient.id]);
      return rows[0] || null;
    }, '家屬關係寫入資料庫');
    record(S, '新增家人：建立服務對象（需求者建立）與一筆可預約、可管理、主要聯絡人的家屬關係',
      recipient.owner_user_id === U.req.id && relation.owner_user_id === U.req.id && relation.data.userId === U.req.id
        && relation.data.relationship === 'family' && relation.data.canBook === true && relation.data.canManageProfile === true
        && relation.data.isPrimaryContact === true, J(relation.data));

    // #100/#101：平台核准交通分區規則，需求者先替家人試算（存在伺服器，地區用家人住址）
    const rulesetCall = (body) => benefitRuleset.handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', cookie: `cr_at=${tokens.root}` }, body: J(body) });
    const draftRes = JSON.parse((await rulesetCall({ action: 'save_draft', ruleset: { code: 'transportation_primary', version: 'E2E.1', name: '合成交通分區規則',
      effectiveFrom: '2026-01-01', conditions: { cmsLevels: [2, 3, 4, 5, 6, 7, 8] },
      calculation: { mode: 'transport_zone', currency: 'TWD', cmsMin: 2, monthlyAmountByZone: { 1: 1680, 2: 1840, 3: 2000, 4: 2400 }, copayByZone: BUNDLED_COPAY },
      source: { agency: '衛生福利部', title: '合成公告', url: 'https://example.gov.tw/ltc', checkedAt: '2026-09-01' } } })).body);
    const approved = await rulesetCall({ action: 'approve', id: draftRes.data && draftRes.data.ruleset.id });
    record(S, '（資料準備）平台核准交通分區補助規則', approved.statusCode === 200, approved.body.slice(0, 200));
    await evaluate(page, "(()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return true;})()");
    await goView(page, 'benefits');
    let trialShown = true;
    try { await waitFor(page, "!!document.getElementById('benefitQuickCms')&&!!document.getElementById('benefitQuickRecipient')", '補助試算表單', 8000); } catch (_) { trialShown = false; }
    record(S, '補助試算頁可以使用', trialShown);
    await evaluate(page, `(()=>{const el=document.getElementById('benefitQuickRecipient');el.value=${J(recipient.id)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await waitFor(page, `document.getElementById('benefitQuickRecipient').value===${J(recipient.id)}&&document.querySelector('main').innerText.includes('新北市板橋區')`, '試算頁顯示家人的地區');
    await typeConfirmed(page, '#benefitQuickCms', '4');
    await clickRetry(page, '#benefitQuickRunBtn');
    const saved = await waitForDb(async () => {
      const { rows } = await admin.query(`select data from benefit_assessments where care_recipient_id = $1 order by created_at desc limit 1`, [recipient.id]);
      return rows[0] || null;
    }, '家人的試算存進資料庫');
    record(S, '試算存在伺服器：長照等級是填的，地區是家人住址的縣市（#100）',
      saved.data.facts.cmsLevel === 4 && saved.data.facts.residenceCity === '新北市' && saved.data.createdByUserId === U.req.id, J(saved.data.facts));
    let resultShown = true;
    try { await waitFor(page, "/每月補助額度/.test(document.getElementById('benefitQuickResult').innerText)&&/自付比例/.test(document.getElementById('benefitQuickResult').innerText)", '試算結果顯示每月補助額度與自付比例', 10000); } catch (_) { resultShown = false; }
    record(S, '試算結果顯示每月補助額度與自付比例', resultShown, resultShown ? '' : await evaluate(page, "document.getElementById('benefitQuickResult').innerText"));

    await goView(page, 'requester-new');
    await click(page, `[data-recipient-choice=${J(recipient.id)}]`);
    await click(page, '.wizard-next-btn[data-next="2"]');
    record(S, '選了家人後，上車地址預設為家人的住址', await evaluate(page, `document.getElementById('rqPickup').value===${J(fam.address)}`),
      await evaluate(page, "document.getElementById('rqPickup').value"));
    await typeInto(page, '#rqDestination', destination);
    await click(page, '.wizard-next-btn[data-next="3"]');
    // 排到第 3 天，避開其他情境留給同一位司機的行程
    await evaluate(page, `(()=>{const d=document.getElementById('rqDate');d.value=${J(dayOffset(3))};d.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await clickRetry(page, '.wizard-next-btn[data-next="4"]');
    let reviewed = true;
    try { await waitFor(page, `document.getElementById('requesterWizardReview').textContent.includes(${J(fam.name)})`, '確認步驟顯示乘車人', 8000); }
    catch (_) { reviewed = false; }
    record(S, '確認步驟的乘車人是家人', reviewed, reviewed ? '' : await evaluate(page, "document.getElementById('requesterWizardReview').textContent"));
    record(S, '確認步驟用家人的試算顯示「若由長照特約機構承接」的每月補助額度（#101）', await evaluate(page,
      "(()=>{const t=document.getElementById('requesterWizardReview').textContent;return t.includes('若由長照特約機構承接')&&t.includes('每月補助額度')&&t.includes('1,840');})()"),
      await evaluate(page, "document.getElementById('requesterWizardReview').textContent"));
    await click(page, '#submitRequesterBookingBtn');
    const booking = await waitForDb(async () => {
      const { rows } = await admin.query(`select id, owner_user_id, data from bookings where data->>'recipientId' = $1`, [recipient.id]);
      return rows[0] || null;
    }, '家人的預約寫入資料庫');
    const d = booking.data;
    record(S, '資料庫的預約是家人：服務對象、乘車人姓名與電話是家人，需求者是聯絡人',
      d.requestedByUserId === U.req.id && d.name === fam.name && d.phone === fam.phone
        && d.contacts && d.contacts.requester && d.contacts.requester.name === U.req.name, J({ name: d.name, phone: d.phone, contacts: d.contacts }));
    await waitFor(page, "!!document.querySelector('.nav-btn.active[data-view=\"requester-bookings\"]')", '送出後回到我的預約');
    record(S, '我的預約顯示這筆是替家人預約（乘車人是家人、標示「家人」）', await evaluate(page,
      `[...document.querySelectorAll('main .list-item h4')].some((h)=>h.innerText.includes(${J(fam.name)})&&h.innerText.includes('家人'))`));
    record(S, '我的預約（接案前）顯示「若由長照特約機構承接」的補助資訊（#101）', await evaluate(page,
      "document.querySelector('main').innerText.includes('若由長照特約機構承接')"));
    const claimed = await claimBooking.handler({ httpMethod: 'POST', headers: { host: '127.0.0.1', cookie: `cr_at=${tokens.dsp}` },
      body: J({ bookingId: booking.id, organizationId: ORG }) });
    record(S, '（資料準備）調度接案', claimed.statusCode === 200, claimed.body);
    const dsp = await openPage(cdp, baseUrl, 'dispatcher-family');
    try {
      await login(dsp, U.dsp);
      await goView(dsp, 'dispatch-home');
      await evaluate(dsp, `(()=>{const el=document.getElementById('operationDateInput');el.value=${J(d.pickupDate)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      let shown = true;
      try { await waitFor(dsp, `document.querySelector('main').innerText.includes(${J(fam.name)})`, '調度畫面顯示家人', 10000); } catch (_) { shown = false; }
      const text = await evaluate(dsp, "document.querySelector('main').innerText");
      record(S, '承接機構的調度看到補助資訊：不是長照特約時說明不適用（#102）', shown && text.includes('補助：承接機構在新北市不是長照特約')
        && !text.includes('每月補助額度'), shown ? '' : text.slice(0, 400));
      record(S, '調度畫面顯示服務對象（家人）的姓名與需求，需求者為聯絡人',
        shown && text.includes(fam.aid) && text.includes(`聯絡人：${U.req.name}`), shown ? '' : text.slice(0, 400));
      // 排車後，司機看到的停靠點：乘車人是家人，需求者是聯絡人（#76 故事 13）
      await click(dsp, `.booking-create-trip-btn[data-booking=${J(booking.id)}]`);
      await waitFor(dsp, "document.getElementById('createTripModal').classList.contains('open')&&!!document.getElementById('newDriver').value&&!!document.getElementById('newVehicle').value",
        '排車視窗帶入司機與車輛');
      await click(dsp, '#saveTripBtn');
      const scheduled = await waitForDb(async () => { const r = await row('bookings', booking.id); return r && r.data.state === 'scheduled' ? r : null; }, '家人的預約已排車');
      const trip = await row('trips', scheduled.data.legs[0].tripId);
      const pickup = (trip.data.steps || []).find((st) => st.type === 'pickup') || {};
      const contacts = pickup.contacts || [];
      record(S, '司機的停靠點：乘車人是家人（姓名、電話），需求者是聯絡人',
        pickup.name === fam.name && contacts.some((c) => c.name === fam.name && c.phone === fam.phone)
          && contacts.some((c) => c.name === `聯絡人 ${U.req.name}` && c.phone === U.req.phone), J(contacts));
    } finally {
      await finishPage(dsp, S);
    }

    // #101：承接機構不是長照特約 → 說明；平台標記長照特約後 → 標示與補助資訊
    const refresh = () => evaluate(page, "(()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return true;})()");
    await refresh();
    let notLtc = true;
    try { await waitFor(page, "document.querySelector('main').innerText.includes('不是長照特約')", '我的預約顯示承接機構不是長照特約', 10000); } catch (_) { notLtc = false; }
    record(S, '承接機構不是長照特約：我的預約說明這趟不適用、沒有金額', notLtc
      && !(await evaluate(page, "document.querySelector('main').innerText.includes('每月補助額度')")), notLtc ? '' : await evaluate(page, "document.querySelector('main').innerText.slice(0,600)"));
    await db.withUser(U.root.id, (c) => c.query("select app.save_ltc_contract(null, $1, '新北市', '合成特約 E2E', '2026-01-01'::date, null)", [ORG]));
    await refresh();
    let ltc = true;
    try { await waitFor(page, "[...document.querySelectorAll('main .list-item')].some((el)=>el.querySelector('.pill.green')&&el.querySelector('.pill.green').innerText==='長照特約'&&el.innerText.includes('每月補助額度'))", '我的預約顯示長照特約與補助資訊', 10000); } catch (_) { ltc = false; }
    record(S, '承接機構是長照特約：承接機構旁標「長照特約」，顯示每月補助額度與自付比例（#101）', ltc
      && await evaluate(page, "document.querySelector('main').innerText.includes('實際以承接機構核定為準')"), ltc ? '' : await evaluate(page, "document.querySelector('main').innerText.slice(0,600)"));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'E-family');
  }
  await finishPage(page, S);
}

// ================================================================ G. 來回預約同意分段載送（#111）
async function flowSplitConsent(cdp, baseUrl) {
  const S = 'G 同意分段載送';
  const destination = '台北市中正區公園路20號';
  const visible = (id) => `(()=>{const el=document.getElementById(${J(id)});return !!el&&!el.closest('.hidden')&&el.offsetParent!==null;})()`;
  const setValue = (id, value) => `(()=>{const el=document.getElementById(${J(id)});el.value=${J(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
  const page = await openPage(cdp, baseUrl, 'requester-split');
  try {
    await login(page, U.req);
    await goView(page, 'requester-new');
    await click(page, '[data-recipient-choice]');
    await click(page, '.wizard-next-btn[data-next="2"]');
    await typeConfirmed(page, '#rqPickup', '新北市板橋區中山路一段161號');
    await typeConfirmed(page, '#rqDestination', destination);
    await click(page, '.wizard-next-btn[data-next="3"]');
    await evaluate(page, setValue('rqDate', dayOffset(6)));
    record(S, '單程預約不顯示「同意分段載送」', !(await evaluate(page, visible('rqSplitLegConsent'))));
    await evaluate(page, setValue('rqTripType', '來回'));
    record(S, '改成來回：顯示「同意分段載送」而且預設勾選', await evaluate(page, visible('rqSplitLegConsent'))
      && await evaluate(page, "document.getElementById('rqSplitLegConsent').checked===true"));
    await evaluate(page, setValue('rqReturnDate', dayOffset(6)));
    await evaluate(page, setValue('rqReturnTime', '16:00'));
    await clickRetry(page, '.wizard-next-btn[data-next="4"]');
    record(S, '確認步驟顯示同意分段載送', await evaluate(page, "document.getElementById('requesterWizardReview').textContent.includes('・同意分段載送')"),
      await evaluate(page, "document.getElementById('requesterWizardReview').textContent"));
    await click(page, '#submitRequesterBookingBtn');
    const created = await waitForDb(async () => {
      const { rows } = await admin.query(`select id, data from bookings where owner_user_id = $1 and data->>'destination' = $2 and data->>'tripType' = '來回'`, [U.req.id, destination]);
      return rows[0] || null;
    }, '來回預約寫入資料庫');
    record(S, '資料庫的預約存下同意分段載送', created.data.splitLegConsent === true, J({ splitLegConsent: created.data.splitLegConsent }));
    await waitFor(page, "!!document.querySelector('.nav-btn.active[data-view=\"requester-bookings\"]')", '送出後回到我的預約');
    record(S, '我的預約顯示同意分段載送', await evaluate(page, "document.querySelector('main').innerText.includes('同意分段載送')"));

    await click(page, `.requester-edit-booking-btn[data-booking=${J(created.id)}]`);
    await click(page, '.wizard-next-btn[data-next="2"]');
    await click(page, '.wizard-next-btn[data-next="3"]');
    record(S, '修改預約時勾選框是預約上的值（已勾選）', await evaluate(page, "document.getElementById('rqSplitLegConsent').checked===true"));
    await click(page, '#rqSplitLegConsent');
    await clickRetry(page, '.wizard-next-btn[data-next="4"]');
    await click(page, '#submitRequesterBookingBtn');
    const amended = await waitForDb(async () => {
      const r = await row('bookings', created.id);
      return r && r.data.splitLegConsent === false ? r : null;
    }, '修改後不同意分段載送寫入資料庫');
    record(S, '修改預約取消同意：資料庫改成不同意', amended.data.splitLegConsent === false);
    await waitFor(page, "!!document.querySelector('.nav-btn.active[data-view=\"requester-bookings\"]')", '修改後回到我的預約');
    record(S, '我的預約顯示不同意分段載送', await evaluate(page, "document.querySelector('main').innerText.includes('不同意分段載送')"));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'G-split');
  }
  await finishPage(page, S);
}

// ================================================================ F. 登入方式開關與客服聯絡（#79）
async function flowPublicSettings(cdp, baseUrl) {
  const S = 'F 登入方式與客服聯絡';
  const line = 'https://lin.ee/synthetic-e2e';
  const email = 'help-e2e@example.tw';
  const visible = (id) => `(()=>{const el=document.getElementById(${J(id)});return !!el&&!el.classList.contains('hidden')&&el.offsetParent!==null;})()`;
  const guest = await openPage(cdp, baseUrl, 'guest-settings');
  try {
    await waitFor(guest, visible('oauthGoogleBtn'), 'Google 登入按鈕顯示');
    record(S, '試營運預設：登入頁有 Google、沒有 Facebook', !(await evaluate(guest, visible('oauthFacebookBtn'))));
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
  }
  await finishPage(guest, S);

  const page = await openPage(cdp, baseUrl, 'root-settings');
  try {
    await login(page, U.root);
    await goView(page, 'platform-organizations');
    await waitFor(page, "!!document.getElementById('platformPublicSettings')&&!document.getElementById('savePublicSettingsBtn').disabled", '平台設定讀到目前的登入方式與客服聯絡');
    {
      // 背景重新載入資料時，畫面保留正在輸入的欄位（焦點、游標、內容）與捲動位置
      const loadsBefore = page.stateLoads.length;
      await evaluate(page, "(()=>{const e=document.getElementById('supportLineUrlInput');e.focus({preventScroll:true});e.value='https://typing-in-progress';e.dispatchEvent(new Event('input',{bubbles:true}));e.setSelectionRange(3,3);return true;})()");
      // 捲到底，記下欄位在畫面上的位置（使用者看到的位置）
      const y = await evaluate(page, "(()=>{window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});return Math.round(window.scrollY);})()");
      const fieldTop = await evaluate(page, "Math.round(document.getElementById('supportLineUrlInput').getBoundingClientRect().top)");
      // 模擬使用者切回這個分頁（無頭瀏覽器的分頁可見狀態不一定，明確設成 visible）
      await evaluate(page, "(()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return true;})()");
      const started = Date.now();
      while (page.stateLoads.length <= loadsBefore && Date.now() - started < 15000) await sleep(150);
      await sleep(800);
      const after = await evaluate(page, "(()=>{const e=document.activeElement;return {id:e&&e.id,value:e&&e.value,caret:e&&e.selectionStart,y:Math.round(window.scrollY),top:e?Math.round(e.getBoundingClientRect().top):null};})()");
      record(S, '背景重新載入資料後：正在輸入的欄位保留焦點、游標與內容，捲動位置不跳回頂端',
        page.stateLoads.length > loadsBefore && after.id === 'supportLineUrlInput' && after.value === 'https://typing-in-progress'
          // 欄位在畫面上的位置不跳（上方區塊變高變矮時，瀏覽器的捲動錨定會微調捲動值，所以比畫面位置）
          && after.caret === 3 && y > 0 && Math.abs(after.top - fieldTop) <= 20,
        J({ y, fieldTop, after, loads: page.stateLoads.length - loadsBefore }));
    }
    await evaluate(page, "(()=>{const c=document.getElementById('loginMethodFacebookInput');if(!c.checked)c.click();return true;})()");
    await typeConfirmed(page, '#supportLineUrlInput', line);
    await typeConfirmed(page, '#supportEmailInput', email);
    // 背景同步重畫畫面時捲動位置會回到頂端（輸入的值會保留），按鈕剛好被捲出畫面就再試一次
    await clickRetry(page, '#savePublicSettingsBtn');
    const saved = await waitForDb(async () => {
      const { rows } = await admin.query(`select key, value from app_settings where key in ('login_methods','support_contact')`);
      const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return m.login_methods && m.login_methods.facebook === true && m.support_contact && m.support_contact.email === email ? m : null;
    }, '設定寫入資料庫');
    record(S, '平台管理者在設定頁打開 Facebook、填寫 LINE 與 Email，寫入資料庫', saved.support_contact.lineUrl === line);
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(page, 'F-root');
  }
  await finishPage(page, S);

  const after = await openPage(cdp, baseUrl, 'guest-after-settings');
  try {
    await waitFor(after, visible('oauthFacebookBtn'), '重新整理後 Facebook 登入按鈕出現', 10000);
    record(S, '儲存後重新整理登入頁：Facebook 按鈕出現（不需重新部署）', true);
    await click(after, '#forgotPasswordBtn');
    await waitFor(after, `document.getElementById('forgotSupportContact').innerText.includes(${J(email)})`, '忘記密碼顯示客服聯絡', 8000);
    record(S, '忘記密碼視窗顯示 LINE 官方帳號與客服 Email', await evaluate(after,
      `!!document.querySelector('#forgotSupportContact a[href=${J(line)}]')&&!!document.querySelector('#forgotSupportContact a[href=${J(`mailto:${email}`)}]')`));
    await click(after, '#forgotPasswordModal [data-close="forgotPasswordModal"]');
    await waitFor(after, "!document.getElementById('forgotPasswordModal').classList.contains('open')", '關閉忘記密碼視窗');
    await login(after, U.req);
    await goView(after, 'account');
    record(S, '我的帳戶顯示客服聯絡', await evaluate(after,
      `!!document.querySelector('#supportContactCard a[href=${J(line)}]')&&document.getElementById('supportContactCard').innerText.includes(${J(email)})`));
    await after.send('Page.navigate', { url: new URL('legal/privacy.html', baseUrl).href });
    let shown = true;
    try { await waitFor(after, `!!document.querySelector('[data-support-email] a[href=${J(`mailto:${email}`)}]')`, '隱私權政策顯示聯絡 Email', 8000); } catch (_) { shown = false; }
    record(S, '隱私權政策顯示聯絡 Email', shown);
  } catch (e) {
    record(S, `流程中斷：${e.message}`, false);
    await screenshot(after, 'F-guest');
  }
  await finishPage(after, S);
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
    // 確認測試真的跑在正式站的 CSP 之下：本機伺服器套用 _headers，script-src 不含 unsafe-inline
    const cspHeader = await new Promise((resolve, reject) => {
      require('node:http').get(baseUrl, (r) => { r.resume(); resolve(String(r.headers['content-security-policy'] || '')); }).on('error', reject);
    });
    const scriptSrc = (cspHeader.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) || '');
    record('啟動', '頁面回應帶 CSP，且 script-src 不允許 unsafe-inline', Boolean(scriptSrc) && !scriptSrc.includes("'unsafe-inline'"), scriptSrc || '（沒有 CSP 標頭）');
    chrome = await launchChrome();
    console.log(`Chrome：${chrome.version ? chrome.version.product : '（未知版本）'}　應用：${baseUrl}　截圖目錄：${ARTIFACT_DIR}`);
    const cdp = new Cdp(chrome.ws);

    console.log('--- A：調度員在需求池接案 ---');
    await flowClaim(cdp, baseUrl, tokens);
    console.log('--- B：司機執行（離線、返回、同步、異常、服務證明照片） ---');
    await flowDriver(cdp, baseUrl, tokens);
    console.log('--- C：需求者取消與通知 ---');
    await flowCancel(cdp, baseUrl, tokens);
    console.log('--- D：調度在畫面上排車 ---');
    await flowSchedule(cdp, baseUrl, tokens);
    console.log('--- E：需求者替家人預約 ---');
    await flowFamily(cdp, baseUrl, tokens);
    console.log('--- G：來回預約同意分段載送 ---');
    await flowSplitConsent(cdp, baseUrl);
    console.log('--- F：登入方式開關與客服聯絡 ---');
    await flowPublicSettings(cdp, baseUrl);
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
