-- 回復 0025：兩支函式回到 0005／0006 的定義（讀 app_state）

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

create or replace function app.my_booking_service_organizations()
returns table (id text, name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct o.id, o.name
    from app_state s
    join organizations o on o.id = s.organization_id
   where s.collection = 'bookings'
     and not s.deleted
     and s.owner_user_id = app.current_user_id()
$$;
