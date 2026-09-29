-- =====================================================================
-- 身分流程需要的資料庫函式
--
-- 這裡只放「RLS 之下做不到、但又確實該允許」的兩件事。其餘的身分操作
-- （建立員工、修改自己的帳號）都走一般 RLS，用登入者自己的身分執行，
-- 沒有在這裡開後門。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 自助註冊
--
-- 為什麼需要 security definer：註冊的人「還沒有身分」，app.user_id 是空的。
-- memberships 的 insert 政策要求 owner 或 super_admin，所以未登入的人不可能
-- 自己把自己加進需求者組織。這支函式把那一步包起來，而且只做這一件事——
-- 組織 ID 是寫死的 ORG-REQ-001，角色是寫死的 requester，呼叫端無法指定，
-- 也就沒辦法拿它註冊出一個調度員或負責人。
--
-- 密碼不在這裡處理：雜湊要用只存在 Netlify 環境變數裡的 pepper 算，
-- 呼叫端會在同一筆交易裡接著呼叫 app.set_credential，失敗就整筆回滾。
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
          'password', 'password:' || p_user_id, true, 'none');

  insert into memberships (id, user_id, organization_id, role, status)
  values (p_membership_id, p_user_id, 'ORG-REQ-001', 'requester', 'active');
end $$;

-- ---------------------------------------------------------------------
-- 建立員工時，用手機號碼找出「已經存在的帳號」
--
-- 為什麼需要 security definer：users_read 只讓你看到自己、以及自己營運組織
-- 底下的人。負責人要把一個「目前還在別家、或只是需求者」的帳號加進自家組織
-- 時，那個人根本不在他看得到的範圍裡，查不到就會變成重複建立帳號，最後撞上
-- phone_e164 的唯一鍵。
--
-- 開這個口子的代價是「可以用手機號碼探測帳號是否存在」，所以函式自己先確認
-- 呼叫者是營運方（負責人或調度人員）或平台管理者——把授權檢查放在資料庫裡，
-- 而不是只放在 Node 那一層。回傳欄位也刻意只給建立員工真正需要的那幾個，
-- 不含電子信箱。
-- ---------------------------------------------------------------------
create or replace function app.staff_lookup_user(p_phone_e164 text)
returns table (id text, display_name text, platform_role text, active boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not (app.is_super_admin() or app.operates_any()) then
    raise exception '沒有權限查詢帳號' using errcode = '42501';
  end if;
  return query
    select u.id, u.display_name, u.platform_role, u.active
    from users u where u.phone_e164 = p_phone_e164;
end $$;

grant execute on function
  app.register_requester(text, text, text, text, text),
  app.staff_lookup_user(text)
to care_ride_app;
