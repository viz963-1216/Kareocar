-- 回復 0031：外鍵拿掉、app_state 的欄位／索引／規則與舊接案函式回來、正式資料表的資料複製回 app_state，
-- 雙向同步恢復（0029 的定義）
set client_min_messages = warning;
alter table bookings drop constraint if exists bookings_requested_by_user_id_fkey;
alter table trips drop constraint if exists trips_driver_id_fkey;
alter table cancellations drop constraint if exists cancellations_cancelled_by_user_id_fkey;

create or replace function app.can_read_recipient_benefit(p_recipient_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or exists (select 1 from app_state s
                  where s.collection = 'careRecipients' and s.id = p_recipient_id
                    and s.owner_user_id = app.current_user_id())
      or exists (select 1 from bookings s
                  where not s.deleted
                    and s.data->>'recipientId' = p_recipient_id
                    and s.organization_id = any(app.my_ops_orgs()))
$$;

create or replace function app.can_manage_recipient_benefit(p_recipient_id text, p_organization_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or (p_organization_id is not null
          and app.has_role_in(p_organization_id, array['owner', 'dispatcher'])
          and exists (select 1 from bookings s
                       where not s.deleted
                         and s.data->>'recipientId' = p_recipient_id
                         and s.organization_id = p_organization_id))
$$;

create or replace function app.recipient_refreshable_bookings(p_recipient_id text)
returns table (id text, pickup_date text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not app.can_refresh_recipient_benefit(p_recipient_id) then
    raise exception '只有建立這位服務對象的人可以更新預約的補助估算' using errcode = '42501';
  end if;
  return query
    select b.id, b.data->>'pickupDate'
      from bookings b
     where not b.deleted and b.data->>'recipientId' = p_recipient_id
       and app.booking_benefit_refreshable(b.data)
     order by b.id;
end $$;

drop policy if exists benefit_read on benefit_assessments;
create policy benefit_read on benefit_assessments for select
  using (app.is_super_admin()
         or created_by_user_id = app.current_user_id()
         or exists (select 1 from app_state s
                     where s.collection = 'careRecipients' and s.id = benefit_assessments.care_recipient_id
                       and s.owner_user_id = app.current_user_id())
         or exists (select 1 from app_state s
                     where s.collection = 'bookings' and not s.deleted
                       and s.data->>'recipientId' = benefit_assessments.care_recipient_id
                       and s.organization_id = any(app.my_ops_orgs())));

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

alter table app_state
  add column booking_state text generated always as (nullif(data->>'state', '')) stored,
  add column pickup_at text generated always as (nullif(data->>'pickupDate', '')) stored;
create index if not exists app_state_pool_idx
  on app_state (collection, booking_state) where not deleted;
create policy app_state_driver_read on app_state for select
  using (collection = 'trips'
         and (organization_id || '|' || coalesce(data->>'driverId', ''))
             in (select unnest(app.my_active_driver_keys())));

-- 資料複製回 app_state（歸屬欄位照正式資料表，不經歸屬規則）
alter table app_state disable trigger app_state_force_scope;
insert into app_state (collection, id, organization_id, owner_user_id, booking_id, data, deleted, version, created_at, updated_at)
select 'bookings', id, organization_id, owner_user_id, id, data, deleted, version, created_at, updated_at from bookings
on conflict (collection, id) do nothing;
insert into app_state (collection, id, organization_id, owner_user_id, trip_id, booking_id, data, deleted, version, revision, created_at, updated_at)
select 'trips', id, organization_id, owner_user_id, id, nullif(data->>'bookingId', ''), data, deleted, coalesce(version, 1), revision, created_at, updated_at from trips
on conflict (collection, id) do nothing;
alter table app_state enable trigger app_state_force_scope;

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

create trigger app_state_sync_typed
  after insert or update or delete on app_state
  for each row execute function app.app_state_sync_typed();

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
          or t.revision is distinct from greatest(s.revision, 0) or t.version is distinct from s.version
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
