'use strict';

/**
 * 每日排程：把行程日期超過保存期限（app_settings.retention_years，預設 5 年）的預約與行程匿名化，
 * 連同預約修改紀錄，以及所有預約都已過期的服務對象（0016）。
 * 以 care_ride_app 身分、不帶登入者執行（app.anonymize_expired_records 只允許系統排程或平台管理者）。
 * 每一筆匿名化都在資料庫函式裡寫稽核紀錄。排程設定在 netlify.toml。
 */

const { withoutUser } = require('./_db');
const { anonymizedSummary } = require('./_consent');

exports.handler = async () => {
  try {
    const rows = await withoutUser(async (client) => (await client.query('select * from app.anonymize_expired_records()')).rows);
    const summary = anonymizedSummary(rows);
    console.log('[retention] anonymized', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify({ ok: true, anonymized: summary }) };
  } catch (error) {
    console.error('[retention] failed', error && error.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
