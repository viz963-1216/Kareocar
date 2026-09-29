-- =====================================================================
-- 應用程式執行期需要的東西
--
-- Apps Script 版本把這些放在 Script Properties 與 CacheService。搬到 Netlify
-- 之後那兩個都沒有了（Function 是無狀態的），所以放進資料庫，並且用
-- expires_at 讓它們像快取一樣會過期，不會無限累積。
-- =====================================================================

-- session 版本：改密碼／改手機時遞增，讓舊 token 立刻失效
alter table users add column if not exists session_version int not null default 1;

-- 速率限制與密碼重設驗證碼。key 是不可逆的雜湊（見應用層 opaqueKey），
-- 手機號碼與 IP 都不會以明文存在這裡。
create table if not exists auth_rate_limits (
  key         text primary key,
  state       jsonb not null default '{}'::jsonb,
  expires_at  timestamptz not null
);
create index if not exists auth_rate_expiry_idx on auth_rate_limits (expires_at);

alter table auth_rate_limits enable row level security;
-- 沒有政策：應用角色不能直接碰，只能走下面的函式

-- 讀取時順手清掉過期的列，不需要另外排程
create or replace function app.rate_get(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  delete from auth_rate_limits where expires_at < now() - interval '1 hour';
  select state into v from auth_rate_limits
   where key = p_key and expires_at > now();
  return v;
end $$;

create or replace function app.rate_put(p_key text, p_state jsonb, p_ttl_seconds int)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into auth_rate_limits (key, state, expires_at)
  values (p_key, p_state, now() + make_interval(secs => greatest(1, p_ttl_seconds)))
  on conflict (key) do update
    set state = excluded.state, expires_at = excluded.expires_at
$$;

create or replace function app.rate_clear(p_key text)
returns void
language sql security definer set search_path = public, pg_temp
as $$ delete from auth_rate_limits where key = p_key $$;

-- 登入需要在「還沒有身分」的情況下用手機號碼找人，RLS 擋得住一般查詢，
-- 所以走這支受控函式。只回傳驗證流程需要的欄位。
create or replace function app.find_user_for_login(p_phone_e164 text)
returns table (id text, display_name text, active boolean, platform_role text, session_version int)
language sql security definer set search_path = public, pg_temp
as $$
  select u.id, u.display_name, u.active, u.platform_role, u.session_version
  from users u where u.phone_e164 = p_phone_e164
$$;

create or replace function app.get_session_version(p_user_id text)
returns int
language sql security definer set search_path = public, pg_temp
as $$ select coalesce((select session_version from users where id = p_user_id), 0) $$;

create or replace function app.bump_session_version(p_user_id text)
returns int
language sql security definer set search_path = public, pg_temp
as $$
  update users set session_version = session_version + 1
   where id = p_user_id returning session_version
$$;

-- 登入成功後要載入的身分資料
create or replace function app.get_memberships(p_user_id text)
returns table (id text, organization_id text, role text, status text)
language sql security definer set search_path = public, pg_temp
as $$
  select m.id, m.organization_id, m.role, m.status
  from memberships m where m.user_id = p_user_id and m.status = 'active'
$$;

grant execute on function
  app.rate_get(text), app.rate_put(text, jsonb, int), app.rate_clear(text),
  app.find_user_for_login(text), app.get_session_version(text),
  app.bump_session_version(text), app.get_memberships(text)
to care_ride_app;
