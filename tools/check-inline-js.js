#!/usr/bin/env node
/**
 * Syntax-checks every inline <script> block in index.html.
 *
 * index.html carries all of its JavaScript inline, so a normal linter sees
 * nothing. This extracts each block and runs it through the V8 parser, which
 * is what catches a mis-balanced brace after an edit.
 *
 *   node tools/check-inline-js.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const blocks = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue;           // external, nothing inline
  if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue; // data blocks
  const startLine = html.slice(0, m.index).split('\n').length;
  const id = (attrs.match(/id\s*=\s*["']([^"']+)["']/) || [])[1] || '(anonymous)';
  blocks.push({ id, startLine, code: m[2] });
}

if (!blocks.length) {
  console.error('找不到任何 inline script — 抽取規則可能失效');
  process.exit(2);
}

let failed = 0;
for (const b of blocks) {
  const lines = b.code.split('\n').length;
  try {
    new vm.Script(b.code, { filename: `index.html:${b.startLine} <${b.id}>` });
    console.log(`  PASS  行 ${String(b.startLine).padStart(6)}  ${String(lines).padStart(5)} 行  ${b.id}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  行 ${String(b.startLine).padStart(6)}  ${String(lines).padStart(5)} 行  ${b.id}`);
    console.log(`        ${e.message}`);
  }
}

console.log(`\n${blocks.length} 個 inline script，${failed} 個語法錯誤`);
process.exit(failed ? 1 : 0);
