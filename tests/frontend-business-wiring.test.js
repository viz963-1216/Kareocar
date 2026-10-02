'use strict';
/**
 * 前端串接的靜態核對：接案、需求者取消、司機執行是否真的接到專用端點。
 *
 * 這是讀原始碼的靜態檢查，不是瀏覽器實測。後端整合測試通過、這支也通過，都
 * 不能代表畫面實際操作正常；實際畫面操作由瀏覽器端對端測試另外驗證。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 前端 JS 已從 index.html 拆到 js/，變數名稱沿用 html 以免改動下面每個斷言
const html = require('../tools/_frontend-source').readFrontendSource(ROOT).js;
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
const rules = require('../netlify/functions/_trip-execution-rules');

let pass = 0, fail = 0;
const t = (name, ok) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

/** 取出物件方法本體：從簽名到第一個「換行 + 兩格縮排 + },」。 */
function methodBody(signature) {
  const start = html.indexOf(signature);
  if (start < 0) return '';
  const end = html.indexOf('\n  },', start);
  return end < 0 ? '' : html.slice(start, end);
}
/** 取出頂層函式本體：從簽名到下一個換行後的 }。 */
function functionBody(signature) {
  const start = html.indexOf(signature);
  if (start < 0) return '';
  const end = html.indexOf('\n}', start);
  return end < 0 ? '' : html.slice(start, end);
}

console.log('--- 端點設定 ---');
t('APP_CONFIG 有 claim-booking 端點', html.includes("claimBookingUrl: '/api/v2/claim-booking'"));
t('APP_CONFIG 有 cancel-booking 端點', html.includes("cancelBookingUrl: '/api/v2/cancel-booking'"));
t('APP_CONFIG 有 trip-execute 端點', html.includes("tripExecuteUrl: '/api/v2/trip-execute'"));
for (const name of ['claim-booking', 'cancel-booking', 'trip-execute']) {
  t(`netlify.toml 將 /api/v2/${name} 導向 function`,
    toml.includes(`from = "/api/v2/${name}"`) && toml.includes(`to = "/.netlify/functions/v2-${name}"`));
}

console.log('--- 需求池 ---');
const openDemand = methodBody('  openDemand(date=null,userId=null){');
t('Booking.openDemand 讀取 store.state.demandPool', openDemand.includes('store.state.demandPool'));
t('Booking.openDemand 不再讀取 store.state.bookings', openDemand.length > 0 && !openDemand.includes('store.state.bookings'));
t('demandPool 除了寫入之外確實被讀取', (html.match(/demandPool/g) || []).length >= 2);
const stateLoad = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'v2-state-load.js'), 'utf8');
t('state-load 需求池查詢帶出 bookingPoolProjection 使用的欄位',
  ['pickup_time', 'return_date', 'return_time', 'market_expires_at', 'aid_need', 'companions'].every((c) => stateLoad.includes(c)));

console.log('--- 接案 ---');
const claim = methodBody('  async claim(id,organizationId,userId,expectedVersion){');
t('Booking.claim 呼叫 APP_CONFIG.claimBookingUrl', claim.includes('APP_CONFIG.claimBookingUrl'));
t('Booking.claim 不在本機 store.mutate（避免變成 state-mutate 寫入）', claim.length > 0 && !claim.includes('store.mutate'));
const handlerStart = html.indexOf(".demand-claim-btn').forEach");
const handler = handlerStart < 0 ? '' : html.slice(handlerStart, html.indexOf('}));', handlerStart));
t('接案按鈕不再呼叫 flushAuthoritative', handler.length > 0 && !handler.includes('flushAuthoritative'));
t('接案按鈕接案後重新載入 state-load', handler.includes('AppStateDatabase.loadAll'));

console.log('--- 需求者取消 ---');
const cancel = methodBody("  async cancelOwn(id,userId,reasonCode,reasonText=''){");
t('Booking.cancelOwn 呼叫 APP_CONFIG.cancelBookingUrl', cancel.includes('APP_CONFIG.cancelBookingUrl'));
t('Booking.cancelOwn 不在本機 store.mutate', cancel.length > 0 && !cancel.includes('store.mutate'));
t('Booking.cancelOwn 不在本機排通知（通知由後端同一交易排入）', cancel.length > 0 && !cancel.includes('Notification.queue'));
t('confirmBookingAction 等待非同步取消', html.includes('result=await Booking.cancelOwn('));
t('福利額度釋放的取消包裝等待非同步取消結果（否則 r.ok 永遠不成立）',
  html.includes('Booking.cancelOwn=async function(id,userId,reasonCode,reasonText){const r=await _bookingCancelOwn('));

console.log('--- 通知 ---');
const stateMutateSrc = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'v2-state-mutate.js'), 'utf8');
// #25：通知只由後端流程建立，前端不寫、state-mutate 也不收
t('state-mutate 不接受通知',
  !/ALLOWED_COLLECTIONS = new Set\(\[[^\]]*'notifications'/.test(stateMutateSrc)
    && /notifications:\s*'/.test(stateMutateSrc));
t('前端不把通知排入寫入佇列',
  !/const AUTHORITATIVE_STATE_COLLECTIONS=Object\.freeze\(\[[^\]]*'notifications'/.test(html));
t('Notification.queue 不再寫入本機資料', /queue\(\)\{ return null; \}/.test(html));
t('state-load 回傳的通知以唯讀方式載入本機', html.includes('db.notifications=Array.isArray(collections.notifications)?collections.notifications:[];'));

console.log('--- 司機執行 ---');
const queueChanges = functionBody('function authoritativeQueueChanges_(changes){');
t('state-mutate 佇列排除司機執行自己行程的變更', queueChanges.includes('authoritativeDriverExecutionChange_'));
const owned = functionBody('function authoritativeDriverExecutionChange_(change){');
t('排除範圍涵蓋行程、行程事件、異常', ["'trips'", "'tripEvents'", "'issues'"].every((c) => owned.includes(c)));
t('指派司機若具 trip.manage 仍走原路徑', functionBody('function tripDriverExecutionOwned_(').includes("'trip.manage'"));

const frontKeysMatch = html.match(/const TRIP_EXECUTION_PATCH_KEYS=Object\.freeze\((\[[^\]]*\])\);/);
const frontKeys = frontKeysMatch ? JSON.parse(frontKeysMatch[1].replace(/'/g, '"')) : null;
t('前端送出的行程執行欄位清單與伺服器允許的鍵完全相同',
  Array.isArray(frontKeys) && JSON.stringify([...frontKeys].sort()) === JSON.stringify([...rules.TRIP_PATCH_KEYS].sort()));
t('每個司機執行指令在佇列裡保存自己的行程快照',
  html.includes('...tripDriverExecutionCommandPayload(trip,action,stepId,key,actorUserId)'));
const commandsMatch = html.match(/const TRIP_DRIVER_EXECUTION_COMMANDS=Object\.freeze\((\[[^\]]*\])\);/);
const frontCommands = commandsMatch ? JSON.parse(commandsMatch[1].replace(/'/g, '"')) : [];
t('前端的行程指令都是伺服器支援的指令',
  frontCommands.length === 3 && frontCommands.every((c) => rules.COMMANDS.has(c)));

const adapterStart = html.indexOf('const TripSyncAdapter={');
const adapter = adapterStart < 0 ? '' : html.slice(adapterStart, html.indexOf('\n};', adapterStart));
t('同步轉接器呼叫 APP_CONFIG.tripExecuteUrl', adapter.includes('APP_CONFIG.tripExecuteUrl'));
t('同步轉接器送出定位與異常指令', adapter.includes("command:'location_sample'") && adapter.includes("command:'report_issue'"));
t('同步轉接器把 400／403／404／409 視為不再重送', adapter.includes('[400,403,404,409].includes(status)'));
t('被拒絕後重新載入伺服器資料', adapter.includes('AppStateDatabase.loadAll'));
const reportIssue = methodBody('  reportIssue({tripId,driverId,type,note,actorUserId}){');
t('Trip.reportIssue 把異常排入行程佇列', reportIssue.includes("mutationType:'trip_issue_reported'"));
t('rejected 佇列列不再被當成待同步', html.includes("TRIP_QUEUE_SETTLED_STATUSES=Object.freeze(['synced','rejected'])")
  && html.includes('rows.filter(x=>!TRIP_QUEUE_SETTLED_STATUSES.includes(x.status))'));
t('司機畫面沒有新增中斷行程的入口（中斷仍限 trip.manage）',
  !/interrupt[^\n]{0,80}trip\.execute/.test(html) && methodBody('  interrupt(tripId,actorUserId,').includes("'trip.manage'"));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
require('./_exit-watchdog').finishTest(fail ? 1 : 0, 'frontend-business-wiring');
