'use strict';

/**
 * 資料庫函式（raise exception）的錯誤訊息改成用語表（CONTEXT.md）的叫法再回給畫面（#83）。
 *
 * 舊的 migration 裡有些訊息還是「服務單位」「組織」「承接案件」；改訊息要重新定義整支函式，
 * 所以在伺服器把資料庫錯誤轉成回應的地方統一換掉。新寫的訊息請直接用用語表的叫法。
 */
const PHRASES = [
  ['其他服務單位接走', '其他接送機構接案'], ['有效服務組織', '有效接送機構'], ['服務組織', '接送機構'],
  ['服務單位', '接送機構'], ['交通／車隊公司', '交通接送機構'], ['承接案件', '接案'], ['案件', '預約'],
  ['組織', '機構']
];

function toGlossary(message) {
  let s = String(message === undefined || message === null ? '' : message);
  for (const [from, to] of PHRASES) s = s.split(from).join(to);
  return s;
}

module.exports = { toGlossary };
