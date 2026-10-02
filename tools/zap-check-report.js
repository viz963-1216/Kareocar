#!/usr/bin/env node
'use strict';
/**
 * 讀 ZAP baseline 的 JSON 報告（-J），有高風險（riskcode 3）項目就以 exit 1 結束。
 * 中、低風險只列出，不讓 CI 失敗；完整報告另外保存為 artifact。
 *
 *   node tools/zap-check-report.js zap/report.json [.zap/accepted-high.txt]
 *
 * accepted-high.txt：已評估接受的高風險規則（每行一個 pluginid，# 開頭是註解，要寫明原因）。
 */
const fs = require('fs');

const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };

function summarize(report, accepted = new Set()) {
  const alerts = [];
  for (const site of (report && report.site) || []) {
    for (const a of site.alerts || []) {
      alerts.push({ site: site['@name'], pluginid: String(a.pluginid), name: a.name || a.alert,
        risk: Number(a.riskcode), count: Number(a.count) || (a.instances || []).length });
    }
  }
  const high = alerts.filter((a) => a.risk >= 3 && !accepted.has(a.pluginid));
  const acceptedHigh = alerts.filter((a) => a.risk >= 3 && accepted.has(a.pluginid));
  return { alerts, high, acceptedHigh };
}

function readAccepted(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}

if (require.main === module) {
  const [reportPath, acceptedPath] = process.argv.slice(2);
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`找不到 ZAP 報告：${reportPath || '(未指定)'}`);
    process.exit(2);
  }
  const { alerts, high, acceptedHigh } = summarize(JSON.parse(fs.readFileSync(reportPath, 'utf8')), readAccepted(acceptedPath));
  for (const a of alerts.sort((x, y) => y.risk - x.risk)) {
    console.log(`${RISK[a.risk] || a.risk}\t${a.pluginid}\t${a.name}（${a.count} 處）`);
  }
  if (acceptedHigh.length) console.log(`已評估接受的高風險：${acceptedHigh.map((a) => a.pluginid).join(', ')}`);
  if (high.length) {
    console.error(`\nZAP 發現 ${high.length} 類高風險項目，CI 失敗。詳見 artifact 的報告。`);
    process.exit(1);
  }
  console.log(`\nZAP：沒有高風險項目（共 ${alerts.length} 類提示）。`);
}

module.exports = { summarize, readAccepted };
