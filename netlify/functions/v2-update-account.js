'use strict';

/**
 * POST /api/v2/update-account  —— 使用者修改自己的顯示名稱／手機／密碼
 *
 * 授權靠 RLS：users_update 政策裡的 id = app.current_user_id()。這支端點不會
 * 也不能改到別人的資料列。
 *
 * 重要的一條：改密碼或改手機號碼都必須再輸入一次目前的密碼。手機號碼就是登入
 * 帳號，只要 session token 被偷就能把帳號整個換走——多一道現行密碼，偷到 token
 * 的人還是接管不了帳號。改完之後 bump session 版本，把所有裝置上的舊 token 踢掉。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

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
    const claims = auth.parseSessionToken(token);

    const name = String(body.name || '').trim();
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const newPassword = String(body.newPassword || '');

    if (!name || name.length > 80) throw auth.authError('VALIDATION_ERROR', '請輸入正確顯示名稱');
    if (!/^09\d{8}$/.test(phone)) throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭共 10 位手機號碼');
    if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
      throw auth.authError('WEAK_PASSWORD', '新密碼至少需要 8 碼，最多 128 碼');
    }

    const data = await withUser(claims.userId, async (client) => {
      await auth.verifySessionToken(client, token);

      const user = (await client.query(
        'select id, display_name, phone_e164, platform_role, active from users where id = $1',
        [claims.userId])).rows[0];
      if (!user || user.active !== true) {
        throw auth.authError('SESSION_INVALID', '使用者已停用或不存在');
      }

      const oldPhone = auth.normalizeTaiwanPhone(user.phone_e164);
      const phoneChanged = oldPhone !== phone;

      // 社群登入的帳號沒有密碼憑證，對他們來說 session token 就是唯一的證明
      if ((newPassword || phoneChanged) && await auth.hasPasswordCredential(client, claims.userId)) {
        const currentPassword = String(body.currentPassword || '');
        if (!currentPassword) {
          throw auth.authError('CURRENT_PASSWORD_REQUIRED', '變更密碼或手機號碼前，請先輸入目前的密碼');
        }
        if (!await auth.verifyPasswordCredential(client, claims.userId, currentPassword)) {
          throw auth.authError('INVALID_CREDENTIALS', '目前密碼不正確');
        }
      }

      // 手機號碼是唯一鍵，撞號時 Postgres 回 23505，translateDbError 轉成 ACCOUNT_EXISTS
      await client.query(
        'update users set display_name = $2, phone_e164 = $3, updated_at = now() where id = $1',
        [claims.userId, name, auth.toE164(phone)]);

      if (newPassword) await auth.setPasswordCredential(client, claims.userId, newPassword);

      let sessionToken = token;
      if (newPassword || phoneChanged) {
        await auth.bumpSessionVersion(client, claims.userId);
        // bump 之後手上這張 token 也失效了，馬上換一張新的給呼叫者，
        // 否則使用者改完自己的資料就會被登出
        sessionToken = await auth.issueSessionToken(client, claims.userId);
      }

      await auth.clearLoginRate(client, oldPhone);
      await auth.clearLoginRate(client, phone);

      const memberships = (await client.query(
        'SELECT * FROM app.get_memberships($1)', [claims.userId])).rows;

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'identity.account_updated',$2,'user',$2,$3,$4)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         newPassword ? 'PROFILE_AND_PASSWORD_UPDATE' : 'PROFILE_UPDATE',
         JSON.stringify({ phoneChanged, passwordChanged: !!newPassword })]);

      return {
        user: {
          userId: claims.userId,
          displayName: name,
          phone,
          platformRole: String(user.platform_role || 'none').toLowerCase()
        },
        memberships: memberships.map((m) => ({
          membershipId: m.id, organizationId: m.organization_id, role: m.role, status: m.status
        })),
        sessionToken,
        passwordChanged: !!newPassword
      };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
