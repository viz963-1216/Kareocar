-- =====================================================================
-- 0027：通知與補助的查詢改讀正式資料表（#130，ADR 0005 第 2 步）
--
--   app.notify_booking_requester        通知需求者時讀預約（收件人、日期）
--   app.reserve_booking_benefit         補助額度保留時讀預約的估算（保留目前暫停，#98）
--   app.settle_trip_benefit             行程完成結算時讀行程的預約
--   app.can_read_recipient_benefit／can_manage_recipient_benefit
--                                       承接機構是否正在服務這位服務對象
--   app.booking_benefit_refreshable     預約的行程是否都已完成
--   app.recipient_refreshable_bookings  服務對象還沒完成的預約（重新試算時更新，#102）
-- 全部只讀；長照特約判斷（v2-state-load）在 #127 已改讀 bookings。
-- =====================================================================

create or replace function app.notify_booking_requester(
  p_booking_id text, p_template text, p_payload jsonb, p_source text, p_dedupe_key text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings s
   where s.id = p_booking_id and not s.deleted;
  if not found then
    return null;
  end if;
  return app.enqueue_notification(
    coalesce(nullif(b.data->>'requestedByUserId', ''), b.owner_user_id),
    coalesce(b.organization_id, 'ORG-REQ-001'), p_booking_id, null,
    p_template, p_template,
    jsonb_build_object('bookingId', p_booking_id,
                       'pickupDate', b.data->>'pickupDate', 'pickupTime', b.data->>'pickupTime')
      || coalesce(p_payload, '{}'::jsonb),
    p_source, p_dedupe_key);
end $$;

create or replace function app.reserve_booking_benefit(p_booking_id text, p_reason text)
returns numeric
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  b        bookings%rowtype;
  v_ben    jsonb;
  v_est    numeric;
  v_date   date;
  v_prog   text;
  a        benefit_authorizations%rowtype;
  v_avail  numeric;
  v_amount numeric;
begin
  select * into b from bookings s where s.id = p_booking_id and not s.deleted;
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
  t      trips%rowtype;
  r      record;
  v_total numeric := 0;
begin
  select * into t from trips s where s.id = p_trip_id;
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

create or replace function app.can_read_recipient_benefit(p_recipient_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or exists (select 1 from app_state s
                  where s.collection = 'careRecipients' and s.id = p_recipient_id
                    and s.owner_user_id = app.current_user_id())
      or exists (select 1 from bookings s
                  where not s.deleted
                    and s.data->>'recipientId' = p_recipient_id
                    and s.organization_id = any(app.my_ops_orgs()))
$$;

create or replace function app.can_manage_recipient_benefit(p_recipient_id text, p_organization_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or (p_organization_id is not null
          and app.has_role_in(p_organization_id, array['owner', 'dispatcher'])
          and exists (select 1 from bookings s
                       where not s.deleted
                         and s.data->>'recipientId' = p_recipient_id
                         and s.organization_id = p_organization_id))
$$;

create or replace function app.booking_benefit_refreshable(p_data jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(p_data->>'state', '') not in ('cancelled', 'rejected', 'expired')
     and not coalesce((
       select bool_and(coalesce(t.data->>'status', '') = 'completed')
         from jsonb_array_elements(case when jsonb_typeof(p_data->'legs') = 'array' then p_data->'legs' else '[]'::jsonb end) leg
         left join trips t on t.id = leg->>'tripId' and not t.deleted
        where coalesce(leg->>'status', '') <> 'cancelled'), false)
$$;

create or replace function app.recipient_refreshable_bookings(p_recipient_id text)
returns table (id text, pickup_date text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not app.can_refresh_recipient_benefit(p_recipient_id) then
    raise exception '只有建立這位服務對象的人可以更新預約的補助估算' using errcode = '42501';
  end if;
  return query
    select b.id, b.data->>'pickupDate'
      from bookings b
     where not b.deleted and b.data->>'recipientId' = p_recipient_id
       and app.booking_benefit_refreshable(b.data)
     order by b.id;
end $$;
