'use strict';

/**
 * POST /api/v2/benefit-assess  —— 補助試算（伺服器計算）
 *
 * body: { recipientId, programCode?, serviceDate?, facts: { cmsLevel, identityCategory,
 *         transportationApproved, approvedCarePlan?, eligibleCost? }, organizationId? }
 *
 * 依目前唯一一個 approved 規則版本計算，記錄使用的版本 ID。只有建立這位服務對象的人或平台
 * 超級管理者可以試算；承接機構只能讀（#100）。地區由伺服器從服務對象住址判斷，不採用前端
 * 送來的縣市。之後建立預約時，伺服器用最近一次試算的資料（不是金額）依預約日期重新估算；
 * 重新試算時，這位服務對象還沒完成的預約也一起更新（#102）。
 */

const crypto = require('crypto');
const auth = require('./_auth-pg');
const { runAuthenticated, requireId, optionalText, writeAudit } = require('./_business-rpc');
const benefit = require('./_benefit');

/** 服務對象住址：主要地址，沒有就用預設上車地址。 */
function recipientAddress(r) {
  const a = r.addresses || {};
  const entries = Array.isArray(a.entries) ? a.entries : [];
  const pick = (id) => { const e = id && entries.find((x) => x && x.id === id); return e ? e.address : ''; };
  return pick(a.primaryAddressId) || a.primary || (entries[0] && entries[0].address) || pick(a.defaultPickupAddressId)
    || a.commonPickup || (r.servicePreferences && r.servicePreferences.defaultPickupAddress) || '';
}

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const recipientId = requireId(body.recipientId, '服務對象 ID ');
  const row = (await client.query(
    `select data, owner_user_id from app_state where collection = 'careRecipients' and id = $1 and not deleted`, [recipientId])).rows[0];
  const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;
  if (!row || (!admin && row.owner_user_id !== claims.userId)) {
    throw auth.authError('FORBIDDEN', '只有建立這位服務對象的人可以試算補助');
  }
  const residence = benefit.residenceFromAddress(recipientAddress(row.data || {}));
  if (!residence.city) throw auth.authError('VALIDATION_ERROR', '請先在服務對象資料填寫住址（要有縣市），才能判斷補助地區');

  const programCode = optionalText(body.programCode, 80) || benefit.DEFAULT_PROGRAM_CODE;
  const serviceDate = benefit.dateOnly(body.serviceDate) || new Date().toISOString().slice(0, 10);
  const input = body.facts || {};
  const facts = benefit.normalizeFacts({ ...input,
    // 「是否已核定交通接送」一題：核定交通接送就代表照顧計畫已核定
    approvedCarePlan: input.approvedCarePlan !== undefined && input.approvedCarePlan !== '' ? input.approvedCarePlan : input.transportationApproved,
    residenceCity: residence.city, residenceDistrict: residence.district });
  const ruleset = await benefit.activeRuleset(client, { programCode, serviceDate });
  const result = benefit.evaluate(ruleset, { requestedService: 'transportation', serviceDate, facts });
  const assessment = benefit.withRuleset(result, ruleset, {
    id: `benefit_${crypto.randomBytes(8).toString('hex')}`, recipientId, programCode,
    requestedService: 'transportation', serviceDate, facts,
    organizationId: optionalText(body.organizationId, 80) || null, createdByUserId: claims.userId
  });
  await client.query('select app.record_benefit_assessment($1::jsonb)', [JSON.stringify(assessment)]);
  // 重新試算後，這位服務對象還沒完成的預約改用新的試算估算；已完成的保留原樣（#102，0021）
  const pending = (await client.query('select id, pickup_date from app.recipient_refreshable_bookings($1)', [recipientId])).rows;
  const refreshedBookingIds = [];
  for (const b of pending) {
    const estimate = await benefit.bookingBenefit(client, { recipientId, pickupDate: b.pickup_date });
    const done = (await client.query('select app.set_booking_benefit($1, $2::jsonb) as ok', [b.id, JSON.stringify(estimate)])).rows[0].ok;
    if (done) refreshedBookingIds.push(b.id);
  }
  await writeAudit(client, { eventType: 'benefit.assessment.created', actorUserId: claims.userId,
    entityType: 'benefit_assessment', entityId: assessment.id,
    details: { recipientId, status: assessment.status, rulesetId: assessment.rulesetId, refreshedBookingIds } });
  return { assessment, refreshedBookingIds };
});
