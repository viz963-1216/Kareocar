'use strict';

/**
 * POST /api/v2/benefit-assess  —— 補助試算（伺服器計算）
 *
 * body: { recipientId, programCode?, serviceDate?, facts: { cmsLevel, residenceCity, approvedCarePlan,
 *         transportationApproved, identityCategory, eligibleCost }, organizationId? }
 *
 * 依目前唯一一個 approved 規則版本計算，記錄使用的版本 ID。呼叫者必須讀得到這位服務對象
 * （本人建立的、或正在服務他的機構），由 app_state 的 RLS 判斷。之後建立預約時，伺服器用
 * 最近一次試算的資料（不是金額）依預約日期重新估算。
 */

const crypto = require('crypto');
const auth = require('./_auth-pg');
const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');
const benefit = require('./_benefit');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const recipientId = requireId(body.recipientId, '服務對象 ID ');
  const visible = (await client.query(
    `select 1 from app_state where collection = 'careRecipients' and id = $1 and not deleted`, [recipientId])).rows[0];
  if (!visible) throw auth.authError('FORBIDDEN', '沒有權限替這位服務對象試算補助');

  const programCode = optionalText(body.programCode, 80) || benefit.DEFAULT_PROGRAM_CODE;
  const serviceDate = benefit.dateOnly(body.serviceDate) || new Date().toISOString().slice(0, 10);
  const facts = benefit.normalizeFacts(body.facts || {});
  const ruleset = await benefit.activeRuleset(client, { programCode, serviceDate });
  const result = benefit.evaluate(ruleset, { requestedService: 'transportation', serviceDate, facts });
  const assessment = benefit.withRuleset(result, ruleset, {
    id: `benefit_${crypto.randomBytes(8).toString('hex')}`, recipientId, programCode,
    requestedService: 'transportation', serviceDate, facts,
    organizationId: optionalText(body.organizationId, 80) || null, createdByUserId: claims.userId
  });
  await client.query('select app.record_benefit_assessment($1::jsonb)', [JSON.stringify(assessment)]);
  await writeAudit(client, { eventType: 'benefit.assessment.created', actorUserId: claims.userId,
    entityType: 'benefit_assessment', entityId: assessment.id,
    details: { recipientId, status: assessment.status, rulesetId: assessment.rulesetId } });
  return { assessment };
});
