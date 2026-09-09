'use strict';
const { json, callAppsScript, handleError } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try {
    const sheet = String(event.queryStringParameters?.sheet || '').trim();
    const authorization = String(event.headers?.authorization || event.headers?.Authorization || '');
    const sessionToken = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!sessionToken) return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入再讀取 Google Database' } });
    if (!sheet) return json(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: '缺少 sheet' } });
    const rows = await callAppsScript({ method: 'GET', path: '/database/table', body: { sheet, sessionToken }, query: { sheet } });
    return json(200, { ok: true, data: { rows: Array.isArray(rows) ? rows : [] } });
  } catch (error) { return handleError(error); }
};
