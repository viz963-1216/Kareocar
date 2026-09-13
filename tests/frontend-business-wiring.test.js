'use strict';
/**
 * 前端串接的靜態核對：接案與需求者取消是否真的接到專用端點、需求池是否讀取
 * demandPool。
 *
 * 這是讀原始碼的靜態檢查，不是瀏覽器實測。後端整合測試通過、這支也通過，都
 * 不能代表畫面實際操作正常；實際畫面驗收另行進行。
 *
 * 司機執行畫面目前「沒有」串接 trip-execute 端點，這支測試也不宣稱有。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

/** 取出物件方法本體：從簽名到第一個「換行 + 兩格縮排 + },」。 */
function methodBody(signature) {
  const start = html.indexOf(signature);
  if (start < 0) return '';
  const end = html.indexOf('\n  },', start);
  return end < 0 ? '' : html.slice(start, end);
}

console.log('--- 端點設定 ---');
t('APP_CONFIG 有 claim-booking 端點', html.includes("claimBookingUrl: '/api/v2/claim-booking'"));
t('APP_CONFIG 有 cancel-booking 端點', html.includes("cancelBookingUrl: '/api/v2/cancel-booking'"));
for (const name of ['claim-booking', 'cancel-booking', 'trip-execute']) {
  t(`netlify.toml 將 /api/v2/${name} 導向 function`,
    toml.includes(`from = "/api/v2/${name}"`) && toml.includes(`to = "/.netlify/functions/v2-${name}"`));
}

console.log('--- 需求池 ---');
const openDemand = methodBody('  openDemand(date=null,userId=null){');
t('Booking.openDemand 讀取 store.state.demandPool', openDemand.includes('store.state.demandPool'));
t('Booking.openDemand 不再讀取 store.state.bookings', openDemand.length > 0 && !openDemand.includes('store.state.bookings'));
t('demandPool 除了寫入之外確實被讀取', (html.match(/demandPool/g) || []).length >= 2);

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
t('confirmBookingAction 等待非同步取消', html.includes('result=await Booking.cancelOwn('));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
require('./_exit-watchdog').finishTest(fail ? 1 : 0, 'frontend-business-wiring');
