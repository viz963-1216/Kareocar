-- =====================================================================
-- 0029：預約與行程可以直接寫正式資料表——雙向同步（#132，ADR 0005 第 3 步的基礎）
--
-- 寫入路徑要一支一支改到正式資料表，改的過程中每一步都要全綠，所以同步改成雙向：
--   - 寫 bookings／trips：同步回 app_state（還沒改的讀取者、收斂前的備份）
--   - 寫 app_state：照舊同步到 bookings／trips（還沒改的寫入者）
-- 兩邊用 app.typed_sync_in_progress 旗標避免互相觸發成迴圈。收斂（#133）拿掉兩個方向。
--
-- 正式資料表套用與 app_state 相同的歸屬規則（app.app_state_force_scope）：
--   新增：擁有者是目前登入者；機構只有營運方（或平台管理者）能指定，否則清空
--   更新：機構不能改（app.state_scope_override 例外，接案、撤銷用）；擁有者、建立時間不變；版本 +1
-- 衍生欄位（狀態、接送時間、司機…）一律由 data 算出，寫入者只要給 data。
-- 寫入權限與 app_state 相同：新增不限（範圍由觸發器決定）、更新限本人／營運方／平台管理者。
-- =====================================================================

-- ---------------------------------------------------------------- 寫入前：歸屬規則與衍生欄位

create or replace function app.bookings_before_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.typed_sync_in_progress', true), '') <> '1' then
    if tg_op = 'UPDATE' then
      if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
        new.organization_id := old.organization_id;
      end if;
      new.owner_user_id := old.owner_user_id;
      new.created_at    := old.created_at;
      new.version       := old.version + 1;
    else
      new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
      if new.organization_id is not null
         and not (app.is_super_admin() or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
        new.organization_id := null;
      end if;
      new.version    := greatest(1, coalesce(new.version, 1));
      new.created_at := coalesce(new.created_at, now());
    end if;
    new.updated_at := now();
  end if;
  new.care_recipient_id    := nullif(new.data->>'recipientId', '');
  new.requested_by_user_id := nullif(new.data->>'requestedByUserId', '');
  new.state                := coalesce(nullif(new.data->>'state', ''), 'open');
  new.pickup_at            := app.booking_pickup_at(new.data);
  new.pickup_address       := new.data->>'pickupAddress';
  new.destination          := new.data->>'destination';
  new.trip_type            := new.data->>'tripType';
  new.passenger_count      := app.try_int(new.data->>'passengerCount', 1);
  new.wheelchair_slots     := app.try_int(new.data->>'wheelchairSlots', 0);
  new.special_needs        := new.data->>'specialNeeds';
  new.rideshare_consent    := coalesce(new.data->>'rideshareConsent', '') = 'true';
  new.terms_version        := new.data->>'termsVersion';
  new.market_expires_at    := app.try_timestamptz(new.data->>'marketExpiresAt');
  return new;
end $$;

create or replace function app.trips_before_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.typed_sync_in_progress', true), '') <> '1' then
    if tg_op = 'UPDATE' then
      if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
        new.organization_id := old.organization_id;
      end if;
      new.owner_user_id := old.owner_user_id;
      new.created_at    := old.created_at;
      new.version       := coalesce(old.version, 0) + 1;
    else
      new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
      if new.organization_id is not null
         and not (app.is_super_admin() or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
        new.organization_id := null;
      end if;
      new.version    := greatest(1, coalesce(new.version, 1));
      new.created_at := coalesce(new.created_at, now());
    end if;
    new.updated_at := now();
  end if;
  new.driver_id        := nullif(new.data->>'driverId', '');
  new.vehicle_id       := nullif(new.data->>'vehicleId', '');
  new.state            := coalesce(nullif(new.data->>'status', ''), 'scheduled');
  new.planned_start_at := app.try_timestamptz(new.data->'steps'->0->>'scheduledAt');
  new.planned_end_at   := app.try_timestamptz(new.data->'steps'->-1->>'scheduledAt');
  new.actual_start_at  := app.try_timestamptz(new.data->>'startedAt');
  new.actual_end_at    := app.try_timestamptz(new.data->>'completedAt');
  return new;
end $$;

create trigger bookings_before_write before insert or update on bookings
  for each row execute function app.bookings_before_write();
create trigger trips_before_write before insert or update on trips
  for each row execute function app.trips_before_write();

-- ---------------------------------------------------------------- 寫入後：子資料與同步回 app_state

create or replace function app.bookings_after_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_guard text := coalesce(current_setting('app.typed_sync_in_progress', true), '');
  v_scope text := coalesce(current_setting('app.state_scope_override', true), '');
begin
  delete from booking_legs where booking_id = new.id;
  insert into booking_legs (booking_id, id, direction, sequence, status, scheduled_organization_id, trip_id,
                            requested_pickup_at, scheduled_at, data)
  select new.id, coalesce(nullif(l->>'id', ''), new.id || '#' || n), l->>'direction', app.try_int(l->>'sequence', n::int),
         coalesce(nullif(l->>'status', ''), 'pending'), nullif(l->>'scheduledOrganizationId', ''), nullif(l->>'tripId', ''),
         app.try_timestamptz(l->>'requestedPickupAt'), app.try_timestamptz(l->>'scheduledAt'), l
    from jsonb_array_elements(case when jsonb_typeof(new.data->'legs') = 'array' then new.data->'legs' else '[]'::jsonb end)
         with ordinality as x(l, n)
   where jsonb_typeof(l) = 'object'
  on conflict (booking_id, id) do nothing;

  if coalesce(new.data->>'state', '') = 'cancelled' then
    insert into cancellations (id, booking_id, cancelled_by_user_id, cancelled_at, from_state, reason, status, note, data)
    values ('CXL-' || new.id, new.id, nullif(new.data->>'cancelledByUserId', ''),
            coalesce(app.try_timestamptz(new.data->>'cancelledAt'), new.updated_at), nullif(new.data->>'cancelledFromState', ''),
            nullif(new.data->>'cancelReasonCode', ''), 'completed', nullif(new.data->>'cancelReasonText', ''),
            jsonb_build_object('cancelledTripIds', coalesce(new.data->'cancelledTripIds', '[]'::jsonb)))
    on conflict (id) do update set
      cancelled_by_user_id = excluded.cancelled_by_user_id, cancelled_at = excluded.cancelled_at,
      from_state = excluded.from_state, reason = excluded.reason, note = excluded.note, data = excluded.data;
  else
    delete from cancellations where booking_id = new.id;
  end if;

  if v_guard <> '1' then
    perform set_config('app.typed_sync_in_progress', '1', true);
    perform set_config('app.state_scope_override', '1', true);
    -- 先更新再新增：insert … on conflict 會先跑 app_state 的新增歸屬規則，把非營運方送來的機構清掉
    update app_state set organization_id = new.organization_id, data = new.data, deleted = new.deleted
     where collection = 'bookings' and id = new.id;
    if not found then
      insert into app_state (collection, id, organization_id, owner_user_id, booking_id, data, deleted, version, created_at)
      values ('bookings', new.id, new.organization_id, new.owner_user_id, new.id, new.data, new.deleted, new.version, new.created_at);
    end if;
    perform set_config('app.state_scope_override', v_scope, true);
    perform set_config('app.typed_sync_in_progress', v_guard, true);
  end if;
  return new;
end $$;

create or replace function app.trips_after_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_guard text := coalesce(current_setting('app.typed_sync_in_progress', true), '');
  v_scope text := coalesce(current_setting('app.state_scope_override', true), '');
begin
  delete from trip_bookings where trip_id = new.id;
  insert into trip_bookings (id, trip_id, booking_id, leg_id, sequence)
  select new.id || '|' || r.booking_id || '|' || coalesce(r.leg_id, ''), new.id, r.booking_id, r.leg_id, min(r.n)::int
    from (
      select nullif(ref->>'bookingId', '') as booking_id, nullif(ref->>'legId', '') as leg_id, n
        from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingLegRefs') = 'array'
                                       then new.data->'bookingLegRefs' else '[]'::jsonb end) with ordinality as x(ref, n)
       where jsonb_typeof(ref) = 'object'
      union all
      select b #>> '{}', null, n
        from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingIds') = 'array'
                                       then new.data->'bookingIds' else '[]'::jsonb end) with ordinality as y(b, n)
       where jsonb_typeof(b) = 'string'
         and not coalesce(jsonb_typeof(new.data->'bookingLegRefs') = 'array' and jsonb_array_length(new.data->'bookingLegRefs') > 0, false)
    ) r
   where r.booking_id is not null
   group by r.booking_id, r.leg_id;

  if v_guard <> '1' then
    perform set_config('app.typed_sync_in_progress', '1', true);
    perform set_config('app.state_scope_override', '1', true);
    update app_state set organization_id = new.organization_id, data = new.data, deleted = new.deleted,
           revision = new.revision, booking_id = coalesce(nullif(new.data->>'bookingId', ''), booking_id)
     where collection = 'trips' and id = new.id;
    if not found then
      insert into app_state (collection, id, organization_id, owner_user_id, trip_id, booking_id, data, deleted, version, revision, created_at)
      values ('trips', new.id, new.organization_id, new.owner_user_id, new.id, nullif(new.data->>'bookingId', ''), new.data,
              new.deleted, new.version, new.revision, new.created_at);
    end if;
    perform set_config('app.state_scope_override', v_scope, true);
    perform set_config('app.typed_sync_in_progress', v_guard, true);
  end if;
  return new;
end $$;

create trigger bookings_after_write after insert or update on bookings
  for each row execute function app.bookings_after_write();
create trigger trips_after_write after insert or update on trips
  for each row execute function app.trips_after_write();

-- ---------------------------------------------------------------- app_state → 正式資料表（0023 的同步改用上面的觸發器）

-- 只寫主表：衍生欄位由寫入前觸發器算，子資料由寫入後觸發器產生；旗標讓兩者不改歸屬、不同步回 app_state
create or replace function app.sync_typed_row(p_collection text, p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s app_state%rowtype;
  v_guard text := coalesce(current_setting('app.typed_sync_in_progress', true), '');
begin
  select * into s from app_state where collection = p_collection and id = p_id;
  perform set_config('app.typed_sync_in_progress', '1', true);
  if p_collection = 'bookings' then
    if not found then
      delete from bookings where id = p_id;
    else
      insert into bookings (id, organization_id, owner_user_id, data, deleted, version, created_at, updated_at)
      values (s.id, s.organization_id, s.owner_user_id, s.data, s.deleted, greatest(s.version, 1), s.created_at, s.updated_at)
      on conflict (id) do update set
        organization_id = excluded.organization_id, owner_user_id = excluded.owner_user_id, data = excluded.data,
        deleted = excluded.deleted, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at;
    end if;
  elsif p_collection = 'trips' then
    if not found then
      delete from trips where id = p_id;
    else
      insert into trips (id, organization_id, owner_user_id, data, deleted, version, revision, created_at, updated_at)
      values (s.id, s.organization_id, s.owner_user_id, s.data, s.deleted, s.version, greatest(s.revision, 0), s.created_at, s.updated_at)
      on conflict (id) do update set
        organization_id = excluded.organization_id, owner_user_id = excluded.owner_user_id, data = excluded.data,
        deleted = excluded.deleted, version = excluded.version, revision = excluded.revision,
        created_at = excluded.created_at, updated_at = excluded.updated_at;
    end if;
  end if;
  perform set_config('app.typed_sync_in_progress', v_guard, true);
end $$;
revoke all on function app.sync_typed_row(text, text) from public;

-- 正式資料表同步回來的寫入不要再同步過去
create or replace function app.app_state_sync_typed() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.typed_sync_in_progress', true), '') = '1' then
    return coalesce(new, old);
  end if;
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

-- ---------------------------------------------------------------- 寫入權限（與 app_state 相同）

grant insert, update on bookings, trips to care_ride_app;

create policy bookings_insert on bookings for insert with check (true);
create policy bookings_update on bookings for update
  using (app.is_super_admin() or owner_user_id = app.current_user_id() or organization_id = any(app.my_ops_orgs()))
  with check (app.is_super_admin() or owner_user_id = app.current_user_id() or organization_id = any(app.my_ops_orgs()));

create policy trips_insert on trips for insert with check (true);
create policy trips_update on trips for update
  using (app.is_super_admin() or owner_user_id = app.current_user_id() or organization_id = any(app.my_ops_orgs()))
  with check (app.is_super_admin() or owner_user_id = app.current_user_id() or organization_id = any(app.my_ops_orgs()));
