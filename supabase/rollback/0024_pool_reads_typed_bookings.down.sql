-- 回復 0024：需求池改回讀 app_state（0004 的定義）；同步與一致性檢查回到 0023 的版本，拿掉 trips.version
drop index if exists bookings_pool_idx;

create or replace view app_state_booking_pool as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         s.pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at,
         nullif(s.data->>'pickupTime', '')      as pickup_time,
         nullif(s.data->>'returnDate', '')      as return_date,
         nullif(s.data->>'returnTime', '')      as return_time,
         nullif(s.data->>'marketExpiresAt', '') as market_expires_at,
         left(nullif(s.data->>'aidNeed', ''), 20) as aid_need,
         case when coalesce(s.data->>'companions', '') ~ '^[0-9]{1,2}$'
              then (s.data->>'companions')::int else 0 end as companions,
         s.data->'serverComputed'->'pickup'->>'district'          as pickup_district,
         s.data->'serverComputed'->'pickup'->>'fuzzyAddress'      as pickup_fuzzy_address,
         s.data->'serverComputed'->'destination'->>'district'     as destination_district,
         s.data->'serverComputed'->'destination'->>'fuzzyAddress' as destination_fuzzy_address,
         case when jsonb_typeof(s.data->'serverComputed'->'distanceMeters') = 'number'
              then round((s.data->'serverComputed'->>'distanceMeters')::numeric)::int end as distance_meters,
         case when jsonb_typeof(s.data->'serverComputed'->'durationSeconds') = 'number'
              then round((s.data->'serverComputed'->>'durationSeconds')::numeric)::int end as duration_seconds,
         s.data->'serverComputed'->'quote'->>'status'            as quote_status
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     and (app.is_super_admin() or app.operates_any_approved());

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

alter table trips drop column version;
