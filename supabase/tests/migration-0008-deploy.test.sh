#!/usr/bin/env bash
# migration 0008 的部署行為，在隔離資料庫上實測：
#
#   1. 前面有長交易卡著 app_state 時，以 lock_timeout 套用 → 逾時失敗，而且因為
#      整份在單一交易內，什麼都沒有留下（可以安全重試）
#   2. 正常套用：列出這個交易實際持有的資料表鎖；app_state 的 filenode、欄位、
#      索引、筆數都不變（沒有整表改寫）
#   3. 再套用一次仍成功（重試不會壞）
#   4. 司機讀取政策的執行計畫：司機清單的子查詢只算一次，不是每列都查
#   5. 回復演練：supabase/rollback 的移除 SQL + 重新套用 0007，單一交易；
#      確認 0008 的政策與函式都不在、需求池 view 回到 0007 形狀、資料表不變，
#      之後還能再套用 0008
#   6. 0009（通知只能由後端建立）：lock_timeout 套用、不改寫、擋偽造、可重套、可回復
#
# 只允許本機隔離端點；測試庫名稱固定，已存在就失敗，不覆寫。
set -euo pipefail
case "${PGHOST:-}" in
  /tmp/care-ride-*|localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是本機隔離端點（/tmp/care-ride-*、localhost 或 127.0.0.1）'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=careride_mig_test
M8="$ROOT/supabase/migrations/0008_business_flow_endpoints.sql"
q() { psql -X -tA -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

fail=0
check() { if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; fail=1; fi; }

createdb "$DB"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  [ "$migration" = "$M8" ] && continue
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$migration" >/dev/null
done

# 合成資料：兩千筆行程與一個司機，讓「有沒有改寫」與執行計畫都更接近實況
q -q <<'SQL'
insert into organizations (id, org_type, name, active) values ('ORG-MIG','transport_provider','合成承運',true);
insert into users (id, display_name, phone_e164, platform_role, active) values ('USR-MIG-DRV','合成司機','+886933000001','none',true);
insert into memberships (id, user_id, organization_id, role, status) values ('M-MIG-DRV','USR-MIG-DRV','ORG-MIG','driver','active');
insert into drivers (id, user_id, organization_id, duty_status, active) values ('DRV-MIG','USR-MIG-DRV','ORG-MIG','on_duty',true);
insert into app_state (collection, id, data)
  select 'trips', 'TRP-MIG-' || g,
         jsonb_build_object('id', 'TRP-MIG-' || g, 'driverId', case when g % 50 = 0 then 'DRV-MIG' else 'DRV-OTHER' end, 'status', 'scheduled')
    from generate_series(1, 2000) g;
begin;
select set_config('app.state_scope_override', '1', true);
update app_state set organization_id = 'ORG-MIG' where collection = 'trips';
commit;
SQL

snapshot() {
  q -c "select pg_relation_filenode('app_state')
        || ' | ' || (select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum)
                       from pg_attribute where attrelid = 'app_state'::regclass and attnum > 0 and not attisdropped)
        || ' | ' || (select string_agg(indexrelid::regclass::text, ',' order by indexrelid::regclass::text)
                       from pg_index where indrelid = 'app_state'::regclass)
        || ' | ' || (select count(*) from app_state)"
}
BEFORE="$(snapshot)"

echo "--- 1. 長交易卡住時以 lock_timeout 套用 ---"
psql -X -q -d "$DB" -c 'begin' -c 'select count(*) from app_state' -c 'select pg_sleep(12)' -c 'commit' >/dev/null &
BLOCKER=$!
sleep 1
set +e
TIMEOUT_OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '2s'" -c 'begin' -f "$M8" -c 'commit' 2>&1)"
TIMEOUT_RC=$?
set -e
wait "$BLOCKER"
echo "$TIMEOUT_OUT" | grep -E 'ERROR' | sed 's/^/    /'
[ "$TIMEOUT_RC" -ne 0 ] && echo "$TIMEOUT_OUT" | grep -q 'lock timeout'; check "取不到鎖時在 lock_timeout 內失敗，而不是無限等待" $?
LEFT="$(q -c "select (select count(*) from pg_policies where policyname = 'app_state_driver_read')
               + (select count(*) from pg_proc where proname in ('lock_driver_trip','apply_driver_trip_execution','my_active_driver_keys'))")"
[ "$LEFT" = "0" ]; check "逾時失敗後沒有留下任何 0008 的政策或函式（整份回滾，可重試）" $?
[ "$(snapshot)" = "$BEFORE" ]; check "逾時失敗後 app_state 完全沒變" $?

echo "--- 2. 正常套用，列出本交易持有的鎖 ---"
LOCKS="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M8" \
  -c "select c.relname || ' ' || l.mode
        from pg_locks l join pg_class c on c.oid = l.relation
       where l.pid = pg_backend_pid() and l.locktype = 'relation'
         and c.relnamespace = 'public'::regnamespace
       order by 1" \
  -c 'commit' 2>/dev/null)"
echo "$LOCKS" | sed 's/^/    /'
AFTER="$(snapshot)"
echo "    套用前：$BEFORE"
echo "    套用後：$AFTER"
[ "$AFTER" = "$BEFORE" ]; check "app_state 的 filenode、欄位、索引、筆數都不變（沒有整表改寫）" $?
if echo "$AFTER" | grep -q 'trip_driver_id'; then
  check "沒有新增 trip_driver_id 欄位" 1
else
  check "沒有新增 trip_driver_id 欄位" 0
fi

echo "--- 3. 再套用一次 ---"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M8" -c 'commit' >/dev/null 2>&1; check "重複套用成功" $?
[ "$(snapshot)" = "$BEFORE" ]; check "重複套用後 app_state 仍不變" $?

echo "--- 4. 司機讀取政策 ---"
VISIBLE="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
  -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
  -c "select count(*) from app_state where collection = 'trips'" | tail -1)"
[ "$VISIBLE" = "40" ]; check "司機只讀得到指派給自己的 40 趟（實得 $VISIBLE）" $?
PLAN="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
  -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
  -c "explain (analyze, costs off, timing off, summary off) select id from app_state where collection = 'trips'")"
echo "$PLAN" | sed 's/^/    /'
echo "$PLAN" | grep -Eq 'hashed SubPlan|InitPlan'; check "司機清單子查詢是 hashed SubPlan／InitPlan（每個查詢算一次）" $?

echo "--- 5. 回復演練 ---"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' \
  -f "$ROOT/supabase/rollback/0008_business_flow_endpoints.down.sql" \
  -f "$ROOT/supabase/migrations/0007_app_state.sql" -c 'commit' >/dev/null 2>&1
check "移除 0008 並重新套用 0007（單一交易）成功" $?
LEFT2="$(q -c "select (select count(*) from pg_policies where policyname in ('app_state_driver_read','app_state_notification_recipient_read'))
                + (select count(*) from pg_proc where proname in ('lock_driver_trip','apply_driver_trip_execution','my_active_driver_keys','is_my_active_trip_driver','cancel_app_state_booking'))")"
[ "$LEFT2" = "0" ]; check "回復後沒有 0008 的政策或函式（剩 $LEFT2）" $?
POOLCOLS="$(q -c "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'app_state_booking_pool'")"
[ "$POOLCOLS" = "10" ]; check "需求池 view 回到 0007 的 10 欄（實得 $POOLCOLS）" $?
[ "$(snapshot)" = "$BEFORE" ]; check "回復後 app_state 的 filenode、欄位、索引、筆數不變" $?
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M8" -c 'commit' >/dev/null 2>&1
check "回復後可以再次套用 0008" $?

echo "--- 6. 0009 通知寫入限制 ---"
M9="$ROOT/supabase/migrations/0009_server_only_notifications.sql"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M9" -c 'commit' >/dev/null 2>&1; check "0009 以單一交易 + lock_timeout 套用成功" $?
[ "$(snapshot)" = "$BEFORE" ]; check "套用 0009 後 app_state 不改寫" $?
GUARD="$(q -c "select count(*) from pg_trigger where tgname = 'app_state_guard_notifications' and tgrelid = 'app_state'::regclass")"
[ "$GUARD" = "1" ]; check "通知寫入觸發器存在" $?
set +e
FORGE="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c "insert into app_state (collection, id, data) values ('notifications', 'NTF-MIG-FORGE', '{}')" 2>&1)"
FORGE_RC=$?
set -e
if [ "$FORGE_RC" -ne 0 ] && echo "$FORGE" | grep -q '通知只能由系統流程建立'; then check "未帶後端旗標的通知 INSERT 被擋" 0; else check "未帶後端旗標的通知 INSERT 被擋" 1; fi
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M9" -c 'commit' >/dev/null 2>&1; check "重複套用 0009 成功" $?
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$ROOT/supabase/rollback/0009_server_only_notifications.down.sql" -c 'commit' >/dev/null 2>&1; check "回復 0009 成功" $?
LEFT9="$(q -c "select (select count(*) from pg_trigger where tgname = 'app_state_guard_notifications')
               + (select count(*) from pg_policies where policyname = 'app_state_notification_recipient_read')
               + (select count(*) from pg_proc where proname in ('app_state_guard_notifications','notification_guard_since'))")"
[ "$LEFT9" = "0" ]; check "回復後沒有 0009 的觸發器、政策或函式（剩 $LEFT9）" $?
[ "$(snapshot)" = "$BEFORE" ]; check "回復 0009 後 app_state 不改寫" $?

dropdb "$DB"
if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
