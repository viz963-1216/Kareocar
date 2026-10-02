'use strict';

/**
 * 長照交通補助公告的排程抓取（#24）。
 *
 * 窄介面：fetchSource(url) → { ok, status, body(Buffer), contentType, error }。正式用 fetch，
 * 測試用 setProvider() 注入假實作。
 *
 * 來源：
 *   1966：長照專區「長照服務給付額度表」HTML，解析長照需要等級門檻與交通接送四區月額度（必須解析成功）
 *   mohw_rules：給付辦法附表 PDF（自付比例）。伺服器不解析 PDF，只用內容雜湊偵測改版；改版時草稿
 *     標示「自付比例需人工核對」，自付比例沿用目前 approved 版本。
 *
 * runFetch(client, { now }) 在同一個連線上：記錄每次抓取 → 失敗就告警並結束（現行版本不變）→
 * 解析 → 內容雜湊與既有草稿／版本相同就不產生 → 否則建立自動草稿並附差異。
 */

const crypto = require('crypto');
const { validTransportCalculation } = require('./_benefit-transport');
const { sendAlert } = require('./_alerts');

const SOURCES = Object.freeze([
  { id: '1966', title: '衛福部 1966 長照專區｜長照服務給付額度表', url: 'https://1966.gov.tw/LTC/cp-6533-70777-207.html', kind: 'html' },
  { id: 'mohw_rules', title: '衛福部｜長期照顧服務申請及給付辦法附表', url: 'https://www.mohw.gov.tw/dl-97629-9ca5aed2-743b-46ed-8659-4e45d9996257.html', kind: 'pdf' }
]);
const PROGRAM_CODE = 'transportation_primary';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;

// 自付比例的內建快照（2026-08-27 由附表五整理，與前端原本的 BENEFIT_CURRENT_TRANSPORT_POLICY 相同）
const BUNDLED_COPAY = Object.freeze({
  1: { low_income: 0, middle_low_income: 10, general: 30 },
  2: { low_income: 0, middle_low_income: 9, general: 27 },
  3: { low_income: 0, middle_low_income: 8, general: 25 },
  4: { low_income: 0, middle_low_income: 7, general: 21 }
});

const defaultProvider = {
  async fetchSource(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow',
        headers: { 'user-agent': 'care-ride-benefit-fetch/1.0 (+https://kareocar.netlify.app)' } });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) return { ok: false, status: res.status, error: '內容超過 5MB' };
      return { ok: res.ok, status: res.status, body, contentType: res.headers.get('content-type') || '',
        error: res.ok ? null : `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, status: null, error: error.name === 'AbortError' ? '逾時' : String(error.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }
};
let provider = defaultProvider;
function setProvider(next) { provider = next || defaultProvider; }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

/** 1966 頁面 → { cmsMin, monthlyAmountByZone } 或 { problems: [...] } */
function parse1966(html) {
  const text = htmlToText(html).replace(/(\d),(\d{3})/g, '$1$2');
  const problems = [];
  const m = text.match(/第一區[：:]\s*(\d{3,5})\s*元\s*第二區[：:]\s*(\d{3,5})\s*元\s*第三區[：:]\s*(\d{3,5})\s*元\s*第四區[：:]\s*(\d{3,5})\s*元/);
  if (!m) problems.push('找不到交通接送四區月額度（第一區～第四區 ○○元），頁面格式可能改變');
  if (m && !/交通接送/.test(text)) problems.push('頁面沒有「交通接送」字樣，可能不是同一份給付額度表');
  const cms = text.match(/長照需要等級\s*([2-8])\s*級以上/);
  if (!cms) problems.push('找不到長照需要等級門檻（○級以上）');
  if (problems.length) return { problems };
  return { cmsMin: Number(cms[1]), monthlyAmountByZone: { 1: Number(m[1]), 2: Number(m[2]), 3: Number(m[3]), 4: Number(m[4]) } };
}

function diffPolicies(before, after) {
  const changes = [];
  const add = (field, from, to) => { if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) changes.push({ field, from: from ?? null, to: to ?? null }); };
  const b = before || {};
  add('長照需要等級門檻', b.cmsMin, after.cmsMin);
  for (const z of [1, 2, 3, 4]) add(`第 ${z} 區月額度`, (b.monthlyAmountByZone || {})[z], after.monthlyAmountByZone[z]);
  for (const z of [1, 2, 3, 4]) {
    for (const c of ['low_income', 'middle_low_income', 'general']) {
      add(`第 ${z} 區自付比例（${c}）`, ((b.copayByZone || {})[z] || {})[c], ((after.copayByZone || {})[z] || {})[c]);
    }
  }
  return changes;
}

async function currentApproved(client) {
  const { rows } = await client.query(
    `select id, version, calculation, source from benefit_rulesets
      where code = $1 and service_type = 'transportation' and status = 'approved' limit 1`, [PROGRAM_CODE]);
  return rows[0] || null;
}

async function lastPdfHash(client) {
  const { rows } = await client.query(
    `select content_hash from benefit_source_fetches where source_id = 'mohw_rules' and status = 'ok'
      order by fetched_at desc offset 1 limit 1`);
  return rows[0] ? rows[0].content_hash : null;
}

async function runFetch(client, { now = new Date() } = {}) {
  const runId = `bfrun_${crypto.randomBytes(6).toString('hex')}`;
  const today = now.toISOString().slice(0, 10);
  const fetched = {};
  for (const s of SOURCES) {
    const r = await provider.fetchSource(s.url);
    const ok = Boolean(r && r.ok && r.body && r.body.length);
    const hash = ok ? sha256(r.body) : null;
    await client.query('select app.record_benefit_fetch($1::jsonb)', [JSON.stringify({ sourceId: s.id, url: s.url,
      status: ok ? 'ok' : 'failed', httpStatus: r && r.status, contentHash: hash, bytes: ok ? r.body.length : null,
      error: ok ? null : (r && r.error) || '沒有內容', runId })]);
    fetched[s.id] = { ok, hash, body: ok ? r.body : null, error: r && r.error };
  }

  const failed = SOURCES.filter((s) => !fetched[s.id].ok);
  if (failed.length) {
    await sendAlert(client, { kind: 'benefit_fetch_failed', title: '福利規則抓取失敗，現行版本不變',
      details: { runId, sources: failed.map((s) => ({ id: s.id, url: s.url, error: fetched[s.id].error })) } });
    return { runId, status: 'fetch_failed', failed: failed.map((s) => s.id) };
  }

  const parsed = parse1966(fetched['1966'].body.toString('utf8'));
  if (parsed.problems) {
    await sendAlert(client, { kind: 'benefit_parse_failed', title: '福利規則解析失敗，現行版本不變',
      details: { runId, problems: parsed.problems } });
    return { runId, status: 'parse_failed', problems: parsed.problems };
  }

  const approved = await currentApproved(client);
  const approvedCalc = approved && approved.calculation && approved.calculation.mode === 'transport_zone' ? approved.calculation : null;
  const pdfHash = fetched.mohw_rules.hash;
  const previousPdfHash = await lastPdfHash(client);
  const pdfChanged = Boolean(previousPdfHash) && previousPdfHash !== pdfHash;
  const policy = {
    mode: 'transport_zone', currency: 'TWD',
    cmsMin: parsed.cmsMin, monthlyAmountByZone: parsed.monthlyAmountByZone,
    copayByZone: (approvedCalc && approvedCalc.copayByZone) || BUNDLED_COPAY,
    copaySource: approvedCalc ? `沿用已核准版本 ${approved.version}` : '內建快照（2026-08-27 附表五）',
    attachmentHash: pdfHash
  };
  const calcErrors = validTransportCalculation(policy);
  if (calcErrors.length) {
    await sendAlert(client, { kind: 'benefit_parse_failed', title: '福利規則解析結果不合理，現行版本不變',
      details: { runId, problems: calcErrors } });
    return { runId, status: 'parse_failed', problems: calcErrors };
  }

  // 內容雜湊：解析出的規則內容＋附表 PDF 雜湊。頁面上無關的文字（日期、計數器）改變不會產生新草稿。
  const sourceHash = sha256(JSON.stringify({ cmsMin: policy.cmsMin, monthly: policy.monthlyAmountByZone,
    copay: policy.copayByZone, attachment: pdfHash }));
  const reviewNotes = [];
  if (!approvedCalc) reviewNotes.push('目前沒有已核准的交通分區規則；自付比例取自內建快照，請對照附表五核對。');
  if (pdfChanged) reviewNotes.push('給付辦法附表 PDF 已改版（內容雜湊不同），自付比例沿用舊版，請人工核對附表五後再核准。');
  const diff = { changes: diffPolicies(approvedCalc, policy), reviewNotes, comparedWith: approved ? approved.version : null };
  const draftId = (await client.query('select app.create_auto_benefit_draft($1::jsonb) as id', [JSON.stringify({
    code: PROGRAM_CODE, version: `auto-${today.replace(/-/g, '')}-${sourceHash.slice(0, 8)}`,
    name: '長照交通接送補助（自動抓取）', effectiveFrom: today,
    conditions: { cmsLevels: [2, 3, 4, 5, 6, 7, 8].filter((n) => n >= policy.cmsMin) },
    calculation: policy,
    source: { agency: '衛生福利部', title: SOURCES[0].title, url: SOURCES[0].url, checkedAt: today,
      attachmentUrl: SOURCES[1].url },
    sourceHash, diff, runId
  })])).rows[0].id;
  return { runId, status: draftId ? 'draft_created' : 'unchanged', draftId, changes: diff.changes.length, reviewNotes };
}

module.exports = { SOURCES, runFetch, parse1966, diffPolicies, htmlToText, setProvider, BUNDLED_COPAY };
