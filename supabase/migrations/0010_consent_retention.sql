-- =====================================================================
-- 0010：同意紀錄與保存期限匿名化（#26 第一部分）
--
-- app_settings：平台設定。retention_years（預設 5）與 legal_documents（個資告知、服務條款的
--   目前版本）。只有平台超級管理者能改（app.set_platform_setting）。
--   條款內容由律師撰寫，尚未發布前版本是 null，系統不要求同意；發布版本後，沒有同意最新版本的
--   使用者不能建立預約，前端會要求先同意。
-- consent_records：使用者同意哪一份文件的哪個版本、什麼時間。只能經 app.accept_consent 寫入，
--   而且只接受目前版本。
-- app.anonymize_expired_records：行程日期超過保存期限的預約與行程，清除姓名、電話、完整地址、
--   座標與自由文字，保留行政區、日期、距離、金額。每一筆都寫稽核紀錄。由每日排程呼叫，
--   平台管理者也能手動執行。
-- =====================================================================

create table app_settings (
  key                 text primary key,
  value               jsonb not null,
  updated_by_user_id  text references users(id),
  updated_at          timestamptz not null default now()
);
alter table app_settings enable row level security;
create policy app_settings_read on app_settings for select using (app.current_user_id() is not null);
grant select on app_settings to care_ride_app;

insert into app_settings (key, value) values
  ('retention_years', '5'::jsonb),
  ('legal_documents', jsonb_build_object(
     'privacy_notice', jsonb_build_object('title', '個人資料蒐集告知', 'version', null, 'url', null),
     'terms',          jsonb_build_object('title', '服務條款',         'version', null, 'url', null)));

create or replace function app.set_platform_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以修改平台設定' using errcode = '42501';
  end if;
  if p_key = 'retention_years' then
    if jsonb_typeof(p_value) <> 'number' or (p_value::text)::numeric < 1 or (p_value::text)::numeric > 30
       or (p_value::text)::numeric <> round((p_value::text)::numeric) then
      raise exception '保存期限必須是 1 到 30 的整數年' using errcode = 'CR400';
    end if;
  elsif p_key = 'legal_documents' then
    if jsonb_typeof(p_value) <> 'object' then
      raise exception '條款設定格式錯誤' using errcode = 'CR400';
    end if;
  else
    raise exception '不支援的設定：%', p_key using errcode = 'CR400';
  end if;
  insert into app_settings (key, value, updated_by_user_id, updated_at)
  values (p_key, p_value, app.current_user_id(), now())
  on conflict (key) do update set value = excluded.value, updated_by_user_id = excluded.updated_by_user_id, updated_at = now();
end $$;
grant execute on function app.set_platform_setting(text, jsonb) to care_ride_app;

-- ---------------------------------------------------------------------
-- 同意紀錄
-- ---------------------------------------------------------------------
create table consent_records (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  document     text not null,
  version      text not null,
  accepted_at  timestamptz not null default now(),
  user_agent   text,
  unique (user_id, document, version)
);
alter table consent_records enable row level security;
create policy consent_records_read on consent_records for select
  using (app.is_super_admin() or user_id = app.current_user_id());
grant select on consent_records to care_ride_app;

-- 目前登入者還沒同意的文件（只算已發布版本的文件）
create or replace function app.consent_missing()
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(d.key order by d.key), '{}')
    from app_settings s, jsonb_each(s.value) d
   where s.key = 'legal_documents'
     and nullif(d.value->>'version', '') is not null
     and not exists (select 1 from consent_records c
                      where c.user_id = app.current_user_id()
                        and c.document = d.key and c.version = d.value->>'version')
$$;
grant execute on function app.consent_missing() to care_ride_app;

create or replace function app.accept_consent(p_document text, p_version text, p_user_agent text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_current text;
  v_id text := 'consent_' || replace(gen_random_uuid()::text, '-', '');
begin
  if app.current_user_id() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  select value->p_document->>'version' into v_current from app_settings where key = 'legal_documents';
  if v_current is null then
    raise exception '這份文件尚未發布' using errcode = 'CR400';
  end if;
  if v_current <> p_version then
    raise exception '文件已改版，請重新閱讀最新版本（%）', v_current using errcode = 'CR400';
  end if;
  insert into consent_records (id, user_id, document, version, user_agent)
  values (v_id, app.current_user_id(), p_document, p_version, left(p_user_agent, 300))
  on conflict (user_id, document, version) do nothing;
  return v_id;
end $$;
grant execute on function app.accept_consent(text, text, text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 匿名化
-- ---------------------------------------------------------------------
-- 預約：清除姓名、電話、完整地址、座標、自由文字；保留行政區、日期、時間、距離、車程、金額
create or replace function app.anonymize_booking_data(p_data jsonb)
returns jsonb
language sql immutable
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
                    else l end order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_data->'legs') with ordinality as x(l, ord)))
       else '{}'::jsonb end
$$;

-- 行程：沿用 0005 的 redact_trip_pii，另外移除定位軌跡與服務證明的收受人、照片
create or replace function app.anonymize_trip_data(p_data jsonb)
returns jsonb
language sql immutable
as $$
  select app.redact_trip_pii(p_data) - 'locationSamples' - 'liveNavigation'
    || jsonb_build_object('anonymizedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || case when jsonb_typeof(p_data->'serviceProofs') = 'array' then jsonb_build_object('serviceProofs',
         (select coalesce(jsonb_agg(case when jsonb_typeof(p) = 'object'
                    then (p - 'photo' - 'signature' - 'gps') || jsonb_build_object('receiverName', null)
                    else p end order by ord), '[]'::jsonb)
            from jsonb_array_elements(p_data->'serviceProofs') with ordinality as x(p, ord)))
       else '{}'::jsonb end
$$;

-- 回傳匿名化了哪些資料。只在系統排程（沒有登入者）或平台超級管理者呼叫時執行。
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
    insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, reason_code, details)
    values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'retention.anonymized', app.current_user_id(),
            'trip', r.id, 'RETENTION_EXPIRED', jsonb_build_object('retentionYears', v_years, 'cutoff', v_cutoff));
    kind := 'trip'; id := r.id; return next;
  end loop;
  perform set_config('app.state_scope_override', '0', true);
end $$;
grant execute on function app.anonymize_expired_records(date) to care_ride_app;
