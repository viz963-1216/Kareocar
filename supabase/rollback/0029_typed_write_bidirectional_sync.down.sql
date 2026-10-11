-- 回復 0029：拿掉正式資料表的寫入（歸屬規則、子資料、同步回 app_state），同步回到單向（0023／0024 的定義）
drop policy if exists bookings_insert on bookings;
drop policy if exists bookings_update on bookings;
drop policy if exists trips_insert on trips;
drop policy if exists trips_update on trips;
revoke insert, update on bookings, trips from care_ride_app;

drop trigger if exists bookings_after_write on bookings;
drop trigger if exists trips_after_write on trips;
drop trigger if exists bookings_before_write on bookings;
drop trigger if exists trips_before_write on trips;
drop function if exists app.bookings_after_write();
drop function if exists app.trips_after_write();
drop function if exists app.bookings_before_write();
drop function if exists app.trips_before_write();

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
                       actual_start_at, actual_end_at, revision, data, created_at, updated_at, owner_user_id, deleted, version)
    values (s.id, s.organization_id, nullif(s.data->>'driverId', ''), nullif(s.data->>'vehicleId', ''),
            coalesce(nullif(s.data->>'status', ''), 'scheduled'),
            app.try_timestamptz(s.data->'steps'->0->>'scheduledAt'), app.try_timestamptz(s.data->'steps'->-1->>'scheduledAt'),
            app.try_timestamptz(s.data->>'startedAt'), app.try_timestamptz(s.data->>'completedAt'),
            greatest(s.revision, 0), s.data, s.created_at, s.updated_at, s.owner_user_id, s.deleted, s.version)
    on conflict (id) do update set
      organization_id = excluded.organization_id, driver_id = excluded.driver_id, vehicle_id = excluded.vehicle_id,
      state = excluded.state, planned_start_at = excluded.planned_start_at, planned_end_at = excluded.planned_end_at,
      actual_start_at = excluded.actual_start_at, actual_end_at = excluded.actual_end_at, revision = excluded.revision,
      data = excluded.data, created_at = excluded.created_at, updated_at = excluded.updated_at,
      owner_user_id = excluded.owner_user_id, deleted = excluded.deleted, version = excluded.version;

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
revoke all on function app.sync_typed_row(text, text) from public;

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
