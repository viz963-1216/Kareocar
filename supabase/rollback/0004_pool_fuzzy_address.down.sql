-- =====================================================================
-- 回復 0004_pool_fuzzy_address：需求池回到 0003 的欄位
--
-- create or replace view 不能刪欄位，所以先刪掉再照 0003 重建並重新授權。
-- =====================================================================

drop view app_state_booking_pool;

create view app_state_booking_pool as
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
              then (s.data->>'companions')::int else 0 end as companions
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     and (app.is_super_admin() or app.operates_any_approved());

grant select on app_state_booking_pool to care_ride_app;
