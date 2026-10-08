'use strict';
/**
 * 畫面用語照 CONTEXT.md 統一（#83）。
 *
 * 掃畫面會出現的文字：js/app.js、js/polish.js 與伺服器函式裡的字串（不含註解、正規表示式），
 * 以及 index.html 的文字與屬性值。出現用語表列為避免的叫法就失敗，避免之後又寫回去。
 * 資料庫函式的舊訊息在伺服器轉成回應時換掉（_glossary.js），這裡一併測。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { toGlossary } = require(path.join(ROOT, 'netlify', 'functions', '_glossary.js'));

const AVOID = ['承接單位', '服務單位', '服務組織', '公司', '組織', '車隊', '業者', '客戶', '會員', '個案', '特約廠商', '合約單位',
  '補貼', '津貼', '訂單', '需求單', '案件', '行程段', '派車單', '趟次', '公開池', '接案池', '公開需求', '搶單', '受理', '派車',
  '建立行程', '併車', '拼車', '案家'];
// 例外：公司的法定名稱（例如「安心交通有限公司」）；車輛群組的資料名稱（「X 車隊」，畫面不顯示，改名時依名稱比對）；
// 「指派車輛」是指派＋車輛，不是派車
const ALLOWED = [/有限公司/g, /^… 車隊$/, /指派車輛/g];

/** 字串字面值的內容（略過註解與正規表示式；樣板字串只取文字部分） */
function stringLiterals(src) {
  const out = []; const n = src.length; const stack = []; let i = 0; let depth = 0; let lastSig = ''; let lastWord = '';
  const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else']);
  const regexAllowed = () => KW.has(lastWord) || lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig);
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out.push(src.slice(i + 1, j)); i = j + 1; lastSig = '"'; lastWord = ''; continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1].depth === depth)) {
      // 樣板字串整段一起檢查（${…} 換成 …），英文詞被 ${} 隔開時才抓得到
      const frame = c === '}' ? stack.pop() : { depth, parts: [] };
      let j = i + 1; const start = j;
      while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) { if (src[j] === '\\') j++; j++; }
      frame.parts.push(src.slice(start, j));
      if (src[j] === '`') { out.push(frame.parts.join('…')); i = j + 1; lastSig = '"'; lastWord = ''; continue; }
      frame.depth = depth; stack.push(frame); i = j + 2; lastSig = '{'; lastWord = ''; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++; while (j < n && /[a-z]/i.test(src[j])) j++;
      i = j; lastSig = '"'; lastWord = ''; continue;
    }
    if (c === '{') depth++; else if (c === '}') depth--;
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++; lastWord = src.slice(i, j); lastSig = 'a'; i = j; continue; }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }
  return out;
}

function avoided(text) {
  let t = text;
  for (const re of ALLOWED) t = t.replace(re, '');
  const hits = AVOID.filter((w) => t.includes(w));
  if (/[一-鿿]/.test(t) && /\b(Leg|Legs|Trip|Trips|Booking|Bookings)\b(?![.(])/.test(t)) hits.push('英文 Leg／Trip／Booking');
  return hits;
}

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };

ok('畫面字串沒有用語表避免的叫法（app.js、polish.js、伺服器函式）', () => {
  const files = ['js/app.js', 'js/polish.js',
    // _glossary.js 是舊叫法的對照表，本來就會有
    ...fs.readdirSync(path.join(ROOT, 'netlify', 'functions')).filter((f) => f.endsWith('.js') && f !== '_glossary.js')
      .map((f) => `netlify/functions/${f}`)];
  const found = [];
  for (const f of files) {
    for (const s of stringLiterals(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      const hits = avoided(s); if (hits.length) found.push(`${f}：${hits.join('、')}｜${s.slice(0, 60)}`);
    }
  }
  assert.deepEqual(found, []);
});
ok('index.html 的文字與屬性沒有用語表避免的叫法', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const texts = [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]).concat([...html.matchAll(/="([^"]*[一-鿿][^"]*)"/g)].map((m) => m[1]));
  const found = texts.flatMap((t) => avoided(t).map((h) => `${h}｜${t.trim().slice(0, 60)}`));
  assert.deepEqual(found, []);
});
ok('掃描本身抓得到：註解與正規表示式不算，字串算', () => {
  const lits = stringLiterals("// 公司\nconst a='組織', r=/公司/g, t=`派車${x}公開池`; /* 搶單 */");
  assert.deepEqual(lits.flatMap(avoided).sort(), ['公開池', '派車', '組織'].sort());
});
ok('資料庫函式的舊訊息換成用語表的叫法', () => {
  assert.equal(toGlossary('已被其他服務單位接走'), '已被其他接送機構接案');
  assert.equal(toGlossary('沒有權限代表這個組織承接案件'), '沒有權限代表這個機構接案');
  assert.equal(toGlossary('此組織不是可承接案件的有效服務組織'), '此機構不是可接案的有效接送機構');
  assert.equal(toGlossary('機構類型只能是交通／車隊公司或長照／日照機構'), '機構類型只能是交通接送機構或長照／日照機構');
  assert.equal(toGlossary(null), '');
});

console.log(`glossary: ${pass} passed`);
