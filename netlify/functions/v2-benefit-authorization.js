'use strict';

/**
 * POST /api/v2/benefit-authorization  —— 正式核定額度（#23 第二部分）
 *
 * body:
 *   { action: 'save', organizationId?, authorization: { recipientId, programCode, validFrom, validTo,
 *     approvedAmount, approvedUnits, referenceNo, source } }
 *   { action: 'revoke', id, reason, organizationId? }
 *   { action: 'adjust', id, amount, reason, organizationId? }
 *
 * 平台超級管理者，或正在服務這位服務對象的機構負責人／調度員（organizationId 是該機構）可以操作；
 * 權限與檢查在 migration 0009 的受控函式裡。預約的保留、釋放、結算由各流程自動處理，不經這裡。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const action = String(body.action || '').trim();
  const organizationId = optionalText(body.organizationId, 80) || null;

  if (action === 'save') {
    const a = body.authorization || {};
    const recipientId = requireId(a.recipientId, '服務對象 ID ');
    const payload = {
      recipientId, organizationId, programCode: optionalText(a.programCode, 80),
      validFrom: optionalText(a.validFrom, 10), validTo: optionalText(a.validTo, 10),
      approvedAmount: a.approvedAmount === undefined || a.approvedAmount === null ? '' : String(a.approvedAmount),
      approvedUnits: a.approvedUnits === undefined || a.approvedUnits === null ? '' : String(a.approvedUnits),
      referenceNo: optionalText(a.referenceNo, 120), source: optionalText(a.source, 40)
    };
    const id = (await client.query('select app.save_benefit_authorization($1::jsonb) as id', [JSON.stringify(payload)])).rows[0].id;
    await writeAudit(client, { eventType: 'benefit.authorization.created', actorUserId: claims.userId, organizationId,
      entityType: 'benefit_authorization', entityId: id, details: { recipientId, approvedAmount: payload.approvedAmount } });
    return { authorizationId: id, balance: (await client.query('select * from app.benefit_balance($1)', [id])).rows[0] };
  }

  if (action === 'revoke') {
    const id = requireId(body.id, '核定 ID ');
    await client.query('select app.revoke_benefit_authorization($1, $2, $3)', [id, optionalText(body.reason, 500), organizationId]);
    await writeAudit(client, { eventType: 'benefit.authorization.revoked', actorUserId: claims.userId, organizationId,
      entityType: 'benefit_authorization', entityId: id, details: { reason: optionalText(body.reason, 500) } });
    return { authorizationId: id };
  }

  if (action === 'adjust') {
    const id = requireId(body.id, '核定 ID ');
    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) throw auth.authError('VALIDATION_ERROR', '調整額度必須是數字');
    const entryId = (await client.query('select app.adjust_benefit_authorization($1, $2, $3, $4) as id',
      [id, amount, optionalText(body.reason, 500), organizationId])).rows[0].id;
    await writeAudit(client, { eventType: 'benefit.ledger.adjusted', actorUserId: claims.userId, organizationId,
      entityType: 'benefit_authorization', entityId: id, details: { amount, entryId } });
    return { authorizationId: id, entryId, balance: (await client.query('select * from app.benefit_balance($1)', [id])).rows[0] };
  }

  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
