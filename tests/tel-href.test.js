'use strict';
/**
 * tel: 連結的跳脫。電話號碼來自使用者輸入（聯絡人），原本直接插進 href="tel:${...}"，
 * 含引號的值可以跳出屬性、注入其他屬性或標籤。
 *
 * 斷言兩件事：telHref 只輸出 tel: 加數字（可帶開頭 +），而且前端程式裡不再有
 * 未經 telHref 的 tel: 插值。
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFrontendSource } = require('../tools/_frontend-source');

const { js } = readFrontendSource();
const line = js.split('\n').find((l) => l.startsWith('const telHref = '));
assert.ok(line, '找不到 telHref 定義');
const escapeLine = js.split('\n').find((l) => l.startsWith('const escapeHTML = '));
const ctx = vm.createContext({});
vm.runInContext(`${escapeLine}\n${line}\nglobalThis.telHref=telHref;globalThis.escapeHTML=escapeHTML;`, ctx);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  PASS', name); };

ok('一般手機號碼', () => assert.equal(ctx.telHref('0912345678'), 'tel:0912345678'));
ok('帶分隔符號的號碼只留數字', () => assert.equal(ctx.telHref('0912-345 678'), 'tel:0912345678'));
ok('國際格式保留開頭 +', () => assert.equal(ctx.telHref('+886 912 345 678'), 'tel:+886912345678'));
ok('雙引號與屬性注入被清掉', () => {
  const href = ctx.telHref('0912345678" onmouseover="alert(1)');
  assert.equal(href, 'tel:09123456781');
  assert.ok(!/["'<> ]/.test(href));
});
ok('javascript: 與標籤被清掉', () => {
  const href = ctx.telHref('javascript:alert(1)//<script>0912</script>');
  assert.ok(href.startsWith('tel:') && /^tel:\+?\d+$/.test(href), href);
});
ok('沒有任何數字時回空字串（呼叫端據此不產生連結）', () => {
  assert.equal(ctx.telHref('"><img src=x>'), '');
  assert.equal(ctx.telHref(null), '');
  assert.equal(ctx.telHref(undefined), '');
});
ok('放進 href 屬性後無法跳出屬性', () => {
  const attr = `href="${ctx.escapeHTML(ctx.telHref('0912" autofocus onfocus="x'))}"`;
  assert.equal((attr.match(/"/g) || []).length, 2, attr);
});
ok('前端程式沒有未經 telHref 的 tel: 插值', () => {
  const raw = js.match(/tel:\$\{/g) || [];
  // telHref 本身的樣板字串是唯一允許的一處
  assert.equal(raw.length, 1, `找到 ${raw.length} 處 tel:\${`);
  assert.ok(line.includes('tel:${'), 'tel:${ 只能出現在 telHref 定義裡');
});

console.log(`tel-href: ${pass} passed`);
