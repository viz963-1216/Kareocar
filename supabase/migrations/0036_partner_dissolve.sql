-- =====================================================================
-- 0036：解除協力關係（#114，ADR 0004）
--
-- app.release_partner_leg   協力機構把自己那一段退回需求池（還沒排車才可以），規則與 js/lifecycle.js 的 releaseLeg
--                           相同；協力機構讀不到整筆預約，所以由這裡鎖定、寫入、記預約事件並通知承接機構
-- app.notify_booking_orgs   通知一筆預約的承接機構或協力機構的負責人與調度員。呼叫者必須是這筆預約的需求者，
--                           或承接機構、協力機構的負責人、調度員；只會通知「現在」是這筆預約承接機構或協力機構的機構
--                           （需求者修改、取消時用；解除協力關係要在寫回之前呼叫）
-- app.partner_booking_views 只列承接中、已排車的預約（取消、退回、過期後協力機構立即讀不到）
-- =====================================================================

create or replace function app.release_partner_leg(p_booking_id text, p_leg_id text)
returns table (booking_id text, primary_organization_id text, version int, leg_label text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_data  jsonb;
  v_org   text;
  v_idx   int;
  v_leg   jsonb;
  v_part  text;
  v_label text;
  v_name  text;
  v_now   text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_event text := 'bevt_' || replace(gen_random_uuid()::text, '-', '');
  v_user  text;
begin
  select s.data, s.organization_id into v_data, v_org from bookings s where s.id = p_booking_id and not s.deleted for update;
  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  select x.n - 1, x.l into v_idx, v_leg
    from jsonb_array_elements(case when jsonb_typeof(v_data->'legs') = 'array' then v_data->'legs' else '[]'::jsonb end)
         with ordinality as x(l, n)
   where x.l->>'id' = p_leg_id;
  v_part := v_leg->>'partnerOrganizationId';
  if v_leg is null or coalesce(v_leg->>'poolStatus', '') <> 'partner' or v_part is null
     or not app.has_role_in(v_part, array['owner','dispatcher']) then
    raise exception '只有負責這一段的協力機構可以退回這一段' using errcode = '42501';
  end if;
  v_label := coalesce(nullif(v_leg->>'label', ''), '這一段');
  if coalesce(v_leg->>'status', 'pending') <> 'pending' then
    raise exception '%已經排車，請先取消行程再退回需求池', v_label using errcode = 'CR400';
  end if;
  select o.name into v_name from organizations o where o.id = v_part;

  v_leg := (v_leg - 'partnerOrganizationId' - 'partnerOrganizationName' - 'partnerOrganizationPhone'
                  - 'partnerClaimedAt' - 'partnerClaimedByUserId')
           || jsonb_build_object('poolStatus', 'in_pool', 'releasedAt', v_now, 'releasedByUserId', app.current_user_id(),
                                 'releasedByOrganizationId', v_part);
  update bookings s set data = jsonb_set(s.data, array['legs', v_idx::text], v_leg) || jsonb_build_object('updatedAt', v_now)
   where s.id = p_booking_id;

  insert into app_state (collection, id, organization_id, booking_id, data)
  values ('bookingEvents', v_event, null, p_booking_id, jsonb_build_object(
    'bookingId', p_booking_id, 'eventType', 'leg_partner_released', 'action', 'leg_partner_released',
    'fromState', v_data->>'state', 'toState', v_data->>'state', 'actorUserId', app.current_user_id(), 'organizationId', v_org,
    'reasonCode', null, 'reasonText', '', 'source', 'booking_leg_endpoint',
    'metadata', jsonb_build_object('legId', p_leg_id, 'direction', v_leg->>'direction', 'label', v_label, 'partnerOrganizationId', v_part),
    'createdAt', v_now));
  perform set_config('app.state_scope_override', '1', true);
  update app_state set organization_id = v_org where collection = 'bookingEvents' and id = v_event;
  perform set_config('app.state_scope_override', '0', true);

  for v_user in
    select m.user_id from memberships m
     where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'dispatcher')
  loop
    perform app.enqueue_notification(v_user, v_org, p_booking_id, null, 'leg_partner_released', 'leg_partner_released',
      jsonb_build_object('bookingId', p_booking_id, 'legLabel', v_label, 'organizationName', coalesce(v_name, '')),
      'booking_leg_endpoint', 'leg_partner_released:' || v_event || ':' || v_user);
  end loop;

  return query select s.id, s.organization_id, s.version, v_label from bookings s where s.id = p_booking_id;
end $$;
grant execute on function app.release_partner_leg(text, text) to care_ride_app;

create or replace function app.notify_booking_orgs(p_booking_id text, p_template text, p_payload jsonb, p_org_ids text[])
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b        bookings%rowtype;
  v_orgs   text[];
  v_org    text;
  v_user   text;
  v_count  int := 0;
  v_batch  text := replace(gen_random_uuid()::text, '-', '');
begin
  select * into b from bookings s where s.id = p_booking_id and not s.deleted;
  if not found then
    return 0;
  end if;
  -- 這筆預約現在的承接機構與協力機構
  v_orgs := array_remove(array[b.organization_id] || coalesce((select array_agg(distinct l.partner_organization_id) from booking_legs l
                                                                 where l.booking_id = b.id and l.pool_status = 'partner'), '{}'), null);
  if not (app.is_super_admin()
          or b.owner_user_id = app.current_user_id()
          or b.requested_by_user_id = app.current_user_id()
          or exists (select 1 from unnest(v_orgs) o where app.has_role_in(o, array['owner','dispatcher']))) then
    raise exception '沒有權限通知這筆預約的機構' using errcode = '42501';
  end if;
  foreach v_org in array coalesce(p_org_ids, '{}') loop
    continue when not (v_org = any(v_orgs));
    for v_user in
      select m.user_id from memberships m
       where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'dispatcher')
    loop
      if app.enqueue_notification(v_user, v_org, p_booking_id, null, p_template, p_template,
           jsonb_build_object('bookingId', p_booking_id) || coalesce(p_payload, '{}'::jsonb),
           'booking_org_notice', p_template || ':' || p_booking_id || ':' || v_org || ':' || v_user || ':' || v_batch) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;
  return v_count;
end $$;
grant execute on function app.notify_booking_orgs(text, text, jsonb, text[]) to care_ride_app;

create or replace function app.partner_booking_views()
returns table (id text, organization_id text, version int, updated_at timestamptz, data jsonb)
language sql stable security definer set search_path = public, pg_temp
as $$
  select b.id, b.organization_id, b.version, b.updated_at,
         jsonb_strip_nulls(jsonb_build_object(
           'id', b.id, 'partnerView', true, 'partnerOrganizationId', l.partner_organization_id,
           'organizationId', b.organization_id, 'primaryOrganizationName', o.name, 'primaryOrganizationPhone', o.contact_phone,
           'state', b.data->'state', 'status', b.data->'status', 'claimStatus', b.data->'claimStatus', 'tripType', b.data->'tripType',
           'recipientId', b.data->'recipientId', 'name', b.data->'name', 'phone', b.data->'phone', 'contacts', b.data->'contacts',
           'passengerCount', b.data->'passengerCount', 'wheelchairSlots', b.data->'wheelchairSlots', 'aidNeed', b.data->'aidNeed',
           'companions', b.data->'companions', 'specialNeed', b.data->'specialNeed', 'serviceNeeds', b.data->'serviceNeeds',
           'poolingConsent', b.data->'poolingConsent', 'rideshareConsent', b.data->'rideshareConsent', 'note', b.data->'note',
           -- 預約上的時間與地點換成協力機構自己那一段的（回程的上下車對調）
           'pickupDate', case when l.direction = 'return' then b.data->'returnDate' else b.data->'pickupDate' end,
           'pickupTime', case when l.direction = 'return' then b.data->'returnTime' else b.data->'pickupTime' end,
           'pickupAddress', case when l.direction = 'return' then b.data->'destination' else b.data->'pickupAddress' end,
           'destination', case when l.direction = 'return' then b.data->'pickupAddress' else b.data->'destination' end,
           'legs', (select jsonb_agg(case when x.e->>'id' = l.id then x.e
                                         else jsonb_build_object('id', x.e->'id', 'direction', x.e->'direction', 'label', x.e->'label',
                                                                 'sequence', x.e->'sequence', 'maskedForPartner', true,
                                                                 'responsibleText', '由其他機構負責') end
                                     order by x.n)
                      from jsonb_array_elements(b.data->'legs') with ordinality as x(e, n))
         )) as data
    from booking_legs l
    join bookings b on b.id = l.booking_id
    join organizations o on o.id = b.organization_id
   where l.pool_status = 'partner'
     and l.partner_organization_id = any(app.my_ops_orgs())
     and not b.deleted
     and coalesce(nullif(b.data->>'state', ''), 'open') in ('claimed', 'partially_scheduled', 'scheduled')
$$;
grant execute on function app.partner_booking_views() to care_ride_app;
