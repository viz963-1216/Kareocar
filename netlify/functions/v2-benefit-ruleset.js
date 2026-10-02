'use strict';

/**
 * POST /api/v2/benefit-ruleset  —— 補助規則版本的草稿與審核（只有平台超級管理者）
 *
 * body:
 *   { action: 'save_draft', id?, ruleset }   新增或修改草稿
 *   { action: 'approve', id, note? }         核准；同一 program code 原本的 approved 變 superseded
 *   { action: 'reject', id, note }           駁回（必須填原因）
 *
 * 狀態只有 draft、approved、superseded、rejected；同一個 program code 與服務類型任一時點
 * 只有一個 approved（資料庫部分唯一索引保證）。核准後新的試算與預約估算改用新版本，
 * 既有的試算與預約快照不會被改寫。
 */

const crypto = require('crypto');
const auth = require('./_auth-pg');
const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');
const benefit = require('./_benefit');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const action = String(body.action || '').trim();
  const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;
  if (!admin) throw auth.authError('FORBIDDEN', '只有平台超級管理者可以管理補助規則');

  if (action === 'save_draft') {
    const id = body.id ? requireId(body.id, '規則 ID ') : `brule_${crypto.randomBytes(8).toString('hex')}`;
    const ruleset = benefit.normalizeRulesetInput(body.ruleset || {});
    const errors = benefit.validateRuleset(ruleset);
    if (errors.length) throw auth.authError('VALIDATION_ERROR', errors.join('；'));
    const dup = (await client.query(
      'select id from benefit_rulesets where code = $1 and version = $2 and id <> $3', [ruleset.code, ruleset.version, id])).rows[0];
    if (dup) throw auth.authError('VALIDATION_ERROR', `${ruleset.code} 已經有版本 ${ruleset.version}`);
    await client.query('select app.save_benefit_ruleset_draft($1, $2::jsonb)', [id, JSON.stringify(ruleset)]);
    await writeAudit(client, { eventType: 'benefit.ruleset.draft_saved', actorUserId: claims.userId,
      entityType: 'benefit_ruleset', entityId: id, details: { code: ruleset.code, version: ruleset.version } });
    const row = (await client.query('select * from benefit_rulesets where id = $1', [id])).rows[0];
    return { ruleset: benefit.rulesetFromRow(row) };
  }

  if (action === 'approve' || action === 'reject') {
    const id = requireId(body.id, '規則 ID ');
    const note = optionalText(body.note, 500);
    const current = benefit.rulesetFromRow((await client.query('select * from benefit_rulesets where id = $1', [id])).rows[0]);
    if (!current) throw auth.authError('NOT_FOUND', '找不到補助規則');
    if (action === 'approve') {
      const errors = benefit.validateRuleset(current, { forApproval: true });
      if (errors.length) throw auth.authError('VALIDATION_ERROR', errors.join('；'));
    }
    const previous = (await client.query(
      `select id, version from benefit_rulesets where code = $1 and service_type = $2 and status = 'approved'`,
      [current.code, current.serviceType])).rows[0] || null;
    const status = (await client.query('select app.review_benefit_ruleset($1, $2, $3) as status',
      [id, action, note])).rows[0].status;
    await writeAudit(client, { eventType: `benefit.ruleset.${status}`, actorUserId: claims.userId,
      entityType: 'benefit_ruleset', entityId: id,
      details: { code: current.code, version: current.version, note, supersededId: status === 'approved' && previous ? previous.id : null } });
    const row = (await client.query('select * from benefit_rulesets where id = $1', [id])).rows[0];
    return { ruleset: benefit.rulesetFromRow(row), supersededId: status === 'approved' && previous ? previous.id : null };
  }

  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
