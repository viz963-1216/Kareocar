#!/usr/bin/env bash
# migration 的結構與往返，在隔離資料庫上實測：
#
#   1. 每支 migration 都有對應的 supabase/rollback/<名稱>.down.sql
#   2. 往返：全部套用 → 依反序回復 → 再全部套用。回復後 public 與 app schema
#      沒有殘留物件；再套用後的 schema 與第一次完全相同
#   3. 司機讀取政策的執行計畫：司機清單的子查詢只算一次，不是每列都查
#   4. 通知觸發器本身（隔離情境）：交易內暫時加上 SELECT／UPDATE／DELETE 政策，
#      驗證觸發器擋下修改與刪除系統通知，交易結束即回滾
#
# 第 3、4 段原本在 migration-0008-deploy.test.sh；那支測試的其他段落是在驗證
# 「在既有資料庫上增量部署與回復 0008」，壓縮成 baseline 之後不再適用。
#
# 只允許本機隔離端點；測試庫名稱固定，已存在就失敗，不覆寫。
# 各段以 check／expect 自行判斷：單一斷言失敗不中止腳本，並印出實際值。
set -euo pipefail
case "${PGHOST:-}" in
  /tmp/care-ride-*|localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是本機隔離端點（/tmp/care-ride-*、localhost 或 127.0.0.1）'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB=careride_migrations_test
q() { psql -X -tA -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

fail=0
check() { if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; fail=1; fi; }
expect() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1（實得 '$2'，預期 '$3'）" 1; fi; }

up() {
  for migration in "$ROOT"/supabase/migrations/*.sql; do
    psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$migration" >/dev/null || return 1
  done
}
down() {
  local files=("$ROOT"/supabase/migrations/*.sql) i name
  for ((i = ${#files[@]} - 1; i >= 0; i--)); do
    name="$(basename "${files[$i]}" .sql)"
    psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/rollback/$name.down.sql" >/dev/null || return 1
  done
}
# schema 的指紋：public 與 app 裡的資料表欄位、view、函式簽名、政策、觸發器、索引
fingerprint() {
  q -c "select md5(string_agg(x, E'\n' order by x)) from (
          select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type
                 || ' ' || is_nullable || ' ' || coalesce(column_default, '') as x
            from information_schema.columns where table_schema in ('public', 'app')
          union all select 'view ' || schemaname || '.' || viewname || ' ' || md5(definition)
            from pg_views where schemaname in ('public', 'app')
          union all select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || p.prosecdef
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
          union all select 'pol ' || tablename || '.' || policyname || ' ' || cmd || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname in ('public', 'app')
          union all select 'trg ' || tgrelid::regclass::text || '.' || tgname
            from pg_trigger where not tgisinternal
          union all select 'idx ' || indexdef
            from pg_indexes where schemaname in ('public', 'app')
        ) s"
}
leftovers() {
  q -c "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S'))
             + (select count(*) from pg_namespace where nspname = 'app')"
}

createdb "$DB"

echo "--- 1. 每支 migration 都有回復檔 ---"
missing=""
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration" .sql)"
  [ -f "$ROOT/supabase/rollback/$name.down.sql" ] || missing="$missing $name"
done
expect "缺少回復檔的 migration" "${missing:-無}" "無"

echo "--- 2. 往返：上 → 下 → 上 ---"
up && r=0 || r=$?; check "第一次套用" "$r"
FIRST="$(fingerprint)"
down && r=0 || r=$?; check "依反序回復" "$r"
expect "回復後 public 與 app 沒有殘留的資料表、view、序列或 app schema" "$(leftovers)" 0
up && r=0 || r=$?; check "回復後再套用" "$r"
expect "再套用後的 schema 指紋與第一次相同" "$(fingerprint)" "$FIRST"

echo "--- 3. 司機讀取政策 ---"
q -q <<'SQL'
insert into organizations (id, org_type, name, active) values ('ORG-MIG','transport_provider','合成承運',true);
insert into users (id, display_name, phone_e164, platform_role, active) values
  ('USR-MIG-DRV','合成司機','+886933000001','none',true),
  ('USR-MIG-OTHER','合成其他人','+886933000002','none',true);
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
VISIBLE="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
  -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
  -c "select count(*) from app_state where collection = 'trips'" | tail -1)"
expect "司機只讀得到指派給自己的行程" "$VISIBLE" 40
PLAN="$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB" -c 'set role care_ride_app' \
  -c "select set_config('app.user_id', 'USR-MIG-DRV', false)" \
  -c "explain (analyze, costs off, timing off, summary off) select id from app_state where collection = 'trips'")"
echo "$PLAN" | sed 's/^/    /'
echo "$PLAN" | grep -Eq 'hashed SubPlan|InitPlan' && r=0 || r=$?; check "司機清單子查詢是 hashed SubPlan／InitPlan（每個查詢算一次）" "$r"

echo "--- 4. 通知觸發器本身（隔離情境，交易結束即回滾） ---"
# 合法後端通知：以函式擁有者身分寫入來源證明與通知（等同後端函式的寫入方式）；
# 另一則是沒有來源證明的一般通知
q -q -c "insert into app.notification_provenance (notification_id, source, booking_id, template, recipient_user_id, content_hash) values ('NTF-MIG-LEGIT', 'cancel_booking_endpoint', 'BKG-MIG', 'booking_cancelled', 'USR-MIG-DRV', md5(jsonb_build_object('id', 'NTF-MIG-LEGIT', 'recipientId', 'USR-MIG-DRV')::text))" \
     -c "insert into app_state (collection, id, data) values ('notifications', 'NTF-MIG-LEGIT', jsonb_build_object('id', 'NTF-MIG-LEGIT', 'recipientId', 'USR-MIG-DRV'))" \
     -c "insert into app_state (collection, id, data) values ('notifications', 'NTF-MIG-PLAIN', jsonb_build_object('id', 'NTF-MIG-PLAIN', 'recipientId', 'USR-MIG-DRV'))" >/dev/null
# 暫時的 SELECT／UPDATE／DELETE 政策讓非收件人、非擁有者也看得到並能改到系統通知，
# 這樣才會真的走到觸發器；少了 SELECT 政策，DELETE／UPDATE 會因 RLS 影響 0 列而
# 根本不觸發觸發器。
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
has "有 UPDATE 政策時，觸發器擋下把通知改成其他集合" "$(guard_try "update app_state set collection = 'tripEvents' where collection = 'notifications' and id = 'NTF-MIG-PLAIN'")" '通知的集合與 ID 不能修改'
expect "隔離情境的暫時政策已隨交易回滾" "$(q -c "select count(*) from pg_policies where policyname like 'tmp_guard_%'")" 0
expect "隔離情境後通知資料列都還在" "$(q -c "select count(*) from app_state where collection = 'notifications' and id in ('NTF-MIG-LEGIT','NTF-MIG-PLAIN')")" 2

dropdb "$DB"
if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
