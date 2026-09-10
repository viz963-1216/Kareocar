'use strict';

/**
 * POST /api/v2/session   —— 用既有的 session token 換回身分（重新整理頁面時用）
 *
 * 取代 identity-session.js（Apps Script 版）。前端在載入時會呼叫這支，
 * 沒有它的話，切到 v2 登入之後只要重新整理就會被登出。
 *
 * 驗證在 withUser 交易內做：verifySessionToken 會比對 users.session_version，
 * 所以改過密碼（版本 +1）的舊 token 會在這裡被踢掉，不只是簽章有效就放行。
 *
 * 使用者資料是「以自己的身分」讀出來的——users_read 政策裡的
 * id = app.current_user_id() 那一條。這裡沒有繞過 RLS 的捷徑。
 */

const { json, parseBody, handleError } = require('./_apps-script');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

// token 用掉超過一半壽命就換一張新的，長時間值班不會做到一半被登出。
// 舊 token 不會因此失效（要讓它失效請改密碼，那會 bump session_version）。
const REFRESH_AFTER_RATIO = 0.5;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const body = parseBody(event);
    const headerToken = String(event.headers?.authorization || event.headers?.Authorization || '')
      .replace(/^Bearer\s+/i, '').trim();
    const token = String(body.sessionToken || '').trim() || headerToken;
    if (!token) {
      return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入' } });
    }

    // 先只驗簽章拿 userId；版本比對需要資料庫，放在交易內
    const claims = auth.parseSessionToken(token);

    const data = await withUser(claims.userId, async (client) => {
      await auth.verifySessionToken(client, token);

      const { rows } = await client.query(
        'select id, display_name, phone_e164, platform_role, active from users where id = $1',
        [claims.userId]);
      const user = rows[0];
      if (!user) throw auth.authError('SESSION_INVALID', '使用者不存在，請重新登入');
      if (user.active !== true) throw auth.authError('SESSION_INVALID', '此帳號已停用');

      const memberships = (await client.query('SELECT * FROM app.get_memberships($1)', [claims.userId])).rows;
      const isSuperAdmin = String(user.platform_role || '').toLowerCase() === 'super_admin';
      if (!isSuperAdmin && memberships.length === 0) {
        throw auth.authError('NO_ACTIVE_IDENTITY', '此帳號目前沒有有效身分，請聯絡平台管理者');
      }

      // 手機號碼回前端時用 09 開頭的本地格式，跟登入端點一致
      const phone = String(user.phone_e164 || '').replace(/^\+886/, '0');

      const result = {
        user: {
          userId: user.id,
          displayName: user.display_name || '',
          phone,
          platformRole: String(user.platform_role || 'none').toLowerCase()
        },
        memberships: memberships.map((m) => ({
          membershipId: m.id, organizationId: m.organization_id, role: m.role, status: m.status
        }))
      };

      const now = Math.floor(Date.now() / 1000);
      const issuedAt = Number(claims.iat || 0);
      const expiresAt = Number(claims.exp || 0);
      const halfway = issuedAt + (expiresAt - issuedAt) * REFRESH_AFTER_RATIO;
      if (now > halfway) {
        result.sessionToken = await auth.issueSessionToken(client, claims.userId);
      }
      return result;
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
