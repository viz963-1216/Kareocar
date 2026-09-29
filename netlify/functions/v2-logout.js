'use strict';

/**
 * POST /api/v2/logout   —— 登出這個裝置
 *
 * 撤銷目前這組 refresh token（Supabase Auth，scope=local），並清掉 cookie。
 * access token 在到期前仍然有效，但瀏覽器已經沒有它了。撤銷失敗不影響清 cookie。
 */

const { json, withCookies } = require('./_http');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    session.assertSameOrigin(event);
  } catch (error) {
    return json(403, { ok: false, error: { code: 'FORBIDDEN', message: error.message } });
  }
  const accessToken = session.readCookie(event, session.ACCESS_COOKIE);
  if (accessToken) {
    try { await supabaseAuth.signOut(accessToken, 'local'); } catch (error) {
      console.warn('[logout] 撤銷 refresh token 失敗', error && error.code);
    }
  }
  return withCookies(json(200, { ok: true, data: { loggedOut: true } }), session.clearSessionCookies(event));
};
