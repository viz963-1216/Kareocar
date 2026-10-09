'use strict';

/**
 * 整合測試用哪個 Postgres 驅動。
 *
 * 預設用真正的 `pg`（CI 有安裝，與正式環境相同）：真正的驅動用 extended protocol，
 * 遇到 SQL 沒用到的參數會報「could not determine data type of parameter $n」，
 * psql 替身把參數代換成文字，抓不到這類錯誤（#122 就是這樣漏到正式站）。
 *
 * 只有裝不了 `pg` 的環境才退回 psql 替身（pg-psql-shim.js），或用 PG_PSQL_SHIM=1 強制使用。
 * 要在任何 require('pg') 之前載入這支。
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
let hasRealPg = false;
try { require.resolve('pg', { paths: [ROOT] }); hasRealPg = true; } catch (_) { hasRealPg = false; }

const useShim = process.env.PG_PSQL_SHIM === '1' || !hasRealPg;
if (useShim) {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'pg') return require.resolve('./pg-psql-shim.js');
    return origResolve.call(this, request, ...rest);
  };
}

const driver = useShim ? 'psql-shim' : 'pg';
console.log(`[pg-driver] ${driver}`);
module.exports = { driver };
