'use strict';

/**
 * 告警的窄介面（#24 先用，#17 接上 Email 與 Discord）。
 *
 *   sendAlert(client, { kind, title, details })
 *
 * 目前：寫稽核紀錄 alert.<kind>，並以 [ALERT] 前綴寫入 Netlify Function 記錄。
 * 測試用 setTransport() 換成記錄呼叫的假實作。
 */

let transport = async ({ kind, title, details }) => {
  console.error(`[ALERT] ${kind}: ${title}`, JSON.stringify(details || {}));
};

function setTransport(next) { transport = next || transport; }

async function sendAlert(client, { kind, title, details = {} }) {
  if (client) {
    await client.query(
      `insert into audit_events (id, event_type, entity_type, entity_id, reason_code, details)
       values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), $1, 'alert', $2, 'ALERT', $3)`,
      [`alert.${kind}`, kind, JSON.stringify({ title, ...details })]);
  }
  try { await transport({ kind, title, details }); } catch (error) { console.error('[ALERT] 傳送失敗', error && error.message); }
}

module.exports = { sendAlert, setTransport };
