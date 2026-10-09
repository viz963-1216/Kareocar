-- 效能測試的合成資料（#125）：30 家機構、2000 位需求者與服務對象、12000 筆預約、6000 趟行程。
-- 只用在本機或 CI 的拋棄式資料庫；所有名稱、電話、地址都是合成的。
-- 參數：:scale（預設 1；資料量乘上這個倍數）
\set ON_ERROR_STOP 1
\if :{?scale}
\else
  \set scale 1
\endif

alter table app_state disable trigger app_state_force_scope;

insert into organizations (id, org_type, name, active, review_status)
select 'ORG-P-' || g, 'transport_provider', '合成機構 ' || g, true, 'approved' from generate_series(1, 30) g;

insert into users (id, display_name, phone_e164, platform_role, active)
select 'USR-PR-' || g, '合成需求者 ' || g, '+8869' || lpad(g::text, 8, '0'), 'none', true from generate_series(1, 2000 * :scale) g;
insert into users (id, display_name, phone_e164, platform_role, active)
select 'USR-PD-' || g, '合成調度 ' || g, '+8868' || lpad(g::text, 8, '0'), 'none', true from generate_series(1, 30) g;
insert into users (id, display_name, phone_e164, platform_role, active)
select 'USR-PV-' || g, '合成司機 ' || g, '+8867' || lpad(g::text, 8, '0'), 'none', true from generate_series(1, 150) g;

insert into memberships (id, user_id, organization_id, role, status)
select 'M-PR-' || g, 'USR-PR-' || g, 'ORG-REQ-001', 'requester', 'active' from generate_series(1, 2000 * :scale) g;
insert into memberships (id, user_id, organization_id, role, status)
select 'M-PD-' || g, 'USR-PD-' || g, 'ORG-P-' || g, 'dispatcher', 'active' from generate_series(1, 30) g;
insert into memberships (id, user_id, organization_id, role, status)
select 'M-PV-' || g, 'USR-PV-' || g, 'ORG-P-' || ((g - 1) % 30 + 1), 'driver', 'active' from generate_series(1, 150) g;
insert into drivers (id, user_id, organization_id, duty_status, active)
select 'DRV-P-' || g, 'USR-PV-' || g, 'ORG-P-' || ((g - 1) % 30 + 1), 'on_duty', true from generate_series(1, 150) g;

insert into app_state (collection, id, owner_user_id, data)
select 'careRecipients', 'CR-P-' || g, 'USR-PR-' || g,
       jsonb_build_object('id', 'CR-P-' || g, 'identity', jsonb_build_object('displayName', '合成長輩 ' || g),
         'addresses', jsonb_build_object('primary', '新北市板橋區文化路一段' || g || '號'),
         'governance', jsonb_build_object('createdByUserId', 'USR-PR-' || g))
  from generate_series(1, 2000 * :scale) g;

-- 預約：前 1/4 在需求池（沒有承接機構），其餘已承接；一半已排車（去程有行程）
insert into app_state (collection, id, owner_user_id, organization_id, booking_id, data)
select 'bookings', 'BKG-P-' || g, 'USR-PR-' || r, case when g % 4 = 0 then null else 'ORG-P-' || o end, 'BKG-P-' || g,
       jsonb_build_object('id', 'BKG-P-' || g, 'requestedByUserId', 'USR-PR-' || r, 'recipientId', 'CR-P-' || r,
         'state', s, 'status', s, 'claimStatus', case when g % 4 = 0 then 'open' else 'claimed' end,
         'name', '合成乘客 ' || g, 'phone', '09' || lpad(g::text, 8, '0'),
         'pickupDate', to_char(current_date + (g % 60) - 20, 'YYYY-MM-DD'), 'pickupTime', '09:00',
         'pickupAddress', '新北市板橋區文化路一段' || r || '號', 'destination', '臺北市中正區公園路20號',
         'tripType', '單程', 'passengerCount', 1, 'wheelchairSlots', 0, 'rideshareConsent', true,
         'marketExpiresAt', to_char(current_date + 30, 'YYYY-MM-DD') || 'T00:00:00.000Z',
         'legs', jsonb_build_array(jsonb_build_object('id', 'BKG-P-' || g || '_outbound', 'direction', 'outbound', 'sequence', 1,
           'label', '去程', 'status', case when s = 'scheduled' then 'scheduled' else 'pending' end,
           'tripId', case when s = 'scheduled' then 'TRP-P-' || (g / 2) end,
           'requestedPickupAt', to_char(current_date + (g % 60) - 20, 'YYYY-MM-DD') || 'T01:00:00.000Z')))
  from (select g, (g - 1) % (2000 * :scale) + 1 as r, (g - 1) % 30 + 1 as o,
               case when g % 4 = 0 then 'open' when g % 2 = 0 then 'scheduled' else 'claimed' end as s
          from generate_series(1, 12000 * :scale) g) x;

insert into app_state (collection, id, organization_id, revision, data)
select 'trips', 'TRP-P-' || g, 'ORG-P-' || ((g * 2 - 1) % 30 + 1), 1,
       jsonb_build_object('id', 'TRP-P-' || g, 'organizationId', 'ORG-P-' || ((g * 2 - 1) % 30 + 1),
         'driverId', 'DRV-P-' || ((g - 1) % 150 + 1), 'status', case when g % 3 = 0 then 'completed' else 'scheduled' end,
         'date', to_char(current_date + ((g * 2) % 60) - 20, 'YYYY-MM-DD'), 'bookingIds', jsonb_build_array('BKG-P-' || (g * 2)),
         'steps', jsonb_build_array(jsonb_build_object('type', 'pickup', 'bookingId', 'BKG-P-' || (g * 2), 'name', '合成乘客'),
                                    jsonb_build_object('type', 'dropoff', 'bookingId', 'BKG-P-' || (g * 2), 'name', '合成乘客')))
  from generate_series(1, 6000 * :scale) g;

alter table app_state enable trigger app_state_force_scope;
analyze;
