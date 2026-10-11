-- =====================================================================
-- 0031：預約與行程搬表——收斂（#133，ADR 0005 第 4 步）
--
-- 讀寫都已經改到正式資料表（#127–#132），這裡拿掉過渡期的同步，app_state 不再存放預約與行程：
--   - 拿掉 app_state ↔ 正式資料表的雙向同步與一致性檢查
--   - 刪掉 app_state 裡的預約與行程（資料都在 bookings／trips）
--   - 拿掉只對 app_state 預約有用的欄位、索引與司機讀取規則；補助試算的讀取規則改看 bookings
--   - 依服務對象找預約的三個函式改用有索引的 care_recipient_id
--   - 刪掉直接寫舊正式資料表的 baseline 接案函式 app.claim_booking（API 用的是 claim_app_state_booking）
--   - 補上擴充時延後的外鍵（預約→需求者、行程→司機、取消→取消的人）。以 NOT VALID 加上：
--     新寫入一律檢查，既有資料不回頭驗證，避免舊資料讓部署失敗
-- 歸屬規則只套用在應用程式的連線（care_ride_app，含 set role 切換成它）；資料庫擁有者的連線（維運、
-- 測試準備資料）本來就繞過所有權限規則，視為可信任，保留它指定的機構、擁有者與版本。
-- 一般寫入端點（v2-state-mutate）照舊拒絕預約與行程。
-- =====================================================================

drop trigger if exists app_state_sync_typed on app_state;
drop function if exists app.app_state_sync_typed();
drop function if exists app.sync_typed_row(text, text);
drop function if exists app.typed_sync_diff();

create or replace function app.bookings_before_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if session_user = 'care_ride_app' or coalesce(current_setting('role', true), '') = 'care_ride_app' then
    if tg_op = 'UPDATE' then
      if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
        new.organization_id := old.organization_id;
      end if;
      new.owner_user_id := old.owner_user_id;
      new.created_at    := old.created_at;
      new.version       := old.version + 1;
    else
      new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
      if new.organization_id is not null
         and not (app.is_super_admin() or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
        new.organization_id := null;
      end if;
      new.version    := greatest(1, coalesce(new.version, 1));
      new.created_at := coalesce(new.created_at, now());
    end if;
    new.updated_at := now();
  end if;
  new.care_recipient_id    := nullif(new.data->>'recipientId', '');
  new.requested_by_user_id := nullif(new.data->>'requestedByUserId', '');
  new.state                := coalesce(nullif(new.data->>'state', ''), 'open');
  new.pickup_at            := app.booking_pickup_at(new.data);
  new.pickup_address       := new.data->>'pickupAddress';
  new.destination          := new.data->>'destination';
  new.trip_type            := new.data->>'tripType';
  new.passenger_count      := app.try_int(new.data->>'passengerCount', 1);
  new.wheelchair_slots     := app.try_int(new.data->>'wheelchairSlots', 0);
  new.special_needs        := new.data->>'specialNeeds';
  new.rideshare_consent    := coalesce(new.data->>'rideshareConsent', '') = 'true';
  new.terms_version        := new.data->>'termsVersion';
  new.market_expires_at    := app.try_timestamptz(new.data->>'marketExpiresAt');
  return new;
end $$;

create or replace function app.trips_before_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if session_user = 'care_ride_app' or coalesce(current_setting('role', true), '') = 'care_ride_app' then
    if tg_op = 'UPDATE' then
      if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
        new.organization_id := old.organization_id;
      end if;
      new.owner_user_id := old.owner_user_id;
      new.created_at    := old.created_at;
      new.version       := coalesce(old.version, 0) + 1;
    else
      new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
      if new.organization_id is not null
         and not (app.is_super_admin() or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
        new.organization_id := null;
      end if;
      new.version    := greatest(1, coalesce(new.version, 1));
      new.created_at := coalesce(new.created_at, now());
    end if;
    new.updated_at := now();
  end if;
  new.driver_id        := nullif(new.data->>'driverId', '');
  new.vehicle_id       := nullif(new.data->>'vehicleId', '');
  new.state            := coalesce(nullif(new.data->>'status', ''), 'scheduled');
  new.planned_start_at := app.try_timestamptz(new.data->'steps'->0->>'scheduledAt');
  new.planned_end_at   := app.try_timestamptz(new.data->'steps'->-1->>'scheduledAt');
  new.actual_start_at  := app.try_timestamptz(new.data->>'startedAt');
  new.actual_end_at    := app.try_timestamptz(new.data->>'completedAt');
  return new;
end $$;

create or replace function app.bookings_after_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from booking_legs where booking_id = new.id;
  insert into booking_legs (booking_id, id, direction, sequence, status, scheduled_organization_id, trip_id,
                            requested_pickup_at, scheduled_at, data)
  select new.id, coalesce(nullif(l->>'id', ''), new.id || '#' || n), l->>'direction', app.try_int(l->>'sequence', n::int),
         coalesce(nullif(l->>'status', ''), 'pending'), nullif(l->>'scheduledOrganizationId', ''), nullif(l->>'tripId', ''),
         app.try_timestamptz(l->>'requestedPickupAt'), app.try_timestamptz(l->>'scheduledAt'), l
    from jsonb_array_elements(case when jsonb_typeof(new.data->'legs') = 'array' then new.data->'legs' else '[]'::jsonb end)
         with ordinality as x(l, n)
   where jsonb_typeof(l) = 'object'
  on conflict (booking_id, id) do nothing;

  if coalesce(new.data->>'state', '') = 'cancelled' then
    insert into cancellations (id, booking_id, cancelled_by_user_id, cancelled_at, from_state, reason, status, note, data)
    values ('CXL-' || new.id, new.id, nullif(new.data->>'cancelledByUserId', ''),
            coalesce(app.try_timestamptz(new.data->>'cancelledAt'), new.updated_at), nullif(new.data->>'cancelledFromState', ''),
            nullif(new.data->>'cancelReasonCode', ''), 'completed', nullif(new.data->>'cancelReasonText', ''),
            jsonb_build_object('cancelledTripIds', coalesce(new.data->'cancelledTripIds', '[]'::jsonb)))
    on conflict (id) do update set
      cancelled_by_user_id = excluded.cancelled_by_user_id, cancelled_at = excluded.cancelled_at,
      from_state = excluded.from_state, reason = excluded.reason, note = excluded.note, data = excluded.data;
  else
    delete from cancellations where booking_id = new.id;
  end if;

  return new;
end $$;

create or replace function app.trips_after_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from trip_bookings where trip_id = new.id;
  insert into trip_bookings (id, trip_id, booking_id, leg_id, sequence)
  select new.id || '|' || r.booking_id || '|' || coalesce(r.leg_id, ''), new.id, r.booking_id, r.leg_id, min(r.n)::int
    from (
      select nullif(ref->>'bookingId', '') as booking_id, nullif(ref->>'legId', '') as leg_id, n
        from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingLegRefs') = 'array'
                                       then new.data->'bookingLegRefs' else '[]'::jsonb end) with ordinality as x(ref, n)
       where jsonb_typeof(ref) = 'object'
      union all
      select b #>> '{}', null, n
        from jsonb_array_elements(case when jsonb_typeof(new.data->'bookingIds') = 'array'
                                       then new.data->'bookingIds' else '[]'::jsonb end) with ordinality as y(b, n)
       where jsonb_typeof(b) = 'string'
         and not coalesce(jsonb_typeof(new.data->'bookingLegRefs') = 'array' and jsonb_array_length(new.data->'bookingLegRefs') > 0, false)
    ) r
   where r.booking_id is not null
   group by r.booking_id, r.leg_id;

  return new;
end $$;

-- 補助試算的讀取規則：「正在服務這位服務對象的機構」原本看 app_state 的預約，改看 bookings
drop policy if exists benefit_read on benefit_assessments;
create policy benefit_read on benefit_assessments for select
  using (app.is_super_admin()
         or created_by_user_id = app.current_user_id()
         or exists (select 1 from app_state s
                     where s.collection = 'careRecipients' and s.id = benefit_assessments.care_recipient_id
                       and s.owner_user_id = app.current_user_id())
         or exists (select 1 from bookings b
                     where not b.deleted
                       and b.care_recipient_id = benefit_assessments.care_recipient_id
                       and b.organization_id = any(app.my_ops_orgs())));

-- 依服務對象找預約改用有索引的 care_recipient_id（由觸發器從 data.recipientId 帶出，意義相同）；
-- 原本比對 data->>'recipientId' 每次都掃整張 bookings（#125 效能測試：服務對象還沒完成的預約變慢）
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
                    and s.care_recipient_id = p_recipient_id
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
                         and s.care_recipient_id = p_recipient_id
                         and s.organization_id = p_organization_id))
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
     where not b.deleted and b.care_recipient_id = p_recipient_id
       and app.booking_benefit_refreshable(b.data)
     order by b.id;
end $$;

delete from app_state where collection in ('bookings', 'trips');

drop policy if exists app_state_driver_read on app_state;
drop index if exists app_state_pool_idx;
alter table app_state drop column booking_state, drop column pickup_at;

drop function if exists app.claim_booking(text, text);

alter table bookings add constraint bookings_requested_by_user_id_fkey
  foreign key (requested_by_user_id) references users(id) on delete set null not valid;
alter table trips add constraint trips_driver_id_fkey
  foreign key (driver_id) references drivers(id) on delete set null not valid;
alter table cancellations add constraint cancellations_cancelled_by_user_id_fkey
  foreign key (cancelled_by_user_id) references users(id) not valid;
