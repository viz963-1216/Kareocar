'use strict';

/**
 * POST /api/v2/confirm-password-reset
 *
 * 驗證碼通過後：在 Supabase Auth 寫入新密碼、把 sessions_valid_after 推到現在
 * （所有裝置上的舊 access token 立刻失效，這正是「我的帳號被盜了」時使用者期待
 * 發生的事）、清掉登入失敗計數與挑戰。資料庫部分在同一筆交易裡，Supabase Auth
 * 的更新放在交易最後，失敗就整筆回滾。
 *
 * 提交之後，再以新密碼登入一次並撤銷這個帳號全部的 refresh token（scope=global），
 * 別的裝置無法再用舊的 refresh token 換到新的 access token。
 */

const { json, parseBody, handleError } = require('./_http');
const { withoutUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const reset = require('./_auth-reset');
const supabaseAuth = require('./_supabase-auth');
const session = require('./_session');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    session.assertSameOrigin(event);
    const body = parseBody(event);
    const phone = auth.normalizeTaiwanPhone(body.phone);
    const code = String(body.otp || body.code || '').replace(/\D/g, '');
    const newPassword = String(body.newPassword || '');

    if (!/^09\d{8}$/.test(phone) || !/^\d{6}$/.test(code)) {
      throw auth.authError('RESET_CODE_INVALID', '手機號碼或驗證碼格式錯誤');
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw auth.authError('WEAK_PASSWORD', '新密碼至少需要 8 碼，最多 128 碼');
    }

    const data = await withoutUser(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM app.find_user_for_login($1)', [auth.toE164(phone)]);
      const user = rows[0];
      // 找不到人也走一次完整驗證失敗路徑，錯誤訊息與真實情況一致
      if (!user || user.active !== true) {
        throw auth.authError('RESET_CODE_INVALID', '驗證碼無效或已失效');
      }

      // 驗證錯誤的次數／作廢必須提交；在交易外才回報預期錯誤。
      // 其他錯誤仍拋出，保留原本完整回滾行為。
      let verified;
      try {
        verified = await reset.verifyChallenge(client, phone, code);
      } catch (error) {
        if (error.code === 'RESET_CODE_INVALID') return { verificationError: error };
        throw error;
      }
      if (String(verified.userId) !== String(user.id)) {
        // 挑戰綁的使用者不是這支手機現在對應的使用者（例如號碼在挑戰有效期內
        // 被移到別的帳號）。
        //
        // 驗證成功的路徑不會寫回 attempts，所以光是拋錯不只會回滾錯誤次數——
        // 挑戰本身還會留著繼續有效，同一組碼可以一直重試。這裡在同一筆交易
        // （仍持有 verifyChallenge 取得的 advisory lock）內把挑戰作廢，提交之後
        // 才回報一般的 RESET_CODE_INVALID。
        //
        // 不動任何一方的密碼與 session：這個分支下兩個帳號都不該被改。
        await reset.clearChallenge(client, phone);
        return { verificationError: auth.authError('RESET_CODE_INVALID', '驗證碼無效或已失效') };
      }

      await session.revokeSessions(client, user.id);
      await auth.clearLoginRate(client, phone);
      await reset.clearChallenge(client, phone);
      await client.query('update users set updated_at = now() where id = $1', [user.id]);

      // 這筆稽核刻意不包 try/catch：它跟改密碼在同一筆交易裡，寫不進去就
      // 整筆回滾。在交易內吞掉錯誤反而更糟——Postgres 會把交易標成 aborted，
      // 後面的 COMMIT 一樣會失敗，只是變成看不懂的錯誤。沒有紀錄的密碼重設
      // 本來就不該被放行。
      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.password.reset_completed',$2,'user',$2,'PASSWORD_RESET_OTP','{}'::jsonb)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, user.id]);

      // 最後才改 Supabase Auth 的密碼：失敗時上面的資料庫變更一起回滾
      await supabaseAuth.updateUser(user.id, { password: newPassword });

      return {
        reset: true,
        user: {
          userId: user.id,
          displayName: user.display_name || '',
          phone,
          platformRole: String(user.platform_role || 'none').toLowerCase()
        }
      };
    });

    if (data.verificationError) throw data.verificationError;

    // 撤銷其他裝置的 refresh token。失敗不影響重設結果：舊的 access token 已因
    // sessions_valid_after 失效，只是舊 refresh token 在 Supabase Auth 那端還沒撤銷。
    try {
      const tokens = await supabaseAuth.signInWithPassword(auth.toE164(phone), newPassword);
      await supabaseAuth.signOut(tokens.accessToken, 'global');
    } catch (error) {
      console.warn('[reset] 撤銷 refresh token 失敗', error && error.code);
    }
    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
