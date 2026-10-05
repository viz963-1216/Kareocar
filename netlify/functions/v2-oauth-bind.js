'use strict';

/**
 * 社群帳號第一次登入後綁定手機（#58）。需要 cr_bind（oauth-callback 簽發，15 分鐘）。
 *
 * GET  /api/v2/oauth-bind  → { provider, email, name }，綁定畫面預先帶入
 * POST /api/v2/oauth-bind
 *   { mode: 'existing', phone, password }
 *       這支手機已經有帳號：密碼正確才綁定（和密碼登入一樣有失敗次數限制）。把剛才社群登入時
 *       Supabase 建立的帳號記到 social_logins，對應到這位使用者（見 0014），並以手機密碼登入。
 *       不必再到 Google／Facebook 確認一次；之後用社群帳號登入時，token 會帶這位使用者。
 *   { mode: 'new', name, email, phone, password }
 *       第一次使用：建立需求者，手機與密碼也設到同一個帳號上，之後兩種方式都能登入。
 *
 * 手機不以簡訊驗證（和一般註冊相同）。
 */

const { json, withCookies, parseBody, handleError, clientIp } = require('./_http');
const { withUser, withoutUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const oauth = require('./_oauth');

function newId(prefix) {
  return `${prefix}-${auth.randomHex(16).slice(0, 16).toUpperCase()}`;
}

function audit(client, eventType, userId, details) {
  return client.query(
    `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
     values ($1,$2,$3,'user',$3,'OAUTH_BIND',$4)`,
    [`AUD-${Date.now()}-${auth.randomHex(4)}`, eventType, userId, JSON.stringify(details)]);
}

async function bindExisting(event, pending, body) {
  const phone = auth.normalizeTaiwanPhone(body.phone);
  const password = String(body.password || '');
  if (!/^09\d{8}$/.test(phone) || !password) throw auth.authError('INVALID_CREDENTIALS', '手機號碼或密碼錯誤');
  const sourceIp = clientIp(event);
  await withoutUser((client) => auth.assertLoginAllowed(client, phone, sourceIp));

  let tokens;
  try {
    tokens = await supabaseAuth.signInWithPassword(auth.toE164(phone), password);
  } catch (error) {
    if (error.code !== 'INVALID_CREDENTIALS') throw error;
    const state = await withoutUser((client) => auth.recordLoginFailure(client, phone, sourceIp));
    if (Number(state.lockedUntil || 0) > Math.floor(Date.now() / 1000)) {
      throw auth.authError('LOGIN_RATE_LIMITED', '失敗次數過多，請稍後再試');
    }
    throw auth.authError('INVALID_CREDENTIALS', '手機號碼或密碼錯誤');
  }
  const claims = await supabaseAuth.verifyAccessToken(tokens.accessToken);
  if (claims.userId === pending.authUserId) throw auth.authError('VALIDATION_ERROR', '這個社群帳號已經綁定');

  const status = await withUser(claims.userId, async (client) => {
    await session.assertSessionActive(client, claims);
    await auth.clearLoginRate(client, phone);
    const r = (await client.query('select app.link_social_login($1, $2, $3) as s',
      [pending.authUserId, pending.provider, pending.email])).rows[0].s;
    if (r === 'provider_taken') {
      throw auth.authError('VALIDATION_ERROR', '這個帳號已經綁定另一個同類型的社群帳號，請先到「我的帳戶」解除');
    }
    if (r === 'in_use') throw auth.authError('IDENTITY_IN_USE', '這個社群帳號已經綁定在其他帳號上');
    await audit(client, 'auth.oauth.bind_existing', claims.userId, { provider: pending.provider });
    if (r === 'linked') await audit(client, 'auth.oauth.linked', claims.userId, { provider: pending.provider });
    return r;
  });

  return withCookies(json(200, { ok: true, data: { mode: 'existing', status } }), [
    ...session.sessionCookies(event, tokens),
    oauth.clearBindCookie(event)
  ]);
}

async function bindNew(event, pending, body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || pending.email || '').trim().toLowerCase();
  const phone = auth.normalizeTaiwanPhone(body.phone);
  const password = String(body.password || '');
  if (!name || name.length > 80) throw auth.authError('VALIDATION_ERROR', '請輸入正確姓名');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw auth.authError('VALIDATION_ERROR', '請輸入正確電子信箱');
  if (!/^09\d{8}$/.test(phone)) throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭的 10 位手機號碼');
  if (password.length < 8) throw auth.authError('WEAK_PASSWORD', '密碼至少需要 8 碼');
  if (password.length > 128) throw auth.authError('WEAK_PASSWORD', '密碼長度不可超過 128 碼');

  const phoneE164 = auth.toE164(phone);
  const userId = pending.authUserId;
  const taken = (await withoutUser((client) =>
    client.query('select 1 from app.find_user_for_login($1)', [phoneE164]))).rows[0];
  if (taken) throw auth.authError('PHONE_EXISTS', '此手機號碼已經有帳號，請改選「我已經有帳號」');

  // 資料庫與 Supabase Auth 同一交易：Supabase 的更新放最後，失敗就整筆回滾
  await withoutUser(async (client) => {
    await client.query('select app.register_requester($1,$2,$3,$4,$5)',
      [userId, newId('MEM-REQ'), name, email, phoneE164]);
    await supabaseAuth.updateUser(userId, { phoneE164, password });
  });

  const tokens = await supabaseAuth.signInWithPassword(phoneE164, password);
  try {
    await withUser(userId, (client) => audit(client, 'identity.requester_registered', userId,
      { via: pending.provider, sourceIp: clientIp(event) ? 'recorded' : 'unknown' }));
  } catch (auditError) {
    console.error('[audit] identity.requester_registered（社群登入）寫入失敗', auditError && auditError.code);
  }
  return withCookies(json(200, { ok: true, data: { mode: 'new', userId } }),
    [...session.sessionCookies(event, tokens), oauth.clearBindCookie(event)]);
}

exports.handler = async (event) => {
  try {
    const pending = oauth.readBind(event);
    if (event.httpMethod === 'GET') {
      if (!pending) throw auth.authError('BIND_EXPIRED', '綁定時間已過，請重新用社群帳號登入');
      return json(200, { ok: true, data: { provider: pending.provider, email: pending.email, name: pending.name } });
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    }
    session.assertSameOrigin(event);
    if (!pending) throw auth.authError('BIND_EXPIRED', '綁定時間已過，請重新用社群帳號登入');
    const body = parseBody(event);
    if (body.mode === 'existing') return await bindExisting(event, pending, body);
    if (body.mode === 'new') return await bindNew(event, pending, body);
    throw auth.authError('VALIDATION_ERROR', '請選擇綁定方式');
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
