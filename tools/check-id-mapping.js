/**
 * 識別碼對應檢查（前端）。
 *
 * 後端與前端用兩套識別碼：後端叫 ORG-REQ-001，前端本機叫 org_requesters。
 * startBackendSession 一直都有換算，但 AppStateDatabase.loadAll 一開始沒有——
 * 結果登入當下權限正常，等資料載入後成員資格的組織變成後端那一套，跟 28 處
 * 寫死比對 APP_CONFIG.requesterOrganizationId 的地方全部對不上，使用者會看到
 * 「你沒有建立預約權限」，連帶服務對象也建不了（那條路徑要先過預約的權限關）。
 *
 * 這支測試同時檢查兩件事：正規化函式的行為，以及 loadAll 真的有呼叫它。
 *
 *   node tools/check-id-mapping.js
 */
const fs = require('fs');
const path = require('path');
const INDEX = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

const APP_CONFIG = { requesterOrganizationId: 'org_requesters' };
const gsText = (v) => String(v ?? '').trim();
const gsOrganizationId = (v) => { const id = gsText(v); return id === 'ORG-REQ-001' ? APP_CONFIG.requesterOrganizationId : id; };
const gsUserId = (v) => { const id = gsText(v); return id === 'USR-SUPER-JERRY' ? 'usr_super_admin' : id; };
global.window = { gsOrganizationId, gsUserId };

// 呼叫點也要檢查：函式存在但沒被呼叫，等於沒修
if (!/const collections=normalizeLoadedIds_\(result\.data\?\.collections\|\|\{\}\);/.test(src)) {
  console.log('FAIL loadAll 沒有呼叫 normalizeLoadedIds_（函式存在但沒用上）');
  process.exit(1);
}
const start = src.indexOf('const LOADED_ORG_FIELDS_');
const end = src.indexOf('const AppStateDatabase={');
if (start < 0 || end < 0) { console.log('FAIL 找不到正規化函式'); process.exit(1); }
eval(src.slice(start, end));

// v2-state-load 真實會回的形狀（後端識別碼）
const input = {
  users: [{ id: 'USR-PW-T1', name: '測試需求者', active: true }],
  memberships: [{ id: 'MEM-REQ-1', userId: 'USR-PW-T1', organizationId: 'ORG-REQ-001', role: 'requester', status: 'active' }],
  organizations: [{ id: 'ORG-REQ-001', type: 'requester_hub', name: '需求者組織', active: true },
                  { id: 'ORG-TP-001', type: 'transport_provider', name: '安馨福祉交通', active: true }],
  drivers: [{ id: 'DRV-1', userId: 'USR-DRV1', organizationId: 'ORG-TP-001', dutyStatus: 'off_duty' }],
  bookings: [{ id: 'BKG-1', requestedByUserId: 'USR-PW-T1', organizationId: null, state: 'open' },
             { id: 'BKG-2', requestedByUserId: 'USR-PW-T1', organizationId: 'ORG-TP-001', state: 'claimed' }],
  issues: [{ id: 'ISS-1', organizationId: 'ORG-TP-001', actorUserId: 'USR-DISP1' }]
};
const out = normalizeLoadedIds_(input);

let pass = 0, fail = 0;
const t = (name, ok) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

t('需求者組織的 id 換算成本機的 org_requesters',
  out.organizations[0].id === 'org_requesters');
t('成員資格的 organizationId 也換算了（這就是當初壞掉的地方）',
  out.memberships[0].organizationId === 'org_requesters');
t('服務單位的 id 維持原樣（兩邊本來就同名）',
  out.organizations[1].id === 'ORG-TP-001');
t('司機的組織維持原樣', out.drivers[0].organizationId === 'ORG-TP-001');
t('使用者 id 維持原樣', out.users[0].id === 'USR-PW-T1');
t('預約的 organizationId 為 null 時不會被改壞',
  out.bookings[0].organizationId === null);
t('已承接預約的組織維持原樣', out.bookings[1].organizationId === 'ORG-TP-001');
t('巢狀以外的使用者欄位有被處理', out.issues[0].actorUserId === 'USR-DISP1');
t('其餘欄位原封不動', out.memberships[0].role === 'requester' && out.memberships[0].status === 'active');

// 最關鍵的一條：前端 28 處都拿 APP_CONFIG.requesterOrganizationId 去比對
const m = out.memberships.find(x => x.userId === 'USR-PW-T1'
  && x.organizationId === APP_CONFIG.requesterOrganizationId && x.status === 'active');
t('canUser(使用者, booking.create_own, org_requesters) 找得到成員資格 → 有建立預約權限', !!m);

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
