'use strict';

/**
 * 「我的帳戶」的登入方式（#58）。
 *
 * GET  /api/v2/login-methods                     → 手機＋密碼（一定有）與 Google、Facebook 是否已綁定
 * POST /api/v2/login-methods { action: 'link', provider }    → { url }：到 Google／Facebook 一次，回到
 *                                                              oauth-callback 後記到 social_logins（見 0014）
 * POST /api/v2/login-methods { action: 'unlink', provider }  → 解除綁定（手機＋密碼一定保留，所以總有一種）
 *
 * 綁定有兩種來源，都算「已綁定」：
 *   - social_logins 的對應（目前的做法：綁定既有帳號、在我的帳戶綁定）
 *   - 帳號本身的 Supabase identity（用社群帳號「第一次使用」建立的帳號，或舊的 identity linking）
 * 解除前者：刪掉對應並刪掉那個 Supabase 社群帳號；解除後者：以本人的 token 呼叫 Supabase。
 */

const { json, withCookies, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const oauth = require('./_oauth');
const { loginMethodEnabled } = require('./_public-settings');

async function currentMethods(claims) {
  const mapped = await withUser(claims.userId, async (client) => {
    await session.assertSessionActive(client, claims);
    return (await client.query(
      'select provider, email from social_logins where user_id = $1', [claims.userId])).rows;
  });
  const own = await supabaseAuth.listUserIdentities(claims.userId);
  return { mapped, own };
}

function summarize({ mapped, own }) {
  return {
    phone: true,
    social: supabaseAuth.OAUTH_PROVIDERS.map((provider) => {
      const m = mapped.find((x) => x.provider === provider);
      const o = own.find((x) => x.provider === provider);
      return { provider, linked: Boolean(m || o), email: (m && m.email) || (o && o.email) || '' };
    })
  };
}

function audit(client, userId, provider) {
  return client.query(
    `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
     values ($1,'auth.oauth.unlinked',$2,'user',$2,'OAUTH',$3)`,
    [`AUD-${Date.now()}-${auth.randomHex(4)}`, userId, JSON.stringify({ provider })]);
}

exports.handler = async (event) => {
  try {
    const claims = await session.requireSession(event);

    if (event.httpMethod === 'GET') {
      return json(200, { ok: true, data: summarize(await currentMethods(claims)) });
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    }

    const body = parseBody(event);
    const provider = supabaseAuth.assertOAuthProvider(body.provider);

    if (body.action === 'link') {
      const enabled = await withUser(claims.userId, async (client) => {
        await session.assertSessionActive(client, claims);
        return loginMethodEnabled(client, provider);
      });
      // 平台設定關閉的登入方式不能新綁定（#79）；已綁定的仍可解除
      if (!enabled) throw auth.authError('VALIDATION_ERROR', '這個登入方式目前沒有開放');
      const { verifier, challenge } = supabaseAuth.pkcePair();
      const url = supabaseAuth.authorizeUrl({ provider, redirectTo: oauth.callbackUrl(event), codeChallenge: challenge });
      return withCookies(json(200, { ok: true, data: { url } }),
        [oauth.oauthCookie(event, { verifier, provider, mode: 'link', expectUserId: claims.userId })]);
    }

    if (body.action === 'unlink') {
      const methods = await currentMethods(claims);
      const removed = await withUser(claims.userId, async (client) => {
        const r = (await client.query('select app.unlink_social_login($1) as a', [provider])).rows[0].a;
        if (r) await audit(client, claims.userId, provider);
        return r;
      });
      if (removed) {
        try { await supabaseAuth.deleteUser(removed); } catch (error) {
          // 對應已經刪掉，這個社群帳號登入後只會被當成未綁定；留給管理者清理
          console.error('[login-methods] 刪除已解除的社群帳號失敗', error && error.code);
        }
        methods.mapped = methods.mapped.filter((m) => m.provider !== provider);
        return json(200, { ok: true, data: summarize(methods) });
      }

      const target = methods.own.find((i) => i.provider === provider);
      if (!target) throw auth.authError('VALIDATION_ERROR', '這個登入方式沒有綁定');
      if (methods.own.length < 2) throw auth.authError('VALIDATION_ERROR', '至少要保留一種登入方式');
      if (claims.authUserId !== claims.userId) {
        throw auth.authError('VALIDATION_ERROR', '請先用手機＋密碼登入，再解除這個登入方式');
      }
      await supabaseAuth.unlinkIdentity(claims.accessToken, target.identityId);
      await withUser(claims.userId, (client) => audit(client, claims.userId, provider));
      methods.own = methods.own.filter((i) => i !== target);
      return json(200, { ok: true, data: summarize(methods) });
    }

    throw auth.authError('VALIDATION_ERROR', '不支援的操作');
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
