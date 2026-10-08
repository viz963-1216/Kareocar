-- 回復 0019：到期匿名化改回 0018 的版本
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
