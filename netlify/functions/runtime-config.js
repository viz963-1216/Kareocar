'use strict';
const { json } = require('./_apps-script');
exports.handler = async () => {
  const googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!googleClientId.endsWith('.apps.googleusercontent.com')) {
    return json(503, { ok: false, error: { code: 'CONFIG_MISSING', message: '正式環境尚未設定有效的 GOOGLE_CLIENT_ID' } });
  }
  return json(200, { ok: true, data: { googleClientId } });
};
