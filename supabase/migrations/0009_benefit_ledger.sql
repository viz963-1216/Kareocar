-- =====================================================================
-- 0009：正式核定額度與補助帳本（#23 第二部分）
--
-- benefit_authorizations：政府核定給服務對象的補助總額（核定文號必填）。
-- benefit_ledger：僅追加的帳本。建立預約時保留（reserve）、取消／不受理／過期時釋放（release）、
--   行程完成時結算（settle）、完成後修正時回轉（settlement_reopened）、管理調整（adjustment）。
--   可用額度 = 核定 + 調整 − 保留中 − 已結算。
--
-- 誰能登錄、撤銷、調整核定：平台超級管理者，以及「正在服務這位服務對象」的機構負責人或調度員
-- （該機構有這位服務對象的預約）。需求者讀得到自己服務對象的核定與帳本，不能改。
--
-- care_ride_app 對兩張表只有 SELECT。保留、釋放、結算的金額由函式從預約的伺服器估算
-- （serverComputed.benefit，見 0008）取得，不接受呼叫端傳入金額；同一個核定以 FOR UPDATE
-- 鎖住，併發的保留不會超出可用額度。
-- =====================================================================

create table benefit_authorizations (
  id                  text primary key,
  recipient_id        text not null,
  organization_id     text references organizations(id),
  program_code        text not null default 'transportation_primary',
  valid_from          date not null,
  valid_to            date,
  approved_amount     numeric(12,2) not null,
  approved_units      numeric(12,2),
  currency            text not null default 'TWD',
  reference_no        text not null,
  source              text not null default 'manual',
  status              text not null default 'active',
  created_by_user_id  text references users(id),
  created_at          timestamptz not null default now(),
  revoked_by_user_id  text references users(id),
  revoked_at          timestamptz,
  revoke_reason       text,
  constraint benefit_authorizations_status_check check (status in ('active', 'revoked')),
  constraint benefit_authorizations_amount_check check (approved_amount >= 0),
  constraint benefit_authorizations_valid_check check (valid_to is null or valid_to >= valid_from),
  constraint benefit_authorizations_reference_check check (btrim(reference_no) <> '')
);
create index benefit_authorizations_recipient_idx on benefit_authorizations (recipient_id, program_code);

create table benefit_ledger (
  id                    text primary key,
  authorization_id      text not null references benefit_authorizations(id),
  recipient_id          text not null,
  booking_id            text,
  trip_id               text,
  entry_type            text not null,
  amount                numeric(12,2) not null default 0,
  reserved_delta        numeric(12,2) not null default 0,
  settled_delta         numeric(12,2) not null default 0,
  authorization_delta   numeric(12,2) not null default 0,
  currency              text not null default 'TWD',
  reason                text,
  actor_user_id         text,
  ruleset_id            text,
  ruleset_version       text,
  source_assessment_id  text,
  created_at            timestamptz not null default now(),
  constraint benefit_ledger_type_check check (entry_type in ('reserve', 'release', 'settle', 'settlement_reopened', 'adjustment'))
);
create index benefit_ledger_authorization_idx on benefit_ledger (authorization_id);
create index benefit_ledger_booking_idx on benefit_ledger (booking_id) where booking_id is not null;

-- ---------------------------------------------------------------------
-- 讀取：平台管理者、服務對象的擁有者、正在服務這位服務對象的機構
-- ---------------------------------------------------------------------
create or replace function app.can_read_recipient_benefit(p_recipient_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or exists (select 1 from app_state s
                  where s.collection = 'careRecipients' and s.id = p_recipient_id
                    and s.owner_user_id = app.current_user_id())
      or exists (select 1 from app_state s
                  where s.collection = 'bookings' and not s.deleted
                    and s.data->>'recipientId' = p_recipient_id
                    and s.organization_id = any(app.my_ops_orgs()))
$$;

-- 能管理核定：平台管理者，或 p_organization_id 的負責人／調度員且該機構正在服務這位服務對象
create or replace function app.can_manage_recipient_benefit(p_recipient_id text, p_organization_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or (p_organization_id is not null
          and app.has_role_in(p_organization_id, array['owner', 'dispatcher'])
          and exists (select 1 from app_state s
                       where s.collection = 'bookings' and not s.deleted
                         and s.data->>'recipientId' = p_recipient_id
                         and s.organization_id = p_organization_id))
$$;

grant execute on function app.can_read_recipient_benefit(text) to care_ride_app;
grant execute on function app.can_manage_recipient_benefit(text, text) to care_ride_app;

alter table benefit_authorizations enable row level security;
alter table benefit_ledger enable row level security;
create policy benefit_authorizations_read on benefit_authorizations for select using (app.can_read_recipient_benefit(recipient_id));
create policy benefit_ledger_read on benefit_ledger for select using (app.can_read_recipient_benefit(recipient_id));
grant select on benefit_authorizations, benefit_ledger to care_ride_app;
revoke insert, update, delete on benefit_authorizations, benefit_ledger from care_ride_app;

-- ---------------------------------------------------------------------
-- 餘額
-- ---------------------------------------------------------------------
create or replace function app.benefit_balance(p_authorization_id text)
returns table (approved numeric, adjustment numeric, reserved numeric, settled numeric, available numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  select a.approved_amount,
         coalesce(sum(l.authorization_delta), 0),
         greatest(coalesce(sum(l.reserved_delta), 0), 0),
         greatest(coalesce(sum(l.settled_delta), 0), 0),
         greatest(a.approved_amount + coalesce(sum(l.authorization_delta), 0)
                  - coalesce(sum(l.reserved_delta), 0) - coalesce(sum(l.settled_delta), 0), 0)
    from benefit_authorizations a
    left join benefit_ledger l on l.authorization_id = a.id
   where a.id = p_authorization_id
   group by a.id, a.approved_amount
$$;
grant execute on function app.benefit_balance(text) to care_ride_app;

create or replace function app.benefit_ledger_id() returns text
language sql volatile as $$ select 'bledger_' || replace(gen_random_uuid()::text, '-', '') $$;

-- ---------------------------------------------------------------------
-- 登錄、撤銷、調整核定
-- ---------------------------------------------------------------------
create or replace function app.save_benefit_authorization(p jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id  text := 'bauth_' || replace(gen_random_uuid()::text, '-', '');
  v_org text := nullif(p->>'organizationId', '');
  v_amount numeric := nullif(p->>'approvedAmount', '')::numeric;
begin
  if not app.can_manage_recipient_benefit(p->>'recipientId', v_org) then
    raise exception '沒有權限登錄這位服務對象的正式核定' using errcode = '42501';
  end if;
  if not exists (select 1 from app_state s where s.collection = 'careRecipients' and s.id = p->>'recipientId' and not s.deleted) then
    raise exception '找不到服務對象' using errcode = 'P0002';
  end if;
  if v_amount is null or v_amount < 0 then
    raise exception '核定總額必須是 0 以上數字' using errcode = 'CR400';
  end if;
  if nullif(p->>'validFrom', '') is null then
    raise exception '請填有效起日' using errcode = 'CR400';
  end if;
  if btrim(coalesce(p->>'referenceNo', '')) = '' then
    raise exception '正式核定請填寫核定文號，避免把試算誤當正式核定' using errcode = 'CR400';
  end if;
  insert into benefit_authorizations (id, recipient_id, organization_id, program_code, valid_from, valid_to,
                                      approved_amount, approved_units, reference_no, source, created_by_user_id)
  values (v_id, p->>'recipientId', v_org, coalesce(nullif(p->>'programCode', ''), 'transportation_primary'),
          (p->>'validFrom')::date, nullif(p->>'validTo', '')::date, v_amount,
          nullif(p->>'approvedUnits', '')::numeric, btrim(p->>'referenceNo'),
          coalesce(nullif(p->>'source', ''), 'manual'), app.current_user_id());
  return v_id;
end $$;

create or replace function app.revoke_benefit_authorization(p_id text, p_reason text, p_organization_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a benefit_authorizations%rowtype;
  v_reserved numeric;
begin
  select * into a from benefit_authorizations where id = p_id for update;
  if not found then
    raise exception '找不到正式核定' using errcode = 'P0002';
  end if;
  if not app.can_manage_recipient_benefit(a.recipient_id, p_organization_id) then
    raise exception '沒有權限撤銷這筆正式核定' using errcode = '42501';
  end if;
  if a.status = 'revoked' then
    return;
  end if;
  select reserved into v_reserved from app.benefit_balance(p_id);
  if v_reserved > 0 then
    raise exception '仍有預約保留額度，請先釋放後再撤銷' using errcode = 'CR400';
  end if;
  update benefit_authorizations
     set status = 'revoked', revoked_at = now(), revoked_by_user_id = app.current_user_id(),
         revoke_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id;
end $$;

create or replace function app.adjust_benefit_authorization(p_id text, p_amount numeric, p_reason text, p_organization_id text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a benefit_authorizations%rowtype;
  b record;
  v_id text := app.benefit_ledger_id();
begin
  select * into a from benefit_authorizations where id = p_id for update;
  if not found then
    raise exception '找不到正式核定' using errcode = 'P0002';
  end if;
  if not app.can_manage_recipient_benefit(a.recipient_id, p_organization_id) then
    raise exception '沒有權限調整這筆正式核定' using errcode = '42501';
  end if;
  if a.status <> 'active' then
    raise exception '已撤銷的核定不能調整' using errcode = 'CR400';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception '調整額度不可為 0' using errcode = 'CR400';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 4 then
    raise exception '請填寫至少 4 個字的調整原因' using errcode = 'CR400';
  end if;
  select * into b from app.benefit_balance(p_id);
  if b.approved + b.adjustment + p_amount < b.reserved + b.settled then
    raise exception '調整後核定總額不能低於已保留＋已結算金額' using errcode = 'CR400';
  end if;
  insert into benefit_ledger (id, authorization_id, recipient_id, entry_type, amount, authorization_delta, currency, reason, actor_user_id)
  values (v_id, p_id, a.recipient_id, 'adjustment', abs(p_amount), p_amount, a.currency, btrim(p_reason), app.current_user_id());
  return v_id;
end $$;

grant execute on function app.save_benefit_authorization(jsonb) to care_ride_app;
grant execute on function app.revoke_benefit_authorization(text, text, text) to care_ride_app;
grant execute on function app.adjust_benefit_authorization(text, numeric, text, text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 預約保留、釋放，行程結算、回轉（金額一律取自伺服器資料，不收呼叫端金額）
-- ---------------------------------------------------------------------
create or replace function app.release_booking_benefit(p_booking_id text, p_reason text)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_total numeric := 0;
begin
  for r in
    select l.authorization_id, l.recipient_id, max(a.currency) as currency, sum(l.reserved_delta) as reserved
      from benefit_ledger l join benefit_authorizations a on a.id = l.authorization_id
     where l.booking_id = p_booking_id
     group by l.authorization_id, l.recipient_id
    having sum(l.reserved_delta) > 0
  loop
    perform 1 from benefit_authorizations where id = r.authorization_id for update;
    insert into benefit_ledger (id, authorization_id, recipient_id, booking_id, entry_type, amount, reserved_delta, currency, reason, actor_user_id)
    values (app.benefit_ledger_id(), r.authorization_id, r.recipient_id, p_booking_id, 'release', r.reserved, -r.reserved,
            r.currency, p_reason, app.current_user_id());
    v_total := v_total + r.reserved;
  end loop;
  return v_total;
end $$;

create or replace function app.reserve_booking_benefit(p_booking_id text, p_reason text)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b        app_state%rowtype;
  v_ben    jsonb;
  v_est    numeric;
  v_date   date;
  v_prog   text;
  a        benefit_authorizations%rowtype;
  v_avail  numeric;
  v_amount numeric;
begin
  select * into b from app_state s where s.collection = 'bookings' and s.id = p_booking_id and not s.deleted;
  if not found then
    return 0;
  end if;
  if coalesce(b.data->>'state', 'open') not in ('open', 'claimed', 'partially_scheduled', 'scheduled') then
    return 0;
  end if;
  if exists (select 1 from benefit_ledger where booking_id = p_booking_id group by booking_id having sum(reserved_delta) > 0) then
    return 0;  -- 已經保留過
  end if;
  v_ben := b.data->'serverComputed'->'benefit';
  v_est := case when jsonb_typeof(v_ben->'estimatedSubsidy') = 'number' then (v_ben->>'estimatedSubsidy')::numeric end;
  if v_est is null or v_est <= 0 or nullif(b.data->>'recipientId', '') is null then
    return 0;
  end if;
  v_date := coalesce(nullif(b.data->>'pickupDate', '')::date, current_date);
  v_prog := coalesce(nullif(v_ben->>'programCode', ''), 'transportation_primary');
  select * into a from benefit_authorizations
   where recipient_id = b.data->>'recipientId' and program_code = v_prog and status = 'active'
     and valid_from <= v_date and (valid_to is null or valid_to >= v_date)
   order by valid_from desc, created_at desc
   limit 1
   for update;
  if not found then
    return 0;
  end if;
  select available into v_avail from app.benefit_balance(a.id);
  v_amount := least(v_est, coalesce(v_avail, 0));
  if v_amount <= 0 then
    return 0;
  end if;
  insert into benefit_ledger (id, authorization_id, recipient_id, booking_id, entry_type, amount, reserved_delta,
                              currency, reason, actor_user_id, ruleset_id, ruleset_version, source_assessment_id)
  values (app.benefit_ledger_id(), a.id, a.recipient_id, p_booking_id, 'reserve', v_amount, v_amount, a.currency,
          p_reason, app.current_user_id(), v_ben->>'rulesetId', v_ben->>'rulesetVersion', v_ben->>'sourceAssessmentId');
  return v_amount;
end $$;

create or replace function app.settle_trip_benefit(p_trip_id text)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t      app_state%rowtype;
  r      record;
  v_total numeric := 0;
begin
  select * into t from app_state s where s.collection = 'trips' and s.id = p_trip_id;
  if not found or coalesce(t.data->>'status', '') <> 'completed' then
    return 0;
  end if;
  for r in
    select l.authorization_id, l.recipient_id, l.booking_id, max(a.currency) as currency, sum(l.reserved_delta) as reserved
      from benefit_ledger l join benefit_authorizations a on a.id = l.authorization_id
     where l.booking_id in (select jsonb_array_elements_text(case when jsonb_typeof(t.data->'bookingIds') = 'array'
                                                                  then t.data->'bookingIds' else '[]'::jsonb end)
                            union select t.data->>'bookingId')
     group by l.authorization_id, l.recipient_id, l.booking_id
    having sum(l.reserved_delta) > 0
  loop
    perform 1 from benefit_authorizations where id = r.authorization_id for update;
    insert into benefit_ledger (id, authorization_id, recipient_id, booking_id, trip_id, entry_type, amount,
                                reserved_delta, settled_delta, currency, reason, actor_user_id)
    values (app.benefit_ledger_id(), r.authorization_id, r.recipient_id, r.booking_id, p_trip_id, 'settle', r.reserved,
            -r.reserved, r.reserved, r.currency, 'trip_completed', app.current_user_id());
    v_total := v_total + r.reserved;
  end loop;
  return v_total;
end $$;

create or replace function app.reopen_trip_benefit_settlement(p_trip_id text)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_total numeric := 0;
begin
  for r in
    select l.authorization_id, l.recipient_id, l.booking_id, max(a.currency) as currency, sum(l.settled_delta) as settled
      from benefit_ledger l join benefit_authorizations a on a.id = l.authorization_id
     where l.trip_id = p_trip_id
     group by l.authorization_id, l.recipient_id, l.booking_id
    having sum(l.settled_delta) > 0
  loop
    perform 1 from benefit_authorizations where id = r.authorization_id for update;
    insert into benefit_ledger (id, authorization_id, recipient_id, booking_id, trip_id, entry_type, amount,
                                reserved_delta, settled_delta, currency, reason, actor_user_id)
    values (app.benefit_ledger_id(), r.authorization_id, r.recipient_id, r.booking_id, p_trip_id, 'settlement_reopened',
            r.settled, r.settled, -r.settled, r.currency, 'trip_correction', app.current_user_id());
    v_total := v_total + r.settled;
  end loop;
  return v_total;
end $$;

grant execute on function app.release_booking_benefit(text, text) to care_ride_app;
grant execute on function app.reserve_booking_benefit(text, text) to care_ride_app;
grant execute on function app.settle_trip_benefit(text) to care_ride_app;
grant execute on function app.reopen_trip_benefit_settlement(text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 需求者取消：與 0007 相同，另外釋放保留的補助額度
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

grant execute on function app.cancel_app_state_booking(text, text, text) to care_ride_app;
