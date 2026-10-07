'use strict';

/**
 * GET /api/v2/public-settings  —— 不需登入（#79）
 *
 * 回傳 { loginMethods: { google, facebook }, supportContact: { lineUrl, email } }。
 * 登入頁用來決定顯示哪些社群登入按鈕；忘記密碼、我的帳戶、隱私權政策用來顯示客服聯絡。
 * 只有這兩組，其他平台設定不會從這裡讀到（見 0015 的 app.public_settings）。
 */

const { json, handleError } = require('./_http');
const { withoutUser, translateDbError } = require('./_db');
const { publicSettings } = require('./_public-settings');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const data = await withoutUser(publicSettings);
    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
