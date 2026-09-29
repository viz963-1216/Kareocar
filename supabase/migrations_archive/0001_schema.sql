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
