'use strict';

/**
 * 接案、司機執行、需求者取消三個專用端點的共用外殼。
 *
 * 授權與狀態驗證全部在資料庫的 security definer 函式裡（0008 migration）；
 * 這裡只負責：驗 session、基本輸入形狀、把函式的錯誤碼轉成前端已經在處理的
 * 應用錯誤碼、寫一筆稽核紀錄。
 */

const { json, parseBody, handleError } = require('./_apps-script');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

/** 0008 函式使用的自訂 SQLSTATE。 */
function translateRpcError(error) {
  const code = error && error.code;
  if (code === 'CR400') return Object.assign(new Error(error.message), { code: 'VALIDATION_ERROR' });
  if (code === 'CR409') return Object.assign(new Error(error.message), { code: 'TRIP_CONFLICT' });
  return translateDbError(error);
}

function bearerToken(event) {
  const header = String(event.headers?.authorization || event.headers?.Authorization || '');
  return header.replace(/^Bearer\s+/i, '').trim();
}

function requireId(value, label) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (!id || id.length > 180) throw auth.authError('VALIDATION_ERROR', `${label}無效`);
  return id;
}

function optionalText(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

async function writeAudit(client, { eventType, actorUserId, organizationId = null, entityType, entityId, details = {} }) {
  await client.query(
    `insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
     values ($1,$2,$3,$4,$5,$6,'DEDICATED_ENDPOINT',$7)`,
    [`AUD-${Date.now()}-${auth.randomHex(4)}`, eventType, actorUserId, organizationId,
     entityType, entityId, JSON.stringify(details)]);
}

/**
 * POST、驗 session、在 withUser 交易內執行 fn。fn 丟出錯誤時整筆交易回滾。
 */
async function runAuthenticated(event, fn) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const token = bearerToken(event);
    if (!token) {
      return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入' } });
    }
    const claims = auth.parseSessionToken(token);
    const body = parseBody(event);
    const data = await withUser(claims.userId, async (client) => {
      await auth.verifySessionToken(client, token);
      return fn(client, body, claims);
    });
    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateRpcError(error));
  }
}

module.exports = { runAuthenticated, translateRpcError, requireId, optionalText, writeAudit };
