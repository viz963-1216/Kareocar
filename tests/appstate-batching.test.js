/**
 * 批次寫入成本的回歸測試。
 *
 * 這裡守的是一個「形狀」而不是一個數字：一次 /state/mutate 的工作表操作
 * 次數必須與批次筆數無關。改壞的典型方式是在迴圈裡加一句看似無害的
 * readTable_ 或 getDataRange —— 功能測試不會失敗，但平台會在資料長大後
 * 抓著全域鎖逾時。
 */
const path = require('path');
const fs = require('fs');
const CWD = path.join(__dirname, '..');

require(path.join(__dirname, 'shim.js'));
require(path.join(__dirname, 'sheets.js'));

// 攔截所有工作表讀寫並計數
const ops = { read: 0, write: 0, rows: 0 };
const origGetSpreadsheet = global.getSpreadsheet_;
global.getSpreadsheet_ = () => {
  const ss = origGetSpreadsheet();
  const origByName = ss.getSheetByName;
  ss.getSheetByName = (n) => {
    const s = origByName(n);
    if (!s) return s;
    const gdr = s.getDataRange, gr = s.getRange, ar = s.appendRow;
    s.getDataRange = () => {
      const r = gdr.call(s); const gv = r.getValues;
      r.getValues = () => { ops.read++; const v = gv.call(r); ops.rows += v.length; return v; };
      return r;
    };
    s.getRange = (...a) => {
      const r = gr.call(s, ...a); const sv = r.setValues, gv = r.getValues;
      r.setValues = (v) => { ops.write++; return sv.call(r, v); };
      r.getValues = () => { ops.read++; return gv.call(r); };
      return r;
    };
    s.appendRow = (row) => { ops.write++; return ar.call(s, row); };
    return s;
  };
  return ss;
};
const origReadTable = global.readTable_;
global.readTable_ = (n) => { ops.read++; const r = origReadTable(n); ops.rows += r.length; return r; };

for (const f of ['AuthCore.gs', 'DatabaseApi.gs', 'AppStateApi.gs']) {
  eval(fs.readFileSync(path.join(CWD, 'apps-script', f), 'utf8'));
}

const P = global.__props;
P.set('AUTH_PASSWORD_PEPPER', 'pepper'); P.set('AUTH_SESSION_SECRET', 'secret');
P.set('AUTH_PBKDF2_ITERATIONS', '1000');

const ROWS = 2000;
__makeSheet('組織', ['組織ID', '啟用狀態'], [{ '組織ID': 'ORG-TP-001', '啟用狀態': true }]);
__makeSheet('使用者', ['使用者ID', '啟用狀態', '平台角色'], [{ '使用者ID': 'U1', '啟用狀態': true, '平台角色': 'none' }]);
__makeSheet('成員資格', ['成員資格ID', '使用者ID', '組織ID', '角色', '狀態'],
  [{ '成員資格ID': 'M', '使用者ID': 'U1', '組織ID': 'ORG-TP-001', '角色': 'dispatcher', '狀態': 'active' }]);
__makeSheet('行程', ['行程ID', '組織ID', '司機ID'],
  Array.from({ length: ROWS }, (_, i) => ({ '行程ID': 'T' + i, '組織ID': 'ORG-TP-001' })));
__makeSheet('預約', ['預約ID', '預約者使用者ID', '組織ID', '預約狀態'],
  Array.from({ length: ROWS }, (_, i) => ({ '預約ID': 'B' + i, '組織ID': 'ORG-TP-001', '預約狀態': 'claimed' })));
__makeSheet('司機', ['司機ID', '使用者ID', '組織ID'], []);
__makeSheet('服務對象', ['服務對象ID'], []);
__makeSheet('服務對象聯絡人', ['聯絡人ID', '服務對象ID', '使用者ID', '狀態'], []);
__makeSheet('行程預約關聯', ['行程ID', '預約ID'], []);
__makeSheet('車輛', ['車輛ID', '組織ID'], []);
__makeSheet('應用狀態', APP_STATE_HEADERS_.slice(), []);

let pass = 0, fail = 0;
const t = (n, c) => {
  try { if (c()) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } }
  catch (e) { fail++; console.log('  FAIL', n, '->', e.message); }
};

const token = authIssueSessionToken_('U1');
let nextId = 0;
// 每批都用一組全新的行程 ID，避免測試自身的版本記帳干擾量測結果。
function measure(batch) {
  const base = nextId; nextId += batch;
  ops.read = 0; ops.write = 0; ops.rows = 0;
  mutateAppState_({
    sessionToken: token,
    changes: Array.from({ length: batch }, (_, i) => ({
      collection: 'trips', id: 'T' + (base + i),
      record: { id: 'T' + (base + i), revision: 1, status: 'new' },
      expectedRevision: 0
    }))
  }, {});
  return { read: ops.read, write: ops.write, rows: ops.rows };
}

console.log(`--- 每張表 ${ROWS} 列時，一次 /state/mutate 的工作表操作 ---`);
const m1 = measure(1);
const m10 = measure(10);
const m50 = measure(50);
for (const [label, m] of [['1 筆', m1], ['10 筆', m10], ['50 筆', m50]]) {
  console.log(`  批次 ${label.padStart(5)} → 讀取 ${String(m.read).padStart(3)} 次、寫入 ${String(m.write).padStart(3)} 次、掃過 ${m.rows.toLocaleString().padStart(7)} 列`);
}

console.log('--- 斷言 ---');
t('讀取次數不隨批次成長（50 筆 ≤ 1 筆 + 2）', () => m50.read <= m1.read + 2);
t('寫入次數不隨批次成長（50 筆 ≤ 2 次）', () => m50.write <= 2);
t('掃過的列數不隨批次成長（50 筆 < 1 筆的 1.5 倍）', () => m50.rows < m1.rows * 1.5);
t('單次讀取次數維持在個位數', () => m50.read < 10);

console.log('--- 批次語意 ---');
t('同批次中同一 ID 的第二次變更看得到第一次的結果', () => {
  const id = 'T' + (nextId++);
  const r = mutateAppState_({
    sessionToken: token,
    changes: [
      { collection: 'trips', id, record: { id, revision: 1, status: 'a' }, expectedRevision: 0 },
      { collection: 'trips', id, record: { id, revision: 2, status: 'b' }, expectedRevision: 1 }
    ]
  }, {});
  return r.ok && appStateParseJson_(appStateFindRow_('trips', id)['資料JSON']).status === 'b';
});

t('中途授權失敗時整批不落地', () => {
  const before = JSON.stringify(__SHEETS['應用狀態'].rows);
  try {
    mutateAppState_({
      sessionToken: token,
      changes: [
        { collection: 'trips', id: 'T' + (nextId++), record: { revision: 1 }, expectedRevision: 0 },
        { collection: 'benefitRulesets', id: 'X', record: { id: 'X' } }   // 一定會被拒絕
      ]
    }, {});
    return false;
  } catch (e) {
    return JSON.stringify(__SHEETS['應用狀態'].rows) === before;
  }
});

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
