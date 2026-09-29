'use strict';
/**
 * 讀取前端原始碼：index.html 與它以 <script src> 載入的本站 JS 檔（依載入順序）。
 *
 * JavaScript 原本全部內嵌在 index.html，檢查工具與測試都直接讀那一個檔；拆成
 * js/ 底下的獨立檔案之後，改由這裡統一回傳，避免每支工具各自猜檔案位置。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFrontendSource(root = ROOT) {
  const htmlFile = path.join(root, 'index.html');
  const html = fs.readFileSync(htmlFile, 'utf8');
  const scripts = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = (m[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    if (/^(https?:)?\/\//i.test(src)) continue;  // 外部網域不屬於本站原始碼
    const file = path.join(root, src.replace(/^\//, ''));
    scripts.push({ src, file, code: fs.readFileSync(file, 'utf8') });
  }
  return { html, htmlFile, scripts, js: scripts.map((s) => s.code).join('\n') };
}

module.exports = { readFrontendSource, ROOT };
