-- =====================================================================
-- 0007：通知只能由後端建立（#25）
--
-- 通知從 app_state 搬到 notifications 資料表：
--   - 只有 security definer 函式寫得進去（app.enqueue_notification）；care_ride_app 對這張表
--     只有 SELECT，前端經任何端點都無法建立、修改、刪除通知
--   - 收件人只讀得到自己的通知（平台管理者例外）
--   - dedupe_key 讓同一事件重試時不會重複通知
--
-- 產生通知的流程：承接（claim-booking）、排車（booking-write）、司機指派與改派（trip-write）、
-- 需求者取消（本檔的 cancel 函式）、行程完成（trip-execute）。
--
-- booking_id／trip_id 的外鍵指向尚未使用的 bookings／trips 資料表（預約與行程目前在
-- app_state，見 #43），所以先拿掉；收件人外鍵保留。
-- =====================================================================

alter table notifications drop constraint if exists notifications_booking_id_fkey;
alter table notifications drop constraint if exists notifications_trip_id_fkey;
alter table notifications
  add column organization_id text references organizations(id) on delete set null,
  add column template        text,
  add column event_type      text,
  add column payload         jsonb not null default '{}'::jsonb,
  add column source          text,
  add column dedupe_key      text;
create unique index notifications_dedupe_idx on notifications (dedupe_key);

drop policy if exists notif_read on notifications;
drop policy if exists notif_insert on notifications;
create policy notif_read on notifications for select
  using (app.is_super_admin() or recipient_user_id = app.current_user_id());
revoke insert, update, delete on notifications from care_ride_app;

-- ---------------------------------------------------------------------
-- 1. 建立通知（只給後端流程呼叫）
-- ---------------------------------------------------------------------
create or replace function app.enqueue_notification(
  p_recipient_user_id text, p_organization_id text, p_booking_id text, p_trip_id text,
  p_template text, p_event_type text, p_payload jsonb, p_source text, p_dedupe_key text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id text;
begin
  if p_recipient_user_id is null
     or not exists (select 1 from users u where u.id = p_recipient_user_id) then
    return null;
  end if;
  v_id := 'ntf_' || replace(gen_random_uuid()::text, '-', '');
  insert into notifications (id, booking_id, trip_id, recipient_user_id, channel, notification_type,
                             status, organization_id, template, event_type, payload, source, dedupe_key)
  values (v_id, p_booking_id, p_trip_id, p_recipient_user_id, 'in_app', p_template,
          'queued', p_organization_id, p_template, p_event_type, coalesce(p_payload, '{}'::jsonb),
          p_source, p_dedupe_key)
  on conflict (dedupe_key) do nothing;
  if not found then
    return null;
  end if;
  return v_id;
end $$;

grant execute on function app.enqueue_notification(text, text, text, text, text, text, jsonb, text, text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 2. 通知預約的需求者（呼叫者不一定讀得到預約，例如司機完成行程時）
-- ---------------------------------------------------------------------
create or replace function app.notify_booking_requester(
  p_booking_id text, p_template text, p_payload jsonb, p_source text, p_dedupe_key text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b app_state%rowtype;
begin
  select * into b from app_state s
   where s.collection = 'bookings' and s.id = p_booking_id and not s.deleted;
  if not found then
    return null;
  end if;
  return app.enqueue_notification(
    coalesce(nullif(b.data->>'requestedByUserId', ''), b.owner_user_id),
    coalesce(b.organization_id, 'ORG-REQ-001'), p_booking_id, null,
    p_template, p_template,
    jsonb_build_object('bookingId', p_booking_id,
                       'pickupDate', b.data->>'pickupDate', 'pickupTime', b.data->>'pickupTime')
      || coalesce(p_payload, '{}'::jsonb),
    p_source, p_dedupe_key);
end $$;

grant execute on function app.notify_booking_requester(text, text, jsonb, text, text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 3. 既有的系統通知搬過來（有後端來源證明的才搬；前端自己寫的不搬）
-- ---------------------------------------------------------------------
insert into notifications (id, booking_id, trip_id, recipient_user_id, channel, notification_type,
                           status, organization_id, template, event_type, payload, source, dedupe_key, created_at)
select s.id, s.booking_id, s.trip_id, p.recipient_user_id, coalesce(s.data->>'channel', 'in_app'),
       s.data->>'template', coalesce(s.data->>'status', 'queued'), s.organization_id,
       s.data->>'template', s.data->>'eventType', coalesce(s.data->'payload', '{}'::jsonb),
       p.source, 'legacy:' || s.id, s.created_at
  from app_state s
  join app.notification_provenance p on p.notification_id = s.id
 where s.collection = 'notifications'
   and exists (select 1 from users u where u.id = p.recipient_user_id)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 4. 需求者取消：與 0005 相同，通知改寫入 notifications 資料表
-- ---------------------------------------------------------------------
create or replace function app.cancel_app_state_booking(
  p_booking_id text, p_reason_code text, p_reason_text text)
returns table (out_booking_id text, out_cancelled_trip_ids text[], out_notification_ids text[])
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  b         app_state%rowtype;
  st        text;
  t         record;
  t_status  text;
  trip_ids  text[] := '{}';
  ntf_ids   text[] := '{}';
  ntf_id    text;
  ntf_data  jsonb;
  proof_id  text;
  ntf_org   text;
  drv_user  text;
  recipient text;
  now_iso   text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  reason    text := left(btrim(coalesce(p_reason_text, '')), 500);
  code      text := left(btrim(coalesce(p_reason_code, '')), 60);
begin
  select * into b
    from app_state s
   where s.collection = 'bookings' and s.id = p_booking_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到預約' using errcode = 'P0002';
  end if;
  if b.owner_user_id is distinct from app.current_user_id()
     or not app.has_role_in('ORG-REQ-001', array['requester']) then
    raise exception '只能取消自己的預約' using errcode = '42501';
  end if;
  if code = '' then
    raise exception '請選擇取消原因' using errcode = 'CR400';
  end if;
  st := coalesce(nullif(b.data->>'state', ''), 'open');
  if st not in ('open', 'claimed', 'partially_scheduled', 'scheduled') then
    raise exception '此預約目前不可取消' using errcode = 'CR400';
  end if;

  for t in
    select s.id, s.data
      from app_state s
     where s.collection = 'trips'
       and not s.deleted
       and (s.booking_id = p_booking_id
            or (jsonb_typeof(s.data->'bookingIds') = 'array'
                and s.data->'bookingIds' ? p_booking_id))
     order by s.id
       for update
  loop
    t_status := coalesce(nullif(t.data->>'status', ''), 'scheduled');
    continue when t_status = 'cancelled';
    if t_status <> 'scheduled' then
      raise exception '行程已開始或已結束，無法由需求者取消' using errcode = 'CR400';
    end if;
    if jsonb_typeof(t.data->'bookingIds') = 'array'
       and jsonb_array_length(t.data->'bookingIds') > 1 then
      raise exception '共乘行程需由調度處理取消' using errcode = 'CR400';
    end if;
    update app_state s
       set data = app.redact_trip_pii(s.data) || jsonb_build_object(
                    'status', 'cancelled',
                    'piiRedactedAt', now_iso,
                    'cancelledAt', now_iso,
                    'stateChangedAt', now_iso,
                    'updatedAt', now_iso,
                    'cancelledByUserId', app.current_user_id(),
                    'cancelReason', reason,
                    'cancelReasonCode', 'booking_cancelled'),
           revision = s.revision + 1
     where s.collection = 'trips' and s.id = t.id;
    trip_ids := trip_ids || t.id;
  end loop;

  update app_state s
     set data = s.data || jsonb_build_object(
                  'state', 'cancelled',
                  'claimStatus', 'cancelled',
                  'status', 'cancelled',
                  'cancelledAt', now_iso,
                  'stateChangedAt', now_iso,
                  'updatedAt', now_iso,
                  'cancelledByUserId', app.current_user_id(),
                  'cancelReasonCode', code,
                  'cancelReasonText', reason,
                  'cancelledTripIds', to_jsonb(trip_ids))
   where s.collection = 'bookings' and s.id = p_booking_id;

  if jsonb_typeof(b.data->'legs') = 'array' then
    update app_state s
       set data = jsonb_set(s.data, '{legs}',
                    (select coalesce(jsonb_agg(l || jsonb_build_object('status', 'cancelled')), '[]'::jsonb)
                       from jsonb_array_elements(s.data->'legs') l))
     where s.collection = 'bookings' and s.id = p_booking_id;
  end if;

  -- 站內通知：寫入 notifications 資料表（0007），只寫資料列、不送出。
  -- dedupe_key 讓同一次取消重試時不會重複通知。
  for t in
    select s.id, s.organization_id, s.data
      from app_state s
     where s.collection = 'trips' and s.id = any(trip_ids)
     order by s.id
  loop
    select d.user_id into drv_user from drivers d where d.id = t.data->>'driverId';
    continue when drv_user is null;
    ntf_id := app.enqueue_notification(
      drv_user, t.organization_id, p_booking_id, t.id, 'trip_cancelled', 'trip_cancelled',
      jsonb_build_object('tripId', t.id, 'tripCode', coalesce(t.data->>'code', ''),
                         'reason', '需求者取消預約', 'bookingId', p_booking_id),
      'cancel_booking_endpoint', 'cancel:' || p_booking_id || ':' || t.id || ':trip_cancelled');
    if ntf_id is not null then ntf_ids := ntf_ids || ntf_id; end if;
  end loop;

  recipient := coalesce(nullif(b.data->>'requestedByUserId', ''), b.owner_user_id);
  if recipient is not null then
    ntf_id := app.enqueue_notification(
      recipient, coalesce(b.organization_id, 'ORG-REQ-001'), p_booking_id, null,
      'booking_cancelled', 'booking_cancelled',
      jsonb_build_object('bookingId', p_booking_id, 'reason', coalesce(nullif(reason, ''), code),
                         'reasonCode', code, 'cancelledTripIds', to_jsonb(trip_ids)),
      'cancel_booking_endpoint', 'cancel:' || p_booking_id || '::booking_cancelled');
    if ntf_id is not null then ntf_ids := ntf_ids || ntf_id; end if;
  end if;

  perform set_config('app.state_scope_override', '1', true);

  -- 取消後承接機構立即失去這筆預約的存取（0005）。原承接機構記在 previousOrganizationIds。
  if b.organization_id is not null then
    update app_state s
       set organization_id = null,
           data = s.data || jsonb_build_object(
                    'organizationId', null,
                    'previousOrganizationIds',
                    coalesce(case when jsonb_typeof(s.data->'previousOrganizationIds') = 'array'
                                  then s.data->'previousOrganizationIds' end, '[]'::jsonb)
                      || to_jsonb(b.organization_id))
     where s.collection = 'bookings' and s.id = p_booking_id;
  end if;

  perform set_config('app.state_scope_override', '0', true);

  return query select p_booking_id, trip_ids, ntf_ids;
end $$;

grant execute on function app.cancel_app_state_booking(text, text, text) to care_ride_app;
