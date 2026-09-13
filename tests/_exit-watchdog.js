'use strict';

/**
 * 「測試跑完了，行程卻不結束」的偵測器。
 *
 * 為什麼需要：2026-09-13 在 main 上的 push CI，Node 24 那個 job 卡在離線測試
 * 那一步，整整 15 分鐘沒有任何輸出，最後被 job timeout 取消。日誌的最後一行
 * 是 tests/db-config-check.test.js 的結尾，下一個測試檔的標題沒有印出來——
 * 也就是說，不是某個測試跑很久，而是**某個 node 行程跑完主體後沒有結束**
 * （或是輸出在取消時遺失）。本機重跑 23 次沒有重現。
 *
 * 與其猜，不如讓它下次發生時留下證據：測試主體結束後掛一個 unref 過的計時器。
 * 行程如果本來就要結束，unref 的計時器不會延長它的壽命，也就不會觸發；只有在
 * 「有別的東西卡著事件迴圈」時才會觸發，這時把還活著的資源印出來並強制結束。
 *
 * 退出碼 97 是刻意挑的，方便在 CI 日誌裡一眼認出是這個原因，而不是測試失敗。
 */

const STUCK_EXIT_CODE = 97;

/**
 * @param {number} ms 主體結束後等多久判定為卡住
 * @param {string} label 出現在訊息裡的識別字
 */
function armExitWatchdog(ms = 5000, label = require('node:path').basename(process.argv[1] || '?')) {
  const timer = setTimeout(() => {
    const resources = typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo()
      : ['(此 Node 版本沒有 getActiveResourcesInfo)'];
    console.error('');
    console.error(`[exit-watchdog] ${label}：測試主體已完成但行程未退出（${ms}ms 後仍在執行）。`);
    console.error(`[exit-watchdog] 仍在活動的資源：${JSON.stringify(resources)}`);
    console.error(`[exit-watchdog] 強制結束，退出碼 ${STUCK_EXIT_CODE}。`);
    process.exit(STUCK_EXIT_CODE);
  }, ms);
  // 關鍵：unref 之後，這個計時器不會讓本來該結束的行程多活一秒。
  timer.unref();
  return timer;
}

/**
 * 明顯代表「有東西沒清乾淨」的資源類型。
 * stdio 相關的 PipeWrap / TTYWrap / FileHandle 不列入。
 *
 * 這份清單只能抓到列出的類型，不能排除所有資源問題；沒列到的資源若卡住
 * 行程，要靠 watchdog（rc 97）與 run.sh 的逐檔逾時（rc 124）現形。
 */
const LEAKY_RESOURCES = new Set([
  'Timeout', 'Immediate', 'ChildProcess', 'Process', 'Socket', 'Server',
  'TCPWrap', 'TCPSocketWrap', 'TCPServerWrap', 'UDPWrap', 'FSWatcher',
  'StatWatcher', 'Worker', 'MessagePort'
]);

/**
 * 測試結束時的收尾：設定退出碼、檢查有沒有沒釋放的資源、掛上 exit watchdog。
 *
 * 為什麼不用 process.exit()：
 *
 *   已重現強制退出路徑附近卡住；改為自然退出後，重複測試未再重現。
 *   Node 內部機制仍未證實。
 *
 *   重現方式：複製 tests/storage-quota.test.js，插入同步的 fs.writeSync(2,…)
 *   標記（不新增計時器），Node v24.19.0 反覆執行。第 20 輪卡住時，最後印出的
 *   標記是 `calling process.exit`，當下 getActiveResourcesInfo() 回傳
 *   ["PipeWrap","PipeWrap"]。重現率：40 輪 1 次、12 輪 1 次；stdout 走檔案時
 *   12 輪也卡 1 次。改為自然退出後 storage-quota 35 輪、其他四支各 30 輪，
 *   皆未再卡住。
 *
 *   以上是觀察，不是機制證明：PipeWrap 不等於「待寫入」，重現與修正後的輪數
 *   也不足以排除版本或環境因素。
 *
 * 但「只設 exitCode」本身不足以當成修法——它不會清掉任何資源。所以這裡同時
 * 檢查 getActiveResourcesInfo()：只要出現 LEAKY_RESOURCES 列出的類型，就直接
 * 判定測試失敗並印出清單。這份清單不完整，不能排除所有資源問題。真的卡住時，watchdog 會
 * 在 5 秒後印出資源清單並以退出碼 97 結束。
 *
 * @param {number} code 期望的退出碼
 * @param {string} label 訊息裡的識別字
 */
function finishTest(code, label) {
  process.exitCode = code;

  const active = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const leaked = active.filter((r) => LEAKY_RESOURCES.has(r));
  if (leaked.length) {
    console.error('');
    console.error(`[exit-watchdog] ${label}：測試結束時仍有未釋放的資源：${JSON.stringify(leaked)}`);
    console.error(`[exit-watchdog] 全部活動資源：${JSON.stringify(active)}`);
    console.error('[exit-watchdog] 判定為測試失敗——沒清乾淨的資源會讓行程無法自然結束。');
    process.exitCode = 1;
  }

  armExitWatchdog(5000, label);
}

module.exports = { armExitWatchdog, finishTest, STUCK_EXIT_CODE, LEAKY_RESOURCES };
