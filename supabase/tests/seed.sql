-- 測試資料。以 postgres 身分執行（擁有者會繞過 RLS，這裡正是我們要的）。
truncate app_state,
         audit_events, kpi_daily, system_reports, benefit_assessments, notifications,
         dispatch_plans, cancellations, quote_snapshots, booking_events, telemetry_events,
         issues, service_proofs, trip_bookings, trips, bookings, vehicles, drivers,
         care_recipient_contacts, care_recipients, memberships,
         users, organizations cascade;

insert into organizations (id, org_type, name) values
  ('ORG-REQ-001','requester_hub','需求者組織'),
  ('ORG-TP-001','transport_provider','安馨福祉交通'),
  ('ORG-TP-002','transport_provider','樂行車隊');

insert into users (id, display_name, phone_e164, platform_role) values
  ('USR-VICTIM','受害需求者','+886912000001','none'),
  ('USR-ATTACK','攻擊者',    '+886912000002','none'),
  ('USR-DISP1', 'A隊調度',   '+886912000003','none'),
  ('USR-DRV1',  'A隊司機',   '+886912000004','none'),
  ('USR-OWN2',  'B隊負責人', '+886912000005','none'),
  ('USR-ROOT',  '平台管理者','+886912000009','super_admin');

insert into memberships (id, user_id, organization_id, role) values
  ('M-V','USR-VICTIM','ORG-REQ-001','requester'),
  ('M-A','USR-ATTACK','ORG-REQ-001','requester'),
  ('M-D','USR-DISP1', 'ORG-TP-001','dispatcher'),
  ('M-R','USR-DRV1',  'ORG-TP-001','driver'),
  ('M-O','USR-OWN2',  'ORG-TP-002','owner');

insert into drivers (id, user_id, organization_id) values
  ('DRV-1','USR-DRV1','ORG-TP-001');

insert into care_recipients (id, display_name, residence_address) values
  ('CR-1','王阿嬤','台北市大安區復興南路一段100號');

insert into care_recipient_contacts (id, care_recipient_id, user_id, name, relation) values
  ('CRC-1','CR-1','USR-VICTIM','受害需求者','子女');

-- 預約與行程存在正式資料表（ADR 0005）。以 postgres（資料庫擁有者）寫入時不套用歸屬規則，保留指定的機構與擁有者。
insert into bookings (id, owner_user_id, organization_id, version, data) values
  ('BKG-VICTIM','USR-VICTIM','ORG-TP-001', 3,
   '{"id":"BKG-VICTIM","recipientId":"CR-1","requestedByUserId":"USR-VICTIM","state":"claimed","status":"claimed","pickupAddress":"台北市大安區復興南路一段100號","destination":"台北市中正區公園路20號"}'),
  ('BKG-OPEN','USR-VICTIM', null, 1,
   '{"id":"BKG-OPEN","recipientId":"CR-1","requestedByUserId":"USR-VICTIM","state":"open","status":"open","pickupAddress":"新北市板橋區文化路二段50號","destination":"台北市士林區中山北路五段99號"}');
insert into trips (id, organization_id, revision, data) values
  ('TRIP-1','ORG-TP-001', 2,
   '{"id":"TRIP-1","organizationId":"ORG-TP-001","driverId":"DRV-1","status":"scheduled","bookingIds":["BKG-VICTIM"]}');

insert into audit_events (id, event_type, actor_user_id, organization_id) values
  ('AUD-1','booking.created','USR-VICTIM','ORG-TP-001');

