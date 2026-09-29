#!/usr/bin/env node
/**
 * 前端 JavaScript 的結構檢查：
 *
 *   1. index.html 不能有內嵌 <script>、inline 事件處理器（onclick= 等）或
 *      javascript: 網址——CSP 的 script-src 不允許 'unsafe-inline'，這些在瀏覽器
 *      裡會被擋下，而且不會有明顯的錯誤畫面
 *   2. index.html 以 <script src> 載入的每個本站 JS 檔都能被 V8 解析
 *      （編輯後括號不平衡這類錯誤，在這裡就會抓到）
 *
 *   node tools/check-inline-js.js
 */
const path = require('path');
const vm = require('vm');
const { readFrontendSource, ROOT } = require('./_frontend-source');

const { html, scripts } = readFrontendSource();
let failed = 0;

const lineOf = (index) => html.slice(0, index).split('\n').length;
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/i.test(m[1])) {
    if (m[2].trim()) { failed++; console.log(`  FAIL  index.html:${lineOf(m.index)} 有 src 的 <script> 內還帶了程式碼`); }
    continue;
  }
  if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;  // JSON 等資料區塊
  failed++;
  console.log(`  FAIL  index.html:${lineOf(m.index)} 有內嵌 <script>，CSP 會擋下`);
}
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
for (const m of markup.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) {
  failed++;
  console.log(`  FAIL  index.html 有 inline 事件處理器 ${m[1]}=，CSP 會擋下`);
}
if (/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(markup)) {
  failed++;
  console.log('  FAIL  index.html 有 javascript: 網址，CSP 會擋下');
}

if (!scripts.length) {
  console.error('index.html 沒有載入任何本站 JS 檔 — 抽取規則可能失效');
  process.exit(2);
}
for (const s of scripts) {
  const lines = s.code.split('\n').length;
  const name = path.relative(ROOT, s.file);
  try {
    new vm.Script(s.code, { filename: name });
    console.log(`  PASS  ${name.padEnd(16)} ${String(lines).padStart(5)} 行`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name.padEnd(16)} ${String(lines).padStart(5)} 行`);
    console.log(`        ${e.message}`);
  }
}

console.log(`\n${scripts.length} 個 JS 檔，${failed} 個問題`);
process.exit(failed ? 1 : 0);
