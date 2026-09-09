'use strict';
const { json, callAppsScript, parseBody, handleError, clientIp } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try { const data = await callAppsScript({ method: 'POST', path: '/identity/request-password-reset', body: parseBody(event), clientIp: clientIp(event) }); return json(200, { ok: true, data }); }
  catch (error) { return handleError(error); }
};
