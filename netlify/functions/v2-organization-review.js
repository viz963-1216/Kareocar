'use strict';

/**
 * POST /api/v2/organization-review  —— 平台管理員審核機構
 *
 * body: { organizationId, decision: 'approve' | 'reject' | 'suspend', note }
 *
 * 呼叫 app.review_organization：只有平台超級管理者能呼叫（其他人 403）；
 * 允許的狀態轉換與「駁回／停權必須填原因」都由函式判斷，稽核紀錄在同一交易寫入。
 */

const { runAuthenticated, requireId, optionalText } = require('./_business-rpc');
const auth = require('./_auth-pg');

const DECISIONS = ['approve', 'reject', 'suspend'];

exports.handler = (event) => runAuthenticated(event, async (client, body) => {
  const organizationId = requireId(body.organizationId, '機構 ID ');
  const decision = optionalText(body.decision, 20);
  if (!DECISIONS.includes(decision)) throw auth.authError('VALIDATION_ERROR', '不支援的審核決定');
  const note = optionalText(body.note, 500);

  const { rows } = await client.query('select * from app.review_organization($1, $2, $3)',
    [organizationId, decision, note]);
  return { organizationId: rows[0].organization_id, reviewStatus: rows[0].review_status };
});
