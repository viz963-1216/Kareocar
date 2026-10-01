'use strict';

/**
 * POST /api/v2/organization-apply  —— 申請成為服務機構
 *
 * body: { name, orgType, taxId, contactPhone, contactName, documentsNote }
 *
 * 呼叫 app.apply_organization：建立 review_status = pending 的組織，呼叫者成為負責人。
 * 審核通過前，這個組織的成員看不到需求池、也不能接案。稽核紀錄由函式在同一交易寫入。
 */

const { runAuthenticated, optionalText } = require('./_business-rpc');
const auth = require('./_auth-pg');

const ORG_TYPES = ['transport_provider', 'care_facility'];

function newId(prefix) {
  return `${prefix}-${auth.randomHex(16).slice(0, 16).toUpperCase()}`;
}

exports.handler = (event) => runAuthenticated(event, async (client, body) => {
  const name = optionalText(body.name, 120);
  const orgType = optionalText(body.orgType, 40);
  if (!name) throw auth.authError('VALIDATION_ERROR', '請輸入機構名稱');
  if (!ORG_TYPES.includes(orgType)) throw auth.authError('VALIDATION_ERROR', '請選擇機構類型');
  const taxId = optionalText(body.taxId, 20);
  if (taxId && !/^\d{8}$/.test(taxId)) throw auth.authError('VALIDATION_ERROR', '統一編號應為 8 位數字');
  const contactPhone = optionalText(body.contactPhone, 30).replace(/[^\d+\-() ]/g, '');
  const application = {
    contactName: optionalText(body.contactName, 80),
    documentsNote: optionalText(body.documentsNote, 1000)
  };

  const organizationId = newId('ORG');
  const membershipId = newId('MEM-OWN');
  await client.query('select app.apply_organization($1,$2,$3,$4,$5,$6,$7)',
    [organizationId, membershipId, name, orgType, taxId || null, contactPhone || null, JSON.stringify(application)]);

  return {
    organization: { id: organizationId, type: orgType, name, reviewStatus: 'pending' },
    membership: { membershipId, organizationId, role: 'owner', status: 'active' }
  };
});
