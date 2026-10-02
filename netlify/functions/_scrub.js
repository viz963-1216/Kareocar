'use strict';

/**
 * 送到外部監控（Sentry、告警）之前清掉個資（#17）：姓名、電話、Email、地址、身分證號。
 *
 *   scrubText(text)    字串裡的電話、Email、身分證號、門牌地址換成佔位字
 *   scrubValue(value)  物件遞迴處理；敏感鍵（name、phone、address…）的值整個拿掉
 */

const SENSITIVE_KEY = /(^|_|-)(name|displayname|phone|mobile|tel|email|address|pickup|destination|contact|recipient|receiver|password|token|secret|cookie|authorization|session|idnumber|birth)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

function scrubText(input) {
  let s = String(input === undefined || input === null ? '' : input);
  if (s.length > MAX_STRING) s = `${s.slice(0, MAX_STRING)}…`;
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?886[-\s]?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '[phone]')
    .replace(/(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g, '[phone]')
    .replace(/\(0\d{1,2}\)\s?\d{3,4}[-\s]?\d{4}(?!\d)/g, '[phone]')
    .replace(/(?<!\d)0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)/g, '[phone]')
    .replace(/(?<![A-Za-z])[A-Z][12]\d{8}(?!\d)/g, '[id]')
    .replace(/[一-鿿]{1,3}[市縣][一-鿿]{1,4}[區鄉鎮市][^\s,，。;；"'`]{0,24}?\d+\s*號(?:之\d+)?(?:\d+樓)?/g, '[address]')
    .replace(/[一-鿿]{1,10}(?:路|街|大道)[一二三四五六七八九十]?段?[^\s,，。;；"'`]{0,12}?\d+\s*號/g, '[address]');
}

function scrubValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

module.exports = { scrubText, scrubValue };
