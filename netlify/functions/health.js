'use strict';

/**
 * GET /api/health  —— 這個後端還活著嗎
 *
 * 舊版是把請求轉給 Apps Script，回報的是「那一端」的健康狀態。身分與資料都搬到
 * Postgres 之後，那個數字只會讓人以為系統還跑在舊版上（它一直回報
 * rowAuthorizationVersion 12.25.79，其實跟正在服務的後端完全無關）。
 *
 * 現在直接量真正的依賴：連得上 Postgres 嗎、必要的環境變數設了嗎。
 *
 * 這支端點不需要登入，所以只回布林值與延遲，不回任何設定內容、主機名稱或版本
 * 字串——健康檢查是給維運看的，不是給人拿來探測環境設定的。
 */

const { json } = require('./_http');
const { withoutUser } = require('./_db');

const REQUIRED_ENV = ['DATABASE_URL', 'AUTH_SESSION_SECRET', 'AUTH_PASSWORD_PEPPER'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }

  const configured = REQUIRED_ENV.every((name) => String(process.env[name] || '').trim().length > 0);

  let database = false;
  let latencyMs = null;
  if (configured) {
    const startedAt = Date.now();
    try {
      await withoutUser((client) => client.query('select 1'));
      database = true;
      latencyMs = Date.now() - startedAt;
    } catch (error) {
      // 錯誤細節只進日誌：對外洩漏連線字串或主機名稱沒有好處
      console.error('[health] 資料庫連線失敗', error && error.code, error && error.message);
    }
  }

  const healthy = configured && database;
  return json(healthy ? 200 : 503, {
    ok: healthy,
    data: { backend: 'postgres', configured, database, latencyMs }
  });
};
