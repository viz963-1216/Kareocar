'use strict';

/**
 * 「我的帳戶」的登入方式（#58）。
 *
 * GET  /api/v2/login-methods                     → 手機＋密碼（一定有）與 Google、Facebook 是否已綁定
 * POST /api/v2/login-methods { action: 'link', provider }    → { url }：前往授權，完成後回到 oauth-callback
 * POST /api/v2/login-methods { action: 'unlink', provider }  → 解除綁定（手機＋密碼一定保留，所以總有一種）
 *
 * 綁定與解除綁定都用使用者自己的 access token 呼叫 Supabase，並寫稽核紀錄。
 */

const { json, withCookies, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const oauth = require('./_oauth');

function summarize(identities) {
  return {
    phone: true,
    social: supabaseAuth.OAUTH_PROVIDERS.map((provider) => {
      const found = identities.find((i) => i.provider === provider);
      return { provider, linked: Boolean(found), email: found ? found.email : '' };
    })
  };
}

exports.handler = async (event) => {
  try {
    const claims = await session.requireSession(event);
    await withUser(claims.userId, (client) => session.assertSessionActive(client, claims));

    if (event.httpMethod === 'GET') {
      const identities = await supabaseAuth.listIdentities(claims.accessToken);
      return json(200, { ok: true, data: summarize(identities) });
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    }

    const body = parseBody(event);
    const provider = supabaseAuth.assertOAuthProvider(body.provider);

    if (body.action === 'link') {
      const { verifier, challenge } = supabaseAuth.pkcePair();
      const url = await supabaseAuth.linkIdentityUrl(claims.accessToken, {
        provider, redirectTo: oauth.callbackUrl(event), codeChallenge: challenge
      });
      return withCookies(json(200, { ok: true, data: { url } }),
        [oauth.oauthCookie(event, { verifier, provider, mode: 'link', expectUserId: claims.userId })]);
    }

    if (body.action === 'unlink') {
      const identities = await supabaseAuth.listIdentities(claims.accessToken);
      const target = identities.find((i) => i.provider === provider);
      if (!target) throw auth.authError('VALIDATION_ERROR', '這個登入方式沒有綁定');
      if (identities.length < 2) throw auth.authError('VALIDATION_ERROR', '至少要保留一種登入方式');
      await supabaseAuth.unlinkIdentity(claims.accessToken, target.identityId);
      await withUser(claims.userId, (client) => client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.oauth.unlinked',$2,'user',$2,'OAUTH',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId, JSON.stringify({ provider })]));
      return json(200, { ok: true, data: summarize(identities.filter((i) => i !== target)) });
    }

    throw auth.authError('VALIDATION_ERROR', '不支援的操作');
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
