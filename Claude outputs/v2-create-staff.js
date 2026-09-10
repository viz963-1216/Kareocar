'use strict';

/**
 * POST /api/v2/create-staff  —— 負責人／平台管理者建立員工
 *
 * 整段跑在 withUser(操作者) 底下，授權完全交給 RLS：
 *   - memberships 的 insert 政策只允許「該組織的 owner，且新增的角色不是 owner」
 *     或 super_admin。所以負責人建得出調度員與司機，建不出第二個負責人；
 *     要新增負責人只有平台管理者做得到。這裡不需要（也不該）自己再判斷一次。
 *   - drivers 的 insert 政策同樣要求 owner 或 super_admin。
 * 這比 Apps Script 版可靠：那邊的權限判斷寫在程式裡，繞過 API 就沒了。
 *
 * 唯一用到 security definer 的是「用手機號碼找既有帳號」——因為要加進來的人
 * 本來就不在操作者看得到的範圍內。那支函式自己會確認呼叫者是營運方。
 */

const { json, parseBody, handleError } = require('./_apps-script');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

const REQUESTER_ORG_ID = 'ORG-REQ-001';
const STAFF_ROLES = ['owner', 'dispatcher', 'driver'];

function newId(prefix) {
  return `${prefix}-${auth.randomHex(16).slice(0, 16).toUpperCase()}`;
}

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

    const organizationId = String(body.organizationId || '').trim();
    const role = String(body.role || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const password = String(body.password || '');
    const alsoRequester = body.alsoRequester === true;

    if (!organizationId || organizationId === REQUESTER_ORG_ID) {
      throw auth.authError('VALIDATION_ERROR', '請選擇一般公司／機構組織');
    }
    if (!STAFF_ROLES.includes(role)) throw auth.authError('VALIDATION_ERROR', '不支援的人員角色');
    if (!name || name.length > 80) throw auth.authError('VALIDATION_ERROR', '請輸入姓名');
    if (!/^09\d{8}$/.test(phone)) throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭共 10 位手機號碼');

    const data = await withUser(claims.userId, async (client) => {
      await auth.verifySessionToken(client, token);

      const org = (await client.query(
        'select id, name from organizations where id = $1 and active', [organizationId])).rows[0];
      if (!org) throw auth.authError('ORG_NOT_FOUND', '找不到有效組織');

      if (role === 'owner') {
        const existing = (await client.query(
          `select 1 from memberships
            where organization_id = $1 and role = 'owner' and status = 'active' limit 1`,
          [organizationId])).rows[0];
        if (existing) throw auth.authError('OWNER_EXISTS', '此組織已經有有效負責人');
      }

      const found = (await client.query(
        'SELECT * FROM app.staff_lookup_user($1)', [auth.toE164(phone)])).rows[0];

      if (found && String(found.platform_role || '').toLowerCase() === 'super_admin') {
        throw auth.authError('FORBIDDEN', '平台超級管理者不可加入公司 Membership');
      }

      let userId = found ? found.id : newId('USR-PW');
      const createdUser = !found;

      if (createdUser) {
        if (password.length < 8) throw auth.authError('WEAK_PASSWORD', '新帳號初始密碼至少需要 8 碼');
        if (password.length > 128) throw auth.authError('WEAK_PASSWORD', '密碼長度不可超過 128 碼');
        await client.query(
          `insert into users (id, display_name, phone_e164, auth_provider, auth_subject_id, active, platform_role)
           values ($1,$2,$3,'password',$4,true,'none')`,
          [userId, name, auth.toE164(phone), `password:${userId}`]);
        await auth.setPasswordCredential(client, userId, password);
      } else {
        const dup = (await client.query(
          `select 1 from memberships
            where user_id = $1 and organization_id = $2 and status = 'active' limit 1`,
          [userId, organizationId])).rows[0];
        if (dup) throw auth.authError('MEMBERSHIP_EXISTS', '此使用者在目前組織已有有效身分');
      }

      const membershipId = newId('MEM-STAFF');
      await client.query(
        `insert into memberships (id, user_id, organization_id, role, status)
         values ($1,$2,$3,$4,'active')`,
        [membershipId, userId, organizationId, role]);

      if (role === 'driver') {
        await client.query(
          `insert into drivers (id, user_id, organization_id, duty_status, active)
           values ($1,$2,$3,'off_duty',true)`,
          [newId('DRV'), userId, organizationId]);
      }

      if (alsoRequester) {
        const hasRequester = (await client.query(
          `select 1 from memberships
            where user_id = $1 and organization_id = $2 and role = 'requester'
              and status = 'active' limit 1`,
          [userId, REQUESTER_ORG_ID])).rows[0];
        if (!hasRequester) {
          await client.query(
            `insert into memberships (id, user_id, organization_id, role, status)
             values ($1,$2,$3,'requester','active')`,
            [newId('MEM-REQ'), userId, REQUESTER_ORG_ID]);
        }
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
         values ($1,'identity.staff_created',$2,$3,'membership',$4,'STAFF_CREATE',$5)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId, organizationId, membershipId,
         JSON.stringify({ targetUserId: userId, role, createdUser, alsoRequester })]);

      return {
        user: {
          userId,
          displayName: createdUser ? name : (found.display_name || name),
          phone,
          platformRole: 'none'
        },
        membership: { membershipId, organizationId, role, status: 'active' },
        createdUser,
        reusedUser: !createdUser
      };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
