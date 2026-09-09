'use strict';
const { json, callAppsScript, parseBody, handleError } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try {
    const authorization = String(event.headers?.authorization || event.headers?.Authorization || '');
    const sessionToken = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!sessionToken) return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入再寫入正式資料庫' } });
    const body = parseBody(event);
    const data = await callAppsScript({ method: 'POST', path: '/state/mutate', body: { sessionToken, changes: Array.isArray(body.changes) ? body.changes : [] } });
    return json(200, { ok: true, data });
  } catch (error) { return handleError(error); }
};
