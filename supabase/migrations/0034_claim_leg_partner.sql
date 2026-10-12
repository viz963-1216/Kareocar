-- =====================================================================
-- 0034：接下單一段成為協力機構（#113，ADR 0004）
--
-- app.claim_booking_leg：別家接送機構從需求池接下在需求池的那一段。鎖定預約後判斷（兩家同時接只有一家成功），
--   規則與 js/lifecycle.js 的 claimLeg 相同；同一筆交易寫入那一段的協力機構（含名稱電話快照）、
--   預約事件（記在承接機構名下），並通知需求者與承接機構的負責人、調度員。
-- app.partner_booking_views：協力機構讀預約的唯一方式（一般的預約讀取規則仍讀不到）。只回傳服務對象與需求、
--   聯絡人、承接機構名稱與電話、自己那一段的完整時間地點；另一段只標「由其他機構負責」。
-- =====================================================================

create or replace function app.claim_booking_leg(p_booking_id text, p_leg_id text, p_organization_id text)
returns table (booking_id text, primary_organization_id text, version int, leg_label text, organization_name text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_data   jsonb;
  v_org    text;
  v_state  text;
  v_idx    int;
  v_leg    jsonb;
  v_name   text;
  v_phone  text;
  v_label  text;
  v_now    text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_event  text := 'bevt_' || replace(gen_random_uuid()::text, '-', '');
  v_user   text;
begin
  if not app.has_role_in(p_organization_id, array['owner','dispatcher']) then
    raise exception '沒有權限代表這個機構接案' using errcode = '42501';
  end if;
  select o.name, o.contact_phone into v_name, v_phone from organizations o
   where o.id = p_organization_id and o.active and o.org_type in ('transport_provider','care_facility')
     and o.review_status = 'approved';
  if not found then
    raise exception '此機構不是可接案的有效接送機構，或尚未通過平台審核' using errcode = '42501';
  end if;

  select s.data, s.organization_id, coalesce(nullif(s.data->>'state', ''), 'open') into v_data, v_org, v_state
    from bookings s where s.id = p_booking_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if v_org is null or v_state not in ('claimed', 'partially_scheduled') then
    raise exception '預約不在承接中，不能接下其中一段' using errcode = '55006';
  end if;
  if v_org = p_organization_id then
    raise exception '承接機構不能接下自己退回的段，請用收回' using errcode = 'CR400';
  end if;

  select x.n - 1, x.l into v_idx, v_leg
    from jsonb_array_elements(case when jsonb_typeof(v_data->'legs') = 'array' then v_data->'legs' else '[]'::jsonb end)
         with ordinality as x(l, n)
   where x.l->>'id' = p_leg_id;
  if not found then
    raise exception '找不到這一段' using errcode = 'P0002';
  end if;
  v_label := coalesce(nullif(v_leg->>'label', ''), '這一段');
  if coalesce(nullif(v_leg->>'poolStatus', ''), 'primary') = 'partner' then
    raise exception '%已經有其他機構接下', v_label using errcode = '55006';
  end if;
  if coalesce(nullif(v_leg->>'poolStatus', ''), 'primary') <> 'in_pool' then
    raise exception '%不在需求池', v_label using errcode = '55006';
  end if;

  v_leg := (v_leg - 'releasedAt' - 'releasedByUserId' - 'releasedByOrganizationId')
           || jsonb_build_object('poolStatus', 'partner', 'partnerOrganizationId', p_organization_id,
                                 'partnerOrganizationName', coalesce(v_name, ''), 'partnerOrganizationPhone', coalesce(v_phone, ''),
                                 'partnerClaimedAt', v_now, 'partnerClaimedByUserId', app.current_user_id());
  update bookings s set data = jsonb_set(s.data, array['legs', v_idx::text], v_leg) || jsonb_build_object('updatedAt', v_now)
   where s.id = p_booking_id;

  -- 預約事件記在承接機構名下（讀取依預約現在的承接機構，見 0028）
  insert into app_state (collection, id, organization_id, booking_id, data)
  values ('bookingEvents', v_event, null, p_booking_id, jsonb_build_object(
    'bookingId', p_booking_id, 'eventType', 'leg_partner_claimed', 'action', 'leg_partner_claimed',
    'fromState', v_state, 'toState', v_state, 'actorUserId', app.current_user_id(), 'organizationId', v_org,
    'reasonCode', null, 'reasonText', '', 'source', 'booking_leg_endpoint',
    'metadata', jsonb_build_object('legId', p_leg_id, 'direction', v_leg->>'direction', 'label', v_label,
                                   'partnerOrganizationId', p_organization_id, 'partnerOrganizationName', coalesce(v_name, '')),
    'createdAt', v_now));
  perform set_config('app.state_scope_override', '1', true);
  update app_state set organization_id = v_org where collection = 'bookingEvents' and id = v_event;
  perform set_config('app.state_scope_override', '0', true);

  -- 通知需求者、承接機構的負責人與調度員
  perform app.notify_booking_requester(p_booking_id, 'booking_leg_partner_claimed',
    jsonb_build_object('legLabel', v_label, 'organizationName', coalesce(v_name, '')),
    'booking_leg_endpoint', 'leg_partner:' || p_booking_id || ':' || p_leg_id || ':' || p_organization_id);
  for v_user in
    select m.user_id from memberships m
     where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'dispatcher')
  loop
    perform app.enqueue_notification(v_user, v_org, p_booking_id, null, 'leg_partner_claimed', 'leg_partner_claimed',
      jsonb_build_object('bookingId', p_booking_id, 'legLabel', v_label, 'organizationName', coalesce(v_name, ''),
                         'organizationPhone', coalesce(v_phone, '')),
      'booking_leg_endpoint', 'leg_partner_ops:' || p_booking_id || ':' || p_leg_id || ':' || p_organization_id || ':' || v_user);
  end loop;

  return query
    select s.id, s.organization_id, s.version, v_label, coalesce(v_name, '') from bookings s where s.id = p_booking_id;
end $$;
grant execute on function app.claim_booking_leg(text, text, text) to care_ride_app;

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
$$;
grant execute on function app.partner_booking_views() to care_ride_app;
