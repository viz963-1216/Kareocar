'use strict';
// 本機 CI（tools/ci-local.sh）在沒有安裝 npm 的 pg 時，把 require('pg') 導到 psql 替身。
// 用這份工具所在的替身（不是被測分支裡的），所以舊分支也能用改進過的替身跑。
module.exports = require('../../../supabase/tests/pg-psql-shim.js');
