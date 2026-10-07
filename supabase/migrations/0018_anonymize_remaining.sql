-- =====================================================================
-- 0018：匿名化剩下的個資（#89）
--
-- #80（0016）之後仍會留下的個資：
--   - 預約的去程／回程地點物件（legs[].pickup／dropoff 的地址與座標）→ 只留行政區
--   - 行程執行快照的司機姓名、電話（executionSnapshots[].resources.driver）→ 只留 ID 與狀態；車輛不是個資，保留
--   - 預約的通知內容（notifications.payload、message_summary）→ 只留預約與行程 ID
--   - 到期匿名化服務對象時，補助試算的事實資料、長照等級、身分別 → 清除（核准刪除帳號原本就清）
--
-- 0016 之前就已匿名化的資料不補清：正式環境上線前沒有資料。
-- 匿名化函式寫入 anonymizedAt（now()），所以是 stable。
-- =====================================================================

create or replace function app.anonymize_booking_data(p_data jsonb)
returns jsonb
language sql stable
as $$
  select p_data
    - 'specialNeed' - 'note' - 'locations' - 'contacts' - 'emergencyContacts'
    || jsonb_build_object(
         'name', null, 'phone', null,
         'pickupAddress', coalesce(p_data->'serverComputed'->'pickup'->>'district', app.approx_area(p_data->>'pickupAddress')),
         'destination', coalesce(p_data->'serverComputed'->'destination'->>'district', app.approx_area(p_data->>'destination')),
         'anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || case when jsonb_typeof(p_data->'serverComputed') = 'object' then jsonb_build_object('serverComputed',
         (p_data->'serverComputed')
           || case when jsonb_typeof(p_data->'serverComputed'->'pickup') = 'object' then jsonb_build_object('pickup',
                jsonb_build_object('district', p_data->'serverComputed'->'pickup'->'district')) else '{}'::jsonb end
           || case when jsonb_typeof(p_data->'serverComputed'->'destination') = 'object' then jsonb_build_object('destination',
                jsonb_build_object('district', p_data->'serverComputed'->'destination'->'district')) else '{}'::jsonb end)
       else '{}'::jsonb end
    || case when jsonb_typeof(p_data->'legs') = 'array' then jsonb_build_object('legs',
         (select coalesce(jsonb_agg(case when jsonb_typeof(l) = 'object'
                    then l || jsonb_build_object('pickupAddress', app.approx_area(l->>'pickupAddress'),
                                                 'destination', app.approx_area(l->>'destination'))
                           -- 地點物件（makeLocationSnapshot：addressText、座標、上車注意事項…）只留縣市與行政區（#89）
                           || case when jsonb_typeof(l->'pickup') = 'object' then jsonb_build_object('pickup',
                                jsonb_strip_nulls(jsonb_build_object(
                                'city', nullif(l->'pickup'->>'city', ''),
                                'district', coalesce(nullif(l->'pickup'->>'district', ''),
                                  app.approx_area(coalesce(l->'pickup'->>'addressText', l->'pickup'->>'address')))))) else '{}'::jsonb end
                           || case when jsonb_typeof(l->'dropoff') = 'object' then jsonb_build_object('dropoff',
                                jsonb_strip_nulls(jsonb_build_object(
                                'city', nullif(l->'dropoff'->>'city', ''),
                                'district', coalesce(nullif(l->'dropoff'->>'district', ''),
                                  app.approx_area(coalesce(l->'dropoff'->>'addressText', l->'dropoff'->>'address')))))) else '{}'::jsonb end
                    else l end order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_data->'legs') with ordinality as x(l, ord)))
       else '{}'::jsonb end
$$;

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
                    then (snap - 'route' - 'needsSummary' - 'passengers' - 'resources')
                         -- 司機只留 ID 與狀態（#89）；車輛（車牌、車型）不是個資，保留
                         || case when jsonb_typeof(snap->'resources') = 'object' then jsonb_build_object('resources',
                              ((snap->'resources') - 'driver')
                              || case when jsonb_typeof(snap->'resources'->'driver') = 'object' then jsonb_build_object('driver',
                                   jsonb_strip_nulls(jsonb_build_object('id', snap->'resources'->'driver'->'id',
                                     'userId', snap->'resources'->'driver'->'userId', 'status', snap->'resources'->'driver'->'status')))
                                 else '{}'::jsonb end)
                            else '{}'::jsonb end
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
grant execute on function app.review_account_deletion(text, text, text) to care_ride_app;
