'use strict';
// tests/monitoring.test.js 用：health.js 在沒有環境變數時不會連資料庫，這裡只是讓 require('pg') 成功。
class Pool { constructor() { throw new Error('測試不應該建立資料庫連線'); } }
module.exports = { Pool };
