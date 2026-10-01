-- =====================================================================
-- 0004：需求池露出伺服器計算的模糊地址、距離與車程
--
-- 預約的 serverComputed 由 Netlify Function 在寫入時產生（定位上下車地址、模糊地址、
-- 路線距離與車程、報價狀態），前端改不到。需求池只露出其中不識別個人的部分：
-- 行政區、模糊地址（路段＋門牌去尾）、距離、車程、報價狀態。
-- 完整地址、姓名、電話、經緯度一律不露出。
--
-- create or replace view 只能在最後面新增欄位，前面的欄位與 0003 完全相同。
-- =====================================================================

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
