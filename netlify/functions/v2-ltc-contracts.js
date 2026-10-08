'use strict';

/**
 * POST /api/v2/ltc-contracts  —— 長照特約（#99，只有平台超級管理者）
 *
 * body:
 *   { action: 'save', contract: { id?, organizationId, city, contractNo, validFrom, validTo } }  新增或修改
 *   { action: 'remove', id }                                                               移除
 *
 * 權限、格式與稽核紀錄都在資料庫函式（0020）；讀取走 state-load 的 ltcContracts。
 */

const { runAuthenticated, requireId, optionalText } = require('./_business-rpc');
const auth = require('./_auth-pg');

const dateOrNull = (v) => {
  const s = optionalText(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw auth.authError('VALIDATION_ERROR', '日期格式不正確');
  return s;
};

exports.handler = (event) => runAuthenticated(event, async (client, body) => {
  const action = optionalText(body.action, 20);
  if (action === 'save') {
    const c = body.contract || {};
    const { rows } = await client.query('select app.save_ltc_contract($1, $2, $3, $4, $5::date, $6::date) as id', [
      optionalText(c.id, 80) || null, requireId(c.organizationId, '機構 ID '), optionalText(c.city, 10),
      optionalText(c.contractNo, 100), dateOrNull(c.validFrom), dateOrNull(c.validTo)]);
    return { id: rows[0].id };
  }
  if (action === 'remove') {
    await client.query('select app.remove_ltc_contract($1)', [requireId(body.id, '長照特約 ID ')]);
    return { id: body.id };
  }
  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
