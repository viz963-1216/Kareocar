'use strict';
/** netlify/functions/_trip-rules.js 的離線測試：調度端寫行程的機構歸屬與狀態轉換。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkTripWrite } = require(path.join(__dirname, '..', 'netlify', 'functions', '_trip-rules.js'));

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };
const throwsCode = (fn, code, re) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return; }
  assert.fail(`預期 ${code}`);
};
const ORG = 'ORG-A';
const scope = (extra = {}) => ({
  driver: { organization_id: ORG, active: true }, vehicle: null, bookings: new Map(), ...extra
});
const base = { id: 'T1', status: 'scheduled', driverId: 'D1', vehicleId: 'V1', bookingIds: [] };
const run = (over = {}) => checkTripWrite({ record: base, existing: null, organizationId: ORG, canManage: true, scope: scope(), ...over });

ok('調度建立 scheduled 行程', () => assert.equal(run().organizationId, ORG));
ok('不是該機構的負責人或調度員：FORBIDDEN', () => throwsCode(() => run({ canManage: false }), 'FORBIDDEN'));
ok('沒有機構：VALIDATION_ERROR', () => throwsCode(() => run({ organizationId: null }), 'VALIDATION_ERROR'));
ok('新行程不能直接進行中', () => throwsCode(() => run({ record: { ...base, status: 'in_progress' } }), 'VALIDATION_ERROR'));
ok('機構以資料庫為準', () => {
  const r = run({ record: { ...base, organizationId: 'ORG-B' }, existing: { data: base, organization_id: ORG } });
  assert.equal(r.organizationId, ORG);
});
ok('狀態轉換：scheduled → cancelled 可以；in_progress → cancelled 不行（請中斷）', () => {
  assert.ok(run({ record: { ...base, status: 'cancelled' }, existing: { data: base } }));
  throwsCode(() => run({ record: { ...base, status: 'cancelled' }, existing: { data: { ...base, status: 'in_progress' } } }), 'VALIDATION_ERROR', /中斷/);
  assert.ok(run({ record: { ...base, status: 'interrupted' }, existing: { data: { ...base, status: 'in_progress' } } }));
  throwsCode(() => run({ record: { ...base, status: 'scheduled' }, existing: { data: { ...base, status: 'completed' } } }), 'VALIDATION_ERROR');
});
ok('司機：別的機構、停用的都不行；沒換司機不檢查', () => {
  throwsCode(() => run({ scope: scope({ driver: { organization_id: 'ORG-B', active: true } }) }), 'VALIDATION_ERROR', /司機/);
  throwsCode(() => run({ scope: scope({ driver: null }) }), 'VALIDATION_ERROR', /司機/);
  throwsCode(() => run({ scope: scope({ driver: { organization_id: ORG, active: false } }) }), 'VALIDATION_ERROR', /停用/);
  assert.ok(run({ existing: { data: base }, scope: scope({ driver: null }) }));
});
ok('車輛：有主檔就必須同機構；沒有主檔的舊資料接受', () => {
  throwsCode(() => run({ scope: scope({ vehicle: { organization_id: 'ORG-B' } }) }), 'VALIDATION_ERROR', /車輛/);
  assert.ok(run({ scope: scope({ vehicle: null }) }));
});
ok('預約：新關聯的必須屬於此機構且可排車；原本就有的不重查', () => {
  const rec = { ...base, bookingId: 'B1', bookingIds: ['B1'] };
  // 只有排車 command 能把預約排進行程（ADR 0003）
  throwsCode(() => run({ record: rec, scope: scope({ bookings: new Map([['B1', { organization_id: ORG, state: 'claimed' }]]) }) }), 'VALIDATION_ERROR', /排車功能/);
  const sched = (over) => run({ scheduling: true, ...over });
  throwsCode(() => sched({ record: rec }), 'VALIDATION_ERROR', /不屬於/);
  throwsCode(() => sched({ record: rec, scope: scope({ bookings: new Map([['B1', { organization_id: 'ORG-B', state: 'claimed' }]]) }) }), 'VALIDATION_ERROR', /不屬於/);
  throwsCode(() => sched({ record: rec, scope: scope({ bookings: new Map([['B1', { organization_id: ORG, state: 'cancelled' }]]) }) }), 'VALIDATION_ERROR', /不能排車/);
  assert.ok(sched({ record: rec, scope: scope({ bookings: new Map([['B1', { organization_id: ORG, state: 'claimed' }]]) }) }));
  assert.ok(sched({ record: rec, scope: scope({ bookings: new Map([['B1', { organization_id: 'ORG-B', state: 'claimed', leg_organization_ids: [ORG] }]]) }) }));
  assert.ok(run({ record: rec, existing: { data: rec } }));
});
console.log(`trip-rules: ${pass} passed`);
