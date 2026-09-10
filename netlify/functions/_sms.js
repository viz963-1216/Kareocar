'use strict';

/**
 * 密碼重設簡訊。對應 AuthCore.gs 的 authSendPasswordResetSms_。
 *
 * 沒有設定 webhook 就直接拒絕，不會偷偷降級成「假裝寄出去了」——那會讓
 * 使用者永遠等不到簡訊卻看到成功訊息。
 */

const SEND_TIMEOUT_MS = 10_000;

function providerUnavailable(message) {
  return Object.assign(new Error(message), { code: 'RESET_PROVIDER_UNAVAILABLE' });
}

async function sendPasswordResetSms(phone, code) {
  const url = String(process.env.PASSWORD_RESET_SMS_WEBHOOK_URL || '').trim();
  const secret = String(process.env.PASSWORD_RESET_SMS_WEBHOOK_SECRET || '').trim();
  if (!url || !/^https:\/\//i.test(url) || !secret) {
    throw providerUnavailable('正式簡訊密碼重設服務尚未設定');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Care-Ride-Secret': secret },
      body: JSON.stringify({
        phone: String(phone),
        message: `安心接送密碼重設驗證碼：${String(code)}（5 分鐘內有效）`
      }),
      signal: controller.signal
    });
  } catch (error) {
    throw providerUnavailable('簡訊服務暫時無法使用，請稍後再試');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 不要把簡訊商的回應內容原封不動丟給前端，那有可能含有電話號碼或金鑰
    console.error('[sms] 簡訊服務回應非 2xx', response.status);
    throw providerUnavailable('簡訊服務暫時無法使用，請稍後再試');
  }
}

module.exports = { sendPasswordResetSms };
