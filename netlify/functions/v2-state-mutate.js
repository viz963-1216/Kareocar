'use strict';

/**
 * POST /api/v2/state-mutate  —— 前端待送出佇列的落地點（Postgres 版）
 *
 * 取代 state-mutate.js（轉給 Apps Script 的那支）。前端送出的格式一個字都沒改：
 * { changes: [{ collection, id, record, deleted, expectedRevision }] }
 *
 * 授權完全交給 RLS 與 app_state 上的觸發器：
 *   - 呼叫端送來的 organizationId / ownerUserId 一律被觸發器覆蓋掉，
 *     所以沒辦法把資料塞給別人、也沒辦法把別人的資料搬成自己的
 *   - 看不到、改不到的資料列，UPDATE 影響 0 列 —— 這裡會回報 FORBIDDEN，
 *     而不是假裝成功
 *
 * 整批在同一筆交易裡：任何一筆失敗就整批不落地，不會留下寫到一半的狀態。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');

const MAX_CHANGES = 200;

// 身分相關的集合有自己的 typed 資料表，登入與 RLS 都依賴它們。
// 讓前端也能從這裡寫，等於同一件事有兩個真相。
const IDENTITY_COLLECTIONS = new Set(['users', 'memberships', 'organizations', 'drivers']);

const ALLOWED_COLLECTIONS = new Set([
  'membershipEvents', 'vehicles', 'careRecipients', 'careRecipientRelations',
  'careRecipientEvents', 'careRecipientMergeEvents',
  'bookingEvents', 'bookingRevisions', 'dispatchPlans',
  'trips', 'tripEvents', 'issues', 'systemReports', 'notifications',
  'benefitRulesets', 'benefitRulesetEvents', 'benefitAssessments',
  'benefitAssessmentEvents', 'benefitLatestEstimateRuns',
  'serviceProofs', 'cancellations', 'telemetryEvents'
]);

// notifications 仍接受前端寫入（派車、中斷等流程的通知）。這些通知沒有後端來源證明，
// 收件人讀取政策不會放行；竄改系統通知由通知觸發器擋下（見 baseline 第 8 部分的第 6 節）。

// 這些欄位絕對不進資料庫，即使前端不小心送上來
const NEVER_STORE = ['password', 'passwordHash', 'passwordUpdatedAt', 'credential',
  'credentialHash', 'salt', 'sessionToken', 'accessToken', 'refreshToken', 'idToken'];

function sanitize(record) {
  const out = { ...(record && typeof record === 'object' ? record : {}) };
  for (const key of NEVER_STORE) delete out[key];
  return out;
}

const text = (v) => String(v === undefined || v === null ? '' : v).trim();

/** 從記錄裡找出關聯的行程／預約，讓 RLS 與查詢有得依靠。 */
function links(collection, record) {
  return {
    tripId: text(record.tripId) || (collection === 'trips' ? text(record.id) : '') || null,
    bookingId: text(record.bookingId) || (collection === 'bookings' ? text(record.id) : '') || null
  };
}

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
        const record = sanitize(change.record);
        const id = text(change.id || record.id);
        const deleted = change.deleted === true;

        if (IDENTITY_COLLECTIONS.has(collection)) {
          throw auth.authError('COLLECTION_FORBIDDEN',
            `${collection} 由身分管理端點負責，不接受從這裡寫入`);
        }
        if (collection === 'bookings') {
          throw auth.authError('COLLECTION_FORBIDDEN', '預約請由預約端點（/api/v2/booking-write）寫入');
        }
        if (!ALLOWED_COLLECTIONS.has(collection)) {
          throw auth.authError('COLLECTION_FORBIDDEN', `不允許寫入此資料集合：${collection}`);
        }
        if (!id || id.length > 180) throw auth.authError('VALIDATION_ERROR', '資料 ID 無效');

        const { tripId, bookingId } = links(collection, record);
        const orgClaim = text(record.organizationId) || null;

        // 行程用 revision 做樂觀鎖：呼叫端說「我看到的是第 N 版」，
        // 對不上就代表有人已經改過，整批拒絕而不是覆蓋掉對方的修改。
        if (collection === 'trips' && !deleted && change.expectedRevision !== undefined) {
          const current = (await client.query(
            `select revision from app_state where collection = 'trips' and id = $1`, [id])).rows[0];
          const seen = Math.max(0, Number(change.expectedRevision) || 0);
          const now = current ? Math.max(0, Number(current.revision) || 0) : 0;
          if (current && now !== seen) {
            throw Object.assign(auth.authError('TRIP_CONFLICT', '這筆行程已被其他人更新，請重新整理'),
              { code: 'TRIP_CONFLICT' });
          }
        }

        const upsert = await client.query(
          `insert into app_state (collection, id, organization_id, trip_id, booking_id,
                                  data, deleted, revision)
             values ($1,$2,$3,$4,$5,$6,$7, case when $1 = 'trips' then 1 else 0 end)
           on conflict (collection, id) do update
             set data = case when $7 then app_state.data else excluded.data end,
                 deleted = $7,
                 trip_id = coalesce(excluded.trip_id, app_state.trip_id),
                 booking_id = coalesce(excluded.booking_id, app_state.booking_id),
                 revision = case when $1 = 'trips' then app_state.revision + 1 else app_state.revision end
           returning version, revision, updated_at`,
          [collection, id, orgClaim, tripId, bookingId, JSON.stringify(record), deleted]);

        if (!upsert.rows.length) {
          // RLS 讓 UPDATE 影響 0 列時不會報錯，只是什麼都沒發生。
          // 這裡明確擋下來，否則前端會以為存好了。
          throw auth.authError('FORBIDDEN', `沒有權限寫入 ${collection}／${id}`);
        }

        const saved = upsert.rows[0];
        results.push({
          collection, id, deleted,
          version: saved.version,
          revision: saved.revision,
          updatedAt: saved.updated_at
        });
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'state.batch_mutated',$2,'app_state','batch','AUTHORITATIVE_WRITE',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         JSON.stringify({ count: results.length })]);

      return { ok: true, results, count: results.length };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
