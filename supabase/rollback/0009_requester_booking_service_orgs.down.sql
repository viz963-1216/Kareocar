-- =====================================================================
-- 移除 migration 0009（僅供回復）
--
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "set lock_timeout = '3s'" -c 'begin' \
--     -f supabase/rollback/0009_requester_booking_service_orgs.down.sql -c 'commit'
--
-- 只移除函式，不動任何資料。新版 state-load 在函式不存在時回傳空的承接單位清單，
-- 需求者畫面回到「尚未指定承接單位」，不會整個載入失敗。
-- =====================================================================
drop function if exists app.my_booking_service_orgs();
