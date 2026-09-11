'use strict';

/**
 * POST /api/v2/register-requester  —— 需求者自助註冊
 *
 * 取代 identity-register-requester.js（Apps Script 版）。
 *
 * 整個註冊是一筆交易：建立使用者、掛上需求者組織的成員資格、寫入密碼憑證。
 * 任何一步失敗就整筆回滾，不會留下「有帳號但沒有密碼」或「有密碼但沒有身分」
 * 的殘骸——Apps Script 版是靠手動補償刪除來達成這件事的。
 */

const { json, parseBody, handleError, clientIp } = require('./_apps-script');
const { withoutUser, withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

const REQUESTER_ORG_ID = 'ORG-REQ-001';

function newId(prefix) {
  return `${prefix}-${auth.randomHex(16).slice(0, 16).toUpperCase()}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const body = parseBody(event);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const password = String(body.password || '');

    if (!name || name.length > 80) throw auth.authError('VALIDATION_ERROR', '請輸入正確姓名');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw auth.authError('VALIDATION_ERROR', '請輸入正確電子信箱');
    if (!/^09\d{8}$/.test(phone)) throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭的 10 位手機號碼');
    if (password.length < 8) throw auth.authError('WEAK_PASSWORD', '密碼至少需要 8 碼');
    if (password.length > 128) throw auth.authError('WEAK_PASSWORD', '密碼長度不可超過 128 碼');

    const userId = newId('USR-PW');
    const membershipId = newId('MEM-REQ');

    const result = await withoutUser(async (client) => {
      await client.query('SELECT app.register_requester($1,$2,$3,$4,$5)',
        [userId, membershipId, name, email, auth.toE164(phone)]);
      await auth.setPasswordCredential(client, userId, password);
      const sessionToken = await auth.issueSessionToken(client, userId);
      return {
        user: { userId, displayName: name, phone, email, platformRole: 'none' },
        membership: { membershipId, organizationId: REQUESTER_ORG_ID, role: 'requester', status: 'active' },
        sessionToken
      };
    });

    result.memberships = [result.membership];

    // 稽核與組織清單都用新帳號自己的身分做，RLS 一併適用。
    // 組織一定要回給前端：activeMembershipsForUser 會要求成員資格指向的組織在
    // 本機存在，否則那筆身分會被濾掉，使用者剛註冊完就看到「沒有有效身分」。
    try {
      result.organizations = await withUser(userId, async (client) => {
        await client.query(
          `insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
           values ($1,'identity.requester_registered',$2,$3,'user',$2,'SELF_REGISTRATION',$4)`,
          [`AUD-${Date.now()}-${auth.randomHex(4)}`, userId, REQUESTER_ORG_ID,
           JSON.stringify({ membershipId, sourceIp: clientIp(event) ? 'recorded' : 'unknown' })]);
        const { rows } = await client.query('select id, org_type, name, active from organizations');
        return rows.map((o) => ({ id: o.id, type: o.org_type, name: o.name || '', active: o.active !== false }));
      });
    } catch (auditError) {
      console.error('[audit] identity.requester_registered 寫入失敗', auditError);
      result.organizations = [{ id: REQUESTER_ORG_ID, type: 'requester_hub', name: '需求者組織', active: true }];
    }

    return json(200, { ok: true, data: result });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
