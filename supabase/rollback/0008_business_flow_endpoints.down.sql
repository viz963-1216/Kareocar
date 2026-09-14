-- =====================================================================
-- 移除 migration 0008（僅供回復；不是正常部署流程的一部分）
--
-- 必須先把程式回復到不依賴 0008 的版本，並與 0007 在同一個交易內執行，
-- 由 0007 還原接案函式與 10 欄的需求池 view：
--
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "set lock_timeout = '3s'" -c 'begin' \
--     -f supabase/rollback/0008_business_flow_endpoints.down.sql \
--     -f supabase/migrations/0007_app_state.sql -c 'commit'
--
-- 只移除 0008 建立的政策與函式；0008 寫入的行程事件、異常、通知資料列保留。
-- 演練：supabase/tests/migration-0008-deploy.test.sh 第 5 段。
-- =====================================================================
drop policy if exists app_state_driver_read on app_state;
drop policy if exists app_state_notification_recipient_read on app_state;
drop function if exists app.apply_driver_trip_execution(text, text, int, text, jsonb, jsonb, jsonb);
drop function if exists app.lock_driver_trip(text);
drop function if exists app.cancel_app_state_booking(text, text, text);
drop function if exists app.my_active_driver_keys();
drop function if exists app.is_my_active_trip_driver(text, text);
