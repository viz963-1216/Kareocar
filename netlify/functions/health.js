'use strict';
const { json, callAppsScript, handleError } = require('./_apps-script');
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  try {
    const data = await callAppsScript({ method: 'GET', path: '/health' });
    const googleClientConfigured = String(process.env.GOOGLE_CLIENT_ID || '').endsWith('.apps.googleusercontent.com');
    return json(200, { ok: true, data: { ...data, googleClientConfigured } });
  } catch (error) { return handleError(error); }
};
