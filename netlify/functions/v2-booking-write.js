'use strict';

/**
 * POST /api/v2/booking-write  —— 預約的建立與修改
 *
 * body: { changes: [{ collection: 'bookings', id, record }] }（與 state-mutate 相同的形狀，
 * 前端的待送出佇列把 bookings 分流到這裡）
 *
 * 規則在 _booking-rules.js：誰能把預約改到哪個狀態、哪些欄位只由伺服器決定。
 * 另外：
 *   - serverComputed（定位、模糊地址、距離、報價）由伺服器計算，見 _bookings.js
 *   - 補助估算（serverComputed.benefit）由伺服器依 approved 規則版本計算，見 _benefit.js；
 *     同一交易內釋放正式核定額度（benefit_ledger，見 0009）；保留暫停中（#98）
 *   - 退回公開池、不受理、重大修改需重新承接時，同一交易內撤銷原承接機構
 *     （app.revoke_booking_organization），原機構立即讀不到
 *   - 不能刪除預約；接案與取消有各自的端點
 *   - 不能排車：排車只走 v2-schedule-trips（ADR 0003），去程／回程的排車欄位一律沿用資料庫的值
 *   - 預約帶服務對象（recipientId）時，需求者必須是這位服務對象的建立者、且有未撤銷的可預約關係（#78）；
 *     承接機構的負責人或調度員只能用本機構服務過或自己建立的服務對象（總驗收收緊）
 *   - 替家人預約時的聯絡人（contacts.requester）由伺服器依登入的需求者寫入，之後沿用資料庫的值（#82）
 *
 * 整批在同一筆交易裡，任何一筆不合規則就整批不寫入。
 */

const { json, parseBody, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');
const { applyServerBookingFields, sanitize } = require('./_bookings');
const { checkBookingWrite } = require('./_booking-rules');
const benefit = require('./_benefit');

const MAX_CHANGES = 50;
const text = (v) => String(v === undefined || v === null ? '' : v).trim();
/** 新預約，或修改時換了服務對象 */
const recipientChanged = (record, existing) => !existing || text((existing.data || {}).recipientId) !== text(record.recipientId);

/**
 * 補助估算由伺服器計算（#23）：新預約、改了日期或服務對象時，依當下唯一 approved 的規則
 * 版本重新估算；其他修改沿用原本的估算。前端送來的補助金額（serverComputed.benefit、
 * commercialSnapshots[].benefit）一律換成伺服器的結果。
 */
async function applyServerBenefit(client, record, existing) {
  const before = existing ? existing.data || {} : null;
  const previous = before && before.serverComputed && before.serverComputed.benefit;
  const stale = !previous || !before
    || String(before.pickupDate || '') !== String(record.pickupDate || '')
    || recipientChanged(record, existing);
  const result = stale ? await benefit.bookingBenefit(client, record) : previous;
  record.serverComputed = { ...(record.serverComputed || {}), benefit: result };
  if (Array.isArray(record.commercialSnapshots)) {
    record.commercialSnapshots = record.commercialSnapshots.map((snap) => (snap && typeof snap === 'object'
      ? { ...snap, benefit: { ...result } } : snap));
  }
  return stale;
}

/**
 * 預約上的服務對象必須屬於這位需求者（#78）。新預約或改了服務對象時檢查；
 * 沒改服務對象的修改沿用原本的檢查結果（關係事後撤銷，已建立的預約仍可修改或取消）。
 * 服務對象要是使用中（不是已封存或已合併），關係的 canBook 沒寫視為可預約（與前端相同）。
 *
 * 關係（careRecipientRelations）走一般寫入端點，任何人都能替自己寫一筆指向別人服務對象的
 * 關係，所以除了關係之外，服務對象本身也必須是呼叫者建立的（替家人預約：只有建立者管理）。
 */
async function assertRecipientBookable(client, { actorUserId, record, existing, roles }) {
  const recipientId = text(record.recipientId);
  if (!recipientId || !recipientChanged(record, existing)) return;
  if (roles.admin) return;
  const opsOrg = existing ? (roles.opsOfExisting ? existing.organization_id : null)
    : (roles.opsOfClaimedOrg ? text(record.organizationId) : null);
  if (opsOrg) {
    // 承接機構：本機構服務過（有本機構承接的預約）、掛在本機構，或是呼叫者自己建立的服務對象
    const { rows: served } = await client.query(
      `select 1 where exists (select 1 from app_state b where b.collection = 'bookings' and not b.deleted
                                and b.organization_id = $1 and b.data->>'recipientId' = $2)
                   or exists (select 1 from app_state r where r.collection = 'careRecipients' and not r.deleted
                                and r.id = $2 and (r.organization_id = $1 or r.owner_user_id = $3))`,
      [opsOrg, recipientId, actorUserId]);
    if (!served.length) throw auth.authError('FORBIDDEN', '這位服務對象不是本機構服務的對象');
    return;
  }
  const { rows } = await client.query(
    `select 1
       from app_state r
       join app_state rel on rel.collection = 'careRecipientRelations' and not rel.deleted
                         and rel.owner_user_id = $1
                         and rel.data->>'userId' = $1 and rel.data->>'recipientId' = r.id
                         and coalesce(rel.data->>'status', 'active') <> 'revoked'
                         and coalesce(rel.data->>'canBook', 'true') <> 'false'
      where r.collection = 'careRecipients' and r.id = $2 and not r.deleted and r.owner_user_id = $1
        and coalesce(r.data->>'status', 'active') = 'active'
      limit 1`, [actorUserId, recipientId]);
  if (!rows.length) throw auth.authError('FORBIDDEN', '不能替這位服務對象預約');
}

/** 0912345678 形式（前端與預約的電話都是這個形式） */
const localPhone = (e164) => { const d = text(e164).replace(/\D/g, ''); return d.startsWith('886') ? `0${d.slice(3)}` : d; };

/**
 * 替家人預約的聯絡人（#82）。前端送來的姓名、電話一律不採用：新預約由需求者自己建立、
 * 而且要求聯絡人時，用登入者的帳號資料；修改時沿用資料庫的值。
 */
async function applyRequesterContact(client, { actorUserId, record, existing }) {
  const asked = record.contacts && typeof record.contacts === 'object' && record.contacts.requester;
  const before = existing && existing.data && existing.data.contacts && existing.data.contacts.requester;
  let requester = null;
  if (existing) requester = before || null;
  else if (asked && !text(record.organizationId)) {
    const u = (await client.query('select display_name, phone_e164 from users where id = $1', [actorUserId])).rows[0];
    if (u) requester = { userId: actorUserId, name: text(u.display_name), phone: localPhone(u.phone_e164) };
  }
  const contacts = { ...(record.contacts && typeof record.contacts === 'object' ? record.contacts : {}) };
  delete contacts.requester;
  if (requester) contacts.requester = requester;
  if (Object.keys(contacts).length) record.contacts = contacts; else delete record.contacts;
}

async function isOps(client, organizationId) {
  if (!organizationId) return false;
  const { rows } = await client.query(`select app.has_role_in($1, array['owner','dispatcher']) as ok`, [organizationId]);
  return rows[0].ok === true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);
    const body = parseBody(event);
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!changes.length) throw auth.authError('VALIDATION_ERROR', '沒有可儲存的預約異動');
    if (changes.length > MAX_CHANGES) throw auth.authError('VALIDATION_ERROR', `單次最多 ${MAX_CHANGES} 筆預約`);

    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);
      const admin = (await client.query('select app.is_super_admin() as ok')).rows[0].ok === true;
      // 已發布的個資告知與服務條款，沒同意最新版本就不能建立預約（#26）
      const consentMissing = admin ? [] : ((await client.query('select app.consent_missing() as m')).rows[0].m || []);

      const results = [];
      for (const change of changes) {
        if (text(change.collection) !== 'bookings') {
          throw auth.authError('COLLECTION_FORBIDDEN', '這支端點只處理預約');
        }
        if (change.deleted === true) throw auth.authError('VALIDATION_ERROR', '預約不能刪除，請使用取消功能');
        const incoming = sanitize(change.record);
        const id = text(change.id || incoming.id);
        if (!id || id.length > 180) throw auth.authError('VALIDATION_ERROR', '預約 ID 無效');
        incoming.id = id;

        const existing = (await client.query(
          `select data, organization_id, owner_user_id from app_state
            where collection = 'bookings' and id = $1 and not deleted
            for update`, [id])).rows[0] || null;
        const roles = {
          admin,
          ownsExisting: Boolean(existing) && existing.owner_user_id === claims.userId,
          opsOfExisting: Boolean(existing) && await isOps(client, existing.organization_id),
          opsOfClaimedOrg: !existing && await isOps(client, text(incoming.organizationId))
        };
        if (existing && !roles.admin && !roles.ownsExisting && !roles.opsOfExisting) {
          throw auth.authError('FORBIDDEN', `沒有權限修改預約 ${id}`);
        }

        if (!existing && consentMissing.length) {
          throw auth.authError('CONSENT_REQUIRED', '請先閱讀並同意最新的個資告知與服務條款');
        }

        let checked;
        try {
          checked = checkBookingWrite({ actorUserId: claims.userId, record: incoming, existing, roles });
        } catch (error) {
          throw auth.authError(error.code || 'VALIDATION_ERROR', error.message);
        }
        const record = checked.record;
        await assertRecipientBookable(client, { actorUserId: claims.userId, record, existing, roles });
        await applyRequesterContact(client, { actorUserId: claims.userId, record, existing });
        await applyServerBookingFields(client, id, record);
        const benefitRepriced = await applyServerBenefit(client, record, existing);

        const upsert = await client.query(
          `insert into app_state (collection, id, organization_id, booking_id, data)
             values ('bookings', $1, $2, $1, $3)
           on conflict (collection, id) do update
             set data = excluded.data, deleted = false
           returning version, updated_at`,
          [id, existing ? null : (text(record.organizationId) || null), JSON.stringify(record)]);
        if (!upsert.rows.length) throw auth.authError('FORBIDDEN', `沒有權限寫入預約 ${id}`);

        if (checked.revoke) {
          await client.query('select app.revoke_booking_organization($1)', [id]);
        }
        // 補助額度帳本（0009）：不受理／過期釋放；新預約或重新估算時（先釋放再）保留。
        // 金額由資料庫函式從剛存好的 serverComputed.benefit 取得。保留暫停中（#98，見 _benefit.js）。
        if (['rejected', 'expired'].includes(String(record.state || ''))) {
          await client.query('select app.release_booking_benefit($1, $2)', [id, `booking_${record.state}`]);
        } else if (benefitRepriced && benefit.LEDGER_RESERVATION_ENABLED) {
          if (existing) await client.query('select app.release_booking_benefit($1, $2)', [id, 'booking_repriced']);
          await client.query('select app.reserve_booking_benefit($1, $2)', [id, existing ? 'booking_amended' : 'booking_created']);
        }

        const saved = (await client.query(
          `select organization_id, version, updated_at from app_state where collection = 'bookings' and id = $1`, [id])).rows[0];
        results.push({
          collection: 'bookings', id, state: record.state || 'open',
          organizationId: saved ? saved.organization_id : null,
          version: saved ? saved.version : upsert.rows[0].version,
          updatedAt: saved ? saved.updated_at : upsert.rows[0].updated_at,
          revoked: checked.revoke
        });
      }

      await client.query(
        `insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
         values ($1,'booking.batch_written',$2,'booking','batch','BOOKING_WRITE',$3)`,
        [`AUD-${Date.now()}-${auth.randomHex(4)}`, claims.userId,
         JSON.stringify({ count: results.length, revoked: results.filter((r) => r.revoked).map((r) => r.id) })]);
      return { ok: true, results, count: results.length };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
