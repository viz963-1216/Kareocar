-- =====================================================================
-- Row Level Security
--
-- 取代 DatabaseApi.gs 裡手寫的 databaseFilterRows_ 與 AppStateApi.gs 裡的
-- appStateAuthorizeMutation_。差別在於：政策是寫在資料庫裡、對著「資料列」
-- 判斷的，不是對著請求內容判斷的——這一輪修掉的那個嚴重漏洞（授權去讀
-- record.requestedByUserId）在這個結構下寫不出來。
--
-- ⚠️ 最重要的一件事：Postgres 的資料表擁有者預設「繞過」RLS。
--    如果 Netlify Function 用 postgres 這個帳號連線，下面所有政策等於不存在。
--    一定要用最後面建立的 care_ride_app 角色連線。0003 會用測試證明這件事。
--
-- 使用者身分由應用層在每筆交易開頭設定：
--    BEGIN;
--    SELECT set_config('app.user_id', $1, true);   -- true = 只在這筆交易內有效
--    ... 查詢 ...
--    COMMIT;
-- =====================================================================

-- ---------------------------------------------------------------- 輔助函式
-- 全部 security definer：由 postgres 擁有，因此讀取 users / memberships 時
-- 不會再觸發 RLS，避免政策互相遞迴。

create or replace function app.current_user_id() returns text
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '') $$;

create or replace function app.is_super_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from users u
      where u.id = app.current_user_id() and u.active and u.platform_role = 'super_admin')
  $$;

create or replace function app.has_role_in(org text, roles text[]) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select org is not null and exists (
      select 1 from memberships m
      where m.user_id = app.current_user_id()
        and m.organization_id = org
        and m.status = 'active'
        and m.role = any(roles))
  $$;

-- 「營運方」＝該組織的負責人或調度人員
create or replace function app.operates(org text) returns boolean
  language sql stable
  as $$ select app.has_role_in(org, array['owner','dispatcher']) $$;

create or replace function app.is_member_of(org text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select org is not null and exists (
      select 1 from memberships m
      where m.user_id = app.current_user_id()
        and m.organization_id = org and m.status = 'active')
  $$;

-- 使用者身為營運方的所有組織（排除需求者集散組織）
create or replace function app.my_ops_orgs() returns text[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(array_agg(distinct m.organization_id), '{}')
    from memberships m
    where m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.role in ('owner','dispatcher')
      and m.organization_id <> 'ORG-REQ-001'
  $$;

create or replace function app.operates_any() returns boolean
  language sql stable
  as $$ select cardinality(app.my_ops_orgs()) > 0 $$;

create or replace function app.my_driver_ids() returns text[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(array_agg(d.id), '{}') from drivers d
    where d.user_id = app.current_user_id()
  $$;

-- 服務對象的所有權來自關係人表，不是請求內容
create or replace function app.owns_recipient(rid text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select rid is not null and exists (
      select 1 from care_recipient_contacts c
      where c.care_recipient_id = rid
        and c.user_id = app.current_user_id()
        and c.status <> 'revoked')
  $$;

create or replace function app.can_see_booking(bid text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select bid is not null and (
      app.is_super_admin() or exists (
        select 1 from bookings b
        where b.id = bid and (
          b.requested_by_user_id = app.current_user_id()
          or b.organization_id = any(app.my_ops_orgs())
          or exists (
            select 1 from trip_bookings tb join trips t on t.id = tb.trip_id
            where tb.booking_id = b.id and t.driver_id = any(app.my_driver_ids()))
        )))
  $$;

create or replace function app.can_see_trip(tid text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select tid is not null and (
      app.is_super_admin() or exists (
        select 1 from trips t
        where t.id = tid and (
          t.organization_id = any(app.my_ops_orgs())
          or t.driver_id = any(app.my_driver_ids())
          or exists (
            select 1 from trip_bookings tb join bookings b on b.id = tb.booking_id
            where tb.trip_id = t.id and b.requested_by_user_id = app.current_user_id())
        )))
  $$;

-- 司機能否操作這趟行程（回報異常、上傳服務證明用）
create or replace function app.drives_trip(tid text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select tid is not null and exists (
      select 1 from trips t where t.id = tid and t.driver_id = any(app.my_driver_ids()))
  $$;

-- 公開需求池的地址模糊化，對應原本的 databaseApproxArea_
create or replace function app.approx_area(address text) returns text
  language sql immutable
  as $$
    select coalesce(
      (regexp_match(
         replace(coalesce(address, ''), '臺', '台'),
         '(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)([^市縣]{1,8}(?:區|鄉|鎮|市))?'
      ))[1] || coalesce((regexp_match(
         replace(coalesce(address, ''), '臺', '台'),
         '(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)([^市縣]{1,8}(?:區|鄉|鎮|市))?'
      ))[2], ''),
      '區域未公開')
  $$;

-- ---------------------------------------------------------------- 開啟 RLS

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','users','password_credentials','memberships','care_recipients',
    'care_recipient_contacts','drivers','vehicles','bookings','trips','trip_bookings',
    'service_proofs','issues','telemetry_events','booking_events','quote_snapshots',
    'cancellations','dispatch_plans','notifications','benefit_assessments',
    'system_reports','kpi_daily','audit_events'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- 沒有政策 = 全部拒絕。以下逐表開放。

-- ---------------------------------------------------------------- 組織與身分

create policy org_read on organizations for select
  using (app.is_super_admin() or app.is_member_of(id));
create policy org_update on organizations for update
  using (app.is_super_admin() or app.has_role_in(id, array['owner']))
  with check (app.is_super_admin() or app.has_role_in(id, array['owner']));
create policy org_insert on organizations for insert
  with check (app.is_super_admin());

create policy users_read on users for select
  using (
    app.is_super_admin()
    or id = app.current_user_id()
    or exists (select 1 from memberships m
               where m.user_id = users.id and m.status = 'active'
                 and m.organization_id = any(app.my_ops_orgs())));
create policy users_update on users for update
  using (app.is_super_admin() or id = app.current_user_id()
         or exists (select 1 from memberships m
                    where m.user_id = users.id and m.status='active'
                      and app.has_role_in(m.organization_id, array['owner'])))
  with check (app.is_super_admin() or id = app.current_user_id()
         or exists (select 1 from memberships m
                    where m.user_id = users.id and m.status='active'
                      and app.has_role_in(m.organization_id, array['owner'])));
create policy users_insert on users for insert with check (true);  -- 註冊；欄位由觸發器把關

-- 只有超級管理者能改平台角色或啟用狀態，避免自我提權
-- security invoker（不是 definer）：這樣 current_user 反映的是真正的連線角色，
-- 才能區分「應用程式使用者」與「DBA / migration」。
create or replace function app.guard_user_privileges() returns trigger
language plpgsql as $$
begin
  -- 只約束透過應用程式角色進來的操作；DBA 直連時不擋，否則初始化做不了。
  if current_user = 'care_ride_app' and not app.is_super_admin() then
    if new.platform_role is distinct from old.platform_role then
      raise exception '只有平台超級管理者可以變更平台角色' using errcode = '42501';
    end if;
    if new.active is distinct from old.active
       and not exists (select 1 from memberships m
                       where m.user_id = old.id and m.status='active'
                         and app.has_role_in(m.organization_id, array['owner'])) then
      raise exception '沒有權限變更帳號啟用狀態' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger users_guard_privileges before update on users
  for each row execute function app.guard_user_privileges();

-- 註冊時不得自行指定 super_admin
create or replace function app.guard_user_insert() returns trigger
language plpgsql as $$
begin
  if new.platform_role = 'super_admin'
     and current_user = 'care_ride_app'
     and not app.is_super_admin() then
    raise exception '不得自行建立平台超級管理者' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger users_guard_insert before insert on users
  for each row execute function app.guard_user_insert();

-- 密碼憑證：任何角色都沒有政策可用，只能經由 0003 的 security definer 函式存取
-- （刻意不建立任何 policy）

create policy memberships_read on memberships for select
  using (app.is_super_admin()
         or user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));
create policy memberships_write on memberships for insert
  with check (app.is_super_admin()
              or (app.has_role_in(organization_id, array['owner']) and role <> 'owner'));
create policy memberships_update on memberships for update
  using (app.is_super_admin() or app.has_role_in(organization_id, array['owner']))
  with check (app.is_super_admin()
              or (app.has_role_in(organization_id, array['owner']) and role <> 'owner'));

-- ---------------------------------------------------------------- 服務對象

create policy recipients_read on care_recipients for select
  using (app.is_super_admin()
         or app.owns_recipient(id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = care_recipients.id
                      and b.organization_id = any(app.my_ops_orgs())));
create policy recipients_insert on care_recipients for insert with check (true);
create policy recipients_update on care_recipients for update
  using (app.is_super_admin() or app.owns_recipient(id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = care_recipients.id
                      and b.organization_id = any(app.my_ops_orgs())))
  with check (app.is_super_admin() or app.owns_recipient(id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = care_recipients.id
                      and b.organization_id = any(app.my_ops_orgs())));

create policy crc_read on care_recipient_contacts for select
  using (app.is_super_admin() or user_id = app.current_user_id()
         or app.owns_recipient(care_recipient_id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = care_recipient_contacts.care_recipient_id
                      and b.organization_id = any(app.my_ops_orgs())));
create policy crc_write on care_recipient_contacts for insert
  with check (app.is_super_admin() or user_id = app.current_user_id()
              or app.owns_recipient(care_recipient_id));
create policy crc_update on care_recipient_contacts for update
  using (app.is_super_admin() or user_id = app.current_user_id() or app.owns_recipient(care_recipient_id))
  with check (app.is_super_admin() or user_id = app.current_user_id() or app.owns_recipient(care_recipient_id));

-- ---------------------------------------------------------------- 車隊

create policy drivers_read on drivers for select
  using (app.is_super_admin() or user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));
create policy drivers_write on drivers for insert
  with check (app.is_super_admin() or app.has_role_in(organization_id, array['owner']));
create policy drivers_update on drivers for update
  using (app.is_super_admin() or user_id = app.current_user_id()
         or app.has_role_in(organization_id, array['owner']))
  with check (app.is_super_admin() or user_id = app.current_user_id()
         or app.has_role_in(organization_id, array['owner']));

create policy vehicles_read on vehicles for select
  using (app.is_super_admin() or organization_id = any(app.my_ops_orgs()));
create policy vehicles_write on vehicles for all
  using (app.is_super_admin() or app.has_role_in(organization_id, array['owner']))
  with check (app.is_super_admin() or app.has_role_in(organization_id, array['owner']));

-- ---------------------------------------------------------------- 預約

-- 讀：自己的、自己組織的、或自己開的行程上的。公開需求池「不」走這條，
-- 走下面那個已遮蔽個資的 view。
create policy bookings_read on bookings for select
  using (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or exists (select 1 from trip_bookings tb join trips t on t.id = tb.trip_id
                    where tb.booking_id = bookings.id
                      and t.driver_id = any(app.my_driver_ids())));

-- 建立：只能建立掛在自己名下的預約
create policy bookings_insert on bookings for insert
  with check (app.is_super_admin()
              or requested_by_user_id = app.current_user_id()
              or app.operates(organization_id));

-- 更新：本人、營運方，或「承接尚未被接走的公開案件」。
-- USING 判斷的是資料庫裡的現況，WITH CHECK 判斷改完之後的樣子——
-- 承接只能接到自己實際隸屬的組織。
create policy bookings_update on bookings for update
  using (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or (organization_id is null and state = 'open' and app.operates_any()))
  with check (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));

-- 公開需求池：只有營運方看得到，且個資已遮蔽
create view public_booking_pool as
  select b.id,
         app.approx_area(b.pickup_address)  as pickup_area,
         app.approx_area(b.destination)     as destination_area,
         b.pickup_at, b.trip_type, b.passenger_count, b.wheelchair_slots,
         b.rideshare_consent, b.version, b.created_at
  from bookings b
  where b.organization_id is null
    and b.state = 'open'
    and (app.is_super_admin() or app.operates_any());

create policy booking_events_read on booking_events for select
  using (app.can_see_booking(booking_id));
create policy booking_events_insert on booking_events for insert
  with check (app.can_see_booking(booking_id));

create policy quotes_read on quote_snapshots for select using (app.can_see_booking(booking_id));
create policy quotes_insert on quote_snapshots for insert with check (app.can_see_booking(booking_id));

create policy cancels_read on cancellations for select using (app.can_see_booking(booking_id));
create policy cancels_insert on cancellations for insert with check (app.can_see_booking(booking_id));
create policy cancels_update on cancellations for update
  using (app.can_see_booking(booking_id)) with check (app.can_see_booking(booking_id));

-- ---------------------------------------------------------------- 行程

create policy trips_read on trips for select using (app.can_see_trip(id));
create policy trips_write on trips for insert
  with check (app.is_super_admin() or app.operates(organization_id));
create policy trips_update on trips for update
  using (app.is_super_admin() or app.operates(organization_id) or app.drives_trip(id))
  with check (app.is_super_admin() or app.operates(organization_id) or app.drives_trip(id));

create policy tb_read on trip_bookings for select
  using (app.can_see_trip(trip_id) and app.can_see_booking(booking_id));
create policy tb_write on trip_bookings for all
  using (app.is_super_admin() or exists (select 1 from trips t
          where t.id = trip_bookings.trip_id and app.operates(t.organization_id)))
  with check (app.is_super_admin() or exists (select 1 from trips t
          where t.id = trip_bookings.trip_id and app.operates(t.organization_id)));

create policy proofs_read on service_proofs for select using (app.can_see_trip(trip_id));
create policy proofs_insert on service_proofs for insert
  with check (app.drives_trip(trip_id)
              or exists (select 1 from trips t where t.id = service_proofs.trip_id
                         and app.operates(t.organization_id)));

create policy issues_read on issues for select using (app.can_see_trip(trip_id));
create policy issues_write on issues for insert
  with check (app.drives_trip(trip_id)
              or exists (select 1 from trips t where t.id = issues.trip_id
                         and app.operates(t.organization_id)));
create policy issues_update on issues for update
  using (app.can_see_trip(trip_id)) with check (app.can_see_trip(trip_id));

create policy telemetry_read on telemetry_events for select using (app.can_see_trip(trip_id));
create policy telemetry_insert on telemetry_events for insert
  with check (app.drives_trip(trip_id)
              or exists (select 1 from trips t where t.id = telemetry_events.trip_id
                         and app.operates(t.organization_id)));

-- ---------------------------------------------------------------- 營運

create policy dispatch_read on dispatch_plans for select
  using (app.is_super_admin() or organization_id = any(app.my_ops_orgs()));
create policy dispatch_write on dispatch_plans for all
  using (app.is_super_admin() or app.operates(organization_id))
  with check (app.is_super_admin() or app.operates(organization_id));

create policy notif_read on notifications for select
  using (app.is_super_admin()
         or recipient_user_id = app.current_user_id()
         or app.can_see_booking(booking_id)
         or app.can_see_trip(trip_id));
create policy notif_insert on notifications for insert
  with check (app.is_super_admin() or app.operates_any());

create policy benefit_read on benefit_assessments for select
  using (app.is_super_admin()
         or created_by_user_id = app.current_user_id()
         or app.owns_recipient(care_recipient_id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = benefit_assessments.care_recipient_id
                      and b.organization_id = any(app.my_ops_orgs())));
create policy benefit_insert on benefit_assessments for insert
  with check (app.is_super_admin() or app.owns_recipient(care_recipient_id) or app.operates_any());

create policy sysrep_read on system_reports for select
  using (app.is_super_admin()
         or reporter_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));
create policy sysrep_insert on system_reports for insert
  with check (reporter_user_id = app.current_user_id());
create policy sysrep_update on system_reports for update
  using (app.is_super_admin()) with check (app.is_super_admin());

create policy kpi_read on kpi_daily for select
  using (app.is_super_admin()
         or organization_id = any(app.my_ops_orgs())
         or driver_id = any(app.my_driver_ids()));
create policy kpi_write on kpi_daily for all
  using (app.is_super_admin() or app.operates(organization_id))
  with check (app.is_super_admin() or app.operates(organization_id));

-- 稽核紀錄：負責人可讀自己組織的；只能新增，永遠不能改或刪
create policy audit_read on audit_events for select
  using (app.is_super_admin() or app.has_role_in(organization_id, array['owner']));
create policy audit_insert on audit_events for insert with check (true);
-- 刻意沒有 UPDATE / DELETE 政策

-- ---------------------------------------------------------------- 應用程式角色
--
-- ⚠️ Netlify Function 必須用這個角色連線。用 postgres 連線會繞過上面全部政策。

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'care_ride_app') then
    create role care_ride_app login;
  end if;
end $$;

grant usage on schema public, app to care_ride_app;
grant select, insert, update, delete on all tables in schema public to care_ride_app;
grant select on public_booking_pool to care_ride_app;
grant execute on all functions in schema app to care_ride_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to care_ride_app;

-- 憑證表完全不開放，只能走 0003 的函式
revoke all on password_credentials from care_ride_app;

-- 稽核紀錄不可竄改
revoke update, delete on audit_events from care_ride_app;
