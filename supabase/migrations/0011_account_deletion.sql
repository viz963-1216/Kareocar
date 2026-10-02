-- =====================================================================
-- 0011：刪除帳號與個資申請（#26 第二部分）
--
-- 使用者提出申請（pending），可自行撤回（cancelled）；平台超級管理者駁回（rejected，需填原因）
-- 或核准。核准時在同一交易內執行（completed）：
--   - 這位使用者的預約與相關行程匿名化（與保存期限匿名化相同的規則）
--   - 他建立的服務對象清除內容並標記刪除；補助試算清除事實資料，金額與規則版本保留
--   - 寄給他的通知刪除；成員資格撤銷；帳號停用並清除姓名、電話、Email，既有登入立即失效
--   - 同意紀錄與稽核紀錄保留（法遵證明）
-- 還有未結束的預約（今天以後、尚未取消）或他是機構的啟用中負責人時不能核准。
-- Supabase Auth 帳號由 v2-account-deletion 在交易成功後刪除。
-- =====================================================================

create table deletion_requests (
  id                  text primary key,
  user_id             text not null references users(id),
  status              text not null default 'pending',
  reason              text,
  requested_at        timestamptz not null default now(),
  reviewed_by_user_id text references users(id),
  reviewed_at         timestamptz,
  review_note         text,
  completed_at        timestamptz,
  summary             jsonb not null default '{}'::jsonb,
  constraint deletion_requests_status_check check (status in ('pending', 'cancelled', 'rejected', 'completed'))
);
create unique index deletion_requests_one_pending_idx on deletion_requests (user_id) where status = 'pending';

alter table deletion_requests enable row level security;
create policy deletion_requests_read on deletion_requests for select
  using (app.is_super_admin() or user_id = app.current_user_id());
grant select on deletion_requests to care_ride_app;

create or replace function app.request_account_deletion(p_reason text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id text := 'delreq_' || replace(gen_random_uuid()::text, '-', '');
begin
  if app.current_user_id() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if app.is_super_admin() then
    raise exception '平台超級管理者帳號不能經申請刪除' using errcode = 'CR400';
  end if;
  if exists (select 1 from deletion_requests where user_id = app.current_user_id() and status = 'pending') then
    raise exception '你已經有一件處理中的刪除申請' using errcode = 'CR400';
  end if;
  insert into deletion_requests (id, user_id, reason) values (v_id, app.current_user_id(), left(btrim(coalesce(p_reason, '')), 500));
  return v_id;
end $$;

create or replace function app.cancel_account_deletion(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update deletion_requests set status = 'cancelled', reviewed_at = now()
   where id = p_id and user_id = app.current_user_id() and status = 'pending';
  if not found then
    raise exception '找不到可撤回的申請' using errcode = 'P0002';
  end if;
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
  update app_state s set data = app.anonymize_booking_data(s.data)
   where s.collection = 'bookings' and s.id = any(v_bookings) and not (s.data ? 'anonymizedAt');
  update app_state s set data = app.anonymize_trip_data(s.data)
   where s.collection = 'trips' and not (s.data ? 'anonymizedAt')
     and (s.booking_id = any(v_bookings)
          or (jsonb_typeof(s.data->'bookingIds') = 'array'
              and exists (select 1 from jsonb_array_elements_text(s.data->'bookingIds') b where b = any(v_bookings))));
  get diagnostics v_trips = row_count;

  -- 服務對象與補助試算
  select coalesce(array_agg(s.id), '{}') into v_recipients from app_state s
   where s.collection = 'careRecipients' and s.owner_user_id = v_user;
  update app_state s set deleted = true,
         data = jsonb_build_object('id', s.id, 'status', 'deleted', 'deletedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where s.collection = 'careRecipients' and s.id = any(v_recipients);
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

  v_summary := jsonb_build_object('bookings', coalesce(array_length(v_bookings, 1), 0), 'trips', v_trips,
                                  'careRecipients', coalesce(array_length(v_recipients, 1), 0), 'notifications', v_ntf);
  update deletion_requests set status = 'completed', reviewed_by_user_id = app.current_user_id(), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''), completed_at = now(), summary = v_summary
   where id = p_id;
  insert into audit_events (id, event_type, actor_user_id, entity_type, entity_id, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'account.deletion_completed', app.current_user_id(),
          'deletion_request', p_id, v_summary || jsonb_build_object('userId', v_user));
  return jsonb_build_object('status', 'completed', 'userId', v_user, 'summary', v_summary);
end $$;

grant execute on function app.request_account_deletion(text) to care_ride_app;
grant execute on function app.cancel_account_deletion(text) to care_ride_app;
grant execute on function app.review_account_deletion(text, text, text) to care_ride_app;
