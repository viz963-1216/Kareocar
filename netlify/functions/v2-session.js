'use strict';

/**
 * POST /api/v2/session   —— 以 cookie 裡的登入工作階段換回身分（重新整理頁面時用）
 *
 * access token 還有效：直接回身分。access token 過期或不見了、但有 refresh token：
 * 向 Supabase Auth 換一組新的，寫回 cookie 後回身分。都不行就清掉 cookie、回 401。
 *
 * 前端呼叫其他 API 拿到 401 SESSION_EXPIRED 時，也是呼叫這支換 token 後重試一次。
 * refresh token 的 cookie 路徑只到這支端點，其他 API 收不到。
 *
 * 使用者資料以自己的身分讀出（users_read 政策的 id = app.current_user_id()），
 * 沒有繞過 RLS 的捷徑。
 */

const { json, withCookies, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');
const { loadIdentity } = require('./_identity');

async function currentOrRefreshed(event) {
  try {
    return { claims: await session.requireSession(event), tokens: null };
  } catch (error) {
    if (!['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(error.code)) throw error;
    const refreshToken = session.readCookie(event, session.REFRESH_COOKIE);
    if (!refreshToken) throw error;
    const tokens = await supabaseAuth.refresh(refreshToken);
    const claims = await supabaseAuth.verifyAccessToken(tokens.accessToken);
    return { claims, tokens };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    session.assertSameOrigin(event);
    const { claims, tokens } = await currentOrRefreshed(event);
    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      return loadIdentity(client, claims.userId);
    });
    const response = json(200, { ok: true, data });
    return tokens ? withCookies(response, session.sessionCookies(event, tokens)) : response;
  } catch (error) {
    const response = handleError(translateDbError(error));
    // 身分無法恢復時順手清掉 cookie，瀏覽器不會一直帶著失效的 token
    return response.statusCode === 401 ? withCookies(response, session.clearSessionCookies(event)) : response;
  }
};
