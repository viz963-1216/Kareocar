'use strict';

/**
 * GET /api/v2/state-load  —— 一次載入這個身分看得到的所有資料
 *
 * 取代 GoogleDatabase.syncAll：舊版要對 Google 試算表發十幾次請求、再把試算表
 * 的欄位一列一列轉回前端模型。app_state 裡存的本來就是前端模型，所以這裡不需要
 * 任何轉換，直接把 jsonb 原樣送回去。
 *
 * 沒有任何過濾邏輯——RLS 已經在資料庫層決定了哪些列回得來。這也是為什麼每個人
 * 拿到的資料量本來就小：需求者只會拿到自己的，調度員只會拿到自家組織的。
 * 舊版從試算表撈的是「全部」，這正是前端 localStorage 會爆掉的原因。
 *
 * 身分四個集合（users / memberships / organizations / drivers）不在 app_state，
 * 它們有自己的 typed 資料表，這裡從那邊讀出來、轉成前端用的形狀。
 */

const { json, handleError } = require('./_http');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');
const session = require('./_session');
const benefit = require('./_benefit');
const { consentStatus, retentionYears } = require('./_consent');

const MAX_ROWS = 5000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const claims = await session.requireSession(event);

    const data = await withUser(claims.userId, async (client) => {
      await session.assertSessionActive(client, claims);

      const collections = {};
      const push = (name, record) => {
        if (!collections[name]) collections[name] = [];
        collections[name].push(record);
      };

      // ---- app_state：前端模型原樣取回 ----
      // 預約與行程讀正式資料表（ADR 0005，0023 同步過去的）；其他集合照舊讀 app_state。
      // 兩邊的讀取規則等價，回給前端的欄位一模一樣。
      const rows = (await client.query(
        `select collection, id, data, organization_id, owner_user_id, version, revision, updated_at
           from (
             select collection, id, data, organization_id, owner_user_id, version, revision, updated_at
               from app_state
              where not deleted
                and collection not in ('bookings', 'trips', 'notifications', 'benefitRulesets', 'benefitRulesetEvents',
                                       'benefitAssessments', 'benefitAssessmentEvents', 'benefitLatestEstimateRuns')
             union all
             select 'bookings', id, data, organization_id, owner_user_id, version, 0, updated_at
               from bookings where not deleted
             union all
             select 'trips', id, data, organization_id, owner_user_id, version, revision, updated_at
               from trips where not deleted
           ) r
          order by updated_at
          limit $1`, [MAX_ROWS])).rows;

      // 預約上的補助資訊（#101）：承接機構在服務對象居住縣市、接送當天是否有有效的長照特約。
      // 需求者讀不到 ltc_contracts，用 security definer 的 app.ltc_contract_active 判斷；同樣的組合只查一次。
      const ltcCache = new Map();
      const ltcActive = async (org, city, date) => {
        if (!org || !city || !date) return false;
        const key = `${org}|${city}|${date}`;
        if (!ltcCache.has(key)) {
          ltcCache.set(key, (await client.query('select app.ltc_contract_active($1, $2, $3::date) as ok', [org, city, date])).rows[0].ok === true);
        }
        return ltcCache.get(key);
      };
      const bookingBenefitView = async (record, org) => {
        const sb = record.serverComputed && record.serverComputed.benefit;
        const city = sb && sb.facts && sb.facts.residenceCity;
        const date = benefit.dateOnly((sb && sb.serviceDate) || record.pickupDate);
        return benefit.bookingBenefitView(sb, { claimed: !!org, ltcActive: await ltcActive(org, city, date) });
      };

      for (const row of rows) {
        const record = (row.data && typeof row.data === 'object') ? row.data : {};
        push(row.collection, {
          ...record,
          ...(row.collection === 'bookings' ? { benefitView: await bookingBenefitView(record, row.organization_id) } : {}),
          id: row.id,
          // 伺服器說了算的欄位放在後面覆蓋，避免前端拿到自己上次送的舊值
          organizationId: row.organization_id || null,
          version: row.version,
          ...(row.collection === 'trips' ? { revision: row.revision } : {}),
          updatedAt: row.updated_at
        });
      }

      // ---- 通知：notifications 資料表，RLS 只放行收件人本人 ----
      const notifications = (await client.query(
        `select id, booking_id, trip_id, recipient_user_id, channel, status, organization_id,
                template, event_type, payload, created_at, sent_at
           from notifications
          order by created_at desc
          limit 200`)).rows;
      for (const n of notifications) {
        push('notifications', {
          id: n.id, organizationId: n.organization_id, recipientUserId: n.recipient_user_id,
          bookingId: n.booking_id, tripId: n.trip_id, channel: n.channel, template: n.template,
          eventType: n.event_type, payload: n.payload || {}, status: n.status,
          createdAt: n.created_at, sentAt: n.sent_at, error: null
        });
      }

      // ---- 補助規則版本與試算（#23）：從資料表讀，前端唯讀 ----
      const rulesets = (await client.query('select * from benefit_rulesets order by created_at')).rows;
      for (const r of rulesets) {
        const ruleset = benefit.rulesetFromRow(r);
        push('benefitRulesets', ruleset);
        // 前端的版本歷史由資料表的時間欄位組出來
        for (const [eventType, at, actorUserId] of [['created', r.created_at, r.created_by_user_id],
          ['approved', r.approved_at, r.approved_by_user_id], ['superseded', r.superseded_at, null],
          ['rejected', r.rejected_at, r.rejected_by_user_id]]) {
          if (!at) continue;
          push('benefitRulesetEvents', { id: `${r.id}:${eventType}`, rulesetId: r.id, eventType, actorUserId,
            detail: eventType === 'rejected' ? r.review_note || '' : `${r.code} ${r.version}`, createdAt: at });
        }
      }
      // 公告抓取紀錄（RLS 只放行平台管理者）
      const fetches = (await client.query(
        `select id, source_id, url, fetched_at, status, http_status, content_hash, error, run_id
           from benefit_source_fetches order by fetched_at desc limit 20`)).rows;
      for (const f of fetches) {
        push('benefitSourceFetches', { id: f.id, sourceId: f.source_id, url: f.url, fetchedAt: f.fetched_at, status: f.status,
          httpStatus: f.http_status, contentHash: f.content_hash, error: f.error || '', runId: f.run_id });
      }
      const assessments = (await client.query(
        `select data, created_at from benefit_assessments where source = 'server' order by created_at desc limit 500`)).rows;
      for (const a of assessments) push('benefitAssessments', { ...(a.data || {}), createdAt: a.created_at });

      // ---- 正式核定與補助帳本（0009）：RLS 只放行管理者、服務對象擁有者、服務中的機構 ----
      const num = (v) => (v === null || v === undefined ? null : Number(v));
      const auths = (await client.query('select * from benefit_authorizations order by created_at')).rows;
      for (const a of auths) {
        push('benefitAuthorizations', {
          id: a.id, schemaVersion: 1, recipientId: a.recipient_id, organizationId: a.organization_id,
          programCode: a.program_code, validFrom: benefit.dateOnly(a.valid_from), validTo: benefit.dateOnly(a.valid_to),
          approved: true, status: a.status, approvedAmount: num(a.approved_amount), approvedUnits: num(a.approved_units),
          currency: a.currency, source: a.source, referenceNo: a.reference_no, createdByUserId: a.created_by_user_id,
          createdAt: a.created_at, revokedAt: a.revoked_at, revokedByUserId: a.revoked_by_user_id
        });
        push('benefitAuthorizationEvents', { id: `${a.id}:created`, authorizationId: a.id, recipientId: a.recipient_id,
          eventType: 'created', actorUserId: a.created_by_user_id, detail: `核定文號 ${a.reference_no}`, createdAt: a.created_at });
        if (a.revoked_at) {
          push('benefitAuthorizationEvents', { id: `${a.id}:revoked`, authorizationId: a.id, recipientId: a.recipient_id,
            eventType: 'revoked', actorUserId: a.revoked_by_user_id, detail: a.revoke_reason || '撤銷正式核定', createdAt: a.revoked_at });
        }
      }
      const ledger = (await client.query('select * from benefit_ledger order by created_at desc limit 2000')).rows;
      for (const l of ledger) {
        push('benefitLedger', {
          id: l.id, schemaVersion: 1, authorizationId: l.authorization_id, recipientId: l.recipient_id,
          bookingId: l.booking_id, tripId: l.trip_id, entryType: l.entry_type, amount: num(l.amount),
          reservedDelta: num(l.reserved_delta), settledDelta: num(l.settled_delta), authorizationDelta: num(l.authorization_delta),
          currency: l.currency, reason: l.reason, actorUserId: l.actor_user_id, rulesetId: l.ruleset_id,
          rulesetVersion: l.ruleset_version, sourceAssessmentId: l.source_assessment_id, createdAt: l.created_at
        });
      }

      // ---- 身分：從 typed 資料表轉成前端形狀 ----
      const users = (await client.query(
        `select id, display_name, phone_e164, email, platform_role, active from users`)).rows;
      for (const u of users) {
        push('users', {
          id: u.id,
          name: u.display_name || '',
          phone: String(u.phone_e164 || '').replace(/^\+886/, '0'),
          email: u.email || '',
          platformRole: String(u.platform_role || '').toLowerCase() === 'super_admin' ? 'super_admin' : null,
          active: u.active !== false,
          password: ''
        });
      }

      const memberships = (await client.query(
        `select id, user_id, organization_id, role, status from memberships`)).rows;
      for (const m of memberships) {
        push('memberships', {
          id: m.id, userId: m.user_id, organizationId: m.organization_id,
          role: m.role, status: m.status
        });
      }

      // 審核欄位：平台管理員看全部，機構成員看到自己組織的狀態與原因（org_read 政策）
      const orgs = (await client.query(
        `select id, org_type, name, tax_id, contact_phone, active, review_status, review_note,
                reviewed_at, application, applied_at
           from organizations`)).rows;
      for (const o of orgs) {
        push('organizations', {
          id: o.id, type: o.org_type, name: o.name || '', active: o.active !== false,
          taxId: o.tax_id || '', contactPhone: o.contact_phone || '',
          reviewStatus: o.review_status || 'approved', reviewNote: o.review_note || '',
          reviewedAt: o.reviewed_at, appliedAt: o.applied_at, application: o.application || {}
        });
      }

      // 長照特約（#99）：平台管理者看全部，機構的負責人、調度員看自己機構的（ltc_contracts_read 政策）
      const contracts = (await client.query(
        `select id, organization_id, city, contract_no, to_char(valid_from, 'YYYY-MM-DD') as valid_from,
                to_char(valid_to, 'YYYY-MM-DD') as valid_to, updated_at from ltc_contracts
          order by organization_id, city, valid_from`)).rows;
      for (const c of contracts) {
        push('ltcContracts', {
          id: c.id, organizationId: c.organization_id, city: c.city, contractNo: c.contract_no,
          validFrom: c.valid_from || null, validTo: c.valid_to || null, updatedAt: c.updated_at
        });
      }

      // 需求者看得到承接自己預約的機構名稱（只有名稱）。自己是成員的機構上面已經有完整資料。
      // active: false 讓前端不會把它當成可切換或可承接的組織，只用來顯示名稱。
      const known = new Set(orgs.map((o) => o.id));
      const serving = (await client.query('select id, name from app.my_booking_service_organizations()')).rows;
      for (const o of serving) {
        if (known.has(o.id)) continue;
        push('organizations', { id: o.id, name: o.name || '', type: '', active: false, limited: true });
      }

      const drivers = (await client.query(
        `select id, user_id, organization_id, fleet_id, duty_status, service_area, active from drivers`)).rows;
      for (const d of drivers) {
        push('drivers', {
          id: d.id, userId: d.user_id, organizationId: d.organization_id,
          // 前端讀 status；dutyStatus 保留給舊版
          fleetId: d.fleet_id || null, status: d.duty_status || 'off_duty', dutyStatus: d.duty_status || 'off_duty',
          serviceArea: d.service_area || '', active: d.active !== false
        });
      }

      // ---- 公開需求池（已遮蔽）----
      const pool = (await client.query(
        `select id, pickup_area, destination_area, pickup_at, trip_type,
                passenger_count, wheelchair_slots, rideshare_consent, version, created_at,
                pickup_time, return_date, return_time, market_expires_at, aid_need, companions,
                pickup_district, pickup_fuzzy_address, destination_district, destination_fuzzy_address,
                distance_meters, duration_seconds, quote_status
           from app_state_booking_pool
          order by pickup_at nulls last
          limit 500`)).rows;

      // 刪除帳號申請（#26）：本人看自己的，平台管理者看全部（RLS）
      const deletionRequests = (await client.query(
        `select d.*, u.display_name from deletion_requests d left join users u on u.id = d.user_id
          order by d.requested_at desc limit 200`)).rows;
      for (const d of deletionRequests) {
        push('deletionRequests', { id: d.id, userId: d.user_id, userName: d.display_name || '', status: d.status,
          reason: d.reason || '', requestedAt: d.requested_at, reviewedAt: d.reviewed_at, reviewNote: d.review_note || '',
          completedAt: d.completed_at, summary: d.summary || {} });
      }

      // 條款同意狀態與保存期限（#26）：前端據此要求同意、顯示設定
      const consent = await consentStatus(client);
      const retention = await retentionYears(client);

      return {
        collections,
        pool,
        consent,
        platformSettings: { retentionYears: retention },
        counts: Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])),
        truncated: rows.length >= MAX_ROWS,
        loadedAt: new Date().toISOString()
      };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
