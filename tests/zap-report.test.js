'use strict';
/** tools/zap-check-report.js 的離線測試：只有未接受的高風險會讓 CI 失敗。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { summarize } = require(path.join(__dirname, '..', 'tools', 'zap-check-report.js'));

const report = { site: [{ '@name': 'https://example.test', alerts: [
  { pluginid: '10038', name: 'CSP 未設定', riskcode: '2', count: '3' },
  { pluginid: '40012', name: 'XSS（反射型）', riskcode: '3', count: '1' },
  { pluginid: '10021', name: 'X-Content-Type-Options', riskcode: '1', instances: [{}, {}] }
] }] };

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };
ok('高風險列入失敗清單，中低風險不列入', () => {
  const r = summarize(report);
  assert.deepEqual(r.high.map((a) => a.pluginid), ['40012']);
  assert.equal(r.alerts.length, 3);
  assert.equal(r.alerts.find((a) => a.pluginid === '10021').count, 2);
});
ok('已評估接受的高風險不讓 CI 失敗，但仍列出', () => {
  const r = summarize(report, new Set(['40012']));
  assert.equal(r.high.length, 0);
  assert.deepEqual(r.acceptedHigh.map((a) => a.pluginid), ['40012']);
});
ok('空報告沒有失敗項目', () => assert.equal(summarize({}).high.length, 0));
console.log(`zap-report: ${pass} passed`);
