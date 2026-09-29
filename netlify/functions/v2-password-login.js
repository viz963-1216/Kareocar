'use strict';

/**
 * POST /api/v2/password-login
 *
 * 走 Postgres 的密碼登入。與 Apps Script 版並存，前端可以逐條切換。
 */

const { json, parseBody, handleError, clientIp } = require('./_http');
const { withoutUser, withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const body = parseBody(event);
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const password = String(body.password || '');
    if (!/^09\d{8}$/.test(phone) || !password) {
      throw auth.authError('INVALID_CREDENTIALS', '帳號或密碼錯誤');
    }
    const sourceIp = clientIp(event);

    // 驗證與「記錄失敗」必須分成兩筆交易：在同一筆裡拋錯會 ROLLBACK，
    // 連失敗計數一起回滾掉，鎖定就永遠不會生效。
    const attempt = await withoutUser(async (client) => {
      await auth.assertLoginAllowed(client, phone, sourceIp);
      const { rows } = await client.query('SELECT * FROM app.find_user_for_login($1)', [auth.toE164(phone)]);
      const user = rows[0];
      const valid = !!user && user.active === true &&
        await auth.verifyPasswordCredential(client, user.id, password);
      return { valid, user };
    });

    if (!attempt.valid) {
      const state = await withoutUser((client) => auth.recordLoginFailure(client, phone, sourceIp));
      const now = Math.floor(Date.now() / 1000);
      const lockedUntil = Number(state.lockedUntil || 0);
      if (lockedUntil > now) {
        throw Object.assign(
          auth.authError('LOGIN_RATE_LIMITED', '登入失敗次數過多，請稍後再試'),
          { retryAfterSeconds: lockedUntil - now });
      }
      throw auth.authError('INVALID_CREDENTIALS', '帳號或密碼錯誤');
    }

    const result = await withUser(attempt.user.id, async (client) => {
      const user = attempt.user;
      await auth.clearLoginRate(client, phone);

      const memberships = (await client.query('SELECT * FROM app.get_memberships($1)', [user.id])).rows;
      if (String(user.platform_role || '').toLowerCase() !== 'super_admin' && memberships.length === 0) {
        throw auth.authError('NO_ACTIVE_IDENTITY', '此帳號目前沒有有效身分，請聯絡平台管理者');
      }

      // 前端的 activeMembershipsForUser 會要求「成員資格指向的組織必須在本機存在」，
      // 否則那筆身分會被過濾掉、變成「沒有有效身分」。以前組織是靠整份鏡像帶進來的，
      // 現在本機一開始是空的，所以身分回應必須自己把組織一起帶上。
      const organizations = (await client.query(
        `select id, org_type, name, active from organizations`)).rows.map((o) => ({
          id: o.id, type: o.org_type, name: o.name || '', active: o.active !== false
        }));

      const sessionToken = await auth.issueSessionToken(client, user.id);
      return {
        organizations,
        user: {
          userId: user.id,
          displayName: user.display_name || '',
          phone,
          platformRole: String(user.platform_role || 'none').toLowerCase()
        },
        memberships: memberships.map((m) => ({
          membershipId: m.id, organizationId: m.organization_id, role: m.role, status: m.status
        })),
        sessionToken
      };
    });

    // 稽核寫入用登入後的身分，讓 RLS 一併適用
    try {
      await withUser(result.user.userId, (client) => client.query(
        `insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.password.login',$2,$3,'user',$2,'PASSWORD_LOGIN',$4)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, result.user.userId,
         result.memberships[0] ? result.memberships[0].organizationId : null,
         JSON.stringify({ sourceIp: sourceIp ? 'recorded' : 'unknown' })]));
    } catch (auditError) {
      console.error('[audit] auth.password.login 寫入失敗', auditError);
    }

    return json(200, { ok: true, data: result });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
