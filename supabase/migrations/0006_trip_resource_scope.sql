-- =====================================================================
-- 0006：行程寫入時查司機、車輛、預約屬於哪個機構
--
-- v2-trip-write 要確認行程指派的司機、車輛與關聯的預約都屬於行程的機構。呼叫者在 RLS 下
-- 看不到別家機構的資料，看不到就分不出「不存在」還是「屬於別人」，所以這裡用
-- security definer 函式只回傳歸屬機構與狀態，不回傳任何個資。
-- =====================================================================

create or replace function app.trip_resource_scope(
  p_driver_id text, p_vehicle_id text, p_booking_ids text[])
returns table (kind text, id text, organization_id text, active boolean, state text, leg_organization_ids text[])
language sql stable security definer set search_path = public, pg_temp
as $$
  select 'driver', d.id, d.organization_id, d.active, null::text, null::text[]
    from drivers d where d.id = p_driver_id
  union all
  select 'vehicle', s.id, s.organization_id, not s.deleted, null::text, null::text[]
    from app_state s where s.collection = 'vehicles' and s.id = p_vehicle_id
  union all
  select 'booking', s.id, s.organization_id, not s.deleted, s.booking_state,
         coalesce((select array_agg(l->>'assignedOrganizationId')
                     from jsonb_array_elements(case when jsonb_typeof(s.data->'legs') = 'array'
                                                    then s.data->'legs' else '[]'::jsonb end) l
                    where coalesce(l->>'assignedOrganizationId', '') <> ''), '{}')
    from app_state s where s.collection = 'bookings' and s.id = any(coalesce(p_booking_ids, '{}'))
$$;

grant execute on function app.trip_resource_scope(text, text, text[]) to care_ride_app;
