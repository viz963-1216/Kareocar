-- =====================================================================
-- 回復 0003_org_review：移除機構審核
--
-- 審核狀態、申請資料與審核紀錄欄位一併刪除（稽核紀錄 audit_events 保留）。
-- 需求池與接案回到「營運方即可」。
-- =====================================================================

drop function app.review_organization(text, text, text);
drop function app.apply_organization(text, text, text, text, text, text, jsonb);

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
     and (app.is_super_admin() or app.operates_any());

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

drop function app.operates_any_approved();
drop trigger organizations_guard_review on organizations;
drop function app.guard_org_review();

alter table organizations
  drop constraint organizations_review_status_check,
  drop column applied_at,
  drop column applied_by_user_id,
  drop column application,
  drop column review_note,
  drop column reviewed_at,
  drop column reviewed_by_user_id,
  drop column review_status;
