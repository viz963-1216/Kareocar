'use strict';

/**
 * 長照交通補助的伺服器計算（#23）。
 *
 * 計算規則與前端 benefitResultFromRuleset 相同（js/app.js），但只套用資料庫裡「目前唯一一個
 * approved」的規則版本，並回傳使用的版本 ID。前端送上的補助金額一律不採用。
 *
 *   evaluate(ruleset, { requestedService, serviceDate, facts })   純函式，離線測試用
 *   activeRuleset(client, { programCode, requestedService, serviceDate })
 *   normalizeFacts(facts)
 *   validateRulesetForApproval(ruleset)
 *   bookingBenefit(client, booking)   建立預約時的補助估算
 */

const transport = require('./_benefit-transport');

const DEFAULT_PROGRAM_CODE = 'transportation_primary';
// transport_zone：長照交通接送的分區月額度＋自付比例（#24，見 _benefit-transport.js）
const CALCULATION_MODES = ['fixed_amount', 'percentage', 'transport_zone', 'none'];

const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const dateOnly = (v) => {
  const s = text(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};
const numberOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boolOrNull = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const stringList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/)).map(text).filter(Boolean))];
const cmsLevels = (v) => [...new Set(stringList(v).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 8))].sort((a, b) => a - b);
const today = () => new Date().toISOString().slice(0, 10);

/** 前端送來的規則內容 → 資料表欄位（save_benefit_ruleset_draft 的參數）。 */
function normalizeRulesetInput(input = {}) {
  const calc = input.calculation || {};
  const cond = input.conditions || {};
  const src = input.source || {};
  return {
    code: text(input.code) || DEFAULT_PROGRAM_CODE,
    version: text(input.version),
    name: text(input.name),
    serviceType: text(input.serviceType) || 'transportation',
    jurisdictionCity: text(input.jurisdiction && input.jurisdiction.city) || text(input.jurisdictionCity) || null,
    effectiveFrom: dateOnly(input.effectiveFrom),
    effectiveTo: dateOnly(input.effectiveTo),
    conditions: {
      cmsLevels: cmsLevels(cond.cmsLevels),
      requireApprovedCarePlan: boolOrNull(cond.requireApprovedCarePlan),
      requireTransportationApproved: boolOrNull(cond.requireTransportationApproved),
      identityCategories: stringList(cond.identityCategories),
      residenceCities: stringList(cond.residenceCities)
    },
    calculation: {
      mode: CALCULATION_MODES.includes(calc.mode) ? calc.mode : 'none',
      currency: text(calc.currency).toUpperCase() || 'TWD',
      amount: numberOrNull(calc.amount),
      percentage: numberOrNull(calc.percentage),
      maxAmount: numberOrNull(calc.maxAmount),
      ...(calc.mode === 'transport_zone' ? {
        cmsMin: numberOrNull(calc.cmsMin),
        monthlyAmountByZone: calc.monthlyAmountByZone || {},
        copayByZone: calc.copayByZone || {}
      } : {})
    },
    source: {
      agency: text(src.agency), title: text(src.title), url: text(src.url),
      publishedAt: dateOnly(src.publishedAt), checkedAt: dateOnly(src.checkedAt)
    }
  };
}

/** 資料表的一列 → 計算與前端用的形狀。 */
function rulesetFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, code: row.code, version: row.version, name: row.name, serviceType: row.service_type,
    jurisdiction: { country: 'TW', city: row.jurisdiction_city || null },
    effectiveFrom: dateOnly(row.effective_from), effectiveTo: dateOnly(row.effective_to),
    status: row.status, conditions: row.conditions || {}, calculation: row.calculation || {}, source: row.source || {},
    reviewNote: row.review_note || '', createdByUserId: row.created_by_user_id || null,
    origin: row.origin || 'manual', sourceHash: row.source_hash || null, diff: row.diff || null, fetchRunId: row.fetch_run_id || null,
    approvedByUserId: row.approved_by_user_id || null, approvedAt: row.approved_at || null,
    supersededAt: row.superseded_at || null, rejectedByUserId: row.rejected_by_user_id || null,
    rejectedAt: row.rejected_at || null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

/** 草稿必填欄位；核准時另外要求來源與計算方式完整。回傳錯誤訊息陣列。 */
function validateRuleset(r, { forApproval = false } = {}) {
  const errors = [];
  if (!r.code) errors.push('缺少 program code');
  if (!r.version) errors.push('缺少版本');
  if (!r.name) errors.push('缺少規則名稱');
  if (!r.effectiveFrom) errors.push('缺少生效日');
  if (r.effectiveTo && r.effectiveFrom && r.effectiveTo < r.effectiveFrom) errors.push('失效日不能早於生效日');
  const calc = r.calculation || {};
  if (calc.mode === 'fixed_amount' && (calc.amount === null || calc.amount < 0)) errors.push('固定金額必須是 0 以上');
  if (calc.mode === 'percentage') {
    if (calc.percentage === null || calc.percentage < 0 || calc.percentage > 100) errors.push('補助比例必須介於 0–100');
    if (calc.maxAmount !== null && calc.maxAmount !== undefined && calc.maxAmount < 0) errors.push('補助上限不可為負數');
  }
  if (calc.mode === 'transport_zone') errors.push(...transport.validTransportCalculation(calc));
  if (forApproval) {
    const src = r.source || {};
    if (!src.agency) errors.push('核准前必須填寫規則來源機關');
    if (!src.title) errors.push('核准前必須填寫規則來源標題');
    if (!/^https?:\/\//i.test(src.url || '')) errors.push('核准前必須填寫 http/https 官方來源網址');
    if (!src.checkedAt) errors.push('核准前必須填寫來源查核日期');
  }
  return errors;
}

function normalizeFacts(facts = {}) {
  return {
    cmsLevel: numberOrNull(facts.cmsLevel),
    residenceCity: text(facts.residenceCity) || null,
    residenceDistrict: text(facts.residenceDistrict) || null,
    approvedCarePlan: boolOrNull(facts.approvedCarePlan),
    transportationApproved: boolOrNull(facts.transportationApproved),
    identityCategory: text(facts.identityCategory) || null,
    eligibleCost: numberOrNull(facts.eligibleCost)
  };
}

const NOT_OFFICIAL = '此結果是系統試算，不等同主管機關正式核定。';

const CITY_PATTERN = /(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|苗栗縣|宜蘭縣|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/;
/** 臺／台視為同一個字，比對縣市時用。 */
const canonicalCity = (value) => (text(value) || '').replace(/臺/g, '台');

/** 從住址判斷縣市與鄉鎮市區（#100：補助試算的地區由服務對象住址決定）。 */
function residenceFromAddress(address) {
  const canonical = canonicalCity(address).replace(/\s+/g, '');
  const m = canonical.match(CITY_PATTERN);
  if (!m) return { city: null, district: null };
  const rest = canonical.slice(m.index + m[1].length);
  const d = rest.match(/^(.{1,4}?[區鄉鎮市])/);
  return { city: m[1], district: d ? d[1] : null };
}

/** 與前端 benefitResultFromRuleset 相同的判斷。 */
function evaluate(ruleset, { requestedService = 'transportation', serviceDate = null, facts = {} } = {}) {
  const reasons = [];
  const missing = [];
  const failed = [];
  const date = dateOnly(serviceDate) || today();
  const f = normalizeFacts(facts);
  if (!ruleset) {
    return { status: 'ruleset_required', eligibility: { eligible: null, confidence: 'unavailable' }, estimatedSubsidy: null,
      estimatedCopay: null, currency: 'TWD', reasons, warnings: ['尚未有已核准的補助規則。'], missingFields: [] };
  }
  const currency = (ruleset.calculation && ruleset.calculation.currency) || 'TWD';
  if (ruleset.serviceType !== requestedService) failed.push(`服務類型 ${requestedService} 不在此規則適用範圍`);
  const inRange = (!ruleset.effectiveFrom || ruleset.effectiveFrom <= date) && (!ruleset.effectiveTo || ruleset.effectiveTo >= date);
  if (!inRange) failed.push(`服務日期 ${date} 不在規則有效期間`); else reasons.push(`服務日期 ${date} 位於規則有效期間`);
  const city = f.residenceCity || '';
  const jurisdictionCity = ruleset.jurisdiction && ruleset.jurisdiction.city;
  if (jurisdictionCity) {
    if (!city) missing.push('residenceCity');
    else if (canonicalCity(city) !== canonicalCity(jurisdictionCity)) {
      // 住的縣市沒有核准的規則：不是「不符合」，是「尚無規則」（#100）
      return { status: 'ruleset_required', eligibility: { eligible: null, confidence: 'unavailable' }, estimatedSubsidy: null,
        estimatedCopay: null, currency, reasons, warnings: [`${city}尚無規則，暫時無法試算。`], missingFields: [] };
    } else reasons.push(`居住地符合 ${jurisdictionCity}`);
  }
  const c = ruleset.conditions || {};
  if ((c.cmsLevels || []).length) {
    if (f.cmsLevel === null) missing.push('cmsLevel');
    else if (!c.cmsLevels.includes(Number(f.cmsLevel))) failed.push(`CMS ${f.cmsLevel} 不在適用等級`);
    else reasons.push(`CMS ${f.cmsLevel} 符合適用等級`);
  }
  for (const [field, required, label] of [
    ['approvedCarePlan', c.requireApprovedCarePlan, '照顧計畫核定'],
    ['transportationApproved', c.requireTransportationApproved, '交通服務核定']]) {
    if (required === null || required === undefined) continue;
    const actual = f[field];
    if (actual === null) missing.push(field);
    else if (actual !== required) failed.push(`${label}條件不符合`);
    else reasons.push(`${label}條件符合`);
  }
  if ((c.identityCategories || []).length) {
    if (!f.identityCategory) missing.push('identityCategory');
    else if (!c.identityCategories.includes(f.identityCategory)) failed.push(`身分類別 ${f.identityCategory} 不在適用範圍`);
    else reasons.push(`身分類別 ${f.identityCategory} 符合`);
  }
  if ((c.residenceCities || []).length) {
    if (!city) missing.push('residenceCity');
    else if (!c.residenceCities.map(canonicalCity).includes(canonicalCity(city))) failed.push(`居住地 ${city} 不在條件清單`);
    else reasons.push(`居住地 ${city} 符合條件`);
  }
  const uniqMissing = [...new Set(missing)];
  if (failed.length) {
    return { status: 'not_eligible', eligibility: { eligible: false, confidence: 'estimated' }, estimatedSubsidy: 0,
      estimatedCopay: f.eligibleCost, currency, reasons: [...reasons, ...failed], warnings: [NOT_OFFICIAL], missingFields: uniqMissing };
  }
  if (uniqMissing.length) {
    return { status: 'insufficient_data', eligibility: { eligible: null, confidence: 'estimated' }, estimatedSubsidy: null,
      estimatedCopay: null, currency, reasons, warnings: [`缺少必要資料：${uniqMissing.join('、')}`, NOT_OFFICIAL], missingFields: uniqMissing };
  }
  const calc = ruleset.calculation || { mode: 'none' };
  const round2 = (n) => Math.round(n * 100) / 100;
  let subsidy = null;
  let copay = null;
  let zoneFields = {};
  const warnings = [];
  if (calc.mode === 'fixed_amount') {
    subsidy = Math.max(0, Number(calc.amount) || 0);
    copay = f.eligibleCost === null ? null : Math.max(0, round2(f.eligibleCost - subsidy));
    reasons.push('依規則固定金額計算');
  } else if (calc.mode === 'percentage') {
    if (f.eligibleCost === null) {
      return { status: 'insufficient_data', eligibility: { eligible: null, confidence: 'estimated' }, estimatedSubsidy: null,
        estimatedCopay: null, currency, reasons, warnings: ['依比例計算的規則需要可補助費用（eligibleCost）。'], missingFields: ['eligibleCost'] };
    }
    const raw = f.eligibleCost * (Number(calc.percentage) || 0) / 100;
    const capped = calc.maxAmount === null || calc.maxAmount === undefined ? raw : Math.min(raw, Number(calc.maxAmount) || 0);
    subsidy = Math.max(0, round2(capped));
    copay = Math.max(0, round2(f.eligibleCost - subsidy));
    reasons.push(`依可補助費用 × ${calc.percentage}% 計算${calc.maxAmount !== null && calc.maxAmount !== undefined ? `，上限 ${calc.maxAmount}` : ''}`);
  } else if (calc.mode === 'transport_zone') {
    const t = transport.computeTransport(calc, f);
    if (t.missing) {
      return { status: 'insufficient_data', eligibility: { eligible: null, confidence: 'estimated' }, estimatedSubsidy: null,
        estimatedCopay: null, currency, reasons, warnings: [`缺少必要資料：${t.missing.join('、')}（交通分區需要居住縣市，自付比例需要福利身分）`, NOT_OFFICIAL],
        missingFields: t.missing };
    }
    subsidy = t.subsidy;
    copay = t.copay;
    zoneFields = { zone: t.zone, monthlyLimit: t.monthly, copayRate: t.rate };
    reasons.push(`交通接送第 ${t.zone} 區月額度 ${t.monthly} 元，自付 ${t.rate}%`);
  } else {
    warnings.push('此規則只判斷資格，未設定金額公式。');
  }
  warnings.push(NOT_OFFICIAL);
  return { status: 'eligible_estimate', eligibility: { eligible: true, confidence: 'estimated' }, estimatedSubsidy: subsidy,
    estimatedCopay: copay, ...zoneFields, currency, reasons, warnings, missingFields: [] };
}

/** 目前唯一一個 approved 版本（且服務日期在有效期間內），沒有就回傳 null。 */
async function activeRuleset(client, { programCode = DEFAULT_PROGRAM_CODE, requestedService = 'transportation', serviceDate = null } = {}) {
  const { rows } = await client.query(
    `select * from benefit_rulesets
      where status = 'approved' and code = $1 and service_type = $2
        and (effective_from is null or effective_from <= $3::date)
        and (effective_to is null or effective_to >= $3::date)
      limit 1`, [programCode, requestedService, dateOnly(serviceDate) || today()]);
  return rulesetFromRow(rows[0]);
}

/** 試算結果加上規則版本資訊，存進預約或試算紀錄。 */
function withRuleset(result, ruleset, extra = {}) {
  return {
    schemaVersion: 1, ...result,
    rulesetId: ruleset ? ruleset.id : null, rulesetVersion: ruleset ? ruleset.version : null,
    rulesetEffectiveFrom: ruleset ? ruleset.effectiveFrom : null, rulesetEffectiveTo: ruleset ? ruleset.effectiveTo : null,
    rulesetSource: ruleset ? ruleset.source : null,
    explanation: [...(result.reasons || []), ...(result.warnings || [])].join('；'),
    computedAt: new Date().toISOString(), source: 'server', ...extra
  };
}

/**
 * 預約的補助估算：用服務對象最近一次伺服器試算的資料（CMS 等級、居住地等），
 * 依預約日期當下的 approved 規則重新計算。沒有試算資料時標示需要先試算。
 */
async function bookingBenefit(client, booking) {
  const recipientId = text(booking.recipientId);
  const serviceDate = dateOnly(booking.pickupDate);
  const latest = recipientId ? (await client.query(
    `select id, facts, program_code from benefit_assessments
      where care_recipient_id = $1 and source = 'server' and coalesce(requested_service, 'transportation') = 'transportation'
      order by created_at desc limit 1`, [recipientId])).rows[0] : null;
  const programCode = (latest && latest.program_code) || DEFAULT_PROGRAM_CODE;
  const ruleset = await activeRuleset(client, { programCode, serviceDate });
  if (!latest) {
    return withRuleset({ status: 'assessment_required', eligibility: { eligible: null, confidence: 'unavailable' },
      estimatedSubsidy: null, estimatedCopay: null, currency: 'TWD', reasons: [],
      warnings: ['尚未建立補助試算，請先在「補助試算」填寫長照等級等資料。'], missingFields: [] },
    ruleset, { programCode, requestedService: 'transportation', serviceDate, sourceAssessmentId: null, facts: null });
  }
  const facts = normalizeFacts(latest.facts || {});
  const result = evaluate(ruleset, { requestedService: 'transportation', serviceDate, facts });
  return withRuleset(result, ruleset, { programCode, requestedService: 'transportation', serviceDate,
    sourceAssessmentId: latest.id, facts, cmsLevel: facts.cmsLevel });
}

/**
 * 預約時保留額度、接送完成時結算（0009 的帳本）。暫停中（#98）：平台沒有車資，現在的估算是
 * 整個月的額度，在每筆預約保留整月額度會讓第二筆就顯示「額度用完」。有車資、能算單趟金額後再打開。
 * 釋放不受影響（舊資料若有保留，取消、婉拒、過期時照常釋放）。
 */
const LEDGER_RESERVATION_ENABLED = false;

module.exports = {
  DEFAULT_PROGRAM_CODE, LEDGER_RESERVATION_ENABLED, normalizeRulesetInput, rulesetFromRow, validateRuleset, normalizeFacts,
  evaluate, activeRuleset, withRuleset, bookingBenefit, dateOnly, residenceFromAddress
};
