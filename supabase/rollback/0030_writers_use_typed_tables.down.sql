-- 回復 0030：寫入函式回到改寫 app_state 的定義

create or replace function app.claim_app_state_booking(p_id text, p_organization_id text)
returns table (id text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  row_state text;
  row_org   text;
begin
  if not (app.is_super_admin()
          or app.has_role_in(p_organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限代表這個組織承接案件' using errcode = '42501';
  end if;
  if not exists (select 1 from organizations o
                  where o.id = p_organization_id
                    and o.active
                    and o.org_type in ('transport_provider','care_facility')) then
    raise exception '此組織不是可承接案件的有效服務組織' using errcode = '42501';
  end if;
  if not exists (select 1 from organizations o
                  where o.id = p_organization_id and o.review_status = 'approved') then
    raise exception '此組織尚未通過平台審核或已停權，不能承接案件' using errcode = '42501';
  end if;

  select s.booking_state, s.organization_id into row_state, row_org
    from app_state s
   where s.collection = 'bookings' and s.id = p_id and not s.deleted
     for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if row_org is not null then
    raise exception '已被其他服務單位接走' using errcode = '55006';
  end if;
  if row_state is distinct from 'open' then
    raise exception '不是可承接的狀態' using errcode = '55006';
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = p_organization_id,
         data = s.data || jsonb_build_object(
                  'organizationId', p_organization_id,
                  'state', 'claimed',
                  'claimStatus', 'claimed',
                  'claimedByUserId', app.current_user_id(),
                  'claimedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where s.collection = 'bookings' and s.id = p_id;
  perform set_config('app.state_scope_override', '0', true);

  return query
    select s.id, s.organization_id, s.version
      from app_state s where s.collection = 'bookings' and s.id = p_id;
end $$;

create or replace function app.revoke_booking_organization(p_booking_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b  app_state%rowtype;
  st text;
begin
  select * into b
    from app_state s
   where s.collection = 'bookings' and s.id = p_booking_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到預約' using errcode = 'P0002';
  end if;
  if b.organization_id is null then
    return;
  end if;
  if not (app.is_super_admin()
          or b.owner_user_id = app.current_user_id()
          or app.has_role_in(b.organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限變更這筆預約的承接機構' using errcode = '42501';
  end if;
  st := coalesce(nullif(b.data->>'state', ''), 'open');
  if st not in ('open', 'rejected', 'expired', 'cancelled') then
    raise exception '預約仍在承接中，不能撤銷承接機構' using errcode = 'CR400';
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = null,
         data = s.data || jsonb_build_object(
                  'organizationId', null,
                  'previousOrganizationIds',
                  coalesce(case when jsonb_typeof(s.data->'previousOrganizationIds') = 'array'
                                then s.data->'previousOrganizationIds' end, '[]'::jsonb)
                    || to_jsonb(b.organization_id))
   where s.collection = 'bookings' and s.id = p_booking_id;
  perform set_config('app.state_scope_override', '0', true);
end $$;

create or replace function app.set_booking_benefit(p_booking_id text, p_benefit jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_data jsonb;
begin
  select b.data into v_data from app_state b
   where b.collection = 'bookings' and b.id = p_booking_id and not b.deleted for update;
  if v_data is null then
    raise exception '找不到預約' using errcode = 'P0002';
  end if;
  if not app.can_refresh_recipient_benefit(v_data->>'recipientId') then
    raise exception '只有建立這位服務對象的人可以更新預約的補助估算' using errcode = '42501';
  end if;
  if jsonb_typeof(p_benefit) is distinct from 'object' then
    raise exception '補助估算格式不正確' using errcode = 'CR400';
  end if;
  -- 已結束的預約保留原樣
  if not app.booking_benefit_refreshable(v_data) then
    return false;
  end if;
  v_data := jsonb_set(v_data, '{serverComputed}', coalesce(v_data->'serverComputed', '{}'::jsonb) || jsonb_build_object('benefit', p_benefit));
  if jsonb_typeof(v_data->'commercialSnapshots') = 'array' then
    v_data := jsonb_set(v_data, '{commercialSnapshots}', (
      select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object' then s || jsonb_build_object('benefit', p_benefit) else s end order by n), '[]'::jsonb)
        from jsonb_array_elements(v_data->'commercialSnapshots') with ordinality as x(s, n)));
  end if;
  update app_state set data = v_data where collection = 'bookings' and id = p_booking_id;
  return true;
end $$;

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

  -- 釋放這筆預約保留的補助額度（0009）
  perform app.release_booking_benefit(p_booking_id, 'booking_cancelled');

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

create or replace function app.lock_driver_trip(p_trip_id text)
returns table (trip_data jsonb, trip_revision int, trip_organization_id text, blocking_issue_ids text[])
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r app_state%rowtype;
begin
  select * into r
    from app_state s
   where s.collection = 'trips' and s.id = p_trip_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到行程' using errcode = 'P0002';
  end if;
  if not app.is_my_active_trip_driver(r.data->>'driverId', r.organization_id) then
    raise exception '只有本趟指派司機可以執行此行程' using errcode = '42501';
  end if;

  return query
    select r.data, r.revision, r.organization_id,
           coalesce((select array_agg(i.id order by i.id)
                       from app_state i
                      where i.collection = 'issues'
                        and not i.deleted
                        and i.trip_id = p_trip_id
                        and coalesce(i.data->>'status', 'open') <> 'resolved'
                        and (i.data->>'requiresDispatch' = 'true'
                             or i.data->>'severity' in ('critical', 'emergency'))),
                    '{}'::text[]);
end $$;

create or replace function app.apply_driver_trip_execution(
  p_trip_id text, p_command text, p_expected_revision int, p_idempotency_key text,
  p_patch jsonb, p_events jsonb, p_issue jsonb)
returns table (out_trip_id text, out_revision int, out_status text, out_duplicate boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r           app_state%rowtype;
  patch       jsonb := coalesce(p_patch, '{}'::jsonb);
  events      jsonb := coalesce(p_events, '[]'::jsonb);
  me          text := app.current_user_id();
  revisioned  boolean := p_command in ('complete_step', 'undo_step', 'proof_service');
  allowed     text[];
  ev_types    text[];
  k           text;
  e           jsonb;
  old_status  text;
  new_status  text;
  receipts    jsonb;
  event_ids   text[];
  now_iso     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  select * into r
    from app_state s
   where s.collection = 'trips' and s.id = p_trip_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到行程' using errcode = 'P0002';
  end if;
  if not app.is_my_active_trip_driver(r.data->>'driverId', r.organization_id) then
    raise exception '只有本趟指派司機可以執行此行程' using errcode = '42501';
  end if;

  allowed := case
    when revisioned then array['status','stateChangedAt','startedAt','completedAt','currentStepIndex',
                               'completionPending','steps','passengers','serviceProofs','resourceSegments',
                               'actualMetrics','lastInvariantCheck','invariantViolation','updatedAt']
    when p_command = 'location_sample' then array['locationSamples','liveNavigation']
    when p_command = 'report_issue'    then array[]::text[]
    else null end;
  if allowed is null then
    raise exception '不支援的執行動作' using errcode = 'CR400';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or length(p_idempotency_key) > 180 then
    raise exception '缺少冪等鍵' using errcode = 'CR400';
  end if;
  if jsonb_typeof(patch) <> 'object' or jsonb_typeof(events) <> 'array' then
    raise exception 'patch 必須是物件、events 必須是陣列' using errcode = 'CR400';
  end if;
  if jsonb_array_length(events) > 50 then
    raise exception '單次事件數量過多' using errcode = 'CR400';
  end if;
  for k in select jsonb_object_keys(patch) loop
    if not (k = any(allowed)) then
      raise exception '不允許修改的欄位：%', left(k, 40) using errcode = 'CR400';
    end if;
  end loop;

  old_status := coalesce(nullif(r.data->>'status', ''), 'scheduled');

  -- 冪等：同一個操作重送（例如回應在網路上遺失後重試）直接回報已處理，不再寫入
  if revisioned then
    if jsonb_typeof(r.data->'mutationReceipts') = 'array'
       and exists (select 1 from jsonb_array_elements(r.data->'mutationReceipts') x
                    where x->>'key' = p_idempotency_key) then
      return query select r.id, r.revision, old_status, true;
      return;
    end if;
    if p_expected_revision is distinct from r.revision then
      raise exception '行程已被其他操作更新，請重新整理' using errcode = 'CR409';
    end if;
  elsif p_command = 'report_issue' then
    if p_issue is null or jsonb_typeof(p_issue) <> 'object'
       or btrim(coalesce(p_issue->>'id', '')) = '' or length(p_issue->>'id') > 180 then
      raise exception '異常資料格式不符' using errcode = 'CR400';
    end if;
    if exists (select 1 from app_state s where s.collection = 'issues' and s.id = p_issue->>'id') then
      if exists (select 1 from app_state s
                  where s.collection = 'issues' and s.id = p_issue->>'id'
                    and s.trip_id = p_trip_id and s.owner_user_id = me) then
        return query select r.id, r.revision, old_status, true;
        return;
      end if;
      raise exception '異常 ID 與其他資料衝突' using errcode = 'CR400';
    end if;
  end if;

  -- 狀態轉換
  if revisioned then
    new_status := coalesce(nullif(patch->>'status', ''), old_status);
    if not ((old_status || '>' || new_status) = any (case p_command
         when 'complete_step' then array['scheduled>in_progress','scheduled>completed',
                                         'in_progress>in_progress','in_progress>completed']
         when 'undo_step'     then array['in_progress>in_progress','in_progress>scheduled',
                                         'completed>in_progress']
         when 'proof_service' then array['in_progress>in_progress','in_progress>completed',
                                         'completed>completed'] end)) then
      raise exception '行程狀態不可由 % 轉為 %', old_status, new_status using errcode = 'CR400';
    end if;
  elsif p_command = 'report_issue' then
    if old_status in ('completed', 'cancelled', 'aborted') then
      raise exception '已完成、取消或終止的行程不能再新增現場異常' using errcode = 'CR400';
    end if;
    if p_issue->>'tripId' is distinct from p_trip_id
       or p_issue->>'driverId' is distinct from r.data->>'driverId'
       or coalesce(p_issue->>'status', '') <> 'open'
       or btrim(coalesce(p_issue->>'type', '')) = '' then
      raise exception '異常資料與行程不符' using errcode = 'CR400';
    end if;
  end if;

  -- 事件：類型必須屬於這個指令，而且操作人就是呼叫者
  ev_types := case p_command
    when 'complete_step'   then array['trip_step_completed','trip_passenger_state_changed','trip_state_transitioned']
    when 'undo_step'       then array['trip_event_corrected','trip_proof_of_service_superseded',
                                      'trip_state_transitioned','trip_passenger_state_changed']
    when 'proof_service'   then array['trip_proof_of_service_captured','trip_state_transitioned']
    when 'location_sample' then array['trip_route_deviation_detected','trip_route_deviation_cleared']
    when 'report_issue'    then array['trip_issue_reported'] end;
  for e in select x.value from jsonb_array_elements(events) x loop
    if jsonb_typeof(e) <> 'object'
       or btrim(coalesce(e->>'id', '')) = '' or length(e->>'id') > 180
       or e->>'tripId' is distinct from p_trip_id
       or not (coalesce(e->>'eventType', '') = any(ev_types))
       or e->>'actorUserId' is distinct from me then
      raise exception '事件格式不符或不屬於此操作' using errcode = 'CR400';
    end if;
  end loop;

  -- 寫入行程：revision 與 mutationReceipts 由伺服器產生，不採用呼叫端的值
  if revisioned then
    receipts := coalesce(case when jsonb_typeof(r.data->'mutationReceipts') = 'array'
                              then r.data->'mutationReceipts' end, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                     'key', p_idempotency_key, 'action', p_command, 'at', now_iso,
                     'actorUserId', me, 'resultRevision', r.revision + 1,
                     'source', 'trip_execute_endpoint'));
    if jsonb_array_length(receipts) > 80 then
      select jsonb_agg(x.value order by x.ord) into receipts
        from jsonb_array_elements(receipts) with ordinality x(value, ord)
       where x.ord > jsonb_array_length(receipts) - 80;
    end if;
    update app_state s
       set data = s.data || patch
                  || jsonb_build_object('mutationReceipts', receipts, 'revision', s.revision + 1),
           revision = s.revision + 1
     where s.collection = 'trips' and s.id = p_trip_id;
  elsif p_command = 'location_sample' then
    -- 定位是遙測，不動 revision：不會讓司機接下來的停靠點操作變成 409
    update app_state s
       set data = s.data || patch
     where s.collection = 'trips' and s.id = p_trip_id;
  end if;

  -- 事件與異常：觸發器會把非營運方 INSERT 的 organization_id 清空，
  -- 所以先寫入、再以交易級旗標補上行程的組織，調度端才看得到
  select coalesce(array_agg(distinct x.value->>'id'), '{}'::text[]) into event_ids
    from jsonb_array_elements(events) x;
  if array_length(event_ids, 1) > 0 then
    insert into app_state (collection, id, trip_id, data)
      select 'tripEvents', x.value->>'id', p_trip_id, x.value
        from jsonb_array_elements(events) x
      on conflict (collection, id) do nothing;
    if (select count(*) from app_state s
         where s.collection = 'tripEvents' and s.id = any(event_ids) and s.trip_id = p_trip_id)
       <> array_length(event_ids, 1) then
      raise exception '事件 ID 與其他資料衝突' using errcode = 'CR400';
    end if;
  end if;
  if p_command = 'report_issue' then
    insert into app_state (collection, id, trip_id, data)
    values ('issues', p_issue->>'id', p_trip_id,
            p_issue || jsonb_build_object('organizationId', r.organization_id,
                                          'tripId', p_trip_id,
                                          'driverId', r.data->>'driverId'));
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = r.organization_id
   where s.trip_id = p_trip_id
     and s.organization_id is null
     and s.owner_user_id = me
     and ((s.collection = 'tripEvents' and s.id = any(event_ids))
          or (p_command = 'report_issue' and s.collection = 'issues' and s.id = p_issue->>'id'));
  perform set_config('app.state_scope_override', '0', true);

  return query
    select s.id, s.revision, coalesce(nullif(s.data->>'status', ''), 'scheduled'), false
      from app_state s where s.collection = 'trips' and s.id = p_trip_id;
end $$;

create or replace function app.anonymize_expired_records(p_today date default current_date)
returns table (kind text, id text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_years  int;
  v_cutoff date;
  r record;
begin
  if app.current_user_id() is not null and not app.is_super_admin() then
    raise exception '只有平台超級管理者或系統排程可以執行匿名化' using errcode = '42501';
  end if;
  select coalesce((value::text)::int, 5) into v_years from app_settings where key = 'retention_years';
  v_years := coalesce(v_years, 5);
  v_cutoff := (p_today - make_interval(years => v_years))::date;

  perform set_config('app.state_scope_override', '1', true);
  for r in
    select s.id from app_state s
     where s.collection = 'bookings' and not (s.data ? 'anonymizedAt')
       and s.pickup_at ~ '^\d{4}-\d{2}-\d{2}$' and s.pickup_at::date < v_cutoff
     order by s.id
       for update
  loop
    update app_state s set data = app.anonymize_booking_data(s.data)
     where s.collection = 'bookings' and s.id = r.id;
    update app_state e set data = app.anonymize_event_data(e.data)
     where e.collection = 'bookingEvents' and e.data->>'bookingId' = r.id and not (e.data ? 'anonymizedAt');
    -- 這筆預約的通知內容（#89）
    update notifications n set payload = jsonb_strip_nulls(jsonb_build_object(
               'bookingId', n.payload->'bookingId', 'tripId', n.payload->'tripId')), message_summary = null, data = '{}'::jsonb
     where n.booking_id = r.id;
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'booking', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'booking'; id := r.id; return next;
  end loop;

  for r in
    select s.id from app_state s
     where s.collection = 'trips' and not (s.data ? 'anonymizedAt')
       and coalesce(s.data->>'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (s.data->>'date')::date < v_cutoff
     order by s.id
       for update
  loop
    update app_state s set data = app.anonymize_trip_data(s.data)
     where s.collection = 'trips' and s.id = r.id;
    update app_state e set data = app.anonymize_event_data(e.data)
     where e.collection = 'tripEvents' and coalesce(e.trip_id, e.data->>'tripId') = r.id and not (e.data ? 'anonymizedAt');
    -- 這趟行程的通知（寄給司機的，沒有預約 ID 的也算）（#89）
    update notifications n set payload = jsonb_strip_nulls(jsonb_build_object(
               'bookingId', n.payload->'bookingId', 'tripId', n.payload->'tripId')), message_summary = null, data = '{}'::jsonb
     where n.trip_id = r.id;
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'trip', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'trip'; id := r.id; return next;
  end loop;

  -- 預約修改紀錄：所屬預約已匿名化（本次或之前）就清除快照（#80）
  for r in
    select s.id from app_state s
     where s.collection = 'bookingRevisions' and not (s.data ? 'anonymizedAt')
       and exists (select 1 from bookings b
                    where (b.data ? 'anonymizedAt')
                      and b.id = coalesce(s.booking_id, s.data->>'bookingId'))
     order by s.id
       for update
  loop
    update app_state s set data = app.anonymize_booking_revision_data(s.data)
     where s.collection = 'bookingRevisions' and s.id = r.id;
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'booking_revision', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'booking_revision'; id := r.id; return next;
  end loop;

  -- 服務對象（#80）：還有沒匿名化的預約（未到期、未結束）就不動；否則
  --   有預約、而且都已匿名化 → 匿名化
  --   沒有任何預約（從沒預約過，或合併後預約都轉到另一位）→ 建立超過保存期限，而且建立的帳號已停用或不存在
  --   才匿名化（0019：帳號還在用的人，他的本人資料或還在管理的家人不能因為久沒預約就被清掉）
  for r in
    select s.id from app_state s
     where s.collection = 'careRecipients' and not s.deleted and not (s.data ? 'anonymizedAt')
       and not exists (select 1 from bookings b
                        where not b.deleted
                          and b.data->>'recipientId' = s.id and not (b.data ? 'anonymizedAt'))
       and (exists (select 1 from bookings b where b.data->>'recipientId' = s.id)
            or (s.created_at::date < v_cutoff
                and not exists (select 1 from users u where u.id = s.owner_user_id and u.active)))
     order by s.id
       for update
  loop
    update app_state s set data = app.anonymize_recipient_data(s.data)
     where s.collection = 'careRecipients' and s.id = r.id;
    update app_state e set data = app.anonymize_event_data(e.data)
     where e.collection = 'careRecipientEvents' and e.data->>'recipientId' = r.id and not (e.data ? 'anonymizedAt');
    -- 補助試算的事實資料、長照等級、身分別（#89，與核准刪除帳號相同）
    update benefit_assessments set facts = '{}'::jsonb, data = data - 'facts', cms_level = null, identity_category = null
     where care_recipient_id = r.id;
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'care_recipient', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'care_recipient'; id := r.id; return next;
  end loop;
  perform set_config('app.state_scope_override', '0', true);
end $$;

create or replace function app.review_account_deletion(p_id text, p_decision text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d deletion_requests%rowtype;
  v_user text;
  v_bookings text[];
  v_recipients text[];
  v_trips int := 0;
  v_trip_ids text[];
  v_revisions int := 0;
  v_ntf int := 0;
  v_summary jsonb;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以處理刪除申請' using errcode = '42501';
  end if;
  select * into d from deletion_requests where id = p_id for update;
  if not found then
    raise exception '找不到刪除申請' using errcode = 'P0002';
  end if;
  if d.status <> 'pending' then
    raise exception '這件申請已經處理過（%）', d.status using errcode = 'CR400';
  end if;
  v_user := d.user_id;

  if p_decision = 'reject' then
    if btrim(coalesce(p_note, '')) = '' then
      raise exception '駁回必須填寫原因' using errcode = 'CR400';
    end if;
    update deletion_requests set status = 'rejected', reviewed_by_user_id = app.current_user_id(),
           reviewed_at = now(), review_note = btrim(p_note) where id = p_id;
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_rejected', app.current_user_id(),
            'deletion_request', p_id, jsonb_build_object('userId', v_user, 'note', btrim(p_note)));
    return jsonb_build_object('status', 'rejected');
  end if;
  if p_decision <> 'approve' then
    raise exception '不支援的決定：%', p_decision using errcode = 'CR400';
  end if;

  -- 前置條件
  if exists (select 1 from bookings s
              where not s.deleted
                and (s.owner_user_id = v_user or s.data->>'requestedByUserId' = v_user)
                and coalesce(s.data->>'state', 'open') in ('open', 'claimed', 'partially_scheduled', 'scheduled')
                and (nullif(s.data->>'pickupDate', '') is null or s.data->>'pickupDate' !~ '^\d{4}-\d{2}-\d{2}$'
                     or (s.data->>'pickupDate')::date >= current_date)) then
    raise exception '這位使用者還有未結束的預約，請先取消後再核准' using errcode = 'CR400';
  end if;
  if exists (select 1 from memberships where user_id = v_user and role = 'owner' and status = 'active') then
    raise exception '這位使用者是機構的負責人，請先移交負責人後再核准' using errcode = 'CR400';
  end if;

  perform set_config('app.state_scope_override', '1', true);

  -- 預約與行程
  select coalesce(array_agg(s.id), '{}') into v_bookings from bookings s
   where s.owner_user_id = v_user or s.data->>'requestedByUserId' = v_user;
  -- 每一筆都寫稽核紀錄（#80）
  with upd as (update app_state s set data = app.anonymize_booking_data(s.data)
                where s.collection = 'bookings' and s.id = any(v_bookings) and not (s.data ? 'anonymizedAt') returning s.id)
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
  select 'AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_anonymized', app.current_user_id(), 'booking', upd.id, 'ACCOUNT_DELETION',
         jsonb_build_object('deletionRequestId', p_id, 'userId', v_user) from upd;
  -- 預約修改紀錄的快照（#80）
  with upd as (update app_state s set data = app.anonymize_booking_revision_data(s.data)
                where s.collection = 'bookingRevisions' and not (s.data ? 'anonymizedAt')
                  and coalesce(s.booking_id, s.data->>'bookingId') = any(v_bookings) returning s.id)
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
  select 'AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_anonymized', app.current_user_id(), 'booking_revision', upd.id, 'ACCOUNT_DELETION',
         jsonb_build_object('deletionRequestId', p_id, 'userId', v_user) from upd;
  get diagnostics v_revisions = row_count;
  -- 行程（含服務證明的收受人與自由文字，見 anonymize_trip_data）
  select coalesce(array_agg(s.id), '{}') into v_trip_ids from trips s
   where nullif(s.data->>'bookingId', '') = any(v_bookings)
      or exists (select 1 from trip_bookings tb where tb.trip_id = s.id and tb.booking_id = any(v_bookings));
  with upd as (update app_state s set data = app.anonymize_trip_data(s.data)
                where s.collection = 'trips' and s.id = any(v_trip_ids) and not (s.data ? 'anonymizedAt') returning s.id)
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
  select 'AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_anonymized', app.current_user_id(), 'trip', upd.id, 'ACCOUNT_DELETION',
         jsonb_build_object('deletionRequestId', p_id, 'userId', v_user) from upd;
  get diagnostics v_trips = row_count;

  -- 服務對象與補助試算
  select coalesce(array_agg(s.id), '{}') into v_recipients from app_state s
   where s.collection = 'careRecipients' and s.owner_user_id = v_user;
  with upd as (update app_state s set deleted = true,
         data = jsonb_build_object('id', s.id, 'status', 'deleted', 'deletedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where s.collection = 'careRecipients' and s.id = any(v_recipients) returning s.id)
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
  select 'AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_anonymized', app.current_user_id(), 'care_recipient', upd.id, 'ACCOUNT_DELETION',
         jsonb_build_object('deletionRequestId', p_id, 'userId', v_user) from upd;
  -- 這些預約的通知（寄給司機、調度等其他人的）內容（#89）；寄給他本人的下面整筆刪除
  update notifications n set payload = jsonb_strip_nulls(jsonb_build_object(
             'bookingId', n.payload->'bookingId', 'tripId', n.payload->'tripId')), message_summary = null, data = '{}'::jsonb
   where n.booking_id = any(v_bookings) or n.trip_id = any(v_trip_ids);
  -- 這些預約、行程、服務對象的事件紀錄（修改前後的值、原因、收受人）（#80）
  update app_state e set data = app.anonymize_event_data(e.data)
   where not (e.data ? 'anonymizedAt')
     and ((e.collection = 'bookingEvents' and e.data->>'bookingId' = any(v_bookings))
       or (e.collection = 'tripEvents' and coalesce(e.trip_id, e.data->>'tripId') = any(v_trip_ids))
       or (e.collection = 'careRecipientEvents' and e.data->>'recipientId' = any(v_recipients)));
  update benefit_assessments set facts = '{}'::jsonb, data = data - 'facts', cms_level = null, identity_category = null
   where care_recipient_id = any(v_recipients);

  -- 通知、成員資格、帳號
  delete from notifications where recipient_user_id = v_user;
  get diagnostics v_ntf = row_count;
  update memberships set status = 'revoked', revoked_at = now(), revoked_by_user_id = app.current_user_id()
   where user_id = v_user and status <> 'revoked';
  update users set active = false, display_name = '（已刪除帳號）', phone_e164 = null, email = null,
         data = jsonb_build_object('deletedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
         sessions_valid_after = now(), updated_at = now()
   where id = v_user;

  perform set_config('app.state_scope_override', '0', true);

  v_summary := jsonb_build_object('bookings', coalesce(array_length(v_bookings, 1), 0), 'trips', v_trips, 'bookingRevisions', v_revisions,
                                  'careRecipients', coalesce(array_length(v_recipients, 1), 0), 'notifications', v_ntf);
  update deletion_requests set status = 'completed', reviewed_by_user_id = app.current_user_id(), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''), completed_at = now(), summary = v_summary
   where id = p_id;
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_completed', app.current_user_id(),
          'deletion_request', p_id, v_summary || jsonb_build_object('userId', v_user));
  return jsonb_build_object('status', 'completed', 'userId', v_user, 'summary', v_summary);
end $$;
