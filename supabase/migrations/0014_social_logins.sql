-- =====================================================================
-- 0014：社群登入對應表與 Supabase 的 Custom Access Token Hook（#58 第三部分）
--
-- 原本綁定既有帳號要用 Supabase 的 identity linking：先刪掉社群登入時自動建立的帳號，再由既有
-- 帳號重新到 Google／Facebook 授權一次，使用者要確認兩次。改成自己記錄對應關係：
--
--   social_logins(auth_user_id → user_id)
--     auth_user_id  社群登入時 Supabase 建立的帳號（JWT 的 sub）
--     user_id       系統裡的使用者（users.id，通常是手機註冊的那個帳號）
--
-- Supabase 每次簽發 access token（登入、換 token）都會呼叫 public.custom_access_token_hook，
-- 有對應就在 token 加上 app_user_id；Netlify Function 驗證 token 後以 app_user_id（沒有就用
-- sub）作為使用者。token 由 Supabase 簽章，所以 app_user_id 不能被偽造。
--
-- 寫入只經受控函式：綁定只能綁到自己、一個社群帳號只對應一位使用者、每位使用者每種登入方式
-- 一個；解除綁定由本人；刪除帳號時由平台管理者一併清除。care_ride_app 只有 SELECT（只看得到
-- 自己的）。Hook 要在 Supabase 主控台 Authentication → Hooks 啟用（見 DEPLOYMENT.md）。
-- =====================================================================

create table social_logins (
  auth_user_id text primary key,
  user_id      text not null references users(id) on delete cascade,
  provider     text not null,
  email        text,
  created_at   timestamptz not null default now(),
  constraint social_logins_provider_check check (provider in ('google', 'facebook'))
);
create unique index social_logins_user_provider_idx on social_logins (user_id, provider);

alter table social_logins enable row level security;
create policy social_logins_read on social_logins for select
  using (user_id = app.current_user_id() or app.is_super_admin());
grant select on social_logins to care_ride_app;

-- 綁定到目前的使用者。回傳 linked（新綁定）、already（本來就綁在自己身上）、
-- in_use（綁在別人身上或本身就是系統使用者）、provider_taken（這種登入方式已綁了另一個帳號）。
create function app.link_social_login(p_auth_user_id text, p_provider text, p_email text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me text := app.current_user_id();
  v_owner text;
begin
  if v_me is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if p_provider not in ('google', 'facebook') or coalesce(p_auth_user_id, '') = '' then
    raise exception '不支援的登入方式' using errcode = '22023';
  end if;
  if not exists (select 1 from users where id = v_me and active) then
    raise exception '帳號已停用' using errcode = '42501';
  end if;

  select user_id into v_owner from social_logins where auth_user_id = p_auth_user_id;
  if v_owner = v_me then
    return 'already';
  elsif v_owner is not null then
    return 'in_use';
  end if;
  -- 社群帳號本身就是系統使用者（用「第一次使用」建立的）：不能再掛到別人身上
  if exists (select 1 from users where id = p_auth_user_id) then
    return 'in_use';
  end if;
  if exists (select 1 from social_logins where user_id = v_me and provider = p_provider) then
    return 'provider_taken';
  end if;

  insert into social_logins (auth_user_id, user_id, provider, email)
  values (p_auth_user_id, v_me, p_provider, nullif(lower(p_email), ''));
  return 'linked';
end $$;

-- 本人解除某種登入方式。回傳被解除的 Supabase 帳號 ID（呼叫端接著刪掉它），沒有綁定回傳 null。
create function app.unlink_social_login(p_provider text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me text := app.current_user_id();
  v_auth text;
begin
  if v_me is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  delete from social_logins where user_id = v_me and provider = p_provider
  returning auth_user_id into v_auth;
  return v_auth;
end $$;

-- 刪除帳號（平台管理者核准時）：清掉這位使用者的所有對應，回傳 Supabase 帳號 ID 給呼叫端刪除。
create function app.purge_social_logins(p_user_id text)
returns text[]
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ids text[];
begin
  if not app.is_super_admin() then
    raise exception '只有平台管理者可以執行' using errcode = '42501';
  end if;
  with d as (delete from social_logins where user_id = p_user_id returning auth_user_id)
  select coalesce(array_agg(auth_user_id), '{}') into v_ids from d;
  return v_ids;
end $$;

-- 這個 Supabase 帳號對應到哪位使用者（沒有就回傳 null）。登入回呼與每次請求的檢查用：
-- 解除綁定後，就算還有舊的 token，也會因為對應不見而失效。
create function app.social_login_user(p_auth_user_id text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select user_id from social_logins where auth_user_id = p_auth_user_id
$$;

revoke all on function app.link_social_login(text, text, text), app.unlink_social_login(text),
  app.purge_social_logins(text), app.social_login_user(text) from public;
grant execute on function app.link_social_login(text, text, text), app.unlink_social_login(text),
  app.purge_social_logins(text), app.social_login_user(text) to care_ride_app;

-- Supabase Auth 的 Custom Access Token Hook。輸入 {user_id, claims, ...}，回傳 {claims}。
-- 有對應就加 app_user_id；其他宣告原封不動。
create function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_user text;
begin
  select user_id into v_user from social_logins where auth_user_id = event->>'user_id';
  if v_user is not null then
    v_claims := jsonb_set(v_claims, '{app_user_id}', to_jsonb(v_user));
  end if;
  return jsonb_build_object('claims', v_claims);
end $$;

revoke all on function public.custom_access_token_hook(jsonb) from public;
-- Supabase 以 supabase_auth_admin 呼叫 hook；拋棄式測試資料庫沒有這個角色
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.custom_access_token_hook(jsonb) from anon, authenticated;
  end if;
end $$;
