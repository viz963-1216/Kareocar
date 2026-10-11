-- =====================================================================
-- 0033：來回預約的一段退回需求池（#112，ADR 0004）
--
-- 去程／回程多兩個欄位（由觸發器從 data.legs 帶出）：
--   pool_status              primary（承接機構負責）／in_pool（在需求池）／partner（協力機構負責）／unclaimed（沒有機構承接）
--   partner_organization_id  協力機構（#113 起使用）
-- 需求池的檢視多列出「在需求池的單一段」：只有那一段的模糊欄位，加上 leg_id 與 leg_direction 標示
-- 只有去程／只有回程；承接機構自己的需求池不列出自己退回的段。整筆的那一列這兩欄是空的。
-- 退回、收回走專用端點 v2-booking-leg，規則在 js/lifecycle.js（releaseLeg／reclaimLeg）。
-- =====================================================================

alter table booking_legs
  add column pool_status text not null default 'primary',
  add column partner_organization_id text;
alter table booking_legs add constraint booking_legs_pool_status_check
  check (pool_status in ('primary', 'in_pool', 'partner', 'unclaimed'));
create index booking_legs_in_pool_idx on booking_legs (booking_id) where pool_status = 'in_pool';

CREATE OR REPLACE FUNCTION app.bookings_after_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from booking_legs where booking_id = new.id;
  insert into booking_legs (booking_id, id, direction, sequence, status, scheduled_organization_id, trip_id,
                            requested_pickup_at, scheduled_at, data, pool_status, partner_organization_id)
  select new.id, coalesce(nullif(l->>'id', ''), new.id || '#' || n), l->>'direction', app.try_int(l->>'sequence', n::int),
         coalesce(nullif(l->>'status', ''), 'pending'), nullif(l->>'scheduledOrganizationId', ''), nullif(l->>'tripId', ''),
         app.try_timestamptz(l->>'requestedPickupAt'), app.try_timestamptz(l->>'scheduledAt'), l,
         coalesce(nullif(l->>'poolStatus', ''), 'primary'), nullif(l->>'partnerOrganizationId', '')
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

update booking_legs set pool_status = coalesce(nullif(data->>'poolStatus', ''), 'primary'),
                        partner_organization_id = nullif(data->>'partnerOrganizationId', '')
 where coalesce(nullif(data->>'poolStatus', ''), 'primary') <> 'primary' or nullif(data->>'partnerOrganizationId', '') is not null;

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
         s.data->'serverComputed'->'quote'->>'status'            as quote_status,
         null::text as leg_id,
         null::text as leg_direction
    from bookings s
   where not s.deleted
     and s.organization_id is null
     and nullif(s.data->>'state', '') = 'open'
     and (app.is_super_admin() or app.operates_any_approved())
  union all
  -- 承接機構退回需求池的單一段（#112，ADR 0004）：只給那一段的模糊欄位，回程的上下車對調、用回程時間
  select s.id,
         app.approx_area(case when l.direction = 'return' then s.data->>'destination' else s.data->>'pickupAddress' end) as pickup_area,
         app.approx_area(case when l.direction = 'return' then s.data->>'pickupAddress' else s.data->>'destination' end) as destination_area,
         nullif(case when l.direction = 'return' then s.data->>'returnDate' else s.data->>'pickupDate' end, '') as pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at,
         nullif(case when l.direction = 'return' then s.data->>'returnTime' else s.data->>'pickupTime' end, '') as pickup_time,
         null::text as return_date,
         null::text as return_time,
         null::text as market_expires_at,
         left(nullif(s.data->>'aidNeed', ''), 20) as aid_need,
         case when coalesce(s.data->>'companions', '') ~ '^[0-9]{1,2}$'
              then (s.data->>'companions')::int else 0 end as companions,
         s.data->'serverComputed'->(case when l.direction = 'return' then 'destination' else 'pickup' end)->>'district'     as pickup_district,
         s.data->'serverComputed'->(case when l.direction = 'return' then 'destination' else 'pickup' end)->>'fuzzyAddress' as pickup_fuzzy_address,
         s.data->'serverComputed'->(case when l.direction = 'return' then 'pickup' else 'destination' end)->>'district'     as destination_district,
         s.data->'serverComputed'->(case when l.direction = 'return' then 'pickup' else 'destination' end)->>'fuzzyAddress' as destination_fuzzy_address,
         case when jsonb_typeof(s.data->'serverComputed'->'distanceMeters') = 'number'
              then round((s.data->'serverComputed'->>'distanceMeters')::numeric)::int end as distance_meters,
         case when jsonb_typeof(s.data->'serverComputed'->'durationSeconds') = 'number'
              then round((s.data->'serverComputed'->>'durationSeconds')::numeric)::int end as duration_seconds,
         s.data->'serverComputed'->'quote'->>'status'            as quote_status,
         l.id        as leg_id,
         l.direction as leg_direction
    from bookings s
    join booking_legs l on l.booking_id = s.id
   where not s.deleted
     and s.organization_id is not null
     and nullif(s.data->>'state', '') in ('claimed', 'partially_scheduled')
     and l.pool_status = 'in_pool'
     and not (s.organization_id = any(app.my_ops_orgs()))
     and (app.is_super_admin() or app.operates_any_approved());
