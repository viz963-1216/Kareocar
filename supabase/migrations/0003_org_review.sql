-- =====================================================================
-- 0003：機構申請與平台管理員審核
--
-- 共享需求池上是長者的行程與個資，機構要經平台管理員人工審核後才能進入。
--   pending    已申請，等待審核
--   approved   已核准：成員可以瀏覽需求池、接案
--   rejected   已駁回
--   suspended  已停權：暫時不能瀏覽需求池、接案
--
-- 審核欄位只能經 app.review_organization 改（只有平台超級管理者能呼叫），每次決定
-- 都在同一個交易內寫入稽核紀錄。機構負責人能改自己組織的名稱、電話等欄位
-- （org_update 政策），但改不到審核欄位（觸發器擋下）。
--
-- 既有的組織（平台管理者直接建立的、需求者組織）視為已核准：organizations 的
-- insert 政策本來就只放行平台超級管理者。自行申請的機構一律從 pending 開始。
-- =====================================================================

alter table organizations
  add column review_status       text not null default 'approved',
  add column reviewed_by_user_id text references users(id),
  add column reviewed_at         timestamptz,
  add column review_note         text,
  add column application         jsonb not null default '{}'::jsonb,
  add column applied_by_user_id  text references users(id),
  add column applied_at          timestamptz,
  add constraint organizations_review_status_check
    check (review_status in ('pending', 'approved', 'rejected', 'suspended'));

-- ---------------------------------------------------------------------
-- 審核欄位只能經受控函式修改
-- ---------------------------------------------------------------------
create function app.guard_org_review() returns trigger
language plpgsql as $$
begin
  -- 只約束應用角色；受控函式以擁有者身分執行，DBA 直連也不擋
  if current_user = 'care_ride_app'
     and (new.review_status       is distinct from old.review_status
       or new.reviewed_by_user_id is distinct from old.reviewed_by_user_id
       or new.reviewed_at         is distinct from old.reviewed_at
       or new.review_note         is distinct from old.review_note
       or new.application         is distinct from old.application
       or new.applied_by_user_id  is distinct from old.applied_by_user_id
       or new.applied_at          is distinct from old.applied_at) then
    raise exception '機構審核狀態只能由平台管理員審核' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger organizations_guard_review before update on organizations
  for each row execute function app.guard_org_review();

-- ---------------------------------------------------------------------
-- 需求池與接案：只有已核准、啟用中的服務組織的營運方
-- ---------------------------------------------------------------------
create function app.operates_any_approved() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
     where m.user_id = app.current_user_id()
       and m.status = 'active'
       and m.role in ('owner', 'dispatcher')
       and o.active
       and o.review_status = 'approved'
       and o.org_type in ('transport_provider', 'care_facility'))
$$;
grant execute on function app.operates_any_approved() to care_ride_app;

create or replace view app_state_booking_pool as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         s.pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at,
         nullif(s.data->>'pickupTime', '')      as pickup_time,
         nullif(s.data->>'returnDate', '')      as return_date,
         nullif(s.data->>'returnTime', '')      as return_time,
         nullif(s.data->>'marketExpiresAt', '') as market_expires_at,
         left(nullif(s.data->>'aidNeed', ''), 20) as aid_need,
         case when coalesce(s.data->>'companions', '') ~ '^[0-9]{1,2}$'
              then (s.data->>'companions')::int else 0 end as companions
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     and (app.is_super_admin() or app.operates_any_approved());

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

-- ---------------------------------------------------------------------
-- 申請：登入中的使用者提出機構申請，成為該機構（pending）的負責人
-- ---------------------------------------------------------------------
create function app.apply_organization(
  p_org_id text, p_membership_id text, p_name text, p_org_type text,
  p_tax_id text, p_contact_phone text, p_application jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  me text := app.current_user_id();
begin
  if me is null or not exists (select 1 from users u where u.id = me and u.active) then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if app.is_super_admin() then
    raise exception '平台超級管理者請直接建立組織' using errcode = '42501';
  end if;
  if p_org_type not in ('transport_provider', 'care_facility') then
    raise exception '機構類型只能是交通／車隊公司或長照／日照機構' using errcode = 'CR400';
  end if;
  if btrim(coalesce(p_name, '')) = '' or length(p_name) > 120 then
    raise exception '請輸入機構名稱' using errcode = 'CR400';
  end if;
  if exists (select 1 from memberships m join organizations o on o.id = m.organization_id
              where m.user_id = me and m.role = 'owner' and m.status = 'active'
                and o.review_status = 'pending') then
    raise exception '你已經有一件審核中的申請，請等待審核結果' using errcode = 'CR400';
  end if;

  insert into organizations (id, org_type, name, tax_id, contact_phone, active,
                             review_status, application, applied_by_user_id, applied_at)
  values (p_org_id, p_org_type, btrim(p_name), nullif(btrim(coalesce(p_tax_id, '')), ''),
          nullif(btrim(coalesce(p_contact_phone, '')), ''), true,
          'pending', coalesce(p_application, '{}'::jsonb), me, now());

  insert into memberships (id, user_id, organization_id, role, status)
  values (p_membership_id, me, p_org_id, 'owner', 'active');

  insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'organization.applied', me, p_org_id,
          'organization', p_org_id, 'ORG_APPLICATION',
          jsonb_build_object('orgType', p_org_type, 'membershipId', p_membership_id));
  return p_org_id;
end $$;
grant execute on function app.apply_organization(text, text, text, text, text, text, jsonb) to care_ride_app;

-- ---------------------------------------------------------------------
-- 審核：只有平台超級管理者。決定與稽核紀錄在同一個交易
--   approve  pending／rejected／suspended → approved
--   reject   pending → rejected（必須填原因）
--   suspend  approved → suspended（必須填原因）
-- ---------------------------------------------------------------------
create function app.review_organization(p_org_id text, p_decision text, p_note text)
returns table (organization_id text, review_status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  me      text := app.current_user_id();
  v_current text;
  v_next    text;
  v_note    text := left(btrim(coalesce(p_note, '')), 500);
begin
  if not app.is_super_admin() then
    raise exception '只有平台管理員可以審核機構' using errcode = '42501';
  end if;
  select o.review_status into v_current
    from organizations o
   where o.id = p_org_id and o.org_type <> 'requester_hub'
     for update;
  if not found then
    raise exception '找不到這個機構' using errcode = 'P0002';
  end if;

  v_next := case
    when p_decision = 'approve' and v_current in ('pending', 'rejected', 'suspended') then 'approved'
    when p_decision = 'reject'  and v_current = 'pending'  then 'rejected'
    when p_decision = 'suspend' and v_current = 'approved' then 'suspended'
    else null end;
  if v_next is null then
    raise exception '機構目前是 %，不能執行 %', v_current, p_decision using errcode = 'CR400';
  end if;
  if v_next in ('rejected', 'suspended') and v_note = '' then
    raise exception '駁回或停權必須填寫原因' using errcode = 'CR400';
  end if;

  update organizations o
     set review_status = v_next, reviewed_by_user_id = me, reviewed_at = now(),
         review_note = nullif(v_note, ''), updated_at = now()
   where o.id = p_org_id;

  insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, reason_code, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'organization.reviewed', me, p_org_id,
          'organization', p_org_id, upper('ORG_' || p_decision),
          jsonb_build_object('from', v_current, 'to', v_next, 'note', v_note));

  return query select p_org_id, v_next;
end $$;
grant execute on function app.review_organization(text, text, text) to care_ride_app;
