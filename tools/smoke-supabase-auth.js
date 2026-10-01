#!/usr/bin/env node
'use strict';
/**
 * 用真的 Supabase Auth（Staging）走一遍 netlify/functions/_supabase-auth.js 的每個呼叫。
 *
 * CI 只用假的 Supabase Auth；這支確認真實 API 的回應格式、金鑰與 JWT 簽章方式
 * 跟程式的假設一致。不碰資料庫，結束時刪掉自己建立的測試帳號。
 *
 *   node tools/smoke-supabase-auth.js
 *
 * 金鑰以隱藏輸入讀取，只放在這個行程的記憶體裡，不寫檔、不印出。
 * 拒絕對正式專案執行。
 */
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const PROD_REF = 'vcbhtlwkzavqvxthicis';
const DEFAULT_STAGING_REF = 'hffoakcgntggykvugfht';

// 同一個 readline 介面讀完所有輸入；隱藏輸入時只顯示提示文字，不回顯按鍵
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
const write = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
if (write) rl._writeToOutput = (s) => { if (!muted) write(s); };
// 逐行讀取（緩衝起來，貼上多行或管線輸入都不會漏）
const lines = rl[Symbol.asyncIterator]();
async function prompt(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  return String(value || '').trim();
}

let pass = 0, fail = 0;
function report(ok, name, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  （${detail}）` : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    report(true, name, detail || '');
    return true;
  } catch (error) {
    report(false, name, `${error.code || 'ERROR'}：${error.message}`);
    return false;
  }
}
async function expectFail(name, fn, code) {
  try {
    await fn();
    report(false, name, '預期失敗，實際成功');
  } catch (error) {
    report(!code || error.code === code, name, `${error.code}`);
  }
}
const decode = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[0], 'base64url').toString());

(async () => {
  console.log('\n安心接送 · Supabase Auth 冒煙測試（Staging）\n');
  let ref = '';
  while (true) {
    const input = await prompt(`Staging 專案 ref（直接按 Enter 使用 ${DEFAULT_STAGING_REF}）：`);
    // 貼成整個網址也接受：只取 /project/ 後面那段
    ref = (input.match(/project\/([a-z0-9]{20})/) || [])[1] || input || DEFAULT_STAGING_REF;
    if (/^[a-z0-9]{20}$/.test(ref)) break;
    console.log(`  「${ref.slice(0, 40)}」不是專案 ref（20 個小寫英數字）。直接按 Enter 即可。`);
  }
  if (ref === PROD_REF) { console.log('拒絕執行：這是正式專案。'); process.exit(2); }
  console.log(`  使用 ${ref}`);
  process.env.SUPABASE_URL = `https://${ref}.supabase.co`;
  process.env.SUPABASE_ANON_KEY = await prompt('Publishable key（或 legacy anon key）：', { hidden: true });
  process.env.SUPABASE_SERVICE_ROLE_KEY = await prompt('Secret key（或 legacy service_role key）：', { hidden: true });
  if (!process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('沒有輸入金鑰，結束。'); process.exit(2);
  }
  const jwtSecret = await prompt('Legacy JWT secret（新版專案留空，按 Enter）：', { hidden: true });
  if (jwtSecret) process.env.SUPABASE_JWT_SECRET = jwtSecret;
  process.env.SUPABASE_AUTH_DEBUG = '1';
  rl.close();

  const supa = require(path.join(__dirname, '..', 'netlify', 'functions', '_supabase-auth.js'));
  const phone = `+8869${String(crypto.randomInt(10_000_000, 99_999_999))}`;
  const pw1 = `Smoke-${crypto.randomBytes(9).toString('base64url')}`;
  const pw2 = `Smoke-${crypto.randomBytes(9).toString('base64url')}`;
  let userId = null, tokens = null;

  console.log(`\n測試帳號：${phone}（結束時刪除）\n`);
  try {
    await step('建立已驗證手機的使用者（admin API）', async () => {
      userId = await supa.createUser({ phoneE164: phone, password: pw1 });
      if (!/^[0-9a-f-]{36}$/.test(userId)) throw Object.assign(new Error(`ID 不是 UUID：${userId}`), { code: 'SHAPE' });
      return `id=${userId}`;
    });
    if (!userId) return;

    const loggedIn = await step('手機號碼＋密碼登入', async () => {
      tokens = await supa.signInWithPassword(phone, pw1);
      return `expires_in=${tokens.expiresIn}，alg=${decode(tokens.accessToken).alg}`;
    });
    if (!loggedIn) {
      console.log('\n  登入失敗時最常見的原因：Staging 沒有啟用 Phone 登入（Authentication → Sign In / Providers → Phone）。');
      return;
    }

    await step('驗證 access token 簽章（HS256 用 JWT secret；ES256／RS256 用 JWKS）', async () => {
      const c = await supa.verifyAccessToken(tokens.accessToken);
      if (c.userId !== userId) throw Object.assign(new Error(`sub ${c.userId} ≠ ${userId}`), { code: 'SHAPE' });
      return `sub 相符，iat=${c.iat}`;
    });
    await expectFail('竄改過的 token 被拒', () => supa.verifyAccessToken(`${tokens.accessToken.slice(0, -4)}AAAA`), 'SESSION_INVALID');

    await step('以 refresh token 換新 token，新 token 也驗得過', async () => {
      tokens = await supa.refresh(tokens.refreshToken);
      const c = await supa.verifyAccessToken(tokens.accessToken);
      return `sub=${c.userId === userId ? '相符' : '不符'}`;
    });

    await step('admin 更新密碼', () => supa.updateUser(userId, { password: pw2 }));
    await expectFail('舊密碼登不進去', () => supa.signInWithPassword(phone, pw1), 'INVALID_CREDENTIALS');
    await step('新密碼可以登入', async () => { tokens = await supa.signInWithPassword(phone, pw2); });

    const lastRefresh = tokens.refreshToken;
    await step('登出全部裝置（scope=global）', () => supa.signOut(tokens.accessToken, 'global'));
    await expectFail('登出後 refresh token 不能再換 token', () => supa.refresh(lastRefresh));

    await expectFail('同一支手機重複建立被拒', () => supa.createUser({ phoneE164: phone, password: pw1 }), 'PHONE_EXISTS');
  } finally {
    if (userId) {
      await step('刪除測試帳號', () => supa.deleteUser(userId));
      await expectFail('刪除後登不進去', () => supa.signInWithPassword(phone, pw2), 'INVALID_CREDENTIALS');
    }
    console.log(`\n結果：${pass} 通過 / ${fail} 失敗\n`);
    console.log('請把上面的結果（PASS／FAIL 那些行）貼回給 Claude；裡面不含任何金鑰或 token。\n');
    process.exit(fail ? 1 : 0);
  }
})();
