'use strict';

/**
 * POST /api/v2/account-deletion  —— 刪除帳號與個資申請（#26 第二部分）
 *
 * body:
 *   { action: 'request', reason }      使用者提出申請
 *   { action: 'cancel', id }           使用者撤回自己處理中的申請
 *   { action: 'approve', id, note? }   平台超級管理者核准並執行（見 migration 0011）
 *   { action: 'reject', id, note }     平台超級管理者駁回（必須填原因）
 *
 * 核准時資料庫的清除與 Supabase Auth 帳號刪除在同一個請求裡：先在交易內清除資料，最後刪除
 * Auth 帳號；Auth 刪除失敗就整筆回滾，申請維持 pending，管理員可以再試一次。
 */

const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const action = String(body.action || '').trim();

  if (action === 'request') {
    const id = (await client.query('select app.request_account_deletion($1) as id', [optionalText(body.reason, 500)])).rows[0].id;
    await writeAudit(client, { eventType: 'account.deletion_requested', actorUserId: claims.userId,
      entityType: 'deletion_request', entityId: id, details: {} });
    return { id, status: 'pending' };
  }
  if (action === 'cancel') {
    const id = requireId(body.id, '申請 ID ');
    await client.query('select app.cancel_account_deletion($1)', [id]);
    await writeAudit(client, { eventType: 'account.deletion_cancelled', actorUserId: claims.userId,
      entityType: 'deletion_request', entityId: id, details: {} });
    return { id, status: 'cancelled' };
  }
  if (action === 'approve' || action === 'reject') {
    const id = requireId(body.id, '申請 ID ');
    const result = (await client.query('select app.review_account_deletion($1, $2, $3) as r',
      [id, action, optionalText(body.note, 500)])).rows[0].r;
    if (result.status === 'completed') {
      try {
        await supabaseAuth.deleteUser(result.userId);
      } catch (error) {
        throw auth.authError('AUTH_PROVIDER_ERROR', `資料已準備清除，但登入帳號刪除失敗，整筆未執行，請稍後再試（${error.message}）`);
      }
    }
    return { id, ...result };
  }
  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
