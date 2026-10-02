'use strict';

/**
 * POST /api/v2/consent  —— 個資告知與服務條款的同意（#26）
 *
 * body:
 *   { action: 'status' }                   目前版本與我是否已同意
 *   { action: 'accept', document, version } 同意某份文件的目前版本（版本不是目前版本就拒絕）
 *
 * 已發布版本（app_settings.legal_documents）而還沒同意的使用者不能建立預約（booking-write）。
 */

const auth = require('./_auth-pg');
const { runAuthenticated, optionalText, writeAudit } = require('./_business-rpc');
const { consentStatus } = require('./_consent');

exports.handler = (event) => runAuthenticated(event, async (client, body, claims) => {
  const action = String(body.action || 'status').trim();
  if (action === 'status') return consentStatus(client);
  if (action === 'accept') {
    const document = optionalText(body.document, 60);
    const version = optionalText(body.version, 60);
    if (!document || !version) throw auth.authError('VALIDATION_ERROR', '缺少文件或版本');
    const userAgent = String((event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '');
    const id = (await client.query('select app.accept_consent($1, $2, $3) as id', [document, version, userAgent])).rows[0].id;
    await writeAudit(client, { eventType: 'consent.accepted', actorUserId: claims.userId,
      entityType: 'consent', entityId: id, details: { document, version } });
    return consentStatus(client);
  }
  throw auth.authError('VALIDATION_ERROR', '不支援的動作');
});
