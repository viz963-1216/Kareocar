'use strict';

/**
 * GET /api/v2/oauth-callback?code=…   （#58）
 *
 * Supabase 完成 Google／Facebook 登入後轉回這裡。以授權碼＋cr_oauth 裡的 verifier 換 session。
 *
 * 用途是登入（mode=login）：
 *   - 社群帳號已綁定（token 帶 app_user_id，或本身就是系統使用者）、帳號啟用中 → 寫入登入 cookie
 *   - 還沒綁定 → 不給登入 cookie，只給 cr_bind，回首頁的綁定畫面（?bind=1）
 *
 * 用途是綁定（mode=link，從「我的帳戶」發起，expectUserId 是發起的人）：
 *   - 把這個社群帳號記到 social_logins，綁到發起的人身上（見 0014），只需要到 Google／Facebook 一次。
 *     原本的登入 cookie 不動。
 *   - 已經綁在別人身上、或本身就是另一位系統使用者 → identity_in_use
 *
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

function audit(client, eventType, userId, provider) {
  return client.query(
    `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
     values ($1,$2,$3,'user',$3,'OAUTH',$4)`,
    [`AUD-${Date.now()}-${auth.randomHex(4)}`, eventType, userId, JSON.stringify({ provider })]);
}

async function linkToRequester(event, pending, result, claims, clear, fail) {
  const expect = pending.expectUserId;
  if (!expect) return fail('failed');
  if (claims.userId === expect) {
    return oauth.redirect(`/?linked=${encodeURIComponent(pending.provider)}`, [clear]);
  }
  // 已經對應到另一位使用者
  if (claims.userId !== claims.authUserId) return fail('identity_in_use');

  const status = await withUser(expect, async (client) => {
    const r = (await client.query('select app.link_social_login($1, $2, $3) as s',
      [claims.authUserId, pending.provider, result.profile.email])).rows[0].s;
    if (r === 'linked') await audit(client, 'auth.oauth.linked', expect, pending.provider);
    return r;
  });
  if (status === 'linked' || status === 'already') {
    return oauth.redirect(`/?linked=${encodeURIComponent(pending.provider)}`, [clear]);
  }
  return fail(status === 'provider_taken' ? 'provider_taken' : 'identity_in_use');
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

    if (pending.mode === 'link') return await linkToRequester(event, pending, result, claims, clear, fail);

    const state = (await withoutUser((client) =>
      client.query('select * from app.session_state($1)', [claims.userId]))).rows[0];

    if (!state) {
      // 第一次用這個社群帳號：先綁定手機才能用任何功能
      return oauth.redirect('/?bind=1', [clear, oauth.bindCookie(event, {
        authUserId: claims.authUserId, provider: pending.provider,
        email: result.profile.email, name: result.profile.name
      })]);
    }
    if (state.active !== true) return fail('account_disabled');

    await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      await audit(client, 'auth.oauth.login', claims.userId, pending.provider);
    });

    return oauth.redirect('/', [clear, oauth.clearBindCookie(event), ...session.sessionCookies(event, result)]);
  } catch (error) {
    console.error('[oauth-callback]', error && error.code);
    return fail(error && error.revokedUntil ? 'retry' : 'failed');
  }
};
