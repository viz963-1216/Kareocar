-- =====================================================================
-- 0035：協力機構排自己那一段（#113，ADR 0004）
--
-- 協力機構讀不到整筆預約，也不能用一般寫入改它，所以排車（v2-schedule-trips）多一條受控的路徑：
--   app.partner_lock_booking       協力機構鎖定預約、取得完整內容，只用來判斷（js/lifecycle.js 的 scheduleBookingLeg），
--                                  不回給前端
--   app.apply_partner_leg_schedule 只把協力機構自己那一段標成已排車（行程必須屬於協力機構），並依去程／回程重算預約狀態
-- app.trip_resource_scope 的 leg_organization_ids 改列協力機構（原本的平台指定機構已移除，#110），
-- 行程的資源歸屬檢查因此認得「這筆預約有一段由行程的機構負責」。
-- 一趟行程仍只屬於一家機構。
-- =====================================================================

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
         coalesce((select array_agg(distinct l.partner_organization_id)
                     from booking_legs l
                    where l.booking_id = s.id and l.pool_status = 'partner' and l.partner_organization_id is not null), '{}')
    from bookings s where s.id = any(coalesce(p_booking_ids, '{}'))
$function$;

create or replace function app.partner_lock_booking(p_booking_id text)
returns table (data jsonb, organization_id text, version int)
language sql security definer set search_path = public, pg_temp
as $$
  select s.data, s.organization_id, s.version
    from bookings s
   where s.id = p_booking_id and not s.deleted
     and exists (select 1 from booking_legs l
                  where l.booking_id = s.id and l.pool_status = 'partner'
                    and l.partner_organization_id = any(app.my_ops_orgs()))
     for update
$$;
grant execute on function app.partner_lock_booking(text) to care_ride_app;

create or replace function app.apply_partner_leg_schedule(p_booking_id text, p_leg_id text, p_trip_id text, p_at text)
returns table (version int, state text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_data  jsonb;
  v_idx   int;
  v_leg   jsonb;
  v_org   text;
  v_legs  jsonb;
  v_all   boolean;
  v_to    text;
  v_first text;
begin
  select s.data into v_data from bookings s where s.id = p_booking_id and not s.deleted for update;
  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  select x.n - 1, x.l into v_idx, v_leg
    from jsonb_array_elements(case when jsonb_typeof(v_data->'legs') = 'array' then v_data->'legs' else '[]'::jsonb end)
         with ordinality as x(l, n)
   where x.l->>'id' = p_leg_id;
  if not found then
    raise exception '找不到這一段' using errcode = 'P0002';
  end if;
  v_org := v_leg->>'partnerOrganizationId';
  if coalesce(v_leg->>'poolStatus', '') <> 'partner' or v_org is null
     or not app.has_role_in(v_org, array['owner','dispatcher']) then
    raise exception '沒有權限排這一段' using errcode = '42501';
  end if;
  if coalesce(v_leg->>'status', 'pending') <> 'pending' then
    raise exception '這一段已經排車或不能再排車' using errcode = '55006';
  end if;
  if not exists (select 1 from trips t where t.id = p_trip_id and t.organization_id = v_org and not t.deleted) then
    raise exception '行程必須屬於負責這一段的協力機構' using errcode = '42501';
  end if;

  v_legs := jsonb_set(v_data->'legs', array[v_idx::text],
              v_leg || jsonb_build_object('status', 'scheduled', 'tripId', p_trip_id,
                                          'scheduledOrganizationId', v_org, 'scheduledAt', p_at));
  -- 與 js/lifecycle.js 的 scheduleBookingLeg 相同：每一段都排好才是已排車
  select bool_and(e->>'status' = 'scheduled') into v_all from jsonb_array_elements(v_legs) e;
  v_to := case when v_all then 'scheduled' else 'partially_scheduled' end;
  select e->>'tripId' into v_first from jsonb_array_elements(v_legs) with ordinality x(e, n)
   where e->>'status' = 'scheduled' and coalesce(e->>'tripId', '') <> '' order by n limit 1;

  update bookings s
     set data = s.data || jsonb_build_object('legs', v_legs, 'state', v_to, 'status', v_to, 'claimStatus', 'claimed',
                                             'tripId', v_first, 'updatedAt', p_at)
                       || case when coalesce(s.data->>'state', '') <> v_to then jsonb_build_object('stateChangedAt', p_at) else '{}'::jsonb end
                       || case when v_all then jsonb_build_object('scheduledAt', p_at) else '{}'::jsonb end
   where s.id = p_booking_id;
  return query select s.version, v_to from bookings s where s.id = p_booking_id;
end $$;
grant execute on function app.apply_partner_leg_schedule(text, text, text, text) to care_ride_app;
