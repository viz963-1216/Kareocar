'use strict';
// 本機 CI 用 psql 替身時才載入（NODE_OPTIONS=--require）：只有真正的 pg 才能驗的測試直接標示略過。
// db-ssl.test.js 檢查的是 pg 套件解析連線字串後的 connectionParameters，替身無法模擬套件內部行為。
const path = require('path');
const ONLY_REAL_PG = new Set(['db-ssl.test.js']);
if (process.argv[1] && ONLY_REAL_PG.has(path.basename(process.argv[1]))) {
  console.log(`略過（需要真正的 pg）：${path.basename(process.argv[1])}`);
  process.exit(0);
}
