-- =====================================================================
-- 0009：需求者看得到自己預約的承接單位名稱
--
-- 新增 migration，不改寫已部署的 0001–0008。
--
-- 問題：調度員接案後，預約的 organization_id 指向承接組織；但 organizations 的
-- 讀取政策（0002 org_read）只放行該組織的成員，需求者讀不到那一列，前端
-- bookingServiceOrgName 找不到名稱，「我的預約」顯示「尚未指定承接單位」。
--
-- 做法：不放寬 organizations 政策（放寬會讓需求者看到組織的其他欄位或其他組織），
-- 另外提供一個 security definer 函式，只回傳
--   * 目前使用者「擁有」（owner_user_id，由 0007 觸發器在建立時決定、不可改）
--   * 未刪除、已綁定承接組織
-- 的預約所對應組織的 id 與名稱。不回傳組織類型、狀態、成員、聯絡資料。
--
-- 不改任何資料表、政策或既有函式，不取任何資料表的強鎖。
-- =====================================================================

create or replace function app.my_booking_service_orgs()
returns table (id text, name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct o.id, o.name
    from app_state s
    join organizations o on o.id = s.organization_id
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is not null
     and s.owner_user_id = app.current_user_id()
$$;

revoke all on function app.my_booking_service_orgs() from public;
grant execute on function app.my_booking_service_orgs() to care_ride_app;
