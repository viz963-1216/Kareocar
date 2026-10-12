-- 回復 0038：需求池檢視還原成 0033 的版本，拿掉期限與過期處理
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
drop function if exists app.expire_pool_legs(timestamptz);
drop function if exists app.leg_pool_deadline(timestamptz, text);
