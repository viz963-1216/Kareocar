'use strict';

/**
 * POST /api/v2/bootstrap-admin   —— 一次性使用，用完請立刻移除環境變數
 *
 * 為什麼需要這支：
 *   1. 超級管理者的「帳號列」只能由 DBA 在 Supabase SQL Editor 建立——
 *      users 表上的 guard_user_insert 觸發器明確禁止 care_ride_app 自行
 *      建立 super_admin，這是防自我提權的設計，不該為了方便繞過。
 *   2. 但密碼雜湊不能在 SQL 裡算：pepper 只存在於 Netlify 環境變數，而且
 *      明文密碼寫進 SQL Editor 會留在 Supabase 的查詢紀錄裡。
 *   所以密碼必須由這裡（Function 端）算完再寫入。
 *
 * 四道鎖：
 *   - 沒有設定 BOOTSTRAP_TOKEN 環境變數時，這支端點直接回 404（等於不存在）
 *   - token 必須相符，且用常數時間比對
 *   - 目標帳號必須「已存在、active、platform_role = super_admin」
 *   - 目標帳號必須「還沒有密碼憑證」——所以同一個帳號只能用這支設定一次，
 *     就算 token 外流也沒辦法拿來改掉現有管理者的密碼
 *
 * 用完之後：到 Netlify 刪掉 BOOTSTRAP_TOKEN，這支端點就自動失效。
 */

const { json, parseBody } = require('./_http');
const { withoutUser, translateDbError } = require('./_db');
const auth = require('./_auth-pg');

const NOT_FOUND = { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } };

exports.handler = async (event) => {
  // 未設定 token 時完全不存在——連「這支端點有存在」都不透露
  const expected = String(process.env.BOOTSTRAP_TOKEN || '').trim();
  if (!expected) return json(404, NOT_FOUND);

  if (event.httpMethod !== 'POST') return json(404, NOT_FOUND);

  try {
    const body = parseBody(event);
    const token = String(body.token || '');
    if (!auth.constantTimeEqual(token, expected)) return json(404, NOT_FOUND);

    const phone = auth.normalizeTaiwanPhone(body.phone);
    const password = String(body.password || '');
    if (!/^09\d{8}$/.test(phone)) {
      return json(400, { ok: false, error: { code: 'INVALID_PHONE', message: '手機號碼格式不正確' } });
    }
    if (password.length < 12) {
      return json(400, { ok: false, error: { code: 'WEAK_PASSWORD', message: '超級管理者密碼至少 12 碼' } });
    }

    const result = await withoutUser(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM app.find_user_for_login($1)', [auth.toE164(phone)]);
      const user = rows[0];
      if (!user) {
        return { code: 'USER_NOT_FOUND', message: '找不到這個帳號，請先在 Supabase SQL Editor 建立使用者列' };
      }
      if (String(user.platform_role || '').toLowerCase() !== 'super_admin') {
        return { code: 'NOT_SUPER_ADMIN', message: '這個帳號不是 super_admin，這支端點只用於初始化超級管理者' };
      }
      if (user.active !== true) {
        return { code: 'USER_INACTIVE', message: '這個帳號目前是停用狀態' };
      }
      if (await auth.hasPasswordCredential(client, user.id)) {
        return { code: 'ALREADY_INITIALIZED', message: '這個帳號已經有密碼了，請改用忘記密碼流程' };
      }
      await auth.setPasswordCredential(client, user.id, password);
      return { ok: true, userId: user.id, displayName: user.display_name || '' };
    });

    if (!result.ok) {
      return json(409, { ok: false, error: { code: result.code, message: result.message } });
    }

    console.warn('[bootstrap] 已設定超級管理者密碼', result.userId, '— 請立刻移除 BOOTSTRAP_TOKEN');
    return json(200, {
      ok: true,
      data: {
        userId: result.userId,
        displayName: result.displayName,
        next: '請立刻到 Netlify 刪除 BOOTSTRAP_TOKEN 環境變數並重新部署'
      }
    });
  } catch (error) {
    const e = translateDbError(error);
    console.error('[bootstrap] 失敗', e);
    return json(500, { ok: false, error: { code: e.code || 'BOOTSTRAP_FAILED', message: e.message } });
  }
};
