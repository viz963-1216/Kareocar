'use strict';

/**
 * GET /api/v2/bookings
 *
 * 讀取目前身分看得到的預約。這裡沒有任何過濾邏輯——RLS 已經在資料庫層
 * 決定了哪些列回得來。取代 DatabaseApi.gs 裡 databaseFilterRows_ 對 bookings
 * 的那一段。
 *
 * ?pool=1 改讀公開需求池（已遮蔽個資的 view，只有營運方看得到內容）。
 */

const { json, handleError } = require('./_apps-script');
const { withUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

const MAX_LIMIT = 500;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  }
  try {
    const authorization = String(event.headers?.authorization || event.headers?.Authorization || '');
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return json(401, { ok: false, error: { code: 'SESSION_REQUIRED', message: '請先登入' } });
    }
    // 先只驗簽章拿到 userId，版本比對在交易內做（需要資料庫）
    const claims = auth.parseSessionToken(token);

    const params = event.queryStringParameters || {};
    const wantPool = String(params.pool || '') === '1';
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.limit) || 200));

    const data = await withUser(claims.userId, async (client) => {
      await auth.verifySessionToken(client, token);

      if (wantPool) {
        const { rows } = await client.query(
          `select id, pickup_area, destination_area, pickup_at, trip_type,
                  passenger_count, wheelchair_slots, rideshare_consent, version, created_at
             from public_booking_pool
            order by pickup_at nulls last
            limit $1`, [limit]);
        return { pool: rows };
      }

      const { rows } = await client.query(
        `select id, care_recipient_id, requested_by_user_id, organization_id, state,
                pickup_at, pickup_address, destination, trip_type, passenger_count,
                wheelchair_slots, special_needs, rideshare_consent, version,
                data, created_at, updated_at
           from bookings
          order by pickup_at nulls last
          limit $1`, [limit]);
      return { bookings: rows };
    });

    return json(200, { ok: true, data });
  } catch (error) {
    return handleError(translateDbError(error));
  }
};
