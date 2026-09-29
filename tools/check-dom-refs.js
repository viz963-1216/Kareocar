#!/usr/bin/env node
/**
 * Cross-checks DOM id usage in index.html and the JS files it loads.
 *
 * Reports:
 *   - ids referenced from script ($('x') / getElementById('x')) that no static
 *     element declares and no code creates dynamically — the failure mode after
 *     deleting markup but leaving its handler behind
 *   - duplicate static ids
 *
 * Ids that only ever appear inside generated HTML strings are resolved by also
 * scanning for id="x" anywhere in the file, including template literals.
 *
 *   node tools/check-dom-refs.js
 */
const { readFrontendSource } = require('./_frontend-source');

const source = readFrontendSource();
// markup 加上所有 JS：id 可能宣告在靜態 HTML，也可能在 JS 的樣板字串裡
const html = `${source.html}\n${source.js}`;

// Every id="..." occurrence, whether in static markup or in a template string.
const declared = new Map();
for (const m of html.matchAll(/\bid\s*=\s*["']([A-Za-z_][\w:.-]*)["']/g)) {
  declared.set(m[1], (declared.get(m[1]) || 0) + 1);
}
// Ids assigned in code: el.id = 'x'
for (const m of html.matchAll(/\.id\s*=\s*["']([A-Za-z_][\w:.-]*)["']/g)) {
  declared.set(m[1], (declared.get(m[1]) || 0) + 1);
}

const referenced = new Set();
for (const m of html.matchAll(/(?:getElementById|\$)\(\s*["']([A-Za-z_][\w:.-]*)["']\s*\)/g)) {
  referenced.add(m[1]);
}

const missing = [...referenced].filter((id) => !declared.has(id)).sort();

// Static markup only, so a duplicate here is a real collision.
const staticHtml = source.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const staticIds = new Map();
for (const m of staticHtml.matchAll(/\bid\s*=\s*["']([A-Za-z_][\w:.-]*)["']/g)) {
  staticIds.set(m[1], (staticIds.get(m[1]) || 0) + 1);
}
const duplicates = [...staticIds.entries()].filter(([, n]) => n > 1);

console.log(`靜態 DOM id：${staticIds.size} 個`);
console.log(`程式碼取用的 id：${referenced.size} 個`);

if (duplicates.length) {
  console.log(`\n重複的靜態 id（${duplicates.length}）：`);
  duplicates.forEach(([id, n]) => console.log(`  ${id} ×${n}`));
}

if (missing.length) {
  console.log(`\n取用了但找不到宣告的 id（${missing.length}）：`);
  missing.forEach((id) => console.log(`  ${id}`));
} else {
  console.log('\n沒有懸空的 id 參照');
}

process.exit(missing.length || duplicates.length ? 1 : 0);
