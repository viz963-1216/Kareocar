-- =====================================================================
-- 0032：依關聯找預約／行程時改用有索引的欄位（#147）
--
-- 搬表（ADR 0005）之後 bookings／trips 有從 data 帶出、建了索引的欄位，行程與預約另有對應表
-- trip_bookings。這裡把還在比對 JSON 的批次與後台函式改用它們，結果不變、不用再掃整張表：
--   - 到期匿名化：服務對象有沒有預約 → bookings.care_recipient_id
--   - 核准刪除帳號：這個人的預約 → bookings.requested_by_user_id；這些預約的行程 → trip_bookings
--   - 需求者取消：預約的行程 → trip_bookings
-- 為了讓 trip_bookings 能取代原本的 JSON 比對，對應規則補上單數 bookingId，以及 bookingIds 裡
-- 沒被去程／回程引用涵蓋的預約（與 App 端 bookingIdsOf 相同），並補齊既有行程。
-- =====================================================================

CREATE OR REPLACE FUNCTION app.trips_after_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- 行程與預約的對應：去程／回程引用（bookingLegRefs）一筆一列；bookingIds 與單數 bookingId
  -- 裡沒被引用涵蓋的預約，各補一列（leg 為空）。與 App 端判斷「行程掛了哪些預約」相同
  delete from trip_bookings where trip_id = new.id;
  with refs as (
    select nullif(ref->>'bookingId', '') as booking_id, nullif(ref->>'legId', '') as leg_id, n
      from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingLegRefs') = 'array'
                                     then new.data->'bookingLegRefs' else '[]'::jsonb end) with ordinality as x(ref, n)
     where jsonb_typeof(ref) = 'object'
  ), ids as (
    select b #>> '{}' as booking_id, n
      from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingIds') = 'array'
                                     then new.data->'bookingIds' else '[]'::jsonb end) with ordinality as y(b, n)
     where jsonb_typeof(b) = 'string'
    union all
    select nullif(new.data->>'bookingId', ''), 2147483647
  ), r as (
    select booking_id, leg_id, n from refs
    union all
    select i.booking_id, null, i.n from ids i
     where not exists (select 1 from refs where refs.booking_id = i.booking_id)
  )
  insert into trip_bookings (id, trip_id, booking_id, leg_id, sequence)
  select new.id || '|' || r.booking_id || '|' || coalesce(r.leg_id, ''), new.id, r.booking_id, r.leg_id, min(r.n)::int
    from r
   where r.booking_id is not null and r.booking_id <> ''
   group by r.booking_id, r.leg_id;

  return new;
end $function$;

-- 補齊既有行程的對應（暫停 updated_at 觸發器；資料庫擁有者的寫入不改版本與更新時間，只重跑觸發器）
alter table trips disable trigger trips_updated_touch;
update trips t set data = t.data
 where (nullif(t.data->>'bookingId', '') is not null
        and not exists (select 1 from trip_bookings tb where tb.trip_id = t.id and tb.booking_id = t.data->>'bookingId'))
    or (jsonb_typeof(t.data->'bookingIds') = 'array'
        and exists (select 1 from jsonb_array_elements_text(t.data->'bookingIds') b
                     where not exists (select 1 from trip_bookings tb where tb.trip_id = t.id and tb.booking_id = b)));
alter table trips enable trigger trips_updated_touch;

CREATE OR REPLACE FUNCTION app.anonymize_expired_records(p_today date DEFAULT CURRENT_DATE)
 RETURNS TABLE(kind text, id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    select s.id from bookings s
     where not (s.data ? 'anonymizedAt')
       and coalesce(s.data->>'pickupDate', '') ~ '^\d{4}-\d{2}-\d{2}$' and (s.data->>'pickupDate')::date < v_cutoff
     order by s.id
       for update
  loop
    update bookings s set data = app.anonymize_booking_data(s.data)
     where s.id = r.id;
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
    select s.id from trips s
     where not (s.data ? 'anonymizedAt')
       and coalesce(s.data->>'date', '') ~ '^\d{4}-\d{2}-\d{2}$' and (s.data->>'date')::date < v_cutoff
     order by s.id
       for update
  loop
    update trips s set data = app.anonymize_trip_data(s.data)
     where s.id = r.id;
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
                          and b.care_recipient_id = s.id and not (b.data ? 'anonymizedAt'))
       and (exists (select 1 from bookings b where b.care_recipient_id = s.id)
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
end $function$;

CREATE OR REPLACE FUNCTION app.review_account_deletion(p_id text, p_decision text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
                and (s.owner_user_id = v_user or s.requested_by_user_id = v_user)
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
   where s.owner_user_id = v_user or s.requested_by_user_id = v_user;
  -- 每一筆都寫稽核紀錄（#80）
  with upd as (update bookings s set data = app.anonymize_booking_data(s.data)
                where s.id = any(v_bookings) and not (s.data ? 'anonymizedAt') returning s.id)
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
  select coalesce(array_agg(distinct tb.trip_id), '{}') into v_trip_ids from trip_bookings tb
   where tb.booking_id = any(v_bookings);
  with upd as (update trips s set data = app.anonymize_trip_data(s.data)
                where s.id = any(v_trip_ids) and not (s.data ? 'anonymizedAt') returning s.id)
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
end $function$;

CREATE OR REPLACE FUNCTION app.cancel_app_state_booking(p_booking_id text, p_reason_code text, p_reason_text text)
 RETURNS TABLE(out_booking_id text, out_cancelled_trip_ids text[], out_notification_ids text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  b         bookings%rowtype;
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
    from bookings s
   where s.id = p_booking_id and not s.deleted
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
      from trips s
     where not s.deleted
       and s.id in (select tb.trip_id from trip_bookings tb where tb.booking_id = p_booking_id)
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
    update trips s
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
     where s.id = t.id;
    trip_ids := trip_ids || t.id;
  end loop;

  update bookings s
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
   where s.id = p_booking_id;

  if jsonb_typeof(b.data->'legs') = 'array' then
    update bookings s
       set data = jsonb_set(s.data, '{legs}',
                    (select coalesce(jsonb_agg(l || jsonb_build_object('status', 'cancelled')), '[]'::jsonb)
                       from jsonb_array_elements(s.data->'legs') l))
     where s.id = p_booking_id;
  end if;

  -- 釋放這筆預約保留的補助額度（0009）
  perform app.release_booking_benefit(p_booking_id, 'booking_cancelled');

  -- 站內通知：寫入 notifications 資料表（0007），只寫資料列、不送出。
  -- dedupe_key 讓同一次取消重試時不會重複通知。
  for t in
    select s.id, s.organization_id, s.data
      from trips s
     where s.id = any(trip_ids)
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
    update bookings s
       set organization_id = null,
           data = s.data || jsonb_build_object(
                    'organizationId', null,
                    'previousOrganizationIds',
                    coalesce(case when jsonb_typeof(s.data->'previousOrganizationIds') = 'array'
                                  then s.data->'previousOrganizationIds' end, '[]'::jsonb)
                      || to_jsonb(b.organization_id))
     where s.id = p_booking_id;
  end if;

  perform set_config('app.state_scope_override', '0', true);

  return query select p_booking_id, trip_ids, ntf_ids;
end $function$;
