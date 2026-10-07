'use strict';

/**
 * 送到外部監控（Sentry、告警）之前清掉個資（#17）：姓名、電話、Email、地址、身分證號。
 *
 *   scrubText(text)    字串裡的電話、Email、身分證號、門牌地址換成佔位字
 *   scrubValue(value)  物件遞迴處理；敏感鍵（name、phone、address…，含 primaryPhone 等 camelCase）的值整個拿掉
 */

// 鍵名先拆成單字（camelCase、底線、連字號都拆，不分大小寫），任何一個單字是個資就整個值拿掉（#81）。
// 例如 primaryPhone → primary、phone；emergencyContacts → emergency、contacts；filename 是一個字，不算 name。
const PII_WORDS = new Set(['name', 'names', 'displayname', 'fullname', 'phone', 'phones', 'mobile', 'tel', 'email', 'emails',
  'address', 'addresses', 'pickup', 'dropoff', 'destination', 'location', 'locations', 'lat', 'lng', 'gps', 'coords',
  'contact', 'contacts', 'recipient', 'recipients', 'receiver', 'requester', 'signature', 'photo', 'note', 'notes',
  'idnumber']);
// 不管結尾是什麼都拿掉
const ALWAYS_WORDS = new Set(['password', 'token', 'secret', 'cookie', 'authorization', 'session', 'birth', 'birthdate', 'credential']);
// 這些結尾代表 ID、時間、狀態、筆數，不是個資本身（tripId、pickupAt、contactsCount）
const SAFE_LAST_WORDS = new Set(['id', 'ids', 'at', 'date', 'time', 'count', 'code', 'type', 'status', 'version', 'sequence', 'label']);

function keyWords(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function isSensitiveKey(key) {
  const words = keyWords(key);
  if (words.some((w) => ALWAYS_WORDS.has(w))) return true;
  if (!words.some((w) => PII_WORDS.has(w))) return false;
  return !SAFE_LAST_WORDS.has(words[words.length - 1]);
}
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
      out[k] = isSensitiveKey(k) ? '[redacted]' : scrubValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

module.exports = { scrubText, scrubValue, isSensitiveKey };
