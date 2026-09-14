-- =====================================================================
-- 移除 migration 0009（僅供回復）
--
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "set lock_timeout = '3s'" -c 'begin' \
--     -f supabase/rollback/0009_server_only_notifications.down.sql -c 'commit'
--
-- 移除後通知回到 0008 以前的權限：可經 state-mutate 寫入（新版 handler 仍會拒絕），
-- 收件人不能讀取寫給自己但擁有者是別人的通知。已建立的通知資料列保留。
-- 要回復到舊版程式，必須先執行本檔，否則舊版前端的通知寫入會失敗。
-- 演練：supabase/tests/migration-0008-deploy.test.sh 第 6 段、run-compat-old-code.sh。
-- =====================================================================
drop policy if exists app_state_notification_recipient_read on app_state;
drop trigger if exists app_state_guard_notifications on app_state;
drop function if exists app.app_state_guard_notifications();
drop function if exists app.notification_guard_since();
