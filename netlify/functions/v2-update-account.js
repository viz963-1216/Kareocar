'use strict';

/**
 * POST /api/v2/update-account  —— 使用者修改自己的顯示名稱／手機／密碼
 *
 * 授權靠 RLS：users_update 政策裡的 id = app.current_user_id()。這支端點不會
 * 也不能改到別人的資料列。
 *
 * 改密碼或改手機號碼都必須再輸入一次目前的密碼（由 Supabase Auth 驗證）。手機
 * 號碼就是登入帳號，只要 token 被偷就能把帳號整個換走——多一道現行密碼，偷到
 * token 的人還是接管不了帳號。
 *
 * 改完密碼或手機之後：
 *   - sessions_valid_after 推到現在，所有裝置上既有的 access token 立即失效
 *   - Supabase Auth 撤銷這個使用者全部的 refresh token
 *   - 以新的帳密替目前這個裝置重新登入，寫回 cookie，使用者不會被登出
 */

const { json, withCookies, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);
    const body = parseBody(event);

    const name = String(body.name || '').trim();
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const newPassword = String(body.newPassword || '');
    const currentPassword = String(body.currentPassword || '');

    if (!name || name.length > 80) throw auth.authError('VALIDATION_ERROR', '請輸入正確顯示名稱');
    if (!/^09\d{8}$/.test(phone)) throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭共 10 位手機號碼');
    if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
      throw auth.authError('WEAK_PASSWORD', '新密碼至少需要 8 碼，最多 128 碼');
    }

    let credentialsChanged = false;
    let validAfter = 0;
    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);

      const user = (await client.query(
        'select id, display_name, phone_e164, platform_role, active from users where id = $1',
        [claims.userId])).rows[0];
      if (!user || user.active !== true) {
        throw auth.authError('SESSION_INVALID', '使用者已停用或不存在');
      }

      const oldPhone = auth.normalizeTaiwanPhone(user.phone_e164);
      const phoneChanged = oldPhone !== phone;
      credentialsChanged = Boolean(newPassword) || phoneChanged;

      if (credentialsChanged) {
        if (!currentPassword) {
          throw auth.authError('CURRENT_PASSWORD_REQUIRED', '變更密碼或手機號碼前，請先輸入目前的密碼');
        }
        try {
          await supabaseAuth.signInWithPassword(auth.toE164(oldPhone), currentPassword);
        } catch (error) {
          if (error.code === 'INVALID_CREDENTIALS') throw auth.authError('INVALID_CREDENTIALS', '目前密碼不正確');
          throw error;
        }
      }

      // 手機號碼是唯一鍵，撞號時 Postgres 回 23505，translateDbError 轉成 ACCOUNT_EXISTS
      await client.query(
        'update users set display_name = $2, phone_e164 = $3, updated_at = now() where id = $1',
        [claims.userId, name, auth.toE164(phone)]);

      if (credentialsChanged) {
        // 在交易內呼叫：Supabase Auth 更新失敗就整筆回滾，資料庫與登入帳號不會不一致
        await supabaseAuth.updateUser(claims.userId, {
          phoneE164: phoneChanged ? auth.toE164(phone) : undefined,
          password: newPassword || undefined
        });
        validAfter = await session.revokeSessions(client, claims.userId);
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
        passwordChanged: !!newPassword
      };
    });

    if (!credentialsChanged) return json(200, { ok: true, data });

    // 其他裝置的 refresh token 一併撤銷；失敗時 access token 仍已因 sessions_valid_after 失效
    try { await supabaseAuth.signOut(claims.accessToken, 'global'); } catch (error) {
      console.warn('[update-account] 撤銷 refresh token 失敗', error && error.code);
    }
    await session.waitUntilValid(validAfter);
    const tokens = await supabaseAuth.signInWithPassword(auth.toE164(phone), newPassword || currentPassword);
    return withCookies(json(200, { ok: true, data }), session.sessionCookies(event, tokens));
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
