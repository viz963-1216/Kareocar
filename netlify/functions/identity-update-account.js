'use strict';
const { json, callAppsScript, parseBody, handleError } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try {
    const authorization = String(event.headers?.authorization || event.headers?.Authorization || '');
    const sessionToken = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!sessionToken) return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入' } });
    const body = parseBody(event);
    const data = await callAppsScript({ method: 'POST', path: '/identity/update-account', body: { ...body, sessionToken } });
    return json(200, { ok: true, data });
  } catch (error) { return handleError(error); }
};
