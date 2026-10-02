-- 回復 0009：取消函式回到 0007 的版本，刪除帳本與核定
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

drop function if exists app.reopen_trip_benefit_settlement(text);
drop function if exists app.settle_trip_benefit(text);
drop function if exists app.reserve_booking_benefit(text, text);
drop function if exists app.release_booking_benefit(text, text);
drop function if exists app.adjust_benefit_authorization(text, numeric, text, text);
drop function if exists app.revoke_benefit_authorization(text, text, text);
drop function if exists app.save_benefit_authorization(jsonb);
drop function if exists app.benefit_ledger_id();
drop function if exists app.benefit_balance(text);
drop table if exists benefit_ledger;
drop table if exists benefit_authorizations;
drop function if exists app.can_manage_recipient_benefit(text, text);
drop function if exists app.can_read_recipient_benefit(text);
