/**
 * Script Properties 用量的回歸測試。
 *
 * Google 對 Script Properties 有 500KB 的硬上限。憑證與速率狀態原本都存在
 * 那裡，實測每位使用者約 578 bytes——約 885 人就會寫不進去，症狀是新帳號
 * 註冊失敗、既有帳號改不了密碼，而且沒有預警。
 *
 * 這裡守的是兩個性質：
 *   1. 密碼憑證存在工作表，不佔 Properties
 *   2. 速率限制等暫時狀態存在 CacheService，不佔 Properties 且會自己過期
 *
 * 只要有人把任何一種資料搬回 Properties，這個測試就會失敗。
 */
const path = require('path');
const fs = require('fs');
const CWD = path.join(__dirname, '..');

require(path.join(__dirname, 'shim.js'));
require(path.join(__dirname, 'sheets.js'));
eval(fs.readFileSync(path.join(CWD, 'apps-script', 'AuthCore.gs'), 'utf8'));

const P = global.__props;
P.set('AUTH_PASSWORD_PEPPER', 'p'.repeat(40));
P.set('AUTH_SESSION_SECRET', 's'.repeat(40));
P.set('AUTH_PBKDF2_ITERATIONS', '1000');

const LIMIT = 500 * 1024;
const bytes = () => [...P.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);

let pass = 0, fail = 0;
const t = (n, c) => {
  try { if (c()) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } }
  catch (e) { fail++; console.log('  FAIL', n, '->', e.message); }
};

const USERS = 1000;
const baseline = bytes();
for (let i = 0; i < USERS; i++) {
  authSetPasswordCredential_('USR-PW-' + String(i).padStart(16, '0'), 'Password' + i + 'X');
  authRecordLoginFailure_('09' + String(10000000 + i), '203.0.113.' + (i % 256));
}
const grew = bytes() - baseline;

console.log(`--- ${USERS} 位使用者、每人一次登入失敗 ---`);
console.log(`  Script Properties 增加：${grew} bytes`);
console.log(`  Properties 中的 AUTH_ key：${[...P.keys()].filter(k => k.startsWith('AUTH_')).length} 個`);
console.log(`  憑證工作表列數：${global.__SHEETS['密碼憑證'].rows.length}`);
console.log(`  快取中的暫時狀態：${global.__cache.size} 筆`);

console.log('--- 斷言 ---');
t('憑證不佔 Script Properties', () =>
  [...P.keys()].every((k) => k.indexOf('AUTH_CRED_') !== 0));
t('速率狀態不佔 Script Properties', () =>
  [...P.keys()].every((k) => k.indexOf('AUTH_LOGIN_RATE_') !== 0 && k.indexOf('AUTH_LOGIN_IP_') !== 0));
t(`${USERS} 位使用者的 Properties 增量趨近於零（< 1KB）`, () => grew < 1024);
t('憑證確實寫進了工作表', () => global.__SHEETS['密碼憑證'].rows.length === USERS);
t('暫時狀態確實進了快取', () => global.__cache.size > 0);
t('依此用量推估容納人數 > 10 萬', () => {
  const perUser = grew / USERS;
  return perUser === 0 || LIMIT / perUser > 100000;
});

console.log('--- 快取過期行為 ---');
t('登入鎖定會隨快取 TTL 自行消失', () => {
  const phone = '0988777666';
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let i = 0; i < 6; i++) authRecordLoginFailure_(phone, '198.51.100.9');
    let locked = false;
    try { authAssertLoginAllowed_(phone, '198.51.100.9'); } catch (e) { locked = e.code === 'LOGIN_RATE_LIMITED'; }
    clock += 2 * 60 * 60 * 1000;          // 超過所有 TTL
    authAssertLoginAllowed_(phone, '198.51.100.9');
    return locked;
  } finally { Date.now = realNow; }
});

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
// 不用 process.exit()：它會和 stdout 的待寫入競爭，見 tests/_exit-watchdog.js
require('./_exit-watchdog').finishTest(fail ? 1 : 0, 'storage-quota');
