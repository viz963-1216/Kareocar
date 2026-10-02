'use strict';

/**
 * 長照交通接送補助的分區與計算（#24）。資料與前端原本的 BENEFIT_ZONE_* 相同，移到伺服器。
 *
 * 規則的 calculation.mode = 'transport_zone'：
 *   { cmsMin, monthlyAmountByZone: {1..4}, copayByZone: {1..4: {low_income, middle_low_income, general}} }
 * 月額度依居住地分區；自付比例依福利身分。預估政府負擔 = 月額度 ×（100 − 自付%）。
 */

const ZONE_1 = ['臺北市', '基隆市', '嘉義市', '新竹市'];
const ZONE_2 = ['新北市', '桃園市', '彰化縣', '雲林縣', '新竹縣', '苗栗縣', '嘉義縣', '宜蘭縣', '臺南市', '臺中市'];
const ZONE_3 = ['屏東縣', '高雄市', '南投縣'];
const ZONE_4 = ['臺東縣', '花蓮縣', '澎湖縣', '金門縣', '連江縣'];
const ZONE_4_REMOTE = [
  '新北市烏來區', '新北市石碇區', '新北市坪林區', '新北市平溪區', '新北市雙溪區', '新北市貢寮區',
  '桃園市復興區', '臺南市楠西區', '臺南市南化區', '臺南市左鎮區', '臺南市龍崎區',
  '新竹縣五峰鄉', '新竹縣尖石鄉', '新竹縣關西鎮', '新竹縣峨眉鄉',
  '苗栗縣泰安鄉', '苗栗縣南庄鄉', '苗栗縣獅潭鄉', '苗栗縣三灣鄉', '臺中市和平區',
  '南投縣仁愛鄉', '南投縣信義鄉', '南投縣魚池鄉', '南投縣中寮鄉', '南投縣國姓鄉', '南投縣鹿谷鄉',
  '嘉義縣阿里山鄉', '嘉義縣番路鄉', '嘉義縣大埔鄉',
  '高雄市那瑪夏區', '高雄市桃源區', '高雄市茂林區', '高雄市田寮區', '高雄市六龜區', '高雄市甲仙區', '高雄市杉林區',
  '屏東縣三地門鄉', '屏東縣霧臺鄉', '屏東縣瑪家鄉', '屏東縣泰武鄉', '屏東縣來義鄉', '屏東縣春日鄉', '屏東縣獅子鄉',
  '屏東縣牡丹鄉', '屏東縣滿州鄉', '屏東縣琉球鄉',
  '宜蘭縣大同鄉', '宜蘭縣南澳鄉'
];
const IDENTITY_CATEGORIES = ['low_income', 'middle_low_income', 'general'];

const norm = (s) => String(s || '').replace(/台/g, '臺').replace(/\s+/g, '');

/** 居住地（縣市＋行政區或完整地址）→ 交通補助分區 1–4，判斷不出來回傳 null。 */
function transportZone(place) {
  const p = norm(place);
  if (!p) return null;
  if (ZONE_4_REMOTE.some((x) => p.includes(x)) || ZONE_4.some((x) => p.includes(x))) return 4;
  if (ZONE_1.some((x) => p.includes(x))) return 1;
  if (ZONE_2.some((x) => p.includes(x))) return 2;
  if (ZONE_3.some((x) => p.includes(x))) return 3;
  return null;
}

/** 交通分區規則的計算；回傳 { ok, subsidy, copay, zone, rate } 或 { missing: [...] }。 */
function computeTransport(calc, facts) {
  const place = `${facts.residenceCity || ''}${facts.residenceDistrict || ''}`;
  const zone = transportZone(place);
  const category = facts.identityCategory && IDENTITY_CATEGORIES.includes(facts.identityCategory) ? facts.identityCategory : null;
  const missing = [];
  if (!zone) missing.push('residenceCity');
  if (!category) missing.push('identityCategory');
  if (missing.length) return { missing };
  const monthly = Number((calc.monthlyAmountByZone || {})[zone]) || 0;
  const rate = Number(((calc.copayByZone || {})[zone] || {})[category]);
  const copayRate = Number.isFinite(rate) ? rate : 0;
  return { ok: true, zone, rate: copayRate, monthly,
    subsidy: Math.floor(monthly * (100 - copayRate) / 100), copay: Math.floor(monthly * copayRate / 100) };
}

function validTransportCalculation(calc) {
  const errors = [];
  for (const z of [1, 2, 3, 4]) {
    const m = Number((calc.monthlyAmountByZone || {})[z]);
    if (!Number.isFinite(m) || m <= 0) errors.push(`第 ${z} 區月額度不正確`);
    for (const c of IDENTITY_CATEGORIES) {
      const r = Number(((calc.copayByZone || {})[z] || {})[c]);
      if (!Number.isFinite(r) || r < 0 || r > 100) errors.push(`第 ${z} 區 ${c} 自付比例不正確`);
    }
  }
  return errors;
}

module.exports = { transportZone, computeTransport, validTransportCalculation, IDENTITY_CATEGORIES };
