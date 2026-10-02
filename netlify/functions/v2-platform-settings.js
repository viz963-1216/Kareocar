'use strict';

/**
 * POST /api/v2/platform-settings  —— 平台設定（只有平台超級管理者）
 *
 * body:
 *   { action: 'get' }
 *   { action: 'set_retention', years }                 保存期限（1–30 年，預設 5）
 *   { action: 'set_documents', documents }             條款版本：{ privacy_notice: { title, version, url }, terms: {...} }
 *   { action: 'run_retention' }                         立即執行一次到期資料匿名化（平常由每日排程執行）
 *   { action: 'test_alert' }                            送出測試告警（Email、Discord）
 *   { action: 'test_error' }                            刻意產生一次伺服器錯誤（Sentry）
 *
 * 條款改版（version 變了）後，使用者要重新同意才能建立預約。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, writeAudit } = require('./_business-rpc');
const { legalDocuments, retentionYears } = require('./_consent');
const { sendAlert } = require('./_alerts');

const text = (v, max = 300) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;
  if (!admin) throw auth.authError('FORBIDDEN', '只有平台超級管理者可以修改平台設定');
  const action = String(body.action || 'get').trim();
  const current = async () => ({ retentionYears: await retentionYears(client), legalDocuments: await legalDocuments(client) });

  if (action === 'get') return current();
  if (action === 'set_retention') {
    const years = Number(body.years);
    await client.query(`select app.set_platform_setting('retention_years', $1::jsonb)`, [JSON.stringify(years)]);
    await writeAudit(client, { eventType: 'settings.retention_changed', actorUserId: claims.userId,
      entityType: 'app_settings', entityId: 'retention_years', details: { years } });
    return current();
  }
  if (action === 'set_documents') {
    const before = await legalDocuments(client);
    const next = {};
    for (const key of ['privacy_notice', 'terms']) {
      const d = (body.documents && body.documents[key]) || {};
      const url = text(d.url, 500);
      if (url && !/^https:\/\//i.test(url)) throw auth.authError('VALIDATION_ERROR', '文件網址必須是 https');
      next[key] = { title: text(d.title, 80) || (before[key] && before[key].title) || key,
        version: text(d.version, 60) || null, url: url || null };
    }
    await client.query(`select app.set_platform_setting('legal_documents', $1::jsonb)`, [JSON.stringify(next)]);
    await writeAudit(client, { eventType: 'settings.legal_documents_changed', actorUserId: claims.userId,
      entityType: 'app_settings', entityId: 'legal_documents', details: { before, after: next } });
    return current();
  }
  if (action === 'run_retention') {
    const rows = (await client.query('select * from app.anonymize_expired_records()')).rows;
    return { anonymized: { bookings: rows.filter((r) => r.kind === 'booking').length, trips: rows.filter((r) => r.kind === 'trip').length } };
  }
  // 驗收監控用（#17）：送出一則測試告警到 Email 與 Discord；或刻意產生一次伺服器錯誤送到 Sentry
  if (action === 'test_alert') {
    const result = await sendAlert(client, { kind: 'test', title: '測試告警（平台管理者手動觸發）',
      details: { triggeredBy: claims.userId } });
    return { delivered: result.delivered };
  }
  if (action === 'test_error') {
    throw new Error('測試錯誤（平台管理者手動觸發，用來確認 Sentry 收得到）');
  }

  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
