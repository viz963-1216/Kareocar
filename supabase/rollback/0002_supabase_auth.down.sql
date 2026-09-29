-- =====================================================================
-- 回復 0002_supabase_auth：還原自製密碼憑證與 session 版本（baseline 的狀態）
--
-- 回復後資料庫裡沒有任何密碼：Supabase Auth 的帳號不會被帶回來，所有使用者
-- 都要重新設定密碼。只用在 Staging 或 CI 的往返驗證。
-- =====================================================================

-- 自助註冊還原成 baseline 的版本
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

drop function app.revoke_sessions(text);
drop function app.session_state(text);
drop function app.find_user_for_login(text);
alter table users drop column sessions_valid_after;
alter table users add column session_version int not null default 1;

create function app.find_user_for_login(p_phone_e164 text)
returns table (id text, display_name text, active boolean, platform_role text, session_version int)
language sql security definer set search_path = public, pg_temp
as $$
  select u.id, u.display_name, u.active, u.platform_role, u.session_version
  from users u where u.phone_e164 = p_phone_e164
$$;

create function app.get_session_version(p_user_id text)
returns int
language sql security definer set search_path = public, pg_temp
as $$ select coalesce((select session_version from users where id = p_user_id), 0) $$;

create function app.bump_session_version(p_user_id text)
returns int
language sql security definer set search_path = public, pg_temp
as $$
  update users set session_version = session_version + 1
   where id = p_user_id returning session_version
$$;

grant execute on function
  app.find_user_for_login(text), app.get_session_version(text), app.bump_session_version(text)
to care_ride_app;

create table password_credentials (
  user_id         text primary key references users(id) on delete cascade,
  version         int  not null default 2,
  algorithm       text not null default 'iterated-hmac-sha256-peppered',
  iterations      int  not null default 6000,
  salt            text not null,
  hash            text not null,
  updated_at      timestamptz not null default now()
);
alter table password_credentials enable row level security;
revoke all on password_credentials from care_ride_app;

create function app.get_credential(p_user_id text)
returns table (version int, algorithm text, iterations int, salt text, hash text)
language sql security definer set search_path = public, pg_temp
as $$
  select c.version, c.algorithm, c.iterations, c.salt, c.hash
  from password_credentials c
  where c.user_id = p_user_id
$$;

create function app.set_credential(
  p_user_id text, p_version int, p_algorithm text,
  p_iterations int, p_salt text, p_hash text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or p_salt is null or p_hash is null then
    raise exception '憑證欄位不完整' using errcode = '22023';
  end if;
  insert into password_credentials (user_id, version, algorithm, iterations, salt, hash, updated_at)
  values (p_user_id, p_version, p_algorithm, p_iterations, p_salt, p_hash, now())
  on conflict (user_id) do update
    set version = excluded.version,
        algorithm = excluded.algorithm,
        iterations = excluded.iterations,
        salt = excluded.salt,
        hash = excluded.hash,
        updated_at = now();
end $$;

create function app.delete_credential(p_user_id text)
returns void
language sql security definer set search_path = public, pg_temp
as $$ delete from password_credentials where user_id = p_user_id $$;

create function app.has_credential(p_user_id text)
returns boolean
language sql security definer set search_path = public, pg_temp
as $$ select exists (select 1 from password_credentials where user_id = p_user_id) $$;

grant execute on function
  app.get_credential(text),
  app.set_credential(text, int, text, int, text, text),
  app.delete_credential(text),
  app.has_credential(text)
to care_ride_app;
