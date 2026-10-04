'use strict';

/**
 * POST /api/v2/admin-reset-password  { userId }
 *
 * 忘記密碼不發簡訊（#58）：由平台超級管理者或機構負責人在後台替對方重設，伺服器產生一組
 * 臨時密碼，只在這次回應裡出現一次，由操作者當面或電話交給本人；本人登入後到「我的帳戶」
 * 改成自己的密碼。誰可以重設誰由 app.password_reset_target 決定（見 0013）。
 *
 * 和原本的簡訊重設一樣：把 sessions_valid_after 推到現在（所有裝置的舊 access token 立刻
 * 失效）、清掉登入失敗計數、寫稽核紀錄；資料庫部分在同一筆交易，Supabase Auth 的更新放在
 * 交易最後，失敗就整筆回滾。提交後以臨時密碼登入一次並撤銷全部 refresh token（scope=global）。
 *
 * 不在權限範圍內與帳號不存在回應相同（403），不洩漏帳號是否存在。
 */

const crypto = require('crypto');
const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');

// 去掉容易看錯的字元（0/O、1/l/I），方便口頭或手寫轉交
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TEMP_LENGTH = 12;

function temporaryPassword() {
  let out = '';
  for (let i = 0; i < TEMP_LENGTH; i += 1) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);
    const body = parseBody(event);
    const targetUserId = String(body.userId || '').trim();
    if (!targetUserId || targetUserId.length > 100) {
      throw auth.authError('VALIDATION_ERROR', '請指定要重設密碼的帳號');
    }
    if (targetUserId === claims.userId) {
      throw auth.authError('FORBIDDEN', '不能重設自己的密碼，請到「我的帳戶」變更');
    }

    const password = temporaryPassword();
    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);

      const target = (await client.query(
        'select phone_e164, scope from app.password_reset_target($1)', [targetUserId])).rows[0];
      if (!target) throw auth.authError('FORBIDDEN', '沒有權限重設這個帳號的密碼');

      await session.revokeSessions(client, targetUserId);
      if (target.phone_e164) {
        await auth.clearLoginRate(client, auth.normalizeTaiwanPhone(target.phone_e164));
      }

      // 不包 try/catch：寫不進稽核就整筆回滾，沒有紀錄的重設不放行。臨時密碼不寫進任何紀錄。
      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.password.admin_reset',$2,'user',$3,'PASSWORD_RESET_ADMIN',$4)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId, targetUserId,
         JSON.stringify({ scope: target.scope })]);

      // 最後才改 Supabase Auth 的密碼：失敗時上面的資料庫變更一起回滾
      await supabaseAuth.updateUser(targetUserId, { password });
      return { phoneE164: target.phone_e164 };
    });

    // 撤銷對方其他裝置的 refresh token。失敗不影響重設結果：舊的 access token 已因
    // sessions_valid_after 失效，只是舊 refresh token 在 Supabase Auth 那端還沒撤銷。
    if (data.phoneE164) {
      try {
        const tokens = await supabaseAuth.signInWithPassword(data.phoneE164, password);
        await supabaseAuth.signOut(tokens.accessToken, 'global');
      } catch (error) {
        console.warn('[admin-reset] 撤銷 refresh token 失敗', error && error.code);
      }
    }

    return json(200, { ok: true, data: { reset: true, userId: targetUserId, temporaryPassword: password } });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
