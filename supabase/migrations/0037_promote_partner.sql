-- =====================================================================
-- 0037：升格（#115，ADR 0004）
--
-- app.release_leg_promote_partner：承接機構退回自己那一段，而另一段由協力機構負責時，同一筆交易內讓協力機構
--   升格為承接機構（確保每筆預約一定有承接機構）。規則與 js/lifecycle.js 的 releaseLeg（promoted）相同。
--   一般更新不能把承接機構改成別家（bookings_update 的 with check），所以由這裡改；原承接機構隨即讀不到。
--   記預約事件（升格），通知需求者（承接機構換了）與新承接機構的負責人、調度員。
-- 有協力機構時不能整筆退回或不受理：由一般預約寫入的規則（_booking-rules）擋下。
-- =====================================================================

create or replace function app.release_leg_promote_partner(p_booking_id text, p_leg_id text)
returns table (booking_id text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_data   jsonb;
  v_org    text;
  v_state  text;
  v_legs   jsonb;
  v_leg    jsonb;
  v_pleg   jsonb;
  v_idx    int;
  v_pidx   int;
  v_new    text;
  v_name   text;
  v_label  text;
  v_now    text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_event  text := 'bevt_' || replace(gen_random_uuid()::text, '-', '');
  v_user   text;
begin
  select s.data, s.organization_id, coalesce(nullif(s.data->>'state', ''), 'open') into v_data, v_org, v_state
    from bookings s where s.id = p_booking_id and not s.deleted for update;
  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if v_org is null or not app.has_role_in(v_org, array['owner','dispatcher']) then
    raise exception '只有承接機構的負責人或調度員可以退回這一段' using errcode = '42501';
  end if;
  if coalesce(v_data->>'tripType', '') <> '來回' or coalesce(v_data->>'splitLegConsent', '') <> 'true'
     or v_state not in ('claimed', 'partially_scheduled') then
    raise exception '這筆預約不能只退回其中一段' using errcode = 'CR400';
  end if;
  v_legs := case when jsonb_typeof(v_data->'legs') = 'array' then v_data->'legs' else '[]'::jsonb end;
  select x.n - 1, x.l into v_idx, v_leg from jsonb_array_elements(v_legs) with ordinality x(l, n) where x.l->>'id' = p_leg_id;
  if v_leg is null or coalesce(nullif(v_leg->>'poolStatus', ''), 'primary') <> 'primary' then
    raise exception '這一段不是由承接機構負責' using errcode = 'CR400';
  end if;
  if coalesce(v_leg->>'status', 'pending') <> 'pending' then
    raise exception '這一段已經排車或已取消，不能退回需求池' using errcode = 'CR400';
  end if;
  select x.n - 1, x.l into v_pidx, v_pleg from jsonb_array_elements(v_legs) with ordinality x(l, n)
   where x.l->>'id' <> p_leg_id and x.l->>'poolStatus' = 'partner' limit 1;
  if v_pleg is null then
    raise exception '另一段沒有協力機構，不需要升格' using errcode = 'CR400';
  end if;
  v_new := v_pleg->>'partnerOrganizationId';
  v_label := coalesce(nullif(v_leg->>'label', ''), '這一段');
  select o.name into v_name from organizations o where o.id = v_new;

  v_legs := jsonb_set(v_legs, array[v_idx::text],
              v_leg || jsonb_build_object('poolStatus', 'in_pool', 'releasedAt', v_now,
                                          'releasedByUserId', app.current_user_id(), 'releasedByOrganizationId', v_org));
  v_legs := jsonb_set(v_legs, array[v_pidx::text],
              v_pleg - 'poolStatus' - 'partnerOrganizationId' - 'partnerOrganizationName' - 'partnerOrganizationPhone'
                     - 'partnerClaimedAt' - 'partnerClaimedByUserId');

  perform set_config('app.state_scope_override', '1', true);
  update bookings s
     set organization_id = v_new,
         data = s.data || jsonb_build_object(
                  'legs', v_legs, 'organizationId', v_new, 'updatedAt', v_now, 'claimedAt', v_now,
                  'claimedByUserId', v_pleg->'partnerClaimedByUserId',
                  'previousOrganizationIds',
                  coalesce(case when jsonb_typeof(s.data->'previousOrganizationIds') = 'array'
                                then s.data->'previousOrganizationIds' end, '[]'::jsonb) || to_jsonb(v_org))
   where s.id = p_booking_id;

  insert into app_state (collection, id, organization_id, booking_id, data)
  values ('bookingEvents', v_event, null, p_booking_id, jsonb_build_object(
    'bookingId', p_booking_id, 'eventType', 'leg_partner_promoted', 'action', 'leg_partner_promoted',
    'fromState', v_state, 'toState', v_state, 'actorUserId', app.current_user_id(), 'organizationId', v_new,
    'reasonCode', null, 'reasonText', '', 'source', 'booking_leg_endpoint',
    'metadata', jsonb_build_object('releasedLegId', p_leg_id, 'releasedLabel', v_label,
                                   'previousOrganizationId', v_org, 'newOrganizationId', v_new),
    'createdAt', v_now));
  update app_state set organization_id = v_new where collection = 'bookingEvents' and id = v_event;
  perform set_config('app.state_scope_override', '0', true);

  perform app.notify_booking_requester(p_booking_id, 'booking_primary_changed',
    jsonb_build_object('organizationName', coalesce(v_name, ''), 'legLabel', v_label),
    'booking_leg_endpoint', 'primary_changed:' || v_event);
  for v_user in
    select m.user_id from memberships m
     where m.organization_id = v_new and m.status = 'active' and m.role in ('owner', 'dispatcher')
  loop
    perform app.enqueue_notification(v_user, v_new, p_booking_id, null, 'leg_partner_promoted', 'leg_partner_promoted',
      jsonb_build_object('bookingId', p_booking_id, 'legLabel', v_label),
      'booking_leg_endpoint', 'leg_partner_promoted:' || v_event || ':' || v_user);
  end loop;

  return query select s.id, s.organization_id, s.version from bookings s where s.id = p_booking_id;
end $$;
grant execute on function app.release_leg_promote_partner(text, text) to care_ride_app;
