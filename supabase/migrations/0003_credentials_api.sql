-- =====================================================================
-- 密碼憑證的受控存取
--
-- password_credentials 沒有任何 RLS 政策，care_ride_app 也沒有直接的表權限。
-- 應用層只能透過下面三支 security definer 函式存取，形成一個很窄的出入口。
--
-- 雜湊本身仍然經過 pepper 處理，而 pepper 只存在 Netlify 的環境變數裡——
-- 就算整個資料庫外洩，也沒有 pepper 可以拿來離線破解。這是原本「pepper 和
-- 雜湊都放在 Script Properties」的問題的正解。
--
-- 注意：這些函式刻意不檢查 app.user_id，因為登入當下還沒有身分可言。
-- 邊界是「只有應用程式連得到資料庫」，不是「只有本人讀得到自己的憑證」。
-- =====================================================================

create or replace function app.get_credential(p_user_id text)
returns table (version int, algorithm text, iterations int, salt text, hash text)
language sql security definer set search_path = public, pg_temp
as $$
  select c.version, c.algorithm, c.iterations, c.salt, c.hash
  from password_credentials c
  where c.user_id = p_user_id
$$;

create or replace function app.set_credential(
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

create or replace function app.delete_credential(p_user_id text)
returns void
language sql security definer set search_path = public, pg_temp
as $$ delete from password_credentials where user_id = p_user_id $$;

create or replace function app.has_credential(p_user_id text)
returns boolean
language sql security definer set search_path = public, pg_temp
as $$ select exists (select 1 from password_credentials where user_id = p_user_id) $$;

grant execute on function
  app.get_credential(text),
  app.set_credential(text, int, text, int, text, text),
  app.delete_credential(text),
  app.has_credential(text)
to care_ride_app;

-- =====================================================================
-- 承接公開案件：用一個交易函式取代原本的「版本號比對 + 全域鎖」
--
-- SELECT ... FOR UPDATE 讓資料庫自己處理競爭，兩個調度員同搶一張單時，
-- 後到的那個一定會看到已經被接走的狀態。這是原本在 Sheet 上做不到的。
-- =====================================================================

create or replace function app.claim_booking(p_booking_id text, p_organization_id text)
returns table (id text, state text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_current bookings%rowtype;
begin
  if not (app.is_super_admin() or app.has_role_in(p_organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限代表這個組織承接案件' using errcode = '42501';
  end if;

  select * into v_current from bookings b where b.id = p_booking_id for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if v_current.organization_id is not null then
    raise exception '此需求已被其他服務單位接走' using errcode = '55006';
  end if;
  if v_current.state <> 'open' then
    raise exception '此需求目前不是可承接的狀態' using errcode = '55006';
  end if;

  return query
  update bookings b
     set organization_id = p_organization_id,
         state = 'claimed',
         version = b.version + 1,
         updated_at = now()
   where b.id = p_booking_id
  returning b.id, b.state, b.organization_id, b.version;
end $$;

grant execute on function app.claim_booking(text, text) to care_ride_app;
