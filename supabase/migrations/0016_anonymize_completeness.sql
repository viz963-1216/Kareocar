-- =====================================================================
-- 0016：匿名化與刪除帳號補齊服務對象、預約修改紀錄、服務證明、事件紀錄（#80）
--
-- 0010 的到期匿名化與 0011 的核准刪除帳號只處理預約與行程本身，下面這些個資會留下來：
--   - 預約修改紀錄（bookingRevisions）的快照：修改前的姓名、電話、完整地址、自由文字、修改原因
--   - 行程：服務證明的備註與更正原因、操作收據（key 含收受人姓名）、地點物件（座標）、
--     執行快照裡的乘客個資、路線與需求摘要
--   - 事件紀錄：服務對象修改前後的值（careRecipientEvents）、預約與行程事件的 metadata
--     （例如服務證明事件記著收受人）
--   - 服務對象（careRecipients）本身：所有預約都過了保存期限之後仍保留完整資料
--
-- 本次：
--   - app.anonymize_booking_revision_data：快照只留狀態、承接機構、版本與時間；修改原因清除
--   - app.anonymize_recipient_data：清除姓名、電話、緊急聯絡人、地址、生日、需求與備註文字；
--     地址只留行政區，行動能力只留統計用的選項（白名單），保留性別
--   - app.anonymize_event_data：事件只留類型、狀態、關聯 ID 與時間
--   - app.anonymize_trip_data：見下方
--   - 到期匿名化：預約、行程、服務對象匿名化時一併處理它們的事件紀錄；預約匿名化後處理它的修改紀錄；
--     服務對象沒有未匿名化的預約時匿名化（沒有任何預約的，建立超過保存期限才匿名化）；
--     每一筆都寫稽核紀錄
--   - 核准刪除帳號：一併處理修改紀錄、事件紀錄；預約、修改紀錄、行程、服務對象每一筆都寫稽核紀錄
--
-- 匿名化函式寫入 anonymizedAt（now()），所以是 stable 而不是 immutable。
-- =====================================================================

create or replace function app.anonymize_booking_revision_data(p_data jsonb)
returns jsonb
language sql stable
as $$
  select (p_data - 'snapshot' - 'reasonText')
    || jsonb_build_object(
         'reasonText', null,
         'snapshot', case when jsonb_typeof(p_data->'snapshot') = 'object' then jsonb_strip_nulls(jsonb_build_object(
             'state', p_data->'snapshot'->'state',
             'organizationId', p_data->'snapshot'->'organizationId',
             'bookingVersion', p_data->'snapshot'->'bookingVersion',
             'updatedAt', p_data->'snapshot'->'updatedAt')) else null end,
         'anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;

create or replace function app.anonymize_recipient_data(p_data jsonb)
returns jsonb
language sql stable
as $$
  with a as (
    select case when jsonb_typeof(p_data->'addresses'->'entries') = 'array'
                then p_data->'addresses'->'entries' else '[]'::jsonb end as entries
  )
  select jsonb_strip_nulls(jsonb_build_object(
           'id', p_data->'id', 'schemaVersion', p_data->'schemaVersion', 'scope', p_data->'scope',
           'status', p_data->'status', 'governance', p_data->'governance'))
    || jsonb_build_object(
         'identity', jsonb_build_object('displayName', null, 'birthDate', null, 'gender', p_data->'identity'->'gender'),
         'contacts', jsonb_build_object('primaryPhone', null, 'emergencyContacts', '[]'::jsonb),
         'addresses', jsonb_build_object('district', app.approx_area(coalesce(
             p_data->'addresses'->>'primary',
             (select e->>'address' from jsonb_array_elements(a.entries) e
               where e->>'id' = p_data->'addresses'->>'primaryAddressId' limit 1),
             (select e->>'address' from jsonb_array_elements(a.entries) e limit 1),
             p_data->'servicePreferences'->>'defaultPickupAddress'))),
         -- 行動能力只留統計用的選項，其他（含自由文字）一律不留
         'mobility', jsonb_strip_nulls(jsonb_build_object(
             'walkingAbility', p_data->'mobility'->'walkingAbility',
             'wheelchairType', p_data->'mobility'->'wheelchairType',
             'requiresAccessibleVehicle', p_data->'mobility'->'requiresAccessibleVehicle',
             'requiresEscort', p_data->'mobility'->'requiresEscort',
             'transferAssistance', p_data->'mobility'->'transferAssistance')),
         'servicePreferences', jsonb_strip_nulls(jsonb_build_object('defaultCompanions', p_data->'servicePreferences'->'defaultCompanions')),
         'anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    from a
$$;

-- 事件紀錄（bookingEvents、tripEvents、careRecipientEvents）：metadata、修改前後的值、原因與說明可能含個資
create or replace function app.anonymize_event_data(p_data jsonb)
returns jsonb
language sql stable
as $$
  select (p_data - 'metadata' - 'changes' - 'detail' - 'reason' - 'reasonText' - 'note' - 'payload')
    || jsonb_build_object('anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;

-- 行程：0010 的版本另外清除服務證明的備註與更正原因、操作收據（key 含收受人姓名）、
-- 行程的地點物件（座標），以及執行快照裡的乘客個資、路線與需求摘要
create or replace function app.anonymize_trip_data(p_data jsonb)
returns jsonb
language sql stable
as $$
  select app.redact_trip_pii(p_data) - 'locationSamples' - 'liveNavigation' - 'mutationReceipts'
           - 'pickupLocation' - 'dropoffLocation' - 'dispatchStops' - 'needsSummary'
    || jsonb_build_object('anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || case when jsonb_typeof(p_data->'serviceProofs') = 'array' then jsonb_build_object('serviceProofs',
         (select coalesce(jsonb_agg(case when jsonb_typeof(p) = 'object'
                    then (p - 'photo' - 'signature' - 'gps')
                         || jsonb_build_object('receiverName', null, 'note', null, 'supersededReason', null)
                    else p end order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_data->'serviceProofs') with ordinality as x(p, ord)))
       else '{}'::jsonb end
    || case when jsonb_typeof(p_data->'executionSnapshots') = 'array' then jsonb_build_object('executionSnapshots',
         (select coalesce(jsonb_agg(case when jsonb_typeof(snap) = 'object'
                    then (snap - 'route' - 'needsSummary' - 'passengers')
                         || case when jsonb_typeof(snap->'passengers') = 'array' then jsonb_build_object('passengers',
                              (select coalesce(jsonb_agg(case when jsonb_typeof(pa) = 'object'
                                         then (pa - 'careRecipient' - 'locations' - 'leg' - 'serviceNeeds' - 'serviceNeedsSource')
                                              || jsonb_build_object('name', null, 'phone', null)
                                         else pa end order by o2), '[]'::jsonb)
                                 from jsonb_array_elements(snap->'passengers') with ordinality as y(pa, o2)))
                            else '{}'::jsonb end
                    else snap end order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_data->'executionSnapshots') with ordinality as x(snap, ord)))
       else '{}'::jsonb end
$$;

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
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'trip', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'trip'; id := r.id; return next;
  end loop;

  -- 預約修改紀錄：所屬預約已匿名化（本次或之前）就清除快照（#80）
  for r in
    select s.id from app_state s
     where s.collection = 'bookingRevisions' and not (s.data ? 'anonymizedAt')
       and exists (select 1 from app_state b
                    where b.collection = 'bookings' and (b.data ? 'anonymizedAt')
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
  --   沒有任何預約（從沒預約過，或合併後預約都轉到另一位）→ 建立超過保存期限才匿名化
  for r in
    select s.id from app_state s
     where s.collection = 'careRecipients' and not s.deleted and not (s.data ? 'anonymizedAt')
       and not exists (select 1 from app_state b
                        where b.collection = 'bookings' and not b.deleted
                          and b.data->>'recipientId' = s.id and not (b.data ? 'anonymizedAt'))
       and (exists (select 1 from app_state b where b.collection = 'bookings' and b.data->>'recipientId' = s.id)
            or s.created_at::date < v_cutoff)
     order by s.id
       for update
  loop
    update app_state s set data = app.anonymize_recipient_data(s.data)
     where s.collection = 'careRecipients' and s.id = r.id;
    update app_state e set data = app.anonymize_event_data(e.data)
     where e.collection = 'careRecipientEvents' and e.data->>'recipientId' = r.id and not (e.data ? 'anonymizedAt');
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'care_recipient', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'care_recipient'; id := r.id; return next;
  end loop;
  perform set_config('app.state_scope_override', '0', true);
end $$;
grant execute on function app.anonymize_expired_records(date) to care_ride_app;

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
  if exists (select 1 from app_state s
              where s.collection = 'bookings' and not s.deleted
                and (s.owner_user_id = v_user or s.data->>'requestedByUserId' = v_user)
                and coalesce(s.data->>'state', 'open') in ('open', 'claimed', 'partially_scheduled', 'scheduled')
                and (s.pickup_at is null or s.pickup_at !~ '^\d{4}-\d{2}-\d{2}$' or s.pickup_at::date >= current_date)) then
    raise exception '這位使用者還有未結束的預約，請先取消後再核准' using errcode = 'CR400';
  end if;
  if exists (select 1 from memberships where user_id = v_user and role = 'owner' and status = 'active') then
    raise exception '這位使用者是機構的負責人，請先移交負責人後再核准' using errcode = 'CR400';
  end if;

  perform set_config('app.state_scope_override', '1', true);

  -- 預約與行程
  select coalesce(array_agg(s.id), '{}') into v_bookings from app_state s
   where s.collection = 'bookings' and (s.owner_user_id = v_user or s.data->>'requestedByUserId' = v_user);
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
  select coalesce(array_agg(s.id), '{}') into v_trip_ids from app_state s
   where s.collection = 'trips'
     and (s.booking_id = any(v_bookings)
          or (jsonb_typeof(s.data->'bookingIds') = 'array'
              and exists (select 1 from jsonb_array_elements_text(s.data->'bookingIds') b where b = any(v_bookings))));
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
grant execute on function app.review_account_deletion(text, text, text) to care_ride_app;
