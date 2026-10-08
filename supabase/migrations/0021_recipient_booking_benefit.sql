-- =====================================================================
-- 0021：重新試算時更新預約上的補助估算（#102）
--
-- 用語表：補助試算每位服務對象保留最近一次；重新試算後，這位服務對象還沒完成的預約改用新的試算
-- 估算，已完成的保留原樣。預約可能是需求者自己建立的，也可能是承接機構替服務對象建立的，
-- 需求者在 RLS 之下改不到後者，所以由這兩個受控函式處理。
--
--   app.booking_benefit_refreshable(預約資料)
--                         預約還沒結束：不是取消／婉拒／過期，也不是每一段行程都已完成
--   app.recipient_refreshable_bookings(服務對象)
--                         列出要更新的預約（ID 與接送日期）；只有服務對象建立者與平台管理者能呼叫
--   app.set_booking_benefit(預約, 補助估算)
--                         寫入 serverComputed.benefit 與報價快照裡的補助；同樣的權限與條件
-- 估算由 API（_benefit.js）依接送日期的規則算好再傳進來；使用者沒有直接連資料庫的管道。
-- =====================================================================

create or replace function app.booking_benefit_refreshable(p_data jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(p_data->>'state', '') not in ('cancelled', 'rejected', 'expired')
     and not coalesce((
       select bool_and(coalesce(t.data->>'status', '') = 'completed')
         from jsonb_array_elements(case when jsonb_typeof(p_data->'legs') = 'array' then p_data->'legs' else '[]'::jsonb end) leg
         left join app_state t on t.collection = 'trips' and t.id = leg->>'tripId' and not t.deleted
        where coalesce(leg->>'status', '') <> 'cancelled'), false)
$$;

create or replace function app.can_refresh_recipient_benefit(p_recipient_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select app.is_super_admin()
      or exists (select 1 from app_state r where r.collection = 'careRecipients' and r.id = p_recipient_id
                    and not r.deleted and r.owner_user_id = app.current_user_id())
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
      from app_state b
     where b.collection = 'bookings' and not b.deleted and b.data->>'recipientId' = p_recipient_id
       and app.booking_benefit_refreshable(b.data)
     order by b.id;
end $$;

create or replace function app.set_booking_benefit(p_booking_id text, p_benefit jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_data jsonb;
begin
  select b.data into v_data from app_state b
   where b.collection = 'bookings' and b.id = p_booking_id and not b.deleted for update;
  if v_data is null then
    raise exception '找不到預約' using errcode = 'P0002';
  end if;
  if not app.can_refresh_recipient_benefit(v_data->>'recipientId') then
    raise exception '只有建立這位服務對象的人可以更新預約的補助估算' using errcode = '42501';
  end if;
  if jsonb_typeof(p_benefit) is distinct from 'object' then
    raise exception '補助估算格式不正確' using errcode = 'CR400';
  end if;
  -- 已結束的預約保留原樣
  if not app.booking_benefit_refreshable(v_data) then
    return false;
  end if;
  v_data := jsonb_set(v_data, '{serverComputed}', coalesce(v_data->'serverComputed', '{}'::jsonb) || jsonb_build_object('benefit', p_benefit));
  if jsonb_typeof(v_data->'commercialSnapshots') = 'array' then
    v_data := jsonb_set(v_data, '{commercialSnapshots}', (
      select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object' then s || jsonb_build_object('benefit', p_benefit) else s end order by n), '[]'::jsonb)
        from jsonb_array_elements(v_data->'commercialSnapshots') with ordinality as x(s, n)));
  end if;
  update app_state set data = v_data where collection = 'bookings' and id = p_booking_id;
  return true;
end $$;

revoke all on function app.booking_benefit_refreshable(jsonb) from public;
revoke all on function app.can_refresh_recipient_benefit(text) from public;
revoke all on function app.recipient_refreshable_bookings(text) from public;
revoke all on function app.set_booking_benefit(text, jsonb) from public;
grant execute on function app.recipient_refreshable_bookings(text) to care_ride_app;
grant execute on function app.set_booking_benefit(text, jsonb) to care_ride_app;
