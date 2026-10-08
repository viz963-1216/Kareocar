'use strict';
/** netlify/functions/_booking-rules.js 的離線測試：誰能把預約改到哪個狀態、伺服器欄位沿用。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkBookingWrite } = require(path.join(__dirname, '..', 'netlify', 'functions', '_booking-rules.js'));

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };
const throwsCode = (fn, code) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, e.message); return; }
  assert.fail(`預期 ${code}`);
};
const ME = 'USR-ME';
const none = { admin: false, ownsExisting: false, opsOfExisting: false, opsOfClaimedOrg: false };
const existing = (state, extra = {}, org = null) => ({ data: { id: 'B1', state, requestedByUserId: ME, pickupTime: '09:00', ...extra }, organization_id: org, owner_user_id: ME });

ok('新增：需求者建立公開預約，需求者固定為自己', () => {
  const r = checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'open' }, existing: null, roles: none });
  assert.equal(r.record.requestedByUserId, ME);
  assert.equal(r.revoke, false);
});
ok('新增：不能直接建立已承接預約（除非是該機構調度）', () => {
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'claimed' }, existing: null, roles: none }), 'VALIDATION_ERROR');
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'claimed', organizationId: 'ORG-A' }, existing: null, roles: none }), 'FORBIDDEN');
  const r = checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'claimed', organizationId: 'ORG-A' }, existing: null, roles: { ...none, opsOfClaimedOrg: true } });
  assert.equal(r.record.claimedByUserId, ME);
});
ok('新增：不能替其他帳號建立', () => {
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'open', requestedByUserId: 'OTHER' }, existing: null, roles: none }), 'VALIDATION_ERROR');
});
ok('任何人都不能經這裡取消', () => {
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'cancelled' }, existing: existing('open'), roles: { ...none, ownsExisting: true } }), 'VALIDATION_ERROR');
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'cancelled' }, existing: existing('claimed', {}, 'ORG-A'), roles: { ...none, admin: true } }), 'VALIDATION_ERROR');
});
ok('需求者：公開中可改、可過期；不能自己承接', () => {
  const roles = { ...none, ownsExisting: true };
  assert.ok(checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'open', pickupTime: '10:00' }, existing: existing('open'), roles }));
  assert.ok(checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'expired' }, existing: existing('open'), roles }));
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'claimed' }, existing: existing('open'), roles }), 'VALIDATION_ERROR');
});
ok('需求者重大修改：已承接 → 公開，撤銷原機構', () => {
  const r = checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'open' }, existing: existing('claimed', { claimedByUserId: 'D' }, 'ORG-A'), roles: { ...none, ownsExisting: true } });
  assert.equal(r.revoke, true);
  assert.equal(r.record.organizationId, null);
  assert.equal(r.record.claimedByUserId, null);
});
ok('需求者：排車後不能改時間地址，其他欄位可以', () => {
  const roles = { ...none, ownsExisting: true };
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'scheduled', pickupTime: '11:00' }, existing: existing('scheduled', {}, 'ORG-A'), roles }), 'VALIDATION_ERROR');
  assert.ok(checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'scheduled', pickupTime: '09:00', note: 'x' }, existing: existing('scheduled', {}, 'ORG-A'), roles }));
});
ok('承接機構：退回、不受理、過期都撤銷；一般修改不撤銷', () => {
  const roles = { ...none, opsOfExisting: true };
  for (const s of ['open', 'rejected', 'expired']) {
    assert.equal(checkBookingWrite({ actorUserId: 'D', record: { id: 'B1', state: s }, existing: existing('claimed', {}, 'ORG-A'), roles }).revoke, true, s);
  }
  const r = checkBookingWrite({ actorUserId: 'D', record: { id: 'B1', state: 'claimed', note: 'x' }, existing: existing('claimed', {}, 'ORG-A'), roles });
  assert.equal(r.revoke, false);
  assert.equal(r.record.organizationId, 'ORG-A');
});
ok('承接機構：一般預約寫入不能排車（排車只走 command，ADR 0003）', () => {
  const roles = { ...none, opsOfExisting: true };
  for (const s of ['scheduled', 'partially_scheduled']) {
    throwsCode(() => checkBookingWrite({ actorUserId: 'D', record: { id: 'B1', state: s }, existing: existing('claimed', {}, 'ORG-A'), roles }), 'VALIDATION_ERROR');
  }
  throwsCode(() => checkBookingWrite({ actorUserId: 'D', record: { id: 'B1', state: 'scheduled' }, existing: existing('partially_scheduled', {}, 'ORG-A'), roles }), 'VALIDATION_ERROR');
});
ok('承接機構：已排車不能退回公開池', () => {
  throwsCode(() => checkBookingWrite({ actorUserId: 'D', record: { id: 'B1', state: 'open' }, existing: existing('scheduled', {}, 'ORG-A'), roles: { ...none, opsOfExisting: true } }), 'VALIDATION_ERROR');
});
ok('伺服器欄位沿用資料庫，前端送的被忽略', () => {
  const r = checkBookingWrite({ actorUserId: ME,
    record: { id: 'B1', state: 'open', requestedByUserId: 'OTHER', claimedByUserId: 'X', cancelledAt: 'now', previousOrganizationIds: ['Z'] },
    existing: existing('open', { previousOrganizationIds: ['ORG-OLD'] }), roles: { ...none, ownsExisting: true } });
  assert.equal(r.record.requestedByUserId, ME);
  assert.equal('claimedByUserId' in r.record, false);
  assert.equal('cancelledAt' in r.record, false);
  assert.deepEqual(r.record.previousOrganizationIds, ['ORG-OLD']);
});
ok('不合法的狀態被拒', () => {
  throwsCode(() => checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'hacked' }, existing: null, roles: none }), 'VALIDATION_ERROR');
});
ok('#110：一般寫入不能指定某一段由哪家機構負責（新增與修改、任何角色）', () => {
  const ASSIGN = ['assignedOrganizationId', 'assignedAt', 'assignedByUserId'];
  const leg = { id: 'L1', direction: 'outbound', assignedOrganizationId: 'ORG-X', assignedAt: '2026-10-08T00:00:00Z', assignedByUserId: ME };
  const created = checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'open', legs: [leg] }, existing: null, roles: none });
  assert.ok(ASSIGN.every((k) => !(k in created.record.legs[0])));
  const stored = existing('claimed', { legs: [{ id: 'L1', direction: 'outbound', status: 'pending', assignedOrganizationId: 'ORG-OLD' }] }, 'ORG-A');
  for (const roles of [{ ...none, ownsExisting: true }, { ...none, opsOfExisting: true }, { ...none, admin: true }]) {
    const r = checkBookingWrite({ actorUserId: ME, record: { id: 'B1', state: 'claimed', legs: [leg] }, existing: stored, roles });
    assert.ok(ASSIGN.every((k) => !(k in r.record.legs[0])), JSON.stringify(r.record.legs[0]));
  }
});
console.log(`booking-rules: ${pass} passed`);
