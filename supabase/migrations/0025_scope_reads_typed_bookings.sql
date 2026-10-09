-- =====================================================================
-- 0025：行程資源歸屬、需求者看得到的承接機構改讀正式資料表（#128，ADR 0005 第 2 步）
--
-- 兩支都是純讀取：
--   app.trip_resource_scope              排車、寫行程時查預約屬於哪個機構（司機、車輛照舊）
--   app.my_booking_service_organizations 需求者看得到承接自己預約的機構名稱
-- 預約的狀態照舊看 data 裡的 state（與 app_state 的 booking_state 欄位相同）。
--
-- 撤銷承接機構、取消預約這類「讀出一列再改同一列 app_state」的函式，讀取靠鎖住那一列防止
-- 同時修改，不在這裡改，跟著寫入改接（#132）一起換。
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
  select 'booking', s.id, s.organization_id, not s.deleted, nullif(s.data->>'state', ''),
         coalesce((select array_agg(l->>'assignedOrganizationId')
                     from jsonb_array_elements(case when jsonb_typeof(s.data->'legs') = 'array'
                                                    then s.data->'legs' else '[]'::jsonb end) l
                    where coalesce(l->>'assignedOrganizationId', '') <> ''), '{}')
    from bookings s where s.id = any(coalesce(p_booking_ids, '{}'))
$$;

create or replace function app.my_booking_service_organizations()
returns table (id text, name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct o.id, o.name
    from bookings s
    join organizations o on o.id = s.organization_id
   where not s.deleted
     and s.owner_user_id = app.current_user_id()
$$;
