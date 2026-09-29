'use strict';

/**
 * POST /api/v2/register-requester  —— 需求者自助註冊
 *
 * 先在 Supabase Auth 建立帳號（手機號碼＋密碼，取得使用者 ID），再用同一個 ID
 * 在資料庫建立使用者列與需求者成員資格。資料庫這一步失敗時，補償刪除剛建立的
 * Supabase Auth 帳號，不會留下「能登入但沒有身分」的殘骸。成功後直接登入，
 * token 只寫進 HttpOnly cookie。
 *
 * 手機號碼目前不做簡訊驗證就建立為已驗證（與改用 Supabase Auth 前相同）；
 * 簡訊驗證在 #19 接上。
 */

const { json, withCookies, parseBody, handleError, clientIp } = require('./_http');
const { withoutUser, withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');

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

    session.assertSameOrigin(event);
    const phoneE164 = auth.toE164(phone);
    const membershipId = newId('MEM-REQ');

    // 資料庫已有這個手機號碼時，不先去 Supabase Auth 建帳號再補償
    const taken = await withoutUser(async (client) =>
      (await client.query('SELECT * FROM app.find_user_for_login($1)', [phoneE164])).rows.length > 0);
    if (taken) throw auth.authError('PHONE_EXISTS', '此手機號碼已經註冊');

    const userId = await supabaseAuth.createUser({ phoneE164, password });
    try {
      await withoutUser((client) => client.query('SELECT app.register_requester($1,$2,$3,$4,$5)',
        [userId, membershipId, name, email, phoneE164]));
    } catch (dbError) {
      try { await supabaseAuth.deleteUser(userId); } catch (cleanupError) {
        console.error('[register] 補償刪除 Supabase Auth 帳號失敗，需人工處理', userId, cleanupError && cleanupError.code);
      }
      throw dbError;
    }

    const tokens = await supabaseAuth.signInWithPassword(phoneE164, password);
    const result = {
      user: { userId, displayName: name, phone, email, platformRole: 'none' },
      membership: { membershipId, organizationId: REQUESTER_ORG_ID, role: 'requester', status: 'active' }
    };
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

    return withCookies(json(200, { ok: true, data: result }), session.sessionCookies(event, tokens));
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
