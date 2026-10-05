'use strict';
/**
 * Google、Facebook 登入與綁定手機（#58）的整合測試。
 *
 * 實際的 handler（oauth-start、oauth-callback、oauth-bind、login-methods、password-login、
 * state-load）跑在真實 Postgres 與 RLS 上；Supabase Auth 與 Google／Facebook 由
 * _auth-fixture.js 模擬，包含 PKCE（授權碼只能用對應的 verifier 換一次）。
 * 假 Supabase 簽發 token 時會呼叫資料庫裡實際的 public.custom_access_token_hook（0014），
 * 和正式環境的 Custom Access Token Hook 相同。
 *
 * 只允許本機隔離端點與固定測試庫名稱。
 */
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return require.resolve('./pg-psql-shim.js');
  return origResolve.call(this, request, ...rest);
};

const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_oauth_test') {
  throw Error('Requires dedicated local endpoint and careride_oauth_test database');
}
const PGPORT = process.env.PGPORT;
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(host)}:${PGPORT}/careride_oauth_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-oauth-0123456789';

const fx = require('./_auth-fixture');
const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const start = require(path.join(FN, 'v2-oauth-start.js'));
const callback = require(path.join(FN, 'v2-oauth-callback.js'));
const bind = require(path.join(FN, 'v2-oauth-bind.js'));
const methods = require(path.join(FN, 'v2-login-methods.js'));
const login = require(path.join(FN, 'v2-password-login.js'));
const stateLoad = require(path.join(FN, 'v2-state-load.js'));
const { getPool } = require(path.join(FN, '_db.js'));

const hookClaims = (authUserId) => {
  const v = execFileSync('psql', ['-h', host, '-p', PGPORT, '-U', 'postgres', '-d', 'careride_oauth_test', '-tAc',
    `select public.custom_access_token_hook(jsonb_build_object('user_id', '${authUserId}', 'claims', '{}'::jsonb))->'claims'->>'app_user_id'`]).toString().trim();
  return v ? { app_user_id: v } : {};
};
fx.setClaimsHook(hookClaims);
const sql = (q) => execFileSync('psql', ['-h', host, '-p', PGPORT, '-U', 'postgres', '-d', 'careride_oauth_test', '-tAc', q]).toString().trim();

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};

const H = (cookie, extra = {}) => ({ host: '127.0.0.1', ...(cookie ? { cookie } : {}), ...extra });
const get = (mod, query = {}, cookie = '') => mod.handler({ httpMethod: 'GET', headers: H(cookie), queryStringParameters: query });
const post = (mod, body, cookie = '') => mod.handler({ httpMethod: 'POST', headers: H(cookie, { origin: 'http://127.0.0.1' }), body: JSON.stringify(body) });
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });
const loc = (res) => String((res.headers && res.headers.location) || '');
const has = (jar, name) => new RegExp(`(?:^|; )${name}=`).test(jar);
// token 代表的使用者：有 app_user_id（綁定的社群帳號）就用它，否則用 sub
const userOf = (jar) => {
  const at = decodeURIComponent((jar.match(/(?:^|; )cr_at=([^;]*)/) || [])[1] || '');
  if (!at) return null;
  const c = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString());
  return c.app_user_id || c.sub;
};
const subOf = (jar) => {
  const at = decodeURIComponent((jar.match(/(?:^|; )cr_at=([^;]*)/) || [])[1] || '');
  return at ? JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString()).sub : null;
};

/** 按登入按鈕 → 在 Google 完成登入 → 回到 callback。回傳 callback 的回應與 cookie。 */
async function socialLogin(provider, subject, profile = {}) {
  const s = await get(start, { provider });
  const jar = fx.cookiesFrom(s);
  const code = fx.oauthLogin({ provider, subject, codeChallenge: fx.challengeFrom(loc(s)), ...profile });
  const cb = await get(callback, { code }, jar);
  return { res: cb, jar: fx.cookiesFrom(cb, jar) };
}

(async () => {
  console.log('--- 開始登入 ---');
  let started;
  await t('不支援的登入方式回首頁並帶錯誤', async () => {
    const r = await get(start, { provider: 'myspace' });
    return r.statusCode === 302 && loc(r) === '/?login_error=failed';
  });
  await t('Google：轉到 Supabase 授權網址，帶 PKCE（S256）與本站回呼網址', async () => {
    started = await get(start, { provider: 'google' });
    const u = new URL(loc(started));
    return started.statusCode === 302 && u.origin === 'https://synthetic-project.supabase.co'
      && u.pathname === '/auth/v1/authorize' && u.searchParams.get('provider') === 'google'
      && u.searchParams.get('code_challenge_method') === 's256' && /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('code_challenge'))
      && u.searchParams.get('redirect_to') === 'http://127.0.0.1/api/v2/oauth-callback';
  });
  await t('verifier 放在 HttpOnly、SameSite=Lax、只送到 callback 的 cookie', () => {
    const line = fx.setCookieLines(started).find((l) => l.startsWith('cr_oauth='));
    return Boolean(line) && /HttpOnly/.test(line) && /SameSite=Lax/.test(line) && /Path=\/api\/v2\/oauth-callback/.test(line);
  });

  console.log('--- 回呼的防護 ---');
  await t('沒有 cr_oauth 的回呼（別人塞過來的授權碼）被拒，不給登入 cookie', async () => {
    const code = fx.oauthLogin({ provider: 'google', subject: 'attacker', codeChallenge: 'x' });
    const r = await get(callback, { code });
    return loc(r) === '/?login_error=expired' && !has(fx.cookiesFrom(r), 'cr_at');
  });
  await t('授權碼和這個瀏覽器的 verifier 不配對（PKCE）就換不到 session', async () => {
    const s = await get(start, { provider: 'google' });
    const code = fx.oauthLogin({ provider: 'google', subject: 'attacker2', codeChallenge: 'not-this-browser' });
    const r = await get(callback, { code }, fx.cookiesFrom(s));
    return loc(r) === '/?login_error=failed' && !has(fx.cookiesFrom(r), 'cr_at');
  });
  await t('授權碼只能用一次', async () => {
    const s = await get(start, { provider: 'google' });
    const jar = fx.cookiesFrom(s);
    const code = fx.oauthLogin({ provider: 'google', subject: 'once', codeChallenge: fx.challengeFrom(loc(s)) });
    await get(callback, { code }, jar);
    const again = await get(callback, { code }, jar);
    return loc(again) === '/?login_error=failed';
  });
  await t('被竄改的 cr_oauth（簽章不符）視同沒有', async () => {
    const s = await get(start, { provider: 'google' });
    const jar = fx.cookiesFrom(s).replace(/cr_oauth=([^;.]*)\.([^;]*)/, (m, b, sig) => `cr_oauth=${b}x.${sig}`);
    const r = await get(callback, { code: 'whatever' }, jar);
    return loc(r) === '/?login_error=expired';
  });
  await t('使用者在 Google 按取消 → cancelled', async () => {
    const r = await get(callback, { error: 'access_denied' });
    return loc(r) === '/?login_error=cancelled';
  });

  console.log('--- 第一次登入：建立新帳號 ---');
  let first = await socialLogin('google', 'g-new', { email: 'new.user@example.com', name: '社群新人' });
  await t('還沒綁定：轉到綁定畫面，只給 cr_bind，不給登入 cookie', () =>
    loc(first.res) === '/?bind=1' && has(first.jar, 'cr_bind') && !has(first.jar, 'cr_at'));
  await t('cr_bind 是 HttpOnly、SameSite=Strict，只送到綁定 API', () => {
    const line = fx.setCookieLines(first.res).find((l) => l.startsWith('cr_bind='));
    return /HttpOnly/.test(line) && /SameSite=Strict/.test(line) && /Path=\/api\/v2\/oauth-bind/.test(line);
  });
  await t('綁定前其他 API 都不能用（沒有登入）', async () => {
    const r = await stateLoad.handler({ httpMethod: 'GET', headers: H(first.jar), queryStringParameters: {} });
    return r.statusCode === 401;
  });
  await t('綁定畫面拿得到 Google 帶來的姓名與 Email', async () => {
    const r = parse(await get(bind, {}, first.jar));
    return r.ok && r.data.provider === 'google' && r.data.email === 'new.user@example.com' && r.data.name === '社群新人';
  });
  await t('沒有 cr_bind 不能綁定', async () => {
    const r = parse(await post(bind, { mode: 'new', name: 'x', phone: '0955000111', password: 'Password123' }));
    return r.status === 401 && r.error.code === 'BIND_EXPIRED';
  });
  await t('新帳號用已註冊的手機 → 提示改用「我已經有帳號」', async () => {
    const r = parse(await post(bind, { mode: 'new', name: '社群新人', phone: '0912000001', password: 'Password123' }, first.jar));
    return r.status === 400 && r.error.code === 'PHONE_EXISTS';
  });
  let newUserId = null;
  await t('建立新帳號：成為需求者並登入', async () => {
    const res = await post(bind, { mode: 'new', name: '社群新人', phone: '0955000111', password: 'Password123' }, first.jar);
    const r = parse(res);
    const jar = fx.cookiesFrom(res, first.jar);
    newUserId = r.data && r.data.userId;
    return r.ok && has(jar, 'cr_at') && !has(jar, 'cr_bind') && subOf(jar) === newUserId
      && sql(`select email || '|' || phone_e164 from users where id = '${newUserId}'`) === 'new.user@example.com|+886955000111'
      && sql(`select role from memberships where user_id = '${newUserId}'`) === 'requester';
  });
  await t('之後也能用手機＋密碼登入同一個帳號', async () => {
    const r = parse(await login.handler({ httpMethod: 'POST', headers: H('', { 'x-nf-client-connection-ip': '203.0.113.1' }),
      body: JSON.stringify({ phone: '0955000111', password: 'Password123' }) }));
    return r.ok && r.data.user.userId === newUserId;
  });
  await t('再用同一個 Google 帳號登入：直接進系統', async () => {
    const again = await socialLogin('google', 'g-new');
    return loc(again.res) === '/' && subOf(again.jar) === newUserId && !has(again.jar, 'cr_bind')
      && sql(`select count(*) from audit_events where event_type = 'auth.oauth.login' and actor_user_id = '${newUserId}'`) === '1';
  });

  console.log('--- 第一次登入：綁定既有帳號（只確認一次） ---');
  fx.setSeedPassword('USR-VICTIM', 'VictimPass123');
  const second = await socialLogin('google', 'g-victim', { email: 'victim@example.com' });
  const pendingSocial = (() => { try { return JSON.parse(Buffer.from(decodeURIComponent((second.jar.match(/cr_bind=([^;.]*)/) || [])[1]), 'base64url').toString()).a; } catch (_) { return null; } })();
  await t('密碼錯誤不能綁定', async () => {
    const r = parse(await post(bind, { mode: 'existing', phone: '0912000001', password: 'wrong-password' }, second.jar));
    return r.status === 401 && r.error.code === 'INVALID_CREDENTIALS'
      && sql("select count(*) from social_logins where user_id = 'USR-VICTIM'") === '0';
  });
  await t('密碼正確：直接完成綁定並登入，不必再到 Google', async () => {
    const res = await post(bind, { mode: 'existing', phone: '0912000001', password: 'VictimPass123' }, second.jar);
    const r = parse(res);
    const jar = fx.cookiesFrom(res, second.jar);
    return r.ok && r.data.mode === 'existing' && r.data.status === 'linked' && !r.data.redirectUrl
      && userOf(jar) === 'USR-VICTIM' && !has(jar, 'cr_bind') && !has(jar, 'cr_oauth')
      && sql(`select user_id || '|' || provider || '|' || email from social_logins where auth_user_id = '${pendingSocial}'`) === 'USR-VICTIM|google|victim@example.com'
      && sql(`select count(*) from audit_events where event_type = 'auth.oauth.linked' and actor_user_id = 'USR-VICTIM'`) === '1';
  });
  await t('社群帳號沒有被刪除（改成記錄對應）', () =>
    Boolean(pendingSocial) && !fx.calls.some((c) => c[0] === 'deleteUser' && c[1] === pendingSocial));
  await t('Token Hook：有對應就加 app_user_id，其他宣告原樣保留', () =>
    sql(`select public.custom_access_token_hook(jsonb_build_object('user_id', '${pendingSocial}', 'claims', '{"role":"authenticated","sub":"${pendingSocial}"}'::jsonb))->'claims'::text`)
      === `{"sub": "${pendingSocial}", "role": "authenticated", "app_user_id": "USR-VICTIM"}`
    && sql(`select public.custom_access_token_hook('{"user_id":"nobody","claims":{"x":1}}'::jsonb)::text`) === '{"claims": {"x": 1}}');
  await t('之後用這個 Google 帳號登入，就是原本的帳號', async () => {
    const again = await socialLogin('google', 'g-victim');
    return loc(again.res) === '/' && userOf(again.jar) === 'USR-VICTIM' && subOf(again.jar) === pendingSocial
      && sql(`select count(*) from audit_events where event_type = 'auth.oauth.login' and actor_user_id = 'USR-VICTIM'`) === '1';
  });
  await t('用綁定的社群帳號登入後，API 以原本的帳號身分運作', async () => {
    const again = await socialLogin('google', 'g-victim');
    const r = parse(await get(methods, {}, again.jar));
    return r.ok && r.data.social.find((x) => x.provider === 'google').linked === true;
  });

  console.log('--- 我的帳戶：登入方式 ---');
  const victimJar = `cr_at=${fx.mintAccessToken('USR-VICTIM')}`;
  await t('列出登入方式：手機＋密碼、Google 已綁定、Facebook 未綁定', async () => {
    const r = parse(await get(methods, {}, victimJar));
    const g = r.data.social.find((s) => s.provider === 'google'), f = r.data.social.find((s) => s.provider === 'facebook');
    return r.ok && r.data.phone === true && g.linked === true && g.email === 'victim@example.com' && f.linked === false;
  });
  await t('在我的帳戶綁定 Facebook：只到 Facebook 一次', async () => {
    const res = await post(methods, { action: 'link', provider: 'facebook' }, victimJar);
    const url = parse(res).data.url;
    const jar = fx.cookiesFrom(res, victimJar);
    const code = fx.oauthLogin({ provider: 'facebook', subject: 'f-victim', email: 'victim@fb.example', codeChallenge: fx.challengeFrom(url) });
    const cb = await get(callback, { code }, jar);
    return /\/auth\/v1\/authorize\?/.test(url) && loc(cb) === '/?linked=facebook'
      && sql("select count(*) from social_logins where user_id = 'USR-VICTIM' and provider = 'facebook'") === '1'
      && userOf(fx.cookiesFrom(cb, jar)) === 'USR-VICTIM';
  });
  await t('同一種登入方式不能再綁第二個帳號', async () => {
    const res = await post(methods, { action: 'link', provider: 'google' }, victimJar);
    const jar = fx.cookiesFrom(res, victimJar);
    const code = fx.oauthLogin({ provider: 'google', subject: 'g-victim-2', codeChallenge: fx.challengeFrom(parse(res).data.url) });
    const cb = await get(callback, { code }, jar);
    return loc(cb) === '/?login_error=provider_taken' && sql("select count(*) from social_logins where user_id = 'USR-VICTIM'") === '2';
  });
  await t('已綁在別人身上的社群帳號不能再綁', async () => {
    fx.setSeedPassword('USR-ATTACK', 'AttackPass123');
    const attackJar = `cr_at=${fx.mintAccessToken('USR-ATTACK')}`;
    const res = await post(methods, { action: 'link', provider: 'google' }, attackJar);
    const jar = fx.cookiesFrom(res, attackJar);
    const code = fx.oauthLogin({ provider: 'google', subject: 'g-victim', codeChallenge: fx.challengeFrom(parse(res).data.url) });
    const cb = await get(callback, { code }, jar);
    return loc(cb) === '/?login_error=identity_in_use' && sql("select count(*) from social_logins where user_id = 'USR-ATTACK'") === '0';
  });
  await t('社群帳號本身就是另一位系統使用者 → 不能綁', async () => {
    const res = await post(methods, { action: 'link', provider: 'google' }, `cr_at=${fx.mintAccessToken('USR-ATTACK')}`);
    const jar = fx.cookiesFrom(res, `cr_at=${fx.mintAccessToken('USR-ATTACK')}`);
    const code = fx.oauthLogin({ provider: 'google', subject: 'g-new', codeChallenge: fx.challengeFrom(parse(res).data.url) });
    const cb = await get(callback, { code }, jar);
    return loc(cb) === '/?login_error=identity_in_use' && sql("select count(*) from social_logins where user_id = 'USR-ATTACK'") === '0';
  });
  await t('綁定只能綁到自己：受控函式拒絕沒有登入身分的呼叫', () => {
    try { sql("set app.user_id = ''; select app.link_social_login('x', 'google', null)"); return false; }
    catch (e) { return /請先登入/.test(String(e.stderr || e.message)); }
  });
  const mappedToken = fx.mintAccessToken(pendingSocial, { extra: { app_user_id: 'USR-VICTIM' } });
  await t('解除綁定 Google：對應刪除、Supabase 社群帳號刪除、手機＋密碼仍保留', async () => {
    const r = parse(await post(methods, { action: 'unlink', provider: 'google' }, victimJar));
    return r.ok && r.data.social.find((s) => s.provider === 'google').linked === false && r.data.phone === true
      && sql(`select count(*) from social_logins where auth_user_id = '${pendingSocial}'`) === '0'
      && fx.calls.some((c) => c[0] === 'deleteUser' && c[1] === pendingSocial)
      && sql(`select count(*) from audit_events where event_type = 'auth.oauth.unlinked' and actor_user_id = 'USR-VICTIM'`) === '1';
  });
  await t('解除綁定後，那個社群帳號的舊 token 立即失效', async () => {
    const r = await get(methods, {}, `cr_at=${mappedToken}`);
    return r.statusCode === 401 && JSON.parse(r.body).error.code === 'SESSION_INVALID';
  });
  await t('沒綁定的方式不能解除', async () => {
    const r = parse(await post(methods, { action: 'unlink', provider: 'google' }, victimJar));
    return r.status === 400;
  });
  await t('刪除帳號時清除對應：只有平台管理者可以執行', () => {
    try { sql("select set_config('app.user_id', 'USR-ATTACK', false); select app.purge_social_logins('USR-VICTIM')"); return false; }
    catch (e) {
      return /只有平台管理者/.test(String(e.stderr || e.message))
        && sql("select count(*) from social_logins where user_id = 'USR-VICTIM'") === '1';
    }
  });
  await t('平台管理者清除後回傳要刪除的社群帳號', () =>
    sql("select set_config('app.user_id', 'USR-ROOT', false); select array_length(app.purge_social_logins('USR-VICTIM'), 1)").split('\n').pop() === '1'
    && sql("select count(*) from social_logins where user_id = 'USR-VICTIM'") === '0');
  await t('沒登入不能查登入方式', async () => (await get(methods, {})).statusCode === 401);

  console.log('--- 停用的帳號 ---');
  await t('帳號停用後用社群登入會被擋', async () => {
    sql(`update users set active = false where id = '${newUserId}'`);
    const r = await socialLogin('google', 'g-new');
    sql(`update users set active = true where id = '${newUserId}'`);
    return loc(r.res) === '/?login_error=account_disabled' && !has(r.jar, 'cr_at');
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
