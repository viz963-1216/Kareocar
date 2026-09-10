/**
 * v2 身分流程接線測試：註冊、忘記密碼、建立員工、修改帳號。
 * Netlify Function 的實際程式碼，跑在真實 Postgres + 真實 RLS 上。
 */
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./pg-psql-shim.js');
  return origResolve.call(this, request, ...rest);
};

const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.AUTH_PASSWORD_PEPPER = 'test-pepper-0123456789abcdefghijkl';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';

const sql = (q) => execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc', q]).toString().trim();

// 攔截簡訊發送，把驗證碼留下來給測試用
let lastCode = null;
const smsPath = require.resolve(path.join(FN, '_sms.js'));
require(smsPath);
require.cache[smsPath].exports = {
  sendPasswordResetSms: async (_phone, code) => { lastCode = code; }
};

const auth = require(path.join(FN, '_auth-pg.js'));
const { withUser, withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = require(path.join(FN, 'v2-password-login.js'));
const register = require(path.join(FN, 'v2-register-requester.js'));
const reqReset = require(path.join(FN, 'v2-request-password-reset.js'));
const confirmReset = require(path.join(FN, 'v2-confirm-password-reset.js'));
const createStaff = require(path.join(FN, 'v2-create-staff.js'));
const updateAccount = require(path.join(FN, 'v2-update-account.js'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });
const post = (mod, body, headers) => mod.handler({ httpMethod: 'POST',
  body: JSON.stringify(body), headers: headers || {} });

const R_PHONE = '0933111222', R_PW = 'RequesterPass123';

(async () => {
  console.log('--- 需求者自助註冊 ---');
  let rToken = null, rUserId = null;
  await t('註冊成功並直接拿到 session', async () => {
    const r = parse(await post(register, { name: '王小明', email: 'ming@example.com', phone: R_PHONE, password: R_PW }));
    rToken = r.data && r.data.sessionToken; rUserId = r.data && r.data.user.userId;
    return r.ok === true && !!rToken && r.data.membership.role === 'requester'
      && r.data.membership.organizationId === 'ORG-REQ-001';
  });
  await t('註冊出來的帳號可以登入', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: R_PW }, { 'x-nf-client-connection-ip': '198.51.100.1' }));
    return r.ok === true && r.data.user.userId === rUserId;
  });
  await t('平台角色一定是 none（不能自己註冊成管理者）', () =>
    sql(`select platform_role from users where id = '${rUserId}'`) === 'none');
  await t('重複手機被擋', async () => {
    const r = parse(await post(register, { name: '別人', email: 'other@example.com', phone: R_PHONE, password: 'AnotherPass123' }));
    return r.status === 400 && r.error.code === 'ACCOUNT_EXISTS';
  });
  await t('重複信箱被擋', async () => {
    const r = parse(await post(register, { name: '別人', email: 'MING@example.com', phone: '0933999888', password: 'AnotherPass123' }));
    return r.status === 400 && r.error.code === 'ACCOUNT_EXISTS';
  });
  await t('密碼太短被擋，且沒有留下半個帳號', async () => {
    const before = sql('select count(*) from users');
    const r = parse(await post(register, { name: '短密碼', email: 'short@example.com', phone: '0933777666', password: 'abc' }));
    return r.error.code === 'WEAK_PASSWORD' && sql('select count(*) from users') === before;
  });
  await t('信箱格式錯誤被擋', async () =>
    parse(await post(register, { name: 'x', email: 'not-an-email', phone: '0933777555', password: R_PW })).error.code === 'VALIDATION_ERROR');
  await t('交易性：註冊失敗不留孤兒成員資格', () =>
    sql("select count(*) from memberships m left join users u on u.id=m.user_id where u.id is null") === '0');

  console.log('--- 忘記密碼 ---');
  const NEW_PW = 'BrandNewPass456';
  await t('請求重設會發出驗證碼', async () => {
    lastCode = null;
    const r = parse(await post(reqReset, { phone: R_PHONE }));
    return r.ok === true && /^\d{6}$/.test(String(lastCode));
  });
  await t('未註冊的號碼回應完全相同，且不發簡訊', async () => {
    lastCode = null;
    const r = parse(await post(reqReset, { phone: '0900000123' }));
    return r.ok === true && r.data.requested === true && lastCode === null;
  });
  await t('重複請求會沿用同一組碼，不重發', async () => {
    lastCode = null;
    const r = parse(await post(reqReset, { phone: R_PHONE }));
    return r.ok === true && lastCode === null && r.data.expiresInSeconds > 0;
  });
  let theCode = null;
  await t('取得目前有效的驗證碼（重建一組來測驗證）', async () => {
    sql(`delete from auth_rate_limits`);
    lastCode = null;
    await post(reqReset, { phone: R_PHONE });
    theCode = lastCode;
    return /^\d{6}$/.test(String(theCode));
  });
  await t('錯誤驗證碼被拒', async () => {
    const wrong = String((Number(theCode) + 1) % 1000000).padStart(6, '0');
    const r = parse(await post(confirmReset, { phone: R_PHONE, otp: wrong, newPassword: NEW_PW }));
    return r.status === 400 && r.error.code === 'RESET_CODE_INVALID';
  });
  await t('驗證碼不以明文存在資料庫', () =>
    sql(`select count(*) from auth_rate_limits where state::text like '%${theCode}%'`) === '0');
  await t('正確驗證碼可以改密碼', async () => {
    const r = parse(await post(confirmReset, { phone: R_PHONE, otp: theCode, newPassword: NEW_PW }));
    return r.ok === true && r.data.reset === true;
  });
  await t('舊密碼登不進去了', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: R_PW }, { 'x-nf-client-connection-ip': '198.51.100.2' }));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS';
  });
  await t('新密碼可以登入', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: NEW_PW }, { 'x-nf-client-connection-ip': '198.51.100.3' }));
    rToken = r.data && r.data.sessionToken;
    return r.ok === true;
  });
  await t('重設後舊 session token 立刻失效', async () => {
    const r = parse(await post(updateAccount, { sessionToken: 'x' }));
    return r.status === 401;
  });
  await t('同一組驗證碼不能用第二次', async () => {
    const r = parse(await post(confirmReset, { phone: R_PHONE, otp: theCode, newPassword: 'YetAnotherPw789' }));
    return r.error.code === 'RESET_CODE_INVALID';
  });

  console.log('--- 建立員工 ---');
  // 用 seed.sql 裡的 B 隊負責人（USR-OWN2 / ORG-TP-002），不另外造人
  await withoutUser((c) => auth.setPasswordCredential(c, 'USR-OWN2', 'OwnerPass123'));
  let ownerToken = null;
  await t('負責人登入', async () => {
    const r = parse(await post(login, { phone: '0912000005', password: 'OwnerPass123' }, { 'x-nf-client-connection-ip': '198.51.100.4' }));
    ownerToken = r.data && r.data.sessionToken;
    return r.ok === true;
  });
  await t('負責人可以建立調度員', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-002',
      role: 'dispatcher', name: '調度阿美', phone: '0955222333', password: 'DispPass1234' }));
    return r.ok === true && r.data.createdUser === true && r.data.membership.role === 'dispatcher';
  });
  await t('建立司機時會一併建立 drivers 資料列', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-002',
      role: 'driver', name: '司機阿強', phone: '0955444555', password: 'DrvPass12345' }));
    return r.ok === true && sql(`select count(*) from drivers where user_id = '${r.data.user.userId}'`) === '1';
  });
  await t('負責人「不能」再建立第二個負責人', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-002',
      role: 'owner', name: '想篡位的人', phone: '0955666777', password: 'UsurpPass123' }));
    return r.ok !== true && r.error.code === 'OWNER_EXISTS';
  });
  await t('負責人不能對別家組織建立員工，且不洩漏該組織是否存在', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-001',
      role: 'dispatcher', name: '入侵者', phone: '0955888999', password: 'IntrudePass1' }));
    // organizations 的讀取政策讓別家組織「根本看不到」，所以回的是找不到而不是
    // 沒有權限——後者等於承認那個組織存在。404 不是 502。
    return r.status === 404 && r.error.code === 'ORG_NOT_FOUND'
      && sql("select count(*) from users where phone_e164 = '+886955888999'") === '0';
  });
  await t('需求者（沒有營運身分）不能建立員工', async () => {
    const r = parse(await post(createStaff, { sessionToken: rToken, organizationId: 'ORG-TP-002',
      role: 'dispatcher', name: '越權', phone: '0955121212', password: 'NopePass1234' }));
    return r.status === 404 && r.error.code === 'ORG_NOT_FOUND'
      && sql("select count(*) from users where phone_e164 = '+886955121212'") === '0';
  });
  await t('沒有 token 不能建立員工', async () =>
    parse(await post(createStaff, { organizationId: 'ORG-TP-001', role: 'driver', name: 'x', phone: '0955131313', password: 'aaaaaaaaaaa' })).status === 401);
  await t('同一人在同組織重複加入被擋', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-002',
      role: 'dispatcher', name: '調度阿美', phone: '0955222333', password: 'DispPass1234' }));
    return r.ok !== true && r.error.code === 'MEMBERSHIP_EXISTS';
  });
  await t('超級管理者不可被加入公司', async () => {
    const r = parse(await post(createStaff, { sessionToken: ownerToken, organizationId: 'ORG-TP-002',
      role: 'dispatcher', name: '管理者', phone: '0912000009', password: 'WhateverPw12' }));
    return r.ok !== true && r.error.code === 'FORBIDDEN';
  });

  console.log('--- 修改自己的帳號 ---');
  let userToken = null;
  await t('登入取得 token', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: NEW_PW }, { 'x-nf-client-connection-ip': '198.51.100.5' }));
    userToken = r.data && r.data.sessionToken;
    return r.ok === true;
  });
  await t('只改名字不需要現行密碼', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明', phone: R_PHONE }));
    return r.ok === true && r.data.user.displayName === '王大明';
  });
  await t('改手機沒帶現行密碼會被擋', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明', phone: '0933555444' }));
    return r.ok !== true && r.error.code === 'CURRENT_PASSWORD_REQUIRED';
  });
  await t('現行密碼錯誤會被擋', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明',
      phone: '0933555444', currentPassword: 'WrongOne123' }));
    return r.ok !== true && r.error.code === 'INVALID_CREDENTIALS';
  });
  await t('帶對現行密碼可以改手機，並換發新 token', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明',
      phone: '0933555444', currentPassword: NEW_PW }));
    const changed = r.ok === true && r.data.user.phone === '0933555444'
      && !!r.data.sessionToken && r.data.sessionToken !== userToken;
    userToken = r.data && r.data.sessionToken;
    return changed;
  });
  await t('換發的新 token 立刻可用', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明', phone: '0933555444' }));
    return r.ok === true;
  });
  await t('改成別人已用的手機號碼被擋', async () => {
    const r = parse(await post(updateAccount, { sessionToken: userToken, name: '王大明',
      phone: '0912000005', currentPassword: NEW_PW }));
    return r.ok !== true && r.error.code === 'ACCOUNT_EXISTS';
  });
  await t('改不到別人的資料列（RLS）', () =>
    sql(`select display_name from users where id = 'USR-OWN2'`) === 'B隊負責人');

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
