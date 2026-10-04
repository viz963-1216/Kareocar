/**
 * 回歸測試：身分回應必須帶上組織清單。
 *
 * 為什麼需要這一支：前端的 activeMembershipsForUser 會要求「成員資格指向的組織
 * 存在於本機」，否則那筆身分會被濾掉。組織以前是靠整份資料庫鏡像帶進來的；
 * 改成登入後才向伺服器載入之後，本機一開始是空的，剛註冊完的使用者就會看到
 * 「此帳號目前沒有有效身分」——帳號其實是好的，只是前端看不到那個組織。
 *
 * 所以這裡驗的是「每一個會建立 session 的端點都必須回傳組織」，而且組織必須
 * 涵蓋該身分所有成員資格指向的組織。
 */
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'pg') return require.resolve('./pg-psql-shim.js');
  return origResolve.call(this, r, ...a);
};
const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const session = fx.adapt(require(path.join(FN, 'v2-session.js')));
const register = fx.adapt(require(path.join(FN, 'v2-register-requester.js')));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (r) => ({ status: r.statusCode, ...JSON.parse(r.body) });
const post = (mod, body, headers) => mod.handler({ httpMethod: 'POST',
  body: JSON.stringify(body), headers: headers || {} });

// 前端那條判斷的等價實作：成員資格指向的組織必須看得到，否則身分等於不存在
const usableMemberships = (data) => {
  const orgs = new Set((data.organizations || []).filter(o => o.active !== false).map(o => o.id));
  return (data.memberships || []).filter(m => m.status === 'active' && orgs.has(m.organizationId));
};

(async () => {
  console.log('--- 註冊 ---');
  let regData = null, regToken = null;
  await t('註冊回應帶有組織清單', async () => {
    const r = parse(await post(register, { name: '新註冊者', email: 'newbie@example.com',
      phone: '0977000111', password: 'NewbiePass123' }));
    regData = r.data; regToken = r.data && r.data.sessionToken;
    return r.ok === true && Array.isArray(r.data.organizations) && r.data.organizations.length >= 1;
  });
  await t('註冊後的身分在前端判斷下是「有效」的（這就是當初壞掉的地方）', () =>
    usableMemberships(regData).length >= 1);
  await t('組織清單包含需求者組織', () =>
    (regData.organizations || []).some(o => o.id === 'ORG-REQ-001'));

  console.log('--- 登入 ---');
  let loginData = null, loginToken = null;
  await t('登入回應帶有組織清單', async () => {
    const r = parse(await post(login, { phone: '0977000111', password: 'NewbiePass123' },
      { 'x-nf-client-connection-ip': '198.51.100.60' }));
    loginData = r.data; loginToken = r.data && r.data.sessionToken;
    return r.ok === true && Array.isArray(r.data.organizations) && r.data.organizations.length >= 1;
  });
  await t('登入後的身分在前端判斷下是「有效」的', () => usableMemberships(loginData).length >= 1);

  console.log('--- 重新整理（resume session） ---');
  await t('session 回應帶有組織清單，身分依然有效', async () => {
    const r = parse(await session.handler({ httpMethod: 'POST',
      body: JSON.stringify({ sessionToken: loginToken }), headers: {} }));
    return r.ok === true && Array.isArray(r.data.organizations)
      && usableMemberships(r.data).length >= 1;
  });

  console.log('--- 調度員（多組織情境） ---');
  await withoutUser((c) => fx.setSeedPassword('USR-DISP1', 'DispatchPass123'));
  await t('調度員每一筆成員資格都找得到對應組織', async () => {
    const r = parse(await post(login, { phone: '0912000003', password: 'DispatchPass123' },
      { 'x-nf-client-connection-ip': '198.51.100.61' }));
    const orgs = new Set((r.data.organizations || []).map(o => o.id));
    return r.data.memberships.length >= 1
      && r.data.memberships.every(m => orgs.has(m.organizationId));
  });

  console.log('--- 只會拿到自己看得到的組織 ---');
  await t('需求者拿不到跟自己無關的服務單位', () => {
    const ids = (loginData.organizations || []).map(o => o.id);
    return !ids.includes('ORG-TP-001') && !ids.includes('ORG-TP-002');
  });
  await t('組織清單裡沒有多餘的敏感欄位', () => {
    const keys = new Set((loginData.organizations || []).flatMap(o => Object.keys(o)));
    return [...keys].every(k => ['id', 'type', 'name', 'active'].includes(k));
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
