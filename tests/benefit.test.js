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
ok('縣市規則：住在沒有規則的縣市顯示「尚無規則」（#100）', () => {
  const r = b.evaluate(rule({ jurisdiction: { city: '臺北市' } }), { serviceDate: '2099-01-01', facts: { cmsLevel: 4, residenceCity: '新北市' } });
  assert.equal(r.status, 'ruleset_required');
  assert.equal(r.estimatedSubsidy, null);
  assert.ok(r.warnings.some((w) => w.includes('新北市尚無規則')));
});
ok('事實欄位正規化（字串轉數字、布林）', () => {
  assert.deepEqual(b.normalizeFacts({ cmsLevel: '4', approvedCarePlan: 'true', eligibleCost: '' }),
    { cmsLevel: 4, residenceCity: null, residenceDistrict: null, approvedCarePlan: true, transportationApproved: null, identityCategory: null, eligibleCost: null });
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

// ---- #24：交通分區規則、公告解析
const t = require(path.join(__dirname, '..', 'netlify', 'functions', '_benefit-transport.js'));
const f = require(path.join(__dirname, '..', 'netlify', 'functions', '_benefit-fetch.js'));
const zoneRule = rule({ calculation: { mode: 'transport_zone', currency: 'TWD', cmsMin: 2,
  monthlyAmountByZone: { 1: 1680, 2: 1840, 3: 2000, 4: 2400 }, copayByZone: f.BUNDLED_COPAY } });
ok('交通分區：縣市判斷分區，偏遠行政區算第 4 區', () => {
  assert.equal(t.transportZone('臺北市'), 1);
  assert.equal(t.transportZone('台中市西屯區'), 2);
  assert.equal(t.transportZone('新北市烏來區'), 4);
  assert.equal(t.transportZone('火星'), null);
});
ok('交通分區規則：月額度 ×（100 − 自付%），依福利身分', () => {
  const general = b.evaluate(zoneRule, { serviceDate: '2099-01-01', facts: { cmsLevel: 4, residenceCity: '新北市', identityCategory: 'general' } });
  assert.equal(general.estimatedSubsidy, 1343);
  assert.equal(general.estimatedCopay, 496);
  // #100：預約畫面顯示每月補助額度與自付比例
  assert.equal(general.monthlyLimit, 1840); // 新北市是第 2 區
  assert.equal(general.copayRate, 27);
  const low = b.evaluate(zoneRule, { serviceDate: '2099-01-01', facts: { cmsLevel: 4, residenceCity: '臺北市', identityCategory: 'low_income' } });
  assert.equal(low.estimatedSubsidy, 1680);
});
ok('住址判斷縣市與鄉鎮市區（臺／台視為相同）', () => {
  assert.deepEqual(b.residenceFromAddress('新北市板橋區文化路一段188號'), { city: '新北市', district: '板橋區' });
  assert.deepEqual(b.residenceFromAddress('臺東縣成功鎮中山路1號'), { city: '台東縣', district: '成功鎮' });
  assert.deepEqual(b.residenceFromAddress('火星某處'), { city: null, district: null });
});
ok('規則轄區寫「臺北市」，住址是「台北市」也算符合', () => {
  const r = b.evaluate({ ...zoneRule, jurisdiction: { country: 'TW', city: '臺北市' } },
    { serviceDate: '2099-01-01', facts: { cmsLevel: 4, residenceCity: '台北市', identityCategory: 'general' } });
  assert.equal(r.status, 'eligible_estimate');
});
ok('交通分區規則：缺居住縣市或福利身分就是資料不足', () => {
  const r = b.evaluate(zoneRule, { serviceDate: '2099-01-01', facts: { cmsLevel: 4 } });
  assert.equal(r.status, 'insufficient_data');
  assert.deepEqual(r.missingFields, ['residenceCity', 'identityCategory']);
});
ok('交通分區規則：月額度或自付比例不合理時不能存', () => {
  const bad = b.normalizeRulesetInput({ code: 'x', version: '1', name: 'n', effectiveFrom: '2026-01-01',
    calculation: { mode: 'transport_zone', monthlyAmountByZone: { 1: 0 }, copayByZone: {} } });
  assert.ok(b.validateRuleset(bad).some((e) => /月額度/.test(e)));
});
const sample = (amounts, cms = 2) => `<html><body><h2>長照服務給付額度表</h2><table><tr><th>交通接送（月）</th></tr>
<tr><td>第一區：${amounts[0]}元 第二區：${amounts[1]}元 第三區：${amounts[2]}元 第四區：${amounts[3]}元</td></tr></table>
<p>符合長照需要等級${cms}級以上者</p><script>var x='第一區：9元';</script></body></html>`;
ok('公告解析：取出四區月額度（含千分位）與等級門檻，忽略 script', () => {
  const p = f.parse1966(sample(['1,680', '1,840', '2,000', '2,400']));
  assert.deepEqual(p, { cmsMin: 2, monthlyAmountByZone: { 1: 1680, 2: 1840, 3: 2000, 4: 2400 } });
  assert.equal(f.parse1966(sample(['1,700', '1,900', '2,100', '2,500'], 3)).monthlyAmountByZone[4], 2500);
});
ok('公告解析：格式改變時回報問題，不猜數字', () => {
  const p = f.parse1966('<p>交通接送 請洽各縣市</p>');
  assert.ok(Array.isArray(p.problems) && p.problems.length === 2);
});
ok('差異：只列出有變的欄位', () => {
  const before = { cmsMin: 2, monthlyAmountByZone: { 1: 1680, 2: 1840, 3: 2000, 4: 2400 }, copayByZone: f.BUNDLED_COPAY };
  const after = { ...before, monthlyAmountByZone: { ...before.monthlyAmountByZone, 4: 2500 } };
  assert.deepEqual(f.diffPolicies(before, after), [{ field: '第 4 區月額度', from: 2400, to: 2500 }]);
  assert.ok(f.diffPolicies(null, after).length > 4);
});
const fs = require('node:fs');
ok('瀏覽器不再連政府網站或 r.jina.ai（CSP 與前端程式）', () => {
  const headers = fs.readFileSync(path.join(__dirname, '..', '_headers'), 'utf8');
  const csp = headers.match(/connect-src([^;]*)/)[1];
  assert.equal(csp.trim(), "'self'");
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.ok(!/fetch\([^)]*(jina|gov\.tw)/.test(app) && !app.includes("'https://r.jina.ai/'"));
});

// #101：預約上的補助資訊狀態（依試算結果、是否已接案、承接機構是否為長照特約）
const zoneEstimate = { status: 'eligible_estimate', estimatedSubsidy: 1343, estimatedCopay: 496, monthlyLimit: 1840, copayRate: 27, zone: 2,
  facts: { residenceCity: '新北市' } };
ok('預約補助狀態：沒有試算 → 尚未試算（不擋預約）', () => {
  assert.equal(b.bookingBenefitView(null, { claimed: false }).state, 'assessment_required');
  assert.equal(b.bookingBenefitView({ status: 'assessment_required' }, { claimed: true, ltcActive: true }).state, 'assessment_required');
});
ok('預約補助狀態：尚無規則、不符合、資料不足照試算結果，不顯示金額', () => {
  for (const status of ['ruleset_required', 'not_eligible', 'insufficient_data']) {
    const v = b.bookingBenefitView({ status, warnings: ['x'], reasons: ['y'] }, { claimed: true, ltcActive: true });
    assert.equal(v.state, status);
    assert.equal(v.monthlyLimit, undefined);
  }
});
ok('預約補助狀態：接案前顯示「若由長照特約機構承接」的額度與比例', () => {
  const v = b.bookingBenefitView(zoneEstimate, { claimed: false });
  assert.deepEqual([v.state, v.monthlyLimit, v.copayRate, v.zone], ['pre_claim', 1840, 27, 2]);
});
ok('預約補助狀態：承接機構是長照特約 → 顯示額度與比例', () => {
  const v = b.bookingBenefitView(zoneEstimate, { claimed: true, ltcActive: true });
  assert.deepEqual([v.state, v.monthlyLimit, v.copayRate], ['ltc_contracted', 1840, 27]);
});
ok('預約補助狀態：承接機構不是長照特約（含縣市不符、過期）→ 說明原因，不顯示金額', () => {
  const v = b.bookingBenefitView(zoneEstimate, { claimed: true, ltcActive: false });
  assert.equal(v.state, 'not_ltc');
  assert.equal(v.city, '新北市');
  assert.equal(v.monthlyLimit, undefined);
});
console.log(`benefit: ${pass} passed`);
