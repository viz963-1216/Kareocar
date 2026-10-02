-- 回復 0007：取消函式回到 0005 的版本，通知資料表回到 0001 的形狀
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

  -- 站內通知（只寫資料列，不送出）
  -- 先寫來源證明 app.notification_provenance，寫成功才寫通知（見第 6 節）。
  perform set_config('app.state_scope_override', '1', true);

  for t in
    select s.id, s.organization_id, s.data
      from app_state s
     where s.collection = 'trips' and s.id = any(trip_ids)
     order by s.id
  loop
    select d.user_id into drv_user from drivers d where d.id = t.data->>'driverId';
    continue when drv_user is null;
    ntf_id := 'ntf_' || replace(gen_random_uuid()::text, '-', '');
    ntf_data := jsonb_build_object(
              'id', ntf_id, 'organizationId', t.organization_id, 'recipientId', drv_user,
              'channel', 'line', 'template', 'trip_cancelled', 'eventType', 'trip_cancelled',
              'payload', jsonb_build_object('tripId', t.id, 'tripCode', coalesce(t.data->>'code', ''),
                                            'reason', '需求者取消預約', 'bookingId', p_booking_id,
                                            'bookingOrganizationId', b.organization_id),
              'status', 'queued', 'createdAt', now_iso, 'sentAt', null, 'error', null,
              'source', 'cancel_booking_endpoint');
    proof_id := null;
    insert into app.notification_provenance (notification_id, source, booking_id, trip_id, template, recipient_user_id, content_hash)
    values (ntf_id, 'cancel_booking_endpoint', p_booking_id, t.id, 'trip_cancelled', drv_user, md5(ntf_data::text))
    on conflict (source, booking_id, trip_id, template) do nothing
    returning notification_id into proof_id;
    continue when proof_id is null;
    insert into app_state (collection, id, trip_id, booking_id, data)
    values ('notifications', ntf_id, t.id, p_booking_id, ntf_data);
    update app_state s set organization_id = t.organization_id
     where s.collection = 'notifications' and s.id = ntf_id and s.organization_id is null;
    ntf_ids := ntf_ids || ntf_id;
  end loop;

  recipient := coalesce(nullif(b.data->>'requestedByUserId', ''), b.owner_user_id);
  if recipient is not null then
    ntf_id  := null;
    ntf_org := coalesce(b.organization_id, 'ORG-REQ-001');
    ntf_id  := 'ntf_' || replace(gen_random_uuid()::text, '-', '');
    ntf_data := jsonb_build_object(
                'id', ntf_id, 'organizationId', ntf_org, 'recipientId', recipient,
                'channel', 'line', 'template', 'booking_cancelled', 'eventType', 'booking_cancelled',
                'payload', jsonb_build_object('bookingId', p_booking_id,
                                              'reason', coalesce(nullif(reason, ''), code),
                                              'reasonCode', code,
                                              'cancelledTripIds', to_jsonb(trip_ids)),
                'status', 'queued', 'createdAt', now_iso, 'sentAt', null, 'error', null,
                'source', 'cancel_booking_endpoint');
    proof_id := null;
    insert into app.notification_provenance (notification_id, source, booking_id, trip_id, template, recipient_user_id, content_hash)
    values (ntf_id, 'cancel_booking_endpoint', p_booking_id, '', 'booking_cancelled', recipient, md5(ntf_data::text))
    on conflict (source, booking_id, trip_id, template) do nothing
    returning notification_id into proof_id;
    if proof_id is not null then
      insert into app_state (collection, id, booking_id, data)
      values ('notifications', ntf_id, p_booking_id, ntf_data);
      update app_state s set organization_id = ntf_org
       where s.collection = 'notifications' and s.id = ntf_id and s.organization_id is null;
      ntf_ids := ntf_ids || ntf_id;
    end if;
  end if;

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

drop function if exists app.notify_booking_requester(text, text, jsonb, text, text);
drop function if exists app.enqueue_notification(text, text, text, text, text, text, jsonb, text, text);

delete from notifications where dedupe_key is not null;
drop policy if exists notif_read on notifications;
create policy notif_read on notifications for select
  using (app.is_super_admin()
         or recipient_user_id = app.current_user_id()
         or app.can_see_booking(booking_id)
         or app.can_see_trip(trip_id));
create policy notif_insert on notifications for insert
  with check (app.is_super_admin() or app.operates_any());
grant insert, update, delete on notifications to care_ride_app;

drop index if exists notifications_dedupe_idx;
alter table notifications
  drop column dedupe_key,
  drop column source,
  drop column payload,
  drop column event_type,
  drop column template,
  drop column organization_id;
alter table notifications
  add constraint notifications_booking_id_fkey foreign key (booking_id) references bookings(id) on delete cascade,
  add constraint notifications_trip_id_fkey foreign key (trip_id) references trips(id) on delete cascade;
