'use strict';

/**
 * POST /api/v2/confirm-password-reset
 *
 * 驗證碼通過後：寫新密碼、bump session 版本（所有裝置上的舊 token 立刻失效，
 * 這正是「我的帳號被盜了」時使用者期待發生的事）、清掉登入失敗計數與挑戰。
 *
 * 全部在同一筆交易裡，所以不會出現「密碼換了但舊 session 還活著」的空窗。
 */

const { json, parseBody, handleError } = require('./_apps-script');
const { withoutUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const reset = require('./_auth-reset');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
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
        throw auth.authError('RESET_CODE_INVALID', '驗證碼無效或已失效');
      }

      await auth.setPasswordCredential(client, user.id, newPassword);
      await auth.bumpSessionVersion(client, user.id);
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
    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
