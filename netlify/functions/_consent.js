'use strict';

/** 條款文件與同意狀態（#26）。 */

async function legalDocuments(client) {
  const row = (await client.query(`select value from app_settings where key = 'legal_documents'`)).rows[0];
  return (row && row.value) || {};
}

/** { documents: { key: { title, version, url, accepted } }, missing: [key] } */
async function consentStatus(client) {
  const docs = await legalDocuments(client);
  const missing = (await client.query('select app.consent_missing() as m')).rows[0].m || [];
  const documents = {};
  for (const [key, d] of Object.entries(docs)) {
    documents[key] = { title: d.title || key, version: d.version || null, url: d.url || null,
      published: Boolean(d.version), accepted: Boolean(d.version) && !missing.includes(key) };
  }
  return { documents, missing };
}

async function retentionYears(client) {
  const row = (await client.query(`select value from app_settings where key = 'retention_years'`)).rows[0];
  const n = row ? Number(row.value) : 5;
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/** app.anonymize_expired_records() 回傳的列 → 各類各匿名化了幾筆 */
function anonymizedSummary(rows) {
  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  return { bookings: count('booking'), trips: count('trip'), bookingRevisions: count('booking_revision'),
    careRecipients: count('care_recipient') };
}

module.exports = { legalDocuments, consentStatus, retentionYears, anonymizedSummary };
