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

module.exports = { armExitWatchdog, STUCK_EXIT_CODE };
