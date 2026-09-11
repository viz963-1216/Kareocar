-- ==================== migrations/0001_schema.sql ====================
-- =====================================================================
-- 安心接送 — Postgres schema (Supabase)
--
-- 對應原本 Google Sheet 的 22 張工作表。三個刻意的設計選擇：
--
-- 1. 欄位改用英文 snake_case。前端的資料模型（bookings / requestedByUserId
--    …）本來就是英文，只有 Sheet 那一層是中文，所以這樣反而少一層翻譯。
--
-- 2. 每張主要實體表都有一個 data jsonb 欄位。原本 AppState 的 JSON 記錄比
--    正規化的 Sheet 欄位更豐富（legs、commercialSnapshots、cancellation…），
--    這些放進 data，需要查詢或授權用到的才升格成正式欄位。不會掉資料。
--
-- 3. 原本的「應用狀態」覆蓋層不再需要。它存在是因為 Sheet 沒辦法好好更新
--    一列；Postgres 直接 UPDATE 就好，版本控制交給 version / revision 欄位
--    加上真正的交易。
--
-- 身分驗證維持自有的手機＋密碼流程；Netlify Function 直連 Postgres，每筆
-- 交易先 SET LOCAL app.user_id，RLS 以此為準（見 0002_rls.sql）。
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------- 組織與身分

create table organizations (
  id              text primary key,
  org_type        text not null default 'transport_provider',
  name            text not null,
  tax_id          text,
  contact_phone   text,
  active          boolean not null default true,
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table users (
  id              text primary key,
  display_name    text not null default '',
  phone_e164      text unique,
  email           text,
  auth_provider   text,                       -- password | google | apple | facebook
  auth_subject_id text,
  active          boolean not null default true,
  platform_role   text not null default 'none',   -- none | super_admin
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint users_platform_role_check check (platform_role in ('none','super_admin'))
);
create unique index users_email_lower_idx on users (lower(email)) where email is not null and email <> '';
create index users_auth_subject_idx on users (auth_provider, auth_subject_id);

-- 密碼憑證獨立一張表：沒有任何 RLS 政策允許存取（見 0002），
-- 只能由 security definer 函式或 service role 讀取。pepper 仍在應用層環境變數。
create table password_credentials (
  user_id         text primary key references users(id) on delete cascade,
  version         int  not null default 2,
  algorithm       text not null default 'iterated-hmac-sha256-peppered',
  iterations      int  not null default 6000,
  salt            text not null,
  hash            text not null,
  updated_at      timestamptz not null default now()
);

create table memberships (
  id                  text primary key,
  user_id             text not null references users(id) on delete cascade,
  organization_id     text not null references organizations(id) on delete cascade,
  role                text not null,          -- owner | dispatcher | driver | requester
  status              text not null default 'active',
  revoked_at          timestamptz,
  revoked_by_user_id  text references users(id),
  data                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint memberships_role_check check (role in ('owner','dispatcher','driver','requester')),
  constraint memberships_status_check check (status in ('active','suspended','revoked'))
);
create index memberships_user_idx on memberships (user_id) where status = 'active';
create index memberships_org_idx  on memberships (organization_id) where status = 'active';
-- 一個組織同時只能有一位有效負責人
create unique index memberships_single_owner_idx
  on memberships (organization_id) where role = 'owner' and status = 'active';
-- 同一人在同一組織的同一角色不重複
create unique index memberships_unique_active_idx
  on memberships (user_id, organization_id, role) where status = 'active';

-- ---------------------------------------------------------------- 服務對象

create table care_recipients (
  id                   text primary key,
  display_name         text not null default '',
  birth_date           date,
  primary_phone        text,
  residence_address    text,
  mobility             text,
  wheelchair_type      text,
  needs_accessible_vehicle boolean not null default false,
  needs_escort         boolean not null default false,
  transfer_assistance  text,
  special_needs        text,
  status               text not null default 'active',
  consent_version      text,
  data                 jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 服務對象沒有組織欄位，關係人表就是它的所有權來源
create table care_recipient_contacts (
  id                text primary key,
  care_recipient_id text not null references care_recipients(id) on delete cascade,
  user_id           text references users(id) on delete cascade,
  name              text not null default '',
  relation          text,
  phone             text,
  is_primary        boolean not null default false,
  can_book          boolean not null default false,
  status            text not null default 'active',
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index crc_user_idx      on care_recipient_contacts (user_id) where status <> 'revoked';
create index crc_recipient_idx on care_recipient_contacts (care_recipient_id);

-- ---------------------------------------------------------------- 車隊

create table drivers (
  id              text primary key,
  user_id         text not null references users(id) on delete cascade,
  organization_id text not null references organizations(id) on delete cascade,
  fleet_id        text,
  duty_status     text not null default 'off_duty',
  service_area    text,
  active          boolean not null default true,
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index drivers_user_idx on drivers (user_id);
create index drivers_org_idx  on drivers (organization_id);

create table vehicles (
  id                 text primary key,
  organization_id    text not null references organizations(id) on delete cascade,
  plate              text not null,
  model              text,
  seats              int,
  wheelchair_slots   int not null default 0,
  accessible         boolean not null default false,
  status             text not null default 'available',
  data               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index vehicles_org_idx on vehicles (organization_id);

-- ---------------------------------------------------------------- 預約與行程

create table bookings (
  id                   text primary key,
  care_recipient_id    text references care_recipients(id) on delete set null,
  requested_by_user_id text references users(id) on delete set null,
  organization_id      text references organizations(id) on delete set null,  -- null = 尚未被承接
  state                text not null default 'open',
  pickup_at            timestamptz,
  pickup_address       text,
  destination          text,
  trip_type            text,
  passenger_count      int not null default 1,
  wheelchair_slots     int not null default 0,
  special_needs        text,
  rideshare_consent    boolean not null default false,
  terms_version        text,
  version              int not null default 1,     -- 樂觀鎖：承接流程用
  data                 jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint bookings_version_positive check (version >= 1)
);
create index bookings_requester_idx on bookings (requested_by_user_id);
create index bookings_org_idx       on bookings (organization_id);
create index bookings_recipient_idx on bookings (care_recipient_id);
-- 公開需求池的查詢路徑
create index bookings_open_pool_idx on bookings (pickup_at)
  where organization_id is null and state = 'open';

create table trips (
  id                text primary key,
  organization_id   text not null references organizations(id) on delete cascade,
  driver_id         text references drivers(id) on delete set null,
  vehicle_id        text references vehicles(id) on delete set null,
  state             text not null default 'scheduled',
  planned_start_at  timestamptz,
  planned_end_at    timestamptz,
  actual_start_at   timestamptz,
  actual_end_at     timestamptz,
  estimated_km      numeric(10,2),
  actual_km         numeric(10,2),
  revision          int not null default 0,       -- 樂觀鎖：多裝置同步用
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint trips_revision_nonneg check (revision >= 0)
);
create index trips_org_idx    on trips (organization_id);
create index trips_driver_idx on trips (driver_id);

create table trip_bookings (
  id                text primary key,
  trip_id           text not null references trips(id) on delete cascade,
  booking_id        text not null references bookings(id) on delete cascade,
  sequence          int not null default 1,
  actual_pickup_at  timestamptz,
  actual_dropoff_at timestamptz,
  passenger_state   text,
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (trip_id, booking_id)
);
create index trip_bookings_booking_idx on trip_bookings (booking_id);

-- ---------------------------------------------------------------- 行程衍生資料

create table service_proofs (
  id                  text primary key,
  trip_id             text not null references trips(id) on delete cascade,
  drive_file_id       text,
  signer_name         text,
  captured_at         timestamptz,
  retain_until        date,
  sha256              text,
  created_by_user_id  text references users(id),
  data                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index service_proofs_trip_idx on service_proofs (trip_id);

create table issues (
  id                  text primary key,
  trip_id             text references trips(id) on delete cascade,
  driver_id           text references drivers(id) on delete set null,
  issue_type          text,
  severity            text,
  status              text not null default 'open',
  description         text,
  resolved_at         timestamptz,
  resolved_by_user_id text references users(id),
  data                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index issues_trip_idx on issues (trip_id);

create table telemetry_events (
  id            text primary key,
  trip_id       text not null references trips(id) on delete cascade,
  event_type    text,
  latitude      numeric(10,7),
  longitude     numeric(10,7),
  eta_minutes   int,
  route_drift_m int,
  network_state text,
  description   text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index telemetry_trip_idx on telemetry_events (trip_id, created_at desc);

-- ---------------------------------------------------------------- 預約衍生資料

create table booking_events (
  id             text primary key,
  booking_id     text not null references bookings(id) on delete cascade,
  event_type     text,
  from_state     text,
  to_state       text,
  actor_user_id  text references users(id),
  reason_code    text,
  description    text,
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index booking_events_booking_idx on booking_events (booking_id, created_at desc);

create table quote_snapshots (
  id                 text primary key,
  booking_id         text not null references bookings(id) on delete cascade,
  pricing_version    text,
  estimated_gross    numeric(12,2),
  estimated_subsidy  numeric(12,2),
  estimated_copay    numeric(12,2),
  estimated_km       numeric(10,2),
  vehicle_requirement text,
  note               text,
  data               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index quote_snapshots_booking_idx on quote_snapshots (booking_id);

create table cancellations (
  id                 text primary key,
  booking_id         text not null references bookings(id) on delete cascade,
  cancelled_by_user_id text references users(id),
  cancelled_at       timestamptz not null default now(),
  from_state         text,
  reason             text,
  chargeable         boolean not null default false,
  refund_amount      numeric(12,2),
  status             text not null default 'pending',
  note               text,
  data               jsonb not null default '{}'::jsonb
);
create index cancellations_booking_idx on cancellations (booking_id);

-- ---------------------------------------------------------------- 營運

create table dispatch_plans (
  id                 text primary key,
  plan_date          date,
  organization_id    text not null references organizations(id) on delete cascade,
  booking_ids        text[] not null default '{}',
  suggested_driver_id text references drivers(id) on delete set null,
  suggested_vehicle_id text references vehicles(id) on delete set null,
  rideshare          boolean not null default false,
  efficiency_score   numeric(6,2),
  empty_km_before    numeric(10,2),
  empty_km_after     numeric(10,2),
  status             text not null default 'draft',
  rationale          text,
  data               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index dispatch_plans_org_idx on dispatch_plans (organization_id, plan_date);

create table notifications (
  id                  text primary key,
  booking_id          text references bookings(id) on delete cascade,
  trip_id             text references trips(id) on delete cascade,
  recipient_user_id   text references users(id) on delete cascade,
  channel             text,
  notification_type   text,
  status              text not null default 'pending',
  message_summary     text,
  sent_at             timestamptz,
  data                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index notifications_recipient_idx on notifications (recipient_user_id, created_at desc);

create table benefit_assessments (
  id                 text primary key,
  care_recipient_id  text references care_recipients(id) on delete cascade,
  assessed_on        date,
  cms_level          text,
  identity_category  text,
  service_items      text,
  estimated_subsidy  numeric(12,2),
  estimated_copay    numeric(12,2),
  ruleset_version    text,
  source             text,
  result             text,
  note               text,
  created_by_user_id text references users(id),
  data               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index benefit_recipient_idx on benefit_assessments (care_recipient_id);

create table system_reports (
  id                  text primary key,
  reporter_user_id    text references users(id) on delete set null,
  organization_id     text references organizations(id) on delete set null,
  issue_type          text,
  title               text,
  status              text not null default 'open',
  priority            text,
  description         text,
  resolved_at         timestamptz,
  data                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index system_reports_reporter_idx on system_reports (reporter_user_id);

create table kpi_daily (
  kpi_date           date not null,
  organization_id    text not null references organizations(id) on delete cascade,
  driver_id          text references drivers(id) on delete cascade,
  completed_trips    int not null default 0,
  empty_km           numeric(10,2),
  loaded_km          numeric(10,2),
  avg_load_factor    numeric(6,3),
  on_time_rate       numeric(6,3),
  avg_wait_minutes   numeric(8,2),
  cancel_rate        numeric(6,3),
  rideshare_rate     numeric(6,3),
  data               jsonb not null default '{}'::jsonb,
  primary key (kpi_date, organization_id, driver_id)
);

-- 稽核紀錄：只能新增，不能改也不能刪（見 0002 的政策）
create table audit_events (
  id              text primary key,
  event_type      text not null,
  actor_user_id   text references users(id) on delete set null,
  organization_id text references organizations(id) on delete set null,
  entity_type     text,
  entity_id       text,
  reason_code     text,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index audit_org_idx  on audit_events (organization_id, created_at desc);
create index audit_actor_idx on audit_events (actor_user_id, created_at desc);

-- ---------------------------------------------------------------- updated_at

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','users','memberships','care_recipients','care_recipient_contacts',
    'drivers','vehicles','bookings','trips','trip_bookings','dispatch_plans'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function app.touch_updated_at()',
      t || '_updated', t);
  end loop;
end $$;

-- ==================== migrations/0002_rls.sql ====================
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

-- ==================== migrations/0003_credentials_api.sql ====================
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

-- ==================== migrations/0004_bootstrap.sql ====================
-- =====================================================================
-- 最小可運作的初始資料
--
-- 只建立應用程式假設一定存在的東西。沒有任何示範帳號、沒有預設密碼。
-- 超級管理者請在建立之後，用 Netlify 環境變數裡的 pepper 走
-- authBootstrapSuperAdminFromProperties_ 的等價流程設定密碼。
-- =====================================================================

-- 需求者集散組織：所有自助註冊的需求者都掛在這裡，程式碼多處硬編此 ID。
insert into organizations (id, org_type, name, active)
values ('ORG-REQ-001', 'requester_hub', '需求者組織', true)
on conflict (id) do nothing;

-- =====================================================================
-- 建立超級管理者（手動執行，不要留在 migration 裡自動跑）
--
-- 1. 先在這裡建帳號（沒有密碼，登入不了）：
--
--      insert into users (id, display_name, phone_e164, platform_role, active)
--      values ('USR-ROOT-0001', '平台超級管理者', '+886900000000', 'super_admin', true);
--
-- 2. 再由應用程式呼叫 app.set_credential() 寫入密碼雜湊。雜湊必須由
--    Netlify Function 用環境變數裡的 AUTH_PASSWORD_PEPPER 算出來——
--    絕對不要在 SQL 裡放明文密碼，那會留在 Supabase 的查詢紀錄裡。
-- =====================================================================

-- ==================== migrations/0005_app_runtime.sql ====================
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

-- ==================== migrations/0006_identity_api.sql ====================
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

-- ==================== migrations/0007_app_state.sql ====================
-- =====================================================================
-- 應用狀態表：前端資料模型的權威儲存
--
-- 為什麼是一張通用表而不是攤平成欄位：
--   前端的資料模型是巢狀的（一筆預約有 locations、serviceNeeds、
--   commercialSnapshots…），而 0001 那些 typed 資料表是照 Google 試算表的
--   欄位設計的。兩邊從來就不是同一套。硬把前端記錄逐欄塞進 typed 欄位，
--   28 個集合每一個都要人工對應一次，對錯一欄就是不會報錯的資料損毀。
--
--   所以這裡忠實移植目前實際在運作的模型（Apps Script 的「應用狀態」工作表），
--   整包記錄存成 jsonb；伺服器需要自己判斷的欄位（狀態、時間、地區、組織）
--   用 generated column 從 jsonb 算出來——是「同一份資料的投影」而不是
--   「另一份要同步的副本」，所以不會有兩邊不一致的問題。
--
-- 身分相關的四個集合（users / memberships / organizations / drivers）不走這裡：
-- 它們已經有 typed 資料表，而且登入、成員資格、RLS 全都依賴那些表。寫入端會
-- 明確拒絕，避免同一件事有兩個真相。
-- =====================================================================

create table if not exists app_state (
  collection           text not null,
  id                   text not null,
  organization_id      text,
  owner_user_id        text,
  trip_id              text,
  booking_id           text,
  data                 jsonb not null default '{}'::jsonb,
  deleted              boolean not null default false,
  version              integer not null default 1,
  revision             integer not null default 0,
  updated_by_user_id   text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists app_state_owner_idx on app_state (owner_user_id) where not deleted;
create index if not exists app_state_org_idx   on app_state (organization_id) where not deleted;
create index if not exists app_state_trip_idx  on app_state (trip_id) where trip_id is not null;
create index if not exists app_state_booking_idx on app_state (booking_id) where booking_id is not null;

-- 預約的投影欄位。用 generated 而不是另外寫一張表：資料只有一份，
-- 不可能對不起來，也不需要靠寫入端記得同步。
alter table app_state
  add column if not exists booking_state text
    generated always as (nullif(data->>'state', '')) stored,
  add column if not exists pickup_at text
    generated always as (nullif(data->>'pickupDate', '')) stored;

create index if not exists app_state_pool_idx
  on app_state (collection, booking_state) where not deleted;

-- ---------------------------------------------------------------------
-- 寫入時強制決定「這筆資料屬於誰」
--
-- 這是整張表最重要的一段。範圍絕對不能相信呼叫端送什麼就是什麼——
-- 否則任何人都可以把 organizationId 改成別人的公司，或把 ownerUserId 改成
-- 自己，一步就把別人的資料變成自己的。上一輪修掉的就是這個等級的漏洞。
--
--   新增：擁有者一律是目前登入者；組織只有在你真的是那間公司的營運方時才採納
--   更新：範圍完全不可變，沿用原本那一列的值
-- ---------------------------------------------------------------------
create or replace function app.app_state_force_scope() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- 唯一可以改變組織歸屬的路徑是 app.claim_app_state_booking，它會在自己的
    -- 交易內設定這個旗標。沒有這個例外的話，承接公開案件會被下面兩行還原掉。
    if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
      new.organization_id := old.organization_id;
    end if;
    new.owner_user_id   := old.owner_user_id;
    new.created_at      := old.created_at;
    new.version         := old.version + 1;
  else
    new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
    if new.organization_id is not null
       and not (app.is_super_admin()
                or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
      new.organization_id := null;
    end if;
    new.version := greatest(1, coalesce(new.version, 1));
  end if;
  new.updated_by_user_id := coalesce(app.current_user_id(), new.updated_by_user_id);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_state_force_scope on app_state;
create trigger app_state_force_scope before insert or update on app_state
  for each row execute function app.app_state_force_scope();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table app_state enable row level security;

drop policy if exists app_state_read on app_state;
create policy app_state_read on app_state for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));
-- 注意這裡「沒有」放行未承接的公開需求。放行的話，營運方就能直接查原始表
-- 讀到完整門牌與預約者是誰——遮蔽只做在 view 上，繞過 view 就沒了。
-- 需求池改由下面那個 security definer 的 view 提供，遮蔽無法繞過。

drop policy if exists app_state_insert on app_state;
-- 範圍由觸發器決定，呼叫端寫什麼都會被覆蓋，所以這裡不需要再限制
create policy app_state_insert on app_state for insert with check (true);

drop policy if exists app_state_update on app_state;
create policy app_state_update on app_state for update
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()))
  with check (app.is_super_admin()
              or owner_user_id = app.current_user_id()
              or organization_id = any(app.my_ops_orgs()));

-- 刻意沒有 DELETE 政策：刪除一律是 deleted = true 的軟刪除，保留稽核軌跡

grant select, insert, update on app_state to care_ride_app;

-- ---------------------------------------------------------------------
-- 公開需求池：改讀 app_state，內容遮蔽到行政區
-- ---------------------------------------------------------------------
drop view if exists app_state_booking_pool;
-- 刻意「不」用 security_invoker：view 以擁有者身分執行，所以呼叫者讀不到
-- 原始表也照樣拿得到遮蔽後的結果。授權改由 view 自己的 where 條件把關。
create view app_state_booking_pool as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         s.pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     -- 需求池是給營運方瀏覽待承接需求用的。少了這一行，需求者會在池子裡
     -- 看到自己那筆（RLS 允許他讀自己的資料），跟原本「需求者看到空池」的
     -- 行為不一致，前端拿池子是否為空來決定畫面時就會怪怪的。
     and (app.is_super_admin() or app.operates_any());

grant select on app_state_booking_pool to care_ride_app;

-- ---------------------------------------------------------------------
-- 承接公開案件：交易級的搶單保護
--
-- SELECT ... FOR UPDATE 讓資料庫自己處理競爭：兩個調度員同時搶同一張單，
-- 後到的那個一定會看到已經被接走的狀態，不需要應用層的全域鎖。
-- ---------------------------------------------------------------------
create or replace function app.claim_app_state_booking(p_id text, p_organization_id text)
returns table (id text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  row_state text;
  row_org   text;
begin
  if not (app.is_super_admin()
          or app.has_role_in(p_organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限代表這個組織承接案件' using errcode = '42501';
  end if;

  select s.booking_state, s.organization_id into row_state, row_org
    from app_state s
   where s.collection = 'bookings' and s.id = p_id and not s.deleted
     for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if row_org is not null then
    raise exception '已被其他服務單位接走' using errcode = '55006';
  end if;
  if row_state is distinct from 'open' then
    raise exception '不是可承接的狀態' using errcode = '55006';
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = p_organization_id,
         data = s.data || jsonb_build_object(
                  'organizationId', p_organization_id,
                  'state', 'claimed',
                  'claimStatus', 'claimed',
                  'claimedByUserId', app.current_user_id(),
                  'claimedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where s.collection = 'bookings' and s.id = p_id;

  perform set_config('app.state_scope_override', '0', true);

  return query
    select s.id, s.organization_id, s.version
      from app_state s where s.collection = 'bookings' and s.id = p_id;
end $$;

grant execute on function app.claim_app_state_booking(text, text) to care_ride_app;

