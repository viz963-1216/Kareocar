'use strict';

/**
 * 告警的窄介面（#24 建立，#17 接上 Email 與 Discord）。
 *
 *   sendAlert(client, { kind, title, details })  → { delivered: ['discord', 'email', …] }
 *
 * 每則告警：
 *   - 寫稽核紀錄 alert.<kind>（有傳 client 時）
 *   - 以 [ALERT] 前綴寫入 Netlify Function 記錄
 *   - 有設定才送：Discord（DISCORD_ALERT_WEBHOOK_URL）、Email（Resend：RESEND_API_KEY、
 *     ALERT_EMAIL_FROM、ALERT_EMAIL_TO，多個收件人用逗號分隔）
 * 送出前 details 經 _scrub 清掉個資。任一管道失敗只寫記錄，不影響呼叫端。
 * 測試用 setTransport() 換成記錄呼叫的假實作（取代 Discord 與 Email 兩個管道）。
 *
 * 程式錯誤率與存活檢查的告警由 Sentry 與外部存活檢查服務自己送（見 DEPLOYMENT.md）。
 */

const { scrubValue, scrubText } = require('./_scrub');

const TIMEOUT_MS = 5000;

async function post(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function environmentLabel() {
  return process.env.CONTEXT === 'production' ? '正式' : (process.env.CONTEXT || '本機');
}

function render({ kind, title, details }) {
  const body = JSON.stringify(details || {}, null, 2);
  return { subject: `[安心接送｜${environmentLabel()}] ${title}`,
    text: `${title}\n種類：${kind}\n環境：${environmentLabel()}\n時間：${new Date().toISOString()}\n\n${body}` };
}

const channels = {
  async discord(alert) {
    const url = String(process.env.DISCORD_ALERT_WEBHOOK_URL || '').trim();
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) return false;
    const { subject, text } = render(alert);
    const content = `🚨 **${subject}**\n\`\`\`\n${text.slice(subject.length).slice(0, 1700)}\n\`\`\``;
    await post(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
    return true;
  },
  async email(alert) {
    const key = String(process.env.RESEND_API_KEY || '').trim();
    const from = String(process.env.ALERT_EMAIL_FROM || '').trim();
    const to = String(process.env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!key || !from || !to.length) return false;
    const { subject, text } = render(alert);
    await post('https://api.resend.com/emails', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to, subject, text }) });
    return true;
  }
};

let transport = async (alert) => {
  const delivered = [];
  for (const [name, send] of Object.entries(channels)) {
    try { if (await send(alert)) delivered.push(name); } catch (error) { console.error(`[ALERT] ${name} 傳送失敗`, error && error.message); }
  }
  return delivered;
};
const defaultTransport = transport;

function setTransport(next) { transport = next || defaultTransport; }

async function sendAlert(client, { kind, title, details = {} }) {
  const safe = { kind: String(kind), title: scrubText(title), details: scrubValue(details) };
  if (client) {
    await client.query(
      `insert into audit_events (id, event_type, entity_type, entity_id, reason_code, details)
       values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), $1, 'alert', $2, 'ALERT', $3)`,
      [`alert.${safe.kind}`, safe.kind, JSON.stringify({ title: safe.title, ...safe.details })]);
  }
  console.error(`[ALERT] ${safe.kind}: ${safe.title}`, JSON.stringify(safe.details));
  let delivered = [];
  try { delivered = (await transport(safe)) || []; } catch (error) { console.error('[ALERT] 傳送失敗', error && error.message); }
  return { delivered };
}

module.exports = { sendAlert, setTransport, channels, render };
