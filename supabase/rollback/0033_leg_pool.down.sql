-- 回復 0033：需求池檢視、預約的去程／回程觸發器還原成 0031 的版本，拿掉需求池欄位
-- 拿掉欄位只能刪掉重建：先記下授權，重建後照原樣補回
create temp table _pool_grants as
  select grantee, privilege_type from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'app_state_booking_pool' and grantee <> current_user;
drop view app_state_booking_pool;
create or replace view app_state_booking_pool as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         nullif(s.data->>'pickupDate', '') as pickup_at,
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
    from bookings s
   where not s.deleted
     and s.organization_id is null
     and nullif(s.data->>'state', '') = 'open'
     and (app.is_super_admin() or app.operates_any_approved());
do $$
declare g record;
begin
  for g in select * from _pool_grants loop
    execute format('grant %s on app_state_booking_pool to %I', g.privilege_type, g.grantee);
  end loop;
end $$;
drop table _pool_grants;

CREATE OR REPLACE FUNCTION app.bookings_after_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  return new;
end $function$;

drop index if exists booking_legs_in_pool_idx;
alter table booking_legs drop constraint if exists booking_legs_pool_status_check;
alter table booking_legs drop column pool_status, drop column partner_organization_id;
