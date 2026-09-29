'use strict';

/**
 * POST /api/v2/password-login   { phone, password }
 *
 * 手機號碼加密碼登入。密碼由 Supabase Auth 驗證；成功後 access token 與 refresh
 * token 只寫進 HttpOnly cookie（見 _session.js），回應本體不含任何 token。
 *
 * 速率限制仍由這裡以手機號碼與來源 IP 計算（Supabase Auth 另有自己的限制）。
 */

const { json, withCookies, parseBody, handleError, clientIp } = require('./_http');
const { withoutUser, withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const { loadIdentity } = require('./_identity');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    session.assertSameOrigin(event);
    const body = parseBody(event);
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const password = String(body.password || '');
    if (!/^09\d{8}$/.test(phone) || !password) {
      throw auth.authError('INVALID_CREDENTIALS', '帳號或密碼錯誤');
    }
    const sourceIp = clientIp(event);

    await withoutUser((client) => auth.assertLoginAllowed(client, phone, sourceIp));

    let tokens;
    try {
      tokens = await supabaseAuth.signInWithPassword(auth.toE164(phone), password);
    } catch (error) {
      if (error.code !== 'INVALID_CREDENTIALS') throw error;
      // 記錄失敗是獨立的交易：跟驗證放在同一筆裡拋錯會連計數一起回滾
      const state = await withoutUser((client) => auth.recordLoginFailure(client, phone, sourceIp));
      const now = Math.floor(Date.now() / 1000);
      const lockedUntil = Number(state.lockedUntil || 0);
      if (lockedUntil > now) {
        throw Object.assign(auth.authError('LOGIN_RATE_LIMITED', '登入失敗次數過多，請稍後再試'),
          { retryAfterSeconds: lockedUntil - now });
      }
      throw error;
    }

    let claims = await supabaseAuth.verifyAccessToken(tokens.accessToken);
    const load = () => withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      await auth.clearLoginRate(client, phone);
      return loadIdentity(client, claims.userId);
    });
    let data;
    try {
      data = await load();
    } catch (error) {
      // 剛改過或重設過密碼的同一秒內登入：token 的 iat 還沒到生效起點，等一下重取一次
      if (!error.revokedUntil) throw error;
      await session.waitUntilValid(error.revokedUntil);
      tokens = await supabaseAuth.signInWithPassword(auth.toE164(phone), password);
      claims = await supabaseAuth.verifyAccessToken(tokens.accessToken);
      data = await load();
    }

    // 稽核用登入後的身分寫入，讓 RLS 一併適用；寫入失敗不擋登入
    try {
      await withUser(claims.userId, (client) => client.query(
        `insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.password.login',$2,$3,'user',$2,'PASSWORD_LOGIN',$4)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         data.memberships[0] ? data.memberships[0].organizationId : null,
         JSON.stringify({ sourceIp: sourceIp ? 'recorded' : 'unknown' })]));
    } catch (auditError) {
      console.error('[audit] auth.password.login 寫入失敗', auditError);
    }

    return withCookies(json(200, { ok: true, data }), session.sessionCookies(event, tokens));
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
