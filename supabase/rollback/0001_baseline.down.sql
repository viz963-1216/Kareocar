-- =====================================================================
-- 回復 0001_baseline：移除 baseline 建立的所有物件（資料一併刪除）
--
-- 只用在「從空資料庫套用 baseline」的環境，例如 Staging 重建或 CI 的往返驗證。
-- 正式環境有資料之後，不要用這支回復，改寫新的 migration 往前修。
--
-- 刻意保留、不刪的東西：
--   * care_ride_app 角色：角色是整個叢集共用的，其他資料庫可能還授權給它；
--     baseline 以「不存在才建立」處理，所以再套用一次不會衝突
--   * pgcrypto 擴充：可能被其他 schema 使用
-- =====================================================================

drop view if exists app_state_booking_pool;
drop view if exists public_booking_pool;

drop table if exists
  app_state, auth_rate_limits,
  audit_events, kpi_daily, system_reports, benefit_assessments, notifications,
  dispatch_plans, cancellations, quote_snapshots, booking_events, telemetry_events,
  issues, service_proofs, trip_bookings, trips, bookings, vehicles, drivers,
  care_recipient_contacts, care_recipients, memberships, password_credentials,
  users, organizations
  cascade;

-- app schema：輔助函式、security definer 函式、通知來源證明表
drop schema if exists app cascade;

-- 把 baseline 授予 care_ride_app 的預設權限與 schema 權限收回，讓資料庫回到套用前的樣子
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'care_ride_app') then
    alter default privileges in schema public
      revoke select, insert, update, delete on tables from care_ride_app;
    revoke usage on schema public from care_ride_app;
  end if;
end $$;
