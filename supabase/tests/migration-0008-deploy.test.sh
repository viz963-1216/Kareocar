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
#   6. 通知來源證明：安裝前預先寫入 serverCreated、created_at 在未來的通知安裝後仍讀不到；
#      合法通知在重套、回復、回復後再套用各狀態的可見性；來源證明回復後保留
#   7. 觸發器本身（隔離情境）：交易內暫時加上 DELETE／UPDATE 政策，驗證觸發器擋下
#      修改與刪除系統通知，交易結束即回滾
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
# 只套用 0001–0007，建出 0008 部署前的狀態
for migration in "$ROOT"/supabase/migrations/*.sql; do
  [[ "$(basename "$migration")" < "0008" ]] || continue
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
# 之後各段以 check／expect 自行判斷：單一斷言失敗不中止腳本，並印出實際值
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
                + (select count(*) from pg_trigger where tgname = 'app_state_guard_notifications')
                + (select count(*) from pg_proc where proname in ('lock_driver_trip','apply_driver_trip_execution','my_active_driver_keys','is_my_active_trip_driver','cancel_app_state_booking','app_state_guard_notifications','notification_server_writer','is_server_notification','is_my_server_notification'))")"
[ "$LEFT2" = "0" ]; check "回復後沒有 0008 的政策、觸發器或函式（剩 $LEFT2）" $?
POOLCOLS="$(q -c "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'app_state_booking_pool'")"
[ "$POOLCOLS" = "10" ]; check "需求池 view 回到 0007 的 10 欄（實得 $POOLCOLS）" $?
[ "$(snapshot)" = "$BEFORE" ]; check "回復後 app_state 的 filenode、欄位、索引、筆數不變" $?
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M8" -c 'commit' >/dev/null 2>&1
check "回復後可以再次套用 0008" $?

echo "--- 6. 通知來源證明 ---"
# 每項斷言都印出實際值；失敗不中止腳本
expect() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1（實得 '$2'，預期 '$3'）" 1; fi; }
driver_sees() {
  psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
    -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
    -c "select count(*) from app_state where collection = 'notifications' and id = '$1'" 2>&1 | tail -1
}
driver_diag() {
  echo "    [診斷] 政策：$(q -c "select string_agg(policyname, ',' order by policyname) from pg_policies where tablename = 'app_state'")"
  echo "    [診斷] 來源證明：$(q -c "select notification_id || '→' || recipient_user_id from app.notification_provenance where notification_id = '$1'")"
  echo "    [診斷] 資料列：$(q -c "select collection || '/' || id || ' deleted=' || deleted || ' org=' || coalesce(organization_id, 'null') || ' owner=' || coalesce(owner_user_id, 'null') from app_state where collection = 'notifications' and id = '$1'")"
  echo "    [診斷] 以司機身分：$(psql -X -q -tA -d "$DB" -c 'set role care_ride_app' \
    -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
    -c "select 'current_user_id=' || coalesce(app.current_user_id(), 'null') || ' is_my_server_notification=' || app.is_my_server_notification('$1')" 2>&1 | tail -1)"
}
client_forge() {
  # 以 care_ride_app、非收件人身分寫入：收件人是司機、自帶 serverCreated、created_at 在未來
  psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
    -c "select set_config('app.user_id', 'USR-MIG-OTHER', false)" \
    -c "insert into app_state (collection, id, data, created_at) values ('notifications', '$1', jsonb_build_object('recipientId', 'USR-MIG-DRV', 'serverCreated', true, 'source', 'cancel_booking_endpoint'), '2099-01-01')" >/dev/null 2>&1
  echo $?
}
apply8() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' -f "$M8" -c 'commit' >/dev/null 2>&1; echo $?; }
rollback8() {
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "set lock_timeout = '5s'" -c 'begin' \
    -f "$ROOT/supabase/rollback/0008_business_flow_endpoints.down.sql" \
    -f "$ROOT/supabase/migrations/0007_app_state.sql" -c 'commit' >/dev/null 2>&1
  echo $?
}
expect "回到 0008 安裝前" "$(rollback8)" 0
expect "安裝前以用戶端身分寫入偽造通知" "$(client_forge NTF-MIG-PRE)" 0
expect "安裝前預先偽造的通知：司機讀不到" "$(driver_sees NTF-MIG-PRE)" 0
expect "套用 0008" "$(apply8)" 0
expect "安裝後：預先寫入 serverCreated、created_at 在未來的通知司機仍讀不到" "$(driver_sees NTF-MIG-PRE)" 0
expect "安裝後以用戶端身分寫入偽造通知" "$(client_forge NTF-MIG-AFTER)" 0
expect "安裝後用戶端偽造的通知：司機讀不到" "$(driver_sees NTF-MIG-AFTER)" 0
# 合法後端通知：以函式擁有者身分寫入來源證明與通知（等同後端函式的寫入方式）
for legit in NTF-MIG-LEGIT NTF-MIG-LEGIT2; do
  q -q -c "insert into app.notification_provenance (notification_id, source, booking_id, template, recipient_user_id, content_hash) values ('$legit', 'cancel_booking_endpoint', 'BKG-$legit', 'booking_cancelled', 'USR-MIG-DRV', md5(jsonb_build_object('id', '$legit', 'recipientId', 'USR-MIG-DRV')::text))" \
       -c "insert into app_state (collection, id, data) values ('notifications', '$legit', jsonb_build_object('id', '$legit', 'recipientId', 'USR-MIG-DRV'))" >/dev/null
done
expect "合法後端通知：收件司機讀得到" "$(driver_sees NTF-MIG-LEGIT)$(driver_sees NTF-MIG-LEGIT2)" 11
expect "重套 0008" "$(apply8)" 0
expect "重套 0008 後：合法通知仍讀得到" "$(driver_sees NTF-MIG-LEGIT)" 1
expect "回復 0008" "$(rollback8)" 0
expect "回復後：讀取政策移除，收件司機讀不到" "$(driver_sees NTF-MIG-LEGIT)" 0
expect "回復後：來源證明保留" "$(q -c "select count(*) from app.notification_provenance where notification_id in ('NTF-MIG-LEGIT','NTF-MIG-LEGIT2')")" 2
# 回復期間觸發器不在：改動其中一則的內容
q -q -c "update app_state set data = data || jsonb_build_object('payload', jsonb_build_object('reason', '回復期間竄改')) where collection = 'notifications' and id = 'NTF-MIG-LEGIT2'" >/dev/null
expect "回復期間可以改動通知內容（觸發器已移除）" "$(q -c "select data->'payload'->>'reason' from app_state where collection = 'notifications' and id = 'NTF-MIG-LEGIT2'")" "回復期間竄改"
expect "回復後再套用 0008" "$(apply8)" 0
AGAIN="$(driver_sees NTF-MIG-LEGIT)"
expect "再套用後：未被改動的合法通知恢復可讀" "$AGAIN" 1
expect "再套用後：回復期間被改動的通知不恢復可讀（內容雜湊不符）" "$(driver_sees NTF-MIG-LEGIT2)" 0
[ "$AGAIN" = "1" ] || driver_diag NTF-MIG-LEGIT
expect "再套用後：偽造通知仍讀不到" "$(driver_sees NTF-MIG-PRE)$(driver_sees NTF-MIG-AFTER)" 00
expect "以上過程 app_state 的 filenode、欄位、索引不變" "$(snapshot | cut -d'|' -f1-3)" "$(echo "$BEFORE" | cut -d'|' -f1-3)"

echo "--- 7. 觸發器本身（隔離情境，交易結束即回滾） ---"
# 暫時的 SELECT／UPDATE／DELETE 政策讓非收件人、非擁有者也看得到並能改到系統通知，
# 這樣才會真的走到觸發器；少了 SELECT 政策，DELETE／UPDATE 會因 RLS 影響 0 列而
# 根本不觸發觸發器（run 34798878217 即是如此）。
guard_try() {
  psql -X -q -tA -d "$DB" -c 'begin' \
    -c "create policy tmp_guard_select on app_state for select using (true)" \
    -c "create policy tmp_guard_delete on app_state for delete using (true)" \
    -c "create policy tmp_guard_update on app_state for update using (true) with check (true)" \
    -c 'set local role care_ride_app' -c "select set_config('app.user_id', 'USR-MIG-OTHER', true)" \
    -c "$1" -c 'rollback' 2>&1
}
has() { if echo "$2" | grep -q "$3"; then check "$1" 0; else check "$1（輸出：$(echo "$2" | tr '\n' ' ' | cut -c1-200)）" 1; fi; }
has "有 DELETE 政策時，觸發器擋下刪除系統通知" "$(guard_try "delete from app_state where collection = 'notifications' and id = 'NTF-MIG-LEGIT'")" '系統通知不能由用戶端修改或刪除'
has "有 UPDATE 政策時，觸發器擋下修改系統通知" "$(guard_try "update app_state set data = data || jsonb_build_object('recipientId', 'USR-MIG-OTHER') where collection = 'notifications' and id = 'NTF-MIG-LEGIT'")" '系統通知不能由用戶端修改或刪除'
has "有 UPDATE 政策時，觸發器擋下把通知改成其他集合" "$(guard_try "update app_state set collection = 'tripEvents' where collection = 'notifications' and id = 'NTF-MIG-AFTER'")" '通知的集合與 ID 不能修改'
expect "隔離情境的暫時政策已隨交易回滾" "$(q -c "select count(*) from pg_policies where policyname like 'tmp_guard_%'")" 0
expect "隔離情境後通知資料列都還在" "$(q -c "select count(*) from app_state where collection = 'notifications' and id in ('NTF-MIG-LEGIT','NTF-MIG-AFTER')")" 2

dropdb "$DB"
if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
