-- 回復 0036：拿掉協力機構退回與通知機構的函式，協力機構的檢視還原成 0034 的版本
drop function if exists app.notify_booking_orgs(text, text, jsonb, text[]);
drop function if exists app.release_partner_leg(text, text);
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
