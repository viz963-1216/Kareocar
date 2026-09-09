'use strict';
const { json, callAppsScript, parseBody, handleError } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try {
    const body = parseBody(event);
    const data = await callAppsScript({ method: 'POST', path: '/auth/google', body });
    return json(200, { ok: true, identity: data.identity || {}, data });
  } catch (error) { return handleError(error); }
};
