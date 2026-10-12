-- 回復 0035：拿掉協力機構排車的受控路徑，trip_resource_scope 還原成 0025 的版本
drop function if exists app.apply_partner_leg_schedule(text, text, text, text);
drop function if exists app.partner_lock_booking(text);
CREATE OR REPLACE FUNCTION app.trip_resource_scope(p_driver_id text, p_vehicle_id text, p_booking_ids text[])
 RETURNS TABLE(kind text, id text, organization_id text, active boolean, state text, leg_organization_ids text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
