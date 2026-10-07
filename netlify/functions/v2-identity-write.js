'use strict';

/**
 * POST /api/v2/identity-write  —— 組織、成員資格、司機的寫入
 *
 * 為什麼要單獨開一支：v2-state-mutate 把這三個集合擋掉了（身分資料有專屬的
 * typed 資料表，登入與 RLS 全都依賴它們，不該從通用的 app_state 管道進來）。
 * 但擋掉之後，這三件事在網站上就沒有任何可走的路徑了——平台管理者開不了新
 * 的服務單位、負責人加不了司機、成員資格也停用不了。擋是對的，缺的是替代道路。
 *
 * 授權完全交給 RLS，這裡不自己判斷角色：
 *   organizations  insert 只有 super_admin；update 是 super_admin 或該組織 owner
 *   memberships    insert 是 super_admin，或該組織 owner 且新增的角色不是 owner
 *   drivers        insert/update 是 super_admin 或該組織 owner
 * 越權時 insert 會被 with check 擋下、update 會影響 0 列，兩種都回 FORBIDDEN，
 * 不會假裝成功。
 *
 * 前端送來的格式與 state-mutate 完全相同，差別只在這裡會把記錄攤平成 typed 欄位。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');

const MAX_CHANGES = 100;
const ALLOWED = new Set(['organizations', 'memberships', 'drivers']);

// 前端本機把需求者組織叫 org_requesters，資料庫叫 ORG-REQ-001。
// 讀取那一端由 index.html 的 normalizeLoadedIds_ 換算，寫入這一端要換回來。
const REQUESTER_ORG_LOCAL = 'org_requesters';
const REQUESTER_ORG_DB = 'ORG-REQ-001';
const toDbOrgId = (v) => {
  const id = String(v === undefined || v === null ? '' : v).trim();
  return id === REQUESTER_ORG_LOCAL ? REQUESTER_ORG_DB : id;
};

const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const bool = (v, fallback = true) => (v === undefined || v === null ? fallback : v !== false);

const ORG_TYPES = ['transport_provider', 'care_facility', 'requester_hub'];
const MEMBERSHIP_ROLES = ['owner', 'dispatcher', 'driver', 'requester'];
const MEMBERSHIP_STATES = ['active', 'suspended', 'revoked'];

/**
 * 先 UPDATE，沒有命中才 INSERT。
 *
 * 不能用 INSERT ... ON CONFLICT DO UPDATE：那是一句 INSERT，Postgres 會要求
 * 通過 INSERT 政策的 with check。organizations 的 insert 政策只放行
 * super_admin，所以負責人連「改自己組織的名稱」都會被擋——明明 update 政策
 * 是允許的。拆成兩步之後，各自只會碰到該碰的那條政策。
 */
async function upsert(client, updateSql, updateParams, insertSql, insertParams) {
  const updated = await client.query(updateSql, updateParams);
  if (updated.rows.length) return updated.rows;
  const inserted = await client.query(insertSql, insertParams);
  return inserted.rows;
}

async function writeOrganization(client, id, r) {
  const type = text(r.type || r.orgType) || 'transport_provider';
  if (!ORG_TYPES.includes(type)) throw auth.authError('VALIDATION_ERROR', `不支援的機構類型：${type}`);
  const name = text(r.name);
  if (!name) throw auth.authError('VALIDATION_ERROR', '機構名稱不可空白');

  const params = [toDbOrgId(id), type, name, text(r.taxId) || null, text(r.contactPhone) || null, bool(r.active)];
  return upsert(client,
    `update organizations set org_type=$2, name=$3, tax_id=$4, contact_phone=$5, active=$6, updated_at=now()
      where id=$1 returning id`, params,
    `insert into organizations (id, org_type, name, tax_id, contact_phone, active)
      values ($1,$2,$3,$4,$5,$6) returning id`, params);
}

async function writeMembership(client, id, r) {
  const role = text(r.role).toLowerCase();
  const status = text(r.status).toLowerCase() || 'active';
  if (!MEMBERSHIP_ROLES.includes(role)) throw auth.authError('VALIDATION_ERROR', `不支援的角色：${role}`);
  if (!MEMBERSHIP_STATES.includes(status)) throw auth.authError('VALIDATION_ERROR', `不支援的狀態：${status}`);
  const userId = text(r.userId);
  const orgId = toDbOrgId(r.organizationId);
  if (!userId || !orgId) throw auth.authError('VALIDATION_ERROR', '成員資格缺少使用者或機構');

  const params = [id, userId, orgId, role, status,
    status === 'revoked' ? new Date().toISOString() : null,
    status === 'revoked' ? (text(r.revokedByUserId) || null) : null];
  return upsert(client,
    `update memberships set role=$4, status=$5, revoked_at=$6, revoked_by_user_id=$7, updated_at=now()
      where id=$1 returning id`, params,
    `insert into memberships (id, user_id, organization_id, role, status, revoked_at, revoked_by_user_id)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`, params);
}

const DUTY_STATUSES = ['on_duty', 'break', 'off_duty', 'unavailable'];

async function writeDriver(client, id, r) {
  const userId = text(r.userId);
  const orgId = toDbOrgId(r.organizationId);
  if (!userId || !orgId) throw auth.authError('VALIDATION_ERROR', '司機資料缺少使用者或機構');

  // 前端的欄位是 status（開始執勤／休息／結束執勤都改它）；dutyStatus 是載入時帶下來的舊值，只在沒有 status 時才用
  const duty = text(r.status) || text(r.dutyStatus) || 'off_duty';
  if (!DUTY_STATUSES.includes(duty)) throw auth.authError('VALIDATION_ERROR', `司機狀態不合法：${duty}`);
  const params = [id, userId, orgId, text(r.fleetId) || null, duty, text(r.serviceArea) || null, bool(r.active)];
  return upsert(client,
    `update drivers set fleet_id=$4, duty_status=$5, service_area=$6, active=$7, updated_at=now()
      where id=$1 returning id`, params,
    `insert into drivers (id, user_id, organization_id, fleet_id, duty_status, service_area, active)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`, params);
}

const WRITERS = { organizations: writeOrganization, memberships: writeMembership, drivers: writeDriver };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);

    const body = parseBody(event);
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!changes.length) throw auth.authError('VALIDATION_ERROR', '沒有可儲存的資料異動');
    if (changes.length > MAX_CHANGES) {
      throw auth.authError('VALIDATION_ERROR', `單次異動最多 ${MAX_CHANGES} 筆`);
    }

    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);

      const results = [];
      for (const change of changes) {
        const collection = text(change.collection);
        if (!ALLOWED.has(collection)) {
          throw auth.authError('COLLECTION_FORBIDDEN', `這支端點不處理 ${collection}`);
        }
        if (change.deleted === true) {
          // 身分資料一律不硬刪：成員資格改 status='revoked'，其他改 active=false，
          // 這樣稽核軌跡才留得住。
          throw auth.authError('VALIDATION_ERROR',
            `${collection} 不支援刪除；請改為停用或撤銷`);
        }
        const record = (change.record && typeof change.record === 'object') ? change.record : {};
        const id = text(change.id || record.id);
        if (!id || id.length > 180) throw auth.authError('VALIDATION_ERROR', '資料 ID 無效');

        const rows = await WRITERS[collection](client, id, record);
        if (!rows.length) {
          // RLS 之下越權的 UPDATE 影響 0 列且不報錯。這裡明確擋下來，
          // 否則前端會以為存好了。
          throw auth.authError('FORBIDDEN', `沒有權限寫入 ${collection}／${id}`);
        }
        results.push({ collection, id });
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'identity.batch_written',$2,'identity','batch','IDENTITY_WRITE',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         JSON.stringify({ count: results.length, collections: [...new Set(results.map((x) => x.collection))] })]);

      return { ok: true, results, count: results.length };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
