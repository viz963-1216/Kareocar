'use strict';

/**
 * 登入、換 token、註冊之後回給前端的身分資料（使用者、成員資格、組織清單）。
 * 以使用者自己的身分讀取，RLS 一併適用。
 */

const auth = require('./_auth-pg');

async function loadIdentity(client, userId) {
  const { rows } = await client.query(
    'select id, display_name, phone_e164, platform_role, active from users where id = $1', [userId]);
  const user = rows[0];
  if (!user) throw auth.authError('SESSION_INVALID', '使用者不存在，請重新登入');
  if (user.active !== true) throw auth.authError('SESSION_INVALID', '此帳號已停用');

  const memberships = (await client.query('SELECT * FROM app.get_memberships($1)', [userId])).rows;
  const platformRole = String(user.platform_role || 'none').toLowerCase();
  if (platformRole !== 'super_admin' && memberships.length === 0) {
    throw auth.authError('NO_ACTIVE_IDENTITY', '此帳號目前沒有有效身分，請聯絡平台管理者');
  }

  // 前端的 activeMembershipsForUser 會要求「成員資格指向的組織必須在本機存在」，
  // 否則那筆身分會被過濾掉、變成「沒有有效身分」，所以組織要一起帶上。
  // 只帶最少的欄位（orgs 測試把關）；審核狀態等由 state-load 提供
  const organizations = (await client.query(
    'select id, org_type, name, active from organizations')).rows.map((o) => ({
      id: o.id, type: o.org_type, name: o.name || '', active: o.active !== false
    }));

  return {
    organizations,
    user: {
      userId: user.id,
      displayName: user.display_name || '',
      phone: String(user.phone_e164 || '').replace(/^\+886/, '0'),
      platformRole
    },
    memberships: memberships.map((m) => ({
      membershipId: m.id, organizationId: m.organization_id, role: m.role, status: m.status
    }))
  };
}

module.exports = { loadIdentity };
