/**
 * v2 身分流程接線測試：註冊、後台重設密碼、建立員工、修改帳號。
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

const sql = (q) => execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres', '-d', PGDATABASE, '-tAc', q]).toString().trim();

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withUser, withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const register = fx.adapt(require(path.join(FN, 'v2-register-requester.js')));
const adminReset = fx.adapt(require(path.join(FN, 'v2-admin-reset-password.js')));
const createStaff = fx.adapt(require(path.join(FN, 'v2-create-staff.js')));
const updateAccount = fx.adapt(require(path.join(FN, 'v2-update-account.js')));

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
  let rToken = null, rUserId = null, regToken = null;
  await t('註冊成功並直接拿到 session', async () => {
    const r = parse(await post(register, { name: '王小明', email: 'ming@example.com', phone: R_PHONE, password: R_PW }));
    rToken = r.data && r.data.sessionToken; rUserId = r.data && r.data.user.userId; regToken = rToken;
    return r.ok === true && !!rToken && r.data.membership.role === 'requester'
      && r.data.membership.organizationId === 'ORG-REQ-001';
  });
  await t('註冊出來的帳號可以登入', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: R_PW }, { 'x-nf-client-connection-ip': '198.51.100.1' }));
    return r.ok === true && r.data.user.userId === rUserId;
  });
  await t('平台角色一定是 none（不能自己註冊成管理者）', () =>
    sql(`select platform_role from users where id = '${rUserId}'`) === 'none');
  await t('使用者 ID 就是 Supabase Auth 的使用者 ID，auth_provider 記為 supabase', () =>
    sql(`select auth_provider || '|' || (auth_subject_id = id) from users where id = '${rUserId}'`) === 'supabase|true');
  await t('重複手機被擋，而且不會去 Supabase Auth 建帳號', async () => {
    const before = fx.calls.filter((c) => c[0] === 'createUser').length;
    const r = parse(await post(register, { name: '別人', email: 'other@example.com', phone: R_PHONE, password: 'AnotherPass123' }));
    return r.status === 400 && r.error.code === 'PHONE_EXISTS'
      && fx.calls.filter((c) => c[0] === 'createUser').length === before;
  });
  await t('重複信箱被擋，剛在 Supabase Auth 建的帳號被補償刪除', async () => {
    const r = parse(await post(register, { name: '別人', email: 'MING@example.com', phone: '0933999888', password: 'AnotherPass123' }));
    const created = fx.calls.filter((c) => c[0] === 'createUser' && c[1] === '+886933999888').length;
    let canLogin = true;
    try { await require(path.join(FN, '_supabase-auth.js')).signInWithPassword('+886933999888', 'AnotherPass123'); } catch (_) { canLogin = false; }
    return r.status === 400 && r.error.code === 'ACCOUNT_EXISTS' && created === 1 && canLogin === false
      && sql("select count(*) from users where phone_e164 = '+886933999888'") === '0';
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

  console.log('--- 後台重設密碼（平台管理者） ---');
  const NEW_PW = 'BrandNewPass456';
  fx.setSeedPassword('USR-ROOT', 'RootPass12345');
  let rootToken = null, tempPw = null;
  await t('平台管理者登入', async () => {
    const r = parse(await post(login, { phone: '0912000009', password: 'RootPass12345' }, { 'x-nf-client-connection-ip': '198.51.100.10' }));
    rootToken = r.data && r.data.sessionToken;
    return r.ok === true;
  });
  await t('沒有 token 不能重設', async () =>
    parse(await post(adminReset, { userId: rUserId })).status === 401);
  await t('需求者不能重設別人的密碼，Supabase Auth 沒被呼叫', async () => {
    const before = fx.calls.filter((c) => c[0] === 'updateUser').length;
    const r = parse(await post(adminReset, { sessionToken: regToken, userId: 'USR-DRV1' }));
    return r.status === 403 && r.error.code === 'FORBIDDEN'
      && fx.calls.filter((c) => c[0] === 'updateUser').length === before;
  });
  await t('不存在的帳號與沒有權限的回應相同（不洩漏帳號是否存在）', async () => {
    const r = parse(await post(adminReset, { sessionToken: regToken, userId: 'USR-NOT-EXIST' }));
    return r.status === 403 && r.error.code === 'FORBIDDEN';
  });
  await t('不能用這個方式重設自己', async () => {
    const r = parse(await post(adminReset, { sessionToken: rootToken, userId: 'USR-ROOT' }));
    return r.status === 403 && r.error.code === 'FORBIDDEN';
  });
  await t('平台管理者可以重設需求者，取得 12 碼臨時密碼', async () => {
    const r = parse(await post(adminReset, { sessionToken: rootToken, userId: rUserId }));
    tempPw = r.data && r.data.temporaryPassword;
    return r.ok === true && r.data.reset === true && /^[A-Za-z2-9]{12}$/.test(String(tempPw));
  });
  await t('稽核紀錄記下操作者與範圍，沒有臨時密碼', () =>
    sql(`select actor_user_id || '|' || (details->>'scope') || '|' || (details::text like '%${tempPw}%')
           from audit_events where event_type = 'auth.password.admin_reset' and entity_id = '${rUserId}'`) === 'USR-ROOT|platform|false');
  await t('對方其他裝置的 refresh token 一併撤銷（global sign out）', () =>
    fx.calls.some((c) => c[0] === 'signOut' && c[1] === 'global'));
  await t('舊密碼登不進去了', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: R_PW }, { 'x-nf-client-connection-ip': '198.51.100.2' }));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS';
  });
  await t('重設前簽發的 session token 立刻失效', async () => {
    const r = parse(await post(updateAccount, { sessionToken: regToken, name: '王小明', phone: R_PHONE }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });
  let tempToken = null;
  await t('臨時密碼可以登入', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: tempPw }, { 'x-nf-client-connection-ip': '198.51.100.3' }));
    tempToken = r.data && r.data.sessionToken;
    return r.ok === true && r.data.user.userId === rUserId;
  });
  await t('本人用臨時密碼改成自己的新密碼', async () => {
    const r = parse(await post(updateAccount, { sessionToken: tempToken, name: '王小明', phone: R_PHONE,
      currentPassword: tempPw, newPassword: NEW_PW }));
    return r.ok === true;
  });
  await t('新密碼可以登入', async () => {
    const r = parse(await post(login, { phone: R_PHONE, password: NEW_PW }, { 'x-nf-client-connection-ip': '198.51.100.11' }));
    rToken = r.data && r.data.sessionToken;
    return r.ok === true;
  });

  console.log('--- 建立員工 ---');
  // 用 seed.sql 裡的 B 隊負責人（USR-OWN2 / ORG-TP-002），不另外造人
  fx.setSeedPassword('USR-OWN2', 'OwnerPass123');
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

  console.log('--- 後台重設密碼（機構負責人） ---');
  const idByPhone = (e164) => sql(`select id from users where phone_e164 = '${e164}'`);
  const driverId = idByPhone('+886955444555');
  const dispatcherId = idByPhone('+886955222333');
  await t('負責人可以重設自己機構的司機', async () => {
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: driverId }));
    return r.ok === true && sql(`select details->>'scope' from audit_events
      where event_type = 'auth.password.admin_reset' and entity_id = '${driverId}' order by created_at desc limit 1`) === 'owner';
  });
  await t('負責人不能重設別家機構的司機', async () => {
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: 'USR-DRV1' }));
    return r.status === 403 && r.error.code === 'FORBIDDEN';
  });
  await t('負責人不能重設需求者', async () => {
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: rUserId }));
    return r.status === 403;
  });
  await t('負責人不能重設平台管理者', async () => {
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: 'USR-ROOT' }));
    return r.status === 403;
  });
  await t('司機同時是別家機構成員時，負責人不能重設（避免接管別家帳號）', async () => {
    sql(`insert into memberships (id, user_id, organization_id, role, status) values ('M-TMP-X', '${driverId}', 'ORG-TP-001', 'driver', 'active')`);
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: driverId }));
    sql(`delete from memberships where id = 'M-TMP-X'`);
    return r.status === 403;
  });
  await t('別家的成員資格停權中也一樣不能重設', async () => {
    sql(`insert into memberships (id, user_id, organization_id, role, status) values ('M-TMP-S', '${driverId}', 'ORG-TP-001', 'dispatcher', 'suspended')`);
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: driverId }));
    sql(`delete from memberships where id = 'M-TMP-S'`);
    return r.status === 403;
  });
  await t('司機同時有需求者身分時，負責人仍可重設', async () => {
    sql(`insert into memberships (id, user_id, organization_id, role, status) values ('M-TMP-R', '${driverId}', 'ORG-REQ-001', 'requester', 'active')`);
    const r = parse(await post(adminReset, { sessionToken: ownerToken, userId: driverId }));
    sql(`delete from memberships where id = 'M-TMP-R'`);
    return r.ok === true;
  });
  await t('調度員不能重設司機', async () => {
    const d = parse(await post(login, { phone: '0955222333', password: 'DispPass1234' }, { 'x-nf-client-connection-ip': '198.51.100.12' }));
    const r = parse(await post(adminReset, { sessionToken: d.data && d.data.sessionToken, userId: driverId }));
    return d.ok === true && r.status === 403;
  });
  await t('平台管理者可以重設任何機構的負責人', async () => {
    const r = parse(await post(adminReset, { sessionToken: rootToken, userId: 'USR-OWN2' }));
    return r.ok === true && !!dispatcherId;
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
  await t('改手機前的舊 token 已失效（其他裝置被登出）', async () => {
    const r = parse(await post(updateAccount, { sessionToken: rToken, name: '王大明', phone: '0933555444' }));
    return r.status === 401 && r.error.code === 'SESSION_INVALID';
  });
  await t('Supabase Auth 那端的手機號碼也跟著改了，新手機可以登入', async () => {
    const r = parse(await post(login, { phone: '0933555444', password: NEW_PW }, { 'x-nf-client-connection-ip': '198.51.100.6' }));
    return r.ok === true && r.data.user.userId === rUserId;
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
