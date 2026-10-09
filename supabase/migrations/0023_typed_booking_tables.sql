-- =====================================================================
-- 0023：預約與行程搬到正式資料表——擴充（#126，ADR 0005 第 1 步）
--
-- baseline 早就有 bookings、trips、trip_bookings、cancellations，但 API 一直存在 app_state。
-- 這一步讓正式資料表跟著 app_state 同步，行為完全不變：
--   - 寫入 app_state 的預約、行程時，觸發器同步一份到正式資料表；既有資料一次回填
--   - 去程／回程獨立一張 booking_legs（跨機構排車要用 RLS 只開放其中一段，ADR 0004）
--   - 取消紀錄由已取消預約的欄位產生
--   - 正式資料表的讀取規則與 app_state 等價；寫入只走同步，care_ride_app 只能讀
--   - app.typed_sync_diff() 列出兩邊不一致的地方（測試與部署檢查用）
--
-- 跟 baseline 結構的差別：
--   - 預約→服務對象、行程→車輛不設外鍵：服務對象與車輛仍在 app_state，正式表是空的
--   - 預約→需求者、行程→司機、取消→取消的人、行程與預約關聯→預約，這一步先不設外鍵：
--     同步絕對不能讓原本成功的寫入失敗。收斂（#133）確認資料都對得上之後再加
--   - 行程與預約關聯改以「行程＋預約＋段」為一筆（同一趟可能載同一筆預約的兩段）
--   - 新增 owner_user_id、deleted：讀取規則與 app_state 相同要用到
-- =====================================================================

-- ---------------------------------------------------------------- 安全轉型

-- 轉不了就回 null，不讓同步失敗
create or replace function app.try_timestamptz(p text) returns timestamptz
language plpgsql stable
as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return p::timestamptz;
exception when others then
  return null;
end $$;

create or replace function app.try_int(p text, p_default int) returns int
language sql immutable
as $$ select case when p ~ '^-?[0-9]{1,9}$' then p::int else p_default end $$;

-- 預約的接送時間：pickupDate＋pickupTime，以台灣時間解讀
create or replace function app.booking_pickup_at(p_data jsonb) returns timestamptz
language sql stable
as $$
  select app.try_timestamptz(
    nullif(p_data->>'pickupDate', '') || ' ' || coalesce(nullif(p_data->>'pickupTime', ''), '00:00') || ' Asia/Taipei')
$$;

-- ---------------------------------------------------------------- 結構

-- 舊的讀寫規則以 app.can_see_booking／can_see_trip 判斷（requested_by_user_id、trip_bookings），
-- 跟 app_state 的規則不一樣；換成等價的規則
drop policy if exists bookings_read on bookings;
drop policy if exists bookings_insert on bookings;
drop policy if exists bookings_update on bookings;
drop policy if exists trips_read on trips;
drop policy if exists trips_write on trips;
drop policy if exists trips_update on trips;
drop policy if exists tb_read on trip_bookings;
drop policy if exists tb_write on trip_bookings;
drop policy if exists cancels_read on cancellations;
drop policy if exists cancels_insert on cancellations;
drop policy if exists cancels_update on cancellations;

alter table bookings drop constraint bookings_care_recipient_id_fkey;
alter table bookings drop constraint bookings_requested_by_user_id_fkey;
alter table bookings
  add column owner_user_id     text,
  add column market_expires_at timestamptz,
  add column deleted           boolean not null default false;
create index bookings_owner_idx on bookings (owner_user_id);

alter table trips drop constraint trips_vehicle_id_fkey;
alter table trips drop constraint trips_driver_id_fkey;
alter table trips alter column organization_id drop not null;
alter table trips
  add column owner_user_id text,
  add column deleted       boolean not null default false;

alter table trip_bookings drop constraint trip_bookings_booking_id_fkey;
alter table trip_bookings drop constraint trip_bookings_trip_id_booking_id_key;
alter table trip_bookings add column leg_id text;

alter table cancellations drop constraint cancellations_cancelled_by_user_id_fkey;

create table booking_legs (
  booking_id                text not null references bookings(id) on delete cascade,
  id                        text not null,
  direction                 text,
  sequence                  int,
  status                    text not null default 'pending',
  scheduled_organization_id text,
  trip_id                   text,
  requested_pickup_at       timestamptz,
  scheduled_at              timestamptz,
  data                      jsonb not null default '{}'::jsonb,
  primary key (booking_id, id)
);
create index booking_legs_trip_idx on booking_legs (trip_id);
create index booking_legs_org_idx  on booking_legs (scheduled_organization_id);
alter table booking_legs enable row level security;

-- 只能讀；寫入只走同步（下面的 security definer 函式）
revoke insert, update, delete on bookings, trips, trip_bookings, cancellations, booking_legs from care_ride_app;
grant select on bookings, trips, trip_bookings, cancellations, booking_legs to care_ride_app;

-- ---------------------------------------------------------------- 讀取規則（與 app_state 等價）

create policy bookings_read on bookings for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));

create policy trips_read on trips for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or (organization_id || '|' || coalesce(driver_id, '')) in (select unnest(app.my_active_driver_keys())));

-- 子資料跟著上層：看得到預約／行程才看得到（子查詢同樣受上層的 RLS 限制）
create policy booking_legs_read on booking_legs for select
  using (exists (select 1 from bookings b where b.id = booking_legs.booking_id));
create policy cancels_read on cancellations for select
  using (exists (select 1 from bookings b where b.id = cancellations.booking_id));
create policy tb_read on trip_bookings for select
  using (exists (select 1 from trips t where t.id = trip_bookings.trip_id));

-- ---------------------------------------------------------------- 同步

-- 把 app_state 的一筆預約或行程同步到正式資料表（找不到就刪掉正式資料表那一筆）
create or replace function app.sync_typed_row(p_collection text, p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s app_state%rowtype;
begin
  select * into s from app_state where collection = p_collection and id = p_id;

  if p_collection = 'bookings' then
    if not found then
      delete from bookings where id = p_id;
      return;
    end if;
    insert into bookings (id, care_recipient_id, requested_by_user_id, organization_id, state, pickup_at,
                          pickup_address, destination, trip_type, passenger_count, wheelchair_slots, special_needs,
                          rideshare_consent, terms_version, version, data, created_at, updated_at,
                          owner_user_id, market_expires_at, deleted)
    values (s.id, nullif(s.data->>'recipientId', ''), nullif(s.data->>'requestedByUserId', ''), s.organization_id,
            coalesce(nullif(s.data->>'state', ''), 'open'), app.booking_pickup_at(s.data),
            s.data->>'pickupAddress', s.data->>'destination', s.data->>'tripType',
            app.try_int(s.data->>'passengerCount', 1), app.try_int(s.data->>'wheelchairSlots', 0),
            s.data->>'specialNeeds', coalesce(s.data->>'rideshareConsent', '') = 'true', s.data->>'termsVersion',
            greatest(s.version, 1), s.data, s.created_at, s.updated_at,
            s.owner_user_id, app.try_timestamptz(s.data->>'marketExpiresAt'), s.deleted)
    on conflict (id) do update set
      care_recipient_id = excluded.care_recipient_id, requested_by_user_id = excluded.requested_by_user_id,
      organization_id = excluded.organization_id, state = excluded.state, pickup_at = excluded.pickup_at,
      pickup_address = excluded.pickup_address, destination = excluded.destination, trip_type = excluded.trip_type,
      passenger_count = excluded.passenger_count, wheelchair_slots = excluded.wheelchair_slots,
      special_needs = excluded.special_needs, rideshare_consent = excluded.rideshare_consent,
      terms_version = excluded.terms_version, version = excluded.version, data = excluded.data,
      created_at = excluded.created_at, updated_at = excluded.updated_at, owner_user_id = excluded.owner_user_id,
      market_expires_at = excluded.market_expires_at, deleted = excluded.deleted;

    delete from booking_legs where booking_id = s.id;
    insert into booking_legs (booking_id, id, direction, sequence, status, scheduled_organization_id, trip_id,
                              requested_pickup_at, scheduled_at, data)
    select s.id, coalesce(nullif(l->>'id', ''), s.id || '#' || n), l->>'direction', app.try_int(l->>'sequence', n::int),
           coalesce(nullif(l->>'status', ''), 'pending'), nullif(l->>'scheduledOrganizationId', ''), nullif(l->>'tripId', ''),
           app.try_timestamptz(l->>'requestedPickupAt'), app.try_timestamptz(l->>'scheduledAt'), l
      from jsonb_array_elements(case when jsonb_typeof(s.data->'legs') = 'array' then s.data->'legs' else '[]'::jsonb end)
           with ordinality as x(l, n)
     where jsonb_typeof(l) = 'object'
    on conflict (booking_id, id) do nothing;

    if coalesce(s.data->>'state', '') = 'cancelled' then
      insert into cancellations (id, booking_id, cancelled_by_user_id, cancelled_at, from_state, reason, status, note, data)
      values ('CXL-' || s.id, s.id, nullif(s.data->>'cancelledByUserId', ''),
              coalesce(app.try_timestamptz(s.data->>'cancelledAt'), s.updated_at), nullif(s.data->>'cancelledFromState', ''),
              nullif(s.data->>'cancelReasonCode', ''), 'completed', nullif(s.data->>'cancelReasonText', ''),
              jsonb_build_object('cancelledTripIds', coalesce(s.data->'cancelledTripIds', '[]'::jsonb)))
      on conflict (id) do update set
        cancelled_by_user_id = excluded.cancelled_by_user_id, cancelled_at = excluded.cancelled_at,
        from_state = excluded.from_state, reason = excluded.reason, note = excluded.note, data = excluded.data;
    else
      delete from cancellations where booking_id = s.id;
    end if;

  elsif p_collection = 'trips' then
    if not found then
      delete from trips where id = p_id;
      return;
    end if;
    insert into trips (id, organization_id, driver_id, vehicle_id, state, planned_start_at, planned_end_at,
                       actual_start_at, actual_end_at, revision, data, created_at, updated_at, owner_user_id, deleted)
    values (s.id, s.organization_id, nullif(s.data->>'driverId', ''), nullif(s.data->>'vehicleId', ''),
            coalesce(nullif(s.data->>'status', ''), 'scheduled'),
            app.try_timestamptz(s.data->'steps'->0->>'scheduledAt'), app.try_timestamptz(s.data->'steps'->-1->>'scheduledAt'),
            app.try_timestamptz(s.data->>'startedAt'), app.try_timestamptz(s.data->>'completedAt'),
            greatest(s.revision, 0), s.data, s.created_at, s.updated_at, s.owner_user_id, s.deleted)
    on conflict (id) do update set
      organization_id = excluded.organization_id, driver_id = excluded.driver_id, vehicle_id = excluded.vehicle_id,
      state = excluded.state, planned_start_at = excluded.planned_start_at, planned_end_at = excluded.planned_end_at,
      actual_start_at = excluded.actual_start_at, actual_end_at = excluded.actual_end_at, revision = excluded.revision,
      data = excluded.data, created_at = excluded.created_at, updated_at = excluded.updated_at,
      owner_user_id = excluded.owner_user_id, deleted = excluded.deleted;

    delete from trip_bookings where trip_id = s.id;
    -- 有 bookingLegRefs 用它（每一段一筆），沒有就用 bookingIds（段不明）
    insert into trip_bookings (id, trip_id, booking_id, leg_id, sequence)
    select s.id || '|' || r.booking_id || '|' || coalesce(r.leg_id, ''), s.id, r.booking_id, r.leg_id, min(r.n)::int
      from (
        select nullif(ref->>'bookingId', '') as booking_id, nullif(ref->>'legId', '') as leg_id, n
          from jsonb_array_elements(case when jsonb_typeof(s.data->'bookingLegRefs') = 'array'
                                         then s.data->'bookingLegRefs' else '[]'::jsonb end) with ordinality as x(ref, n)
         where jsonb_typeof(ref) = 'object'
        union all
        select b #>> '{}', null, n
          from jsonb_array_elements(case when jsonb_typeof(s.data->'bookingIds') = 'array'
                                         then s.data->'bookingIds' else '[]'::jsonb end) with ordinality as y(b, n)
         where jsonb_typeof(b) = 'string'
           and not coalesce(jsonb_typeof(s.data->'bookingLegRefs') = 'array' and jsonb_array_length(s.data->'bookingLegRefs') > 0, false)
      ) r
     where r.booking_id is not null
     group by r.booking_id, r.leg_id;
  end if;
end $$;

create or replace function app.app_state_sync_typed() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(new.collection, old.collection) not in ('bookings', 'trips')
     and (tg_op <> 'UPDATE' or old.collection not in ('bookings', 'trips')) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    perform app.sync_typed_row(old.collection, old.id);
    return old;
  end if;
  if tg_op = 'UPDATE' and (old.id, old.collection) is distinct from (new.id, new.collection) then
    perform app.sync_typed_row(old.collection, old.id);
  end if;
  perform app.sync_typed_row(new.collection, new.id);
  return new;
end $$;

create trigger app_state_sync_typed
  after insert or update or delete on app_state
  for each row execute function app.app_state_sync_typed();

-- ---------------------------------------------------------------- 一致性檢查

-- 兩邊不一致的地方；沒有回傳任何一列就是一致
create or replace function app.typed_sync_diff()
returns table (kind text, id text, problem text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select 'booking', s.id, '正式資料表沒有這筆預約'
    from app_state s where s.collection = 'bookings' and not exists (select 1 from bookings b where b.id = s.id)
  union all
  select 'booking', b.id, 'app_state 沒有這筆預約'
    from bookings b where not exists (select 1 from app_state s where s.collection = 'bookings' and s.id = b.id)
  union all
  select 'booking', s.id, '欄位不一致'
    from app_state s join bookings b on b.id = s.id
   where s.collection = 'bookings'
     and (b.data is distinct from s.data or b.organization_id is distinct from s.organization_id
          or b.owner_user_id is distinct from s.owner_user_id or b.deleted is distinct from s.deleted
          or b.version is distinct from greatest(s.version, 1)
          or b.state is distinct from coalesce(nullif(s.data->>'state', ''), 'open'))
  union all
  select 'booking_legs', s.id, '段數不一致'
    from app_state s
   where s.collection = 'bookings'
     and (select count(*) from booking_legs l where l.booking_id = s.id)
         <> (select count(*) from jsonb_array_elements(case when jsonb_typeof(s.data->'legs') = 'array' then s.data->'legs' else '[]'::jsonb end) e
              where jsonb_typeof(e) = 'object')
  union all
  select 'trip', s.id, '正式資料表沒有這趟行程'
    from app_state s where s.collection = 'trips' and not exists (select 1 from trips t where t.id = s.id)
  union all
  select 'trip', t.id, 'app_state 沒有這趟行程'
    from trips t where not exists (select 1 from app_state s where s.collection = 'trips' and s.id = t.id)
  union all
  select 'trip', s.id, '欄位不一致'
    from app_state s join trips t on t.id = s.id
   where s.collection = 'trips'
     and (t.data is distinct from s.data or t.organization_id is distinct from s.organization_id
          or t.owner_user_id is distinct from s.owner_user_id or t.deleted is distinct from s.deleted
          or t.revision is distinct from greatest(s.revision, 0)
          or t.driver_id is distinct from nullif(s.data->>'driverId', ''))
  union all
  select 'trip_bookings', s.id, '行程與預約關聯不一致'
    from app_state s
   where s.collection = 'trips'
     and (select count(distinct tb.booking_id) from trip_bookings tb where tb.trip_id = s.id)
         <> (select count(distinct x) from (
               select r->>'bookingId' as x from jsonb_array_elements(case when jsonb_typeof(s.data->'bookingLegRefs') = 'array' then s.data->'bookingLegRefs' else '[]'::jsonb end) r
                where jsonb_typeof(r) = 'object' and coalesce(r->>'bookingId', '') <> ''
               union
               select b #>> '{}' from jsonb_array_elements(case when jsonb_typeof(s.data->'bookingIds') = 'array' then s.data->'bookingIds' else '[]'::jsonb end) b
                where jsonb_typeof(b) = 'string') q)
  union all
  select 'cancellation', s.id, '已取消的預約沒有取消紀錄'
    from app_state s
   where s.collection = 'bookings' and s.data->>'state' = 'cancelled'
     and not exists (select 1 from cancellations c where c.booking_id = s.id)
$$;
revoke all on function app.typed_sync_diff() from public;
revoke all on function app.sync_typed_row(text, text) from public;

-- ---------------------------------------------------------------- 回填

select app.sync_typed_row(collection, id) from app_state where collection in ('bookings', 'trips');
