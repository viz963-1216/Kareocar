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
      const rows = (await client.query(
        `select collection, id, data, organization_id, owner_user_id, version, revision, updated_at
           from app_state
          where not deleted
          order by updated_at
          limit $1`, [MAX_ROWS])).rows;

      for (const row of rows) {
        const record = (row.data && typeof row.data === 'object') ? row.data : {};
        push(row.collection, {
          ...record,
          id: row.id,
          // 伺服器說了算的欄位放在後面覆蓋，避免前端拿到自己上次送的舊值
          organizationId: row.organization_id || null,
          version: row.version,
          ...(row.collection === 'trips' ? { revision: row.revision } : {}),
          updatedAt: row.updated_at
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

      const drivers = (await client.query(
        `select id, user_id, organization_id, fleet_id, duty_status, service_area, active from drivers`)).rows;
      for (const d of drivers) {
        push('drivers', {
          id: d.id, userId: d.user_id, organizationId: d.organization_id,
          fleetId: d.fleet_id || null, dutyStatus: d.duty_status || 'off_duty',
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

      return {
        collections,
        pool,
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
