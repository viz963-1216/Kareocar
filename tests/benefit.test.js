'use strict';
/** netlify/functions/_benefit.js 的離線測試：規則判斷、金額計算、草稿與核准檢查。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const b = require(path.join(__dirname, '..', 'netlify', 'functions', '_benefit.js'));

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };
const rule = (over = {}) => ({
  id: 'R1', code: 'transportation_primary', version: '2026.1', name: '合成規則', serviceType: 'transportation',
  jurisdiction: { country: 'TW', city: null }, effectiveFrom: '2026-01-01', effectiveTo: null, status: 'approved',
  conditions: { cmsLevels: [2, 3, 4, 5, 6, 7, 8], requireApprovedCarePlan: null, requireTransportationApproved: null, identityCategories: [], residenceCities: [] },
  calculation: { mode: 'fixed_amount', currency: 'TWD', amount: 300, percentage: null, maxAmount: null },
  source: { agency: '衛福部', title: '合成公告', url: 'https://example.gov.tw/x', checkedAt: '2026-09-01' }, ...over
});

ok('沒有已核准的規則：ruleset_required，沒有金額', () => {
  const r = b.evaluate(null, { serviceDate: '2099-01-01', facts: { cmsLevel: 4 } });
  assert.equal(r.status, 'ruleset_required');
  assert.equal(r.estimatedSubsidy, null);
});
ok('固定金額：符合等級就給規則金額', () => {
  const r = b.evaluate(rule(), { serviceDate: '2099-01-01', facts: { cmsLevel: 4, eligibleCost: 500 } });
  assert.equal(r.status, 'eligible_estimate');
  assert.equal(r.estimatedSubsidy, 300);
  assert.equal(r.estimatedCopay, 200);
});
ok('等級不符：not_eligible、補助 0', () => {
  const r = b.evaluate(rule(), { serviceDate: '2099-01-01', facts: { cmsLevel: 1 } });
  assert.equal(r.status, 'not_eligible');
  assert.equal(r.estimatedSubsidy, 0);
});
ok('缺等級：insufficient_data，列出缺的欄位', () => {
  const r = b.evaluate(rule(), { serviceDate: '2099-01-01', facts: {} });
  assert.equal(r.status, 'insufficient_data');
  assert.deepEqual(r.missingFields, ['cmsLevel']);
});
ok('比例計算有上限', () => {
  const r = b.evaluate(rule({ calculation: { mode: 'percentage', currency: 'TWD', amount: null, percentage: 70, maxAmount: 500 } }),
    { serviceDate: '2099-01-01', facts: { cmsLevel: 4, eligibleCost: 1000 } });
  assert.equal(r.estimatedSubsidy, 500);
  assert.equal(r.estimatedCopay, 500);
});
ok('比例計算缺可補助費用：insufficient_data', () => {
  const r = b.evaluate(rule({ calculation: { mode: 'percentage', percentage: 70 } }), { serviceDate: '2099-01-01', facts: { cmsLevel: 4 } });
  assert.deepEqual(r.missingFields, ['eligibleCost']);
});
ok('服務日期在有效期間外：not_eligible', () => {
  const r = b.evaluate(rule({ effectiveTo: '2026-12-31' }), { serviceDate: '2099-01-01', facts: { cmsLevel: 4 } });
  assert.equal(r.status, 'not_eligible');
});
ok('縣市規則：居住地不符不給', () => {
  const r = b.evaluate(rule({ jurisdiction: { city: '臺北市' } }), { serviceDate: '2099-01-01', facts: { cmsLevel: 4, residenceCity: '新北市' } });
  assert.equal(r.status, 'not_eligible');
});
ok('事實欄位正規化（字串轉數字、布林）', () => {
  assert.deepEqual(b.normalizeFacts({ cmsLevel: '4', approvedCarePlan: 'true', eligibleCost: '' }),
    { cmsLevel: 4, residenceCity: null, approvedCarePlan: true, transportationApproved: null, identityCategory: null, eligibleCost: null });
});
ok('草稿檢查：缺版本、名稱、生效日', () => {
  const r = b.normalizeRulesetInput({ code: 'x' });
  const errors = b.validateRuleset(r);
  assert.ok(errors.some((e) => /版本/.test(e)) && errors.some((e) => /名稱/.test(e)) && errors.some((e) => /生效日/.test(e)));
});
ok('核准檢查：要有來源機關、標題、官方網址、查核日期', () => {
  const r = b.normalizeRulesetInput({ code: 'x', version: '1', name: 'n', effectiveFrom: '2026-01-01' });
  assert.equal(b.validateRuleset(r).length, 0);
  const errors = b.validateRuleset(r, { forApproval: true });
  assert.equal(errors.length, 4);
});
ok('輸入正規化：等級清單、計算方式不合法改成 none', () => {
  const r = b.normalizeRulesetInput({ conditions: { cmsLevels: '4,2,9,x,2' }, calculation: { mode: 'magic' } });
  assert.deepEqual(r.conditions.cmsLevels, [2, 4]);
  assert.equal(r.calculation.mode, 'none');
});
console.log(`benefit: ${pass} passed`);
