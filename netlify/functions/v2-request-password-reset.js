'use strict';

/**
 * POST /api/v2/request-password-reset
 *
 * 不存在的手機號碼會得到「跟成功一模一樣」的回應，不建立挑戰也不發簡訊。
 * 這是刻意的：任何差異（錯誤碼、訊息、回應時間長短的量級）都能被拿來
 * 逐一測試哪些號碼有註冊。
 */

const { json, parseBody, handleError } = require('./_apps-script');
const { withoutUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const reset = require('./_auth-reset');
const { sendPasswordResetSms } = require('./_sms');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const body = parseBody(event);
    const phone = auth.normalizeTaiwanPhone(body.phone);
    if (!/^09\d{8}$/.test(phone)) {
      throw auth.authError('VALIDATION_ERROR', '請輸入 09 開頭共 10 位手機號碼');
    }

    const generic = { requested: true, expiresInSeconds: reset.RESET_TTL_SECONDS };

    const data = await withoutUser(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM app.find_user_for_login($1)', [auth.toE164(phone)]);
      const user = rows[0];
      if (!user || user.active !== true) return generic;

      const challenge = await reset.createChallenge(client, user.id, phone,
        (code) => sendPasswordResetSms(phone, code));

      // 同一筆交易，不吞錯誤：在交易內 catch 只會把 aborted 狀態留到 COMMIT。
      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'auth.password.reset_requested',$2,'user',$2,'PASSWORD_RESET_REQUEST',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, user.id,
         JSON.stringify({ resent: challenge.resent })]);

      return { requested: true, expiresInSeconds: challenge.expiresInSeconds };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
