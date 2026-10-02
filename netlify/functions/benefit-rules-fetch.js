'use strict';

/**
 * 每日排程：抓長照交通補助公告，產生自動草稿（#24，見 _benefit-fetch.js）。
 * 以 care_ride_app、不帶登入者執行；抓取或解析失敗時送出告警，現行版本不變。
 * 排程設定在 netlify.toml。
 */

const { withoutUser } = require('./_db');
const { runFetch } = require('./_benefit-fetch');

exports.handler = async () => {
  try {
    const result = await withoutUser((client) => runFetch(client));
    console.log('[benefit-fetch]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (error) {
    console.error('[benefit-fetch] failed', error && error.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
