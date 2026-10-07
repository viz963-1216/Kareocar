'use strict';

/**
 * GET /api/v2/oauth-start?provider=google|facebook   （#58）
 *
 * 登入畫面的「使用 Google／Facebook 登入」按鈕直接連到這裡。產生 PKCE，把 verifier 放進
 * cr_oauth cookie，轉到 Supabase 的授權網址；Supabase 再轉到 Google／Facebook。
 * 流程說明見 _oauth.js。
 *
 * 平台設定關閉的登入方式（#79，試營運期間 Facebook 預設關閉）回首頁並帶 login_error=provider_disabled。
 */

const supabaseAuth = require('./_supabase-auth');
const oauth = require('./_oauth');
const { withoutUser } = require('./_db');
const { loginMethodEnabled } = require('./_public-settings');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return oauth.redirect('/?login_error=failed');
  try {
    const provider = supabaseAuth.assertOAuthProvider((event.queryStringParameters || {}).provider);
    if (!(await withoutUser((client) => loginMethodEnabled(client, provider)))) {
      return oauth.redirect('/?login_error=provider_disabled');
    }
    const { verifier, challenge } = supabaseAuth.pkcePair();
    const location = supabaseAuth.authorizeUrl({
      provider, redirectTo: oauth.callbackUrl(event), codeChallenge: challenge
    });
    return oauth.redirect(location, [oauth.oauthCookie(event, { verifier, provider })]);
  } catch (error) {
    console.error('[oauth-start]', error && error.code);
    return oauth.redirect('/?login_error=failed');
  }
};
