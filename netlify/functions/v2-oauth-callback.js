'use strict';

/**
 * GET /api/v2/oauth-callback?code=…   （#58）
 *
 * Supabase 完成 Google／Facebook 登入後轉回這裡。以授權碼＋cr_oauth 裡的 verifier 換 session：
 *   - 帳號已綁定、啟用中 → 寫入登入 cookie，回首頁（前端照常以 /api/v2/session 恢復登入）
 *   - 還沒綁定           → 不給登入 cookie，只給 cr_bind，回首頁的綁定畫面（?bind=1）
 *   - 用途是「綁定」（mode=link）→ 換到的必須是發起綁定的那個使用者
 * 任何失敗都回首頁並帶 login_error，不在網址留下授權碼以外的資訊。
 */

const { withUser, withoutUser } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const oauth = require('./_oauth');

function errorReason(params) {
  const text = `${params.error || ''} ${params.error_code || ''} ${params.error_description || ''}`;
  if (/identity_already_exists|already linked/i.test(text)) return 'identity_in_use';
  if (/access_denied/i.test(text)) return 'cancelled';
  return 'failed';
}

exports.handler = async (event) => {
  const clear = oauth.clearOauthCookie(event);
  const fail = (reason) => oauth.redirect(`/?login_error=${reason}`, [clear]);
  if (event.httpMethod !== 'GET') return fail('failed');

  const params = event.queryStringParameters || {};
  if (params.error || params.error_code) return fail(errorReason(params));

  const pending = oauth.readOauth(event);
  const code = String(params.code || '');
  if (!pending || !code || code.length > 512) return fail('expired');

  try {
    let result;
    try {
      result = await supabaseAuth.exchangeCode(code, pending.verifier);
    } catch (error) {
      return fail(error.code === 'IDENTITY_IN_USE' ? 'identity_in_use' : 'failed');
    }
    const claims = await supabaseAuth.verifyAccessToken(result.accessToken);
    if (pending.mode === 'link' && pending.expectUserId && claims.userId !== pending.expectUserId) {
      return fail('failed');
    }

    const state = (await withoutUser((client) =>
      client.query('select * from app.session_state($1)', [claims.userId]))).rows[0];

    if (!state) {
      // 第一次用這個社群帳號：先綁定手機才能用任何功能
      if (pending.mode === 'link') return fail('failed');
      return oauth.redirect('/?bind=1', [clear, oauth.bindCookie(event, {
        authUserId: claims.userId, provider: pending.provider,
        email: result.profile.email, name: result.profile.name
      })]);
    }
    if (state.active !== true) return fail('account_disabled');

    await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,$2,$3,'user',$3,'OAUTH',$4)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`,
         pending.mode === 'link' ? 'auth.oauth.linked' : 'auth.oauth.login', claims.userId,
         JSON.stringify({ provider: pending.provider })]);
    });

    const location = pending.mode === 'link' ? `/?linked=${encodeURIComponent(pending.provider)}` : '/';
    return oauth.redirect(location, [clear, oauth.clearBindCookie(event), ...session.sessionCookies(event, result)]);
  } catch (error) {
    console.error('[oauth-callback]', error && error.code);
    return fail(error && error.revokedUntil ? 'retry' : 'failed');
  }
};
