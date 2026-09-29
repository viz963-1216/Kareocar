-- =====================================================================
-- 0002：身分改由 Supabase Auth 負責
--
-- 密碼、手機驗證、token 簽發都交給 Supabase Auth；這個資料庫不再保存任何密碼
-- 雜湊。users.id 對新使用者就是 Supabase Auth 的使用者 ID（auth.users.id 的文字形式），
-- Netlify Function 驗證 access token（JWT）後，以 token 的 sub 作為 app.user_id，
-- 所有 RLS 政策照舊生效。
--
-- 「改密碼後舊 session 全部失效」：Supabase 的 access token 在到期前無法撤銷，
-- 所以在這裡記錄每個使用者的 sessions_valid_after；簽發時間（JWT 的 iat）早於它的
-- token 一律拒絕。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 移除自製的密碼憑證
-- ---------------------------------------------------------------------
drop function app.get_credential(text);
drop function app.set_credential(text, int, text, int, text, text);
drop function app.delete_credential(text);
drop function app.has_credential(text);
drop table password_credentials;

-- ---------------------------------------------------------------------
-- 2. session 版本改為「生效起點」
-- ---------------------------------------------------------------------
drop function app.get_session_version(text);
drop function app.bump_session_version(text);
drop function app.find_user_for_login(text);
alter table users drop column session_version;
alter table users add column sessions_valid_after timestamptz not null default 'epoch';

-- 登入前以手機號碼找人（忘記密碼流程用）。RLS 擋得住一般查詢，所以走受控函式，
-- 只回傳流程需要的欄位。
create function app.find_user_for_login(p_phone_e164 text)
returns table (id text, display_name text, active boolean, platform_role text)
language sql security definer set search_path = public, pg_temp
as $$
  select u.id, u.display_name, u.active, u.platform_role
  from users u where u.phone_e164 = p_phone_e164
$$;

-- 每次請求驗證 session 用：帳號是否啟用、session 生效起點（epoch 秒）。
-- 使用者不存在時回傳 0 列。
create function app.session_state(p_user_id text)
returns table (active boolean, valid_after bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.active, floor(extract(epoch from u.sessions_valid_after))::bigint
  from users u where u.id = p_user_id
$$;

-- 讓這個使用者目前所有的 access token 失效（改密碼、改手機、重設密碼時呼叫）。
-- JWT 的 iat 只到秒，所以生效起點設在「下一秒」：這一秒內（含撤銷之前）簽發的
-- token 全部失效。回傳新的生效起點（epoch 秒）；呼叫端要替使用者重新登入時，
-- 必須等到這個時間之後再向 Supabase Auth 取 token。
create function app.revoke_sessions(p_user_id text)
returns bigint
language sql security definer set search_path = public, pg_temp
as $$
  update users set sessions_valid_after = date_trunc('second', now()) + interval '1 second'
   where id = p_user_id
  returning floor(extract(epoch from sessions_valid_after))::bigint
$$;

grant execute on function
  app.find_user_for_login(text), app.session_state(text), app.revoke_sessions(text)
to care_ride_app;

-- ---------------------------------------------------------------------
-- 3. 自助註冊：使用者 ID 就是 Supabase Auth 的使用者 ID
--
-- 呼叫端先在 Supabase Auth 建立帳號，再以它的 ID 呼叫這支。auth_provider 記為
-- supabase、auth_subject_id 記 Supabase Auth 的使用者 ID（與 id 相同）。
-- 其餘邏輯與 baseline 相同。
-- ---------------------------------------------------------------------
create or replace function app.register_requester(
  p_user_id text, p_membership_id text, p_display_name text,
  p_email text, p_phone_e164 text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or p_membership_id is null or p_phone_e164 is null then
    raise exception '註冊欄位不完整' using errcode = '22023';
  end if;

  -- 明確檢查而不是靠 unique index 撞錯，這樣兩種衝突可以給不同訊息
  if exists (select 1 from users u where u.phone_e164 = p_phone_e164) then
    raise exception '此電子信箱或手機已存在，請使用原本登入方式' using errcode = '23505';
  end if;
  if coalesce(p_email, '') <> ''
     and exists (select 1 from users u where lower(u.email) = lower(p_email)) then
    raise exception '此電子信箱或手機已存在，請使用原本登入方式' using errcode = '23505';
  end if;

  insert into users (id, display_name, phone_e164, email,
                     auth_provider, auth_subject_id, active, platform_role)
  values (p_user_id, p_display_name, p_phone_e164, nullif(p_email, ''),
          'supabase', p_user_id, true, 'none');

  insert into memberships (id, user_id, organization_id, role, status)
  values (p_membership_id, p_user_id, 'ORG-REQ-001', 'requester', 'active');
end $$;

