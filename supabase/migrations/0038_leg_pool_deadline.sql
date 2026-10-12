-- =====================================================================
-- 0038：單一段的接案期限與「沒有機構承接」（#116，ADR 0004）
--
-- app.leg_pool_deadline       那段接送時間前 30 分鐘（與整筆預約相同的提前量）；退回時已經過了就到接送時間為止。
--                             與 js/lifecycle.js 的 legPoolDeadline 相同
-- app.expire_pool_legs        過了期限還在需求池的段標示「沒有機構承接」（unclaimed），另一段與預約狀態不變；
--                             記預約事件、通知需求者與承接機構的負責人、調度員。只有系統排程（不帶登入者）或
--                             平台管理者可以執行；排程是 Netlify 的 leg-pool-expire（每 15 分鐘）
-- 需求池檢視：單一段的 market_expires_at 是這個期限；期限已過的段即使排程還沒跑也不列出
-- =====================================================================

create or replace function app.leg_pool_deadline(p_pickup timestamptz, p_released_at text)
returns timestamptz
language sql stable set search_path = public, pg_temp
as $$
  select case
    when p_pickup is null then null
    when app.try_timestamptz(p_released_at) is null
      or p_pickup - interval '30 minutes' > app.try_timestamptz(p_released_at) then p_pickup - interval '30 minutes'
    else p_pickup
  end
$$;

create or replace function app.expire_pool_legs(p_now timestamptz default now())
returns table (booking_id text, leg_id text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r       record;
  v_data  jsonb;
  v_idx   int;
  v_leg   jsonb;
  v_label text;
  v_now   text := to_char(p_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_event text;
  v_user  text;
begin
  if app.current_user_id() is not null and not app.is_super_admin() then
    raise exception '只有系統排程或平台超級管理者可以處理過期的單一段' using errcode = '42501';
  end if;
  for r in
    select l.booking_id as bid, l.id as lid, b.organization_id as org
      from booking_legs l join bookings b on b.id = l.booking_id
     where l.pool_status = 'in_pool' and not b.deleted
       and app.leg_pool_deadline(l.requested_pickup_at, l.data->>'releasedAt') <= p_now
     order by l.booking_id, l.id
  loop
    select s.data into v_data from bookings s where s.id = r.bid for update skip locked;
    continue when v_data is null;
    select x.n - 1, x.l into v_idx, v_leg
      from jsonb_array_elements(case when jsonb_typeof(v_data->'legs') = 'array' then v_data->'legs' else '[]'::jsonb end)
           with ordinality as x(l, n)
     where x.l->>'id' = r.lid;
    continue when v_leg is null or coalesce(v_leg->>'poolStatus', '') <> 'in_pool';
    v_label := coalesce(nullif(v_leg->>'label', ''), '這一段');
    v_event := 'bevt_' || replace(gen_random_uuid()::text, '-', '');
    update bookings s set data = jsonb_set(s.data, array['legs', v_idx::text],
                                           v_leg || jsonb_build_object('poolStatus', 'unclaimed', 'unclaimedAt', v_now))
                                 || jsonb_build_object('updatedAt', v_now)
     where s.id = r.bid;

    insert into app_state (collection, id, organization_id, booking_id, data)
    values ('bookingEvents', v_event, r.org, r.bid, jsonb_build_object(
      'bookingId', r.bid, 'eventType', 'leg_unclaimed', 'action', 'leg_unclaimed',
      'fromState', v_data->>'state', 'toState', v_data->>'state', 'actorUserId', null, 'organizationId', r.org,
      'reasonCode', 'leg_pool_expired', 'reasonText', '', 'source', 'leg_pool_expire',
      'metadata', jsonb_build_object('legId', r.lid, 'direction', v_leg->>'direction', 'label', v_label),
      'createdAt', v_now));

    perform app.notify_booking_requester(r.bid, 'booking_leg_unclaimed', jsonb_build_object('legLabel', v_label),
      'leg_pool_expire', 'leg_unclaimed:' || r.bid || ':' || r.lid || ':' || v_now);
    for v_user in
      select m.user_id from memberships m
       where m.organization_id = r.org and m.status = 'active' and m.role in ('owner', 'dispatcher')
    loop
      perform app.enqueue_notification(v_user, r.org, r.bid, null, 'leg_unclaimed', 'leg_unclaimed',
        jsonb_build_object('bookingId', r.bid, 'legLabel', v_label),
        'leg_pool_expire', 'leg_unclaimed_ops:' || v_event || ':' || v_user);
    end loop;

    booking_id := r.bid; leg_id := r.lid;
    return next;
  end loop;
end $$;
grant execute on function app.expire_pool_legs(timestamptz) to care_ride_app;

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
         to_char(app.leg_pool_deadline(l.requested_pickup_at, l.data->>'releasedAt') at time zone 'utc',
                 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as market_expires_at,
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
     and coalesce(app.leg_pool_deadline(l.requested_pickup_at, l.data->>'releasedAt') > now(), true)
     and not (s.organization_id = any(app.my_ops_orgs()))
     and (app.is_super_admin() or app.operates_any_approved());
