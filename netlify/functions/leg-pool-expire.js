'use strict';

/**
 * 排程（每 15 分鐘）：需求池裡過了接案期限還沒有機構接的單一段，標示「沒有機構承接」（#116，ADR 0004）。
 * 以 care_ride_app 身分、不帶登入者執行（app.expire_pool_legs 只允許系統排程或平台管理者）。
 * 事件與通知（需求者、承接機構）在資料庫函式裡寫。排程設定在 netlify.toml。
 */

const { withoutUser } = require('./_db');

exports.handler = async () => {
  try {
    const rows = await withoutUser(async (client) => (await client.query('select * from app.expire_pool_legs()')).rows);
    console.log('[leg-pool-expire] unclaimed', rows.length);
    return { statusCode: 200, body: JSON.stringify({ ok: true, unclaimed: rows.length }) };
  } catch (error) {
    console.error('[leg-pool-expire] failed', error && error.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
