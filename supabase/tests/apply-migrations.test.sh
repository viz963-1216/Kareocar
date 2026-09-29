#!/usr/bin/env bash
# tools/apply-migrations.sh 的行為，在隔離資料庫上實測：
#
#   1. 空資料庫：dry-run 只列出、不改；套用後每支都有紀錄，schema 建好
#   2. 再跑一次：沒有待套用的，什麼都不做
#   3. 已套用的檔案被改過（checksum 不符）→ 拒絕，exit 4
#   4. 新檔案版本號小於已套用的最大版本 → 拒絕，exit 5
#   5. 有資料表卻沒有 migration 紀錄（早期手動建立的庫）→ 拒絕，exit 3，什麼都沒建立
#   6. 某支 migration 失敗 → 那一支整筆回滾，之前套用的保留、紀錄正確
#   7. 取不到鎖 → 在 lock_timeout 內失敗，不會無限等
#
# 只允許本機隔離端點；測試庫名稱固定，已存在就失敗，不覆寫。
set -uo pipefail
case "${PGHOST:-}" in
  /tmp/care-ride-*|localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是本機隔離端點（/tmp/care-ride-*、localhost 或 127.0.0.1）'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/tools/apply-migrations.sh"
url() { echo "postgresql://postgres@$PGHOST:$PGPORT/$1"; }
q() { psql -X -tA -d "$1" -c "$2"; }

fail=0
check() { if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; fail=1; fi; }
expect() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1（實得 '$2'，預期 '$3'）" 1; fi; }

DB=careride_apply_test
createdb "$DB" || exit 1
N="$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')"

echo "--- 1. 空資料庫 ---"
OUT="$(MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" --dry-run)"; rc=$?
expect "dry-run 成功" "$rc" 0
expect "dry-run 列出全部 $N 支" "$(echo "$OUT" | grep -c '^  [0-9]')" "$N"
expect "dry-run 沒有建立 ops schema" "$(q $DB "select count(*) from pg_namespace where nspname='ops'")" 0
MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null; expect "套用成功" "$?" 0
expect "每支 migration 都有紀錄" "$(q $DB 'select count(*) from ops.schema_migrations')" "$N"
expect "schema 已建立（app_state 存在）" "$(q $DB "select to_regclass('public.app_state') is not null")" t

echo "--- 2. 再跑一次 ---"
OUT="$(MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN")"; rc=$?
expect "沒有待套用時成功結束" "$rc" 0
echo "$OUT" | grep -q '沒有待套用'; check "回報沒有待套用" $?

echo "--- 3. 已套用的檔案被改過 ---"
q $DB "update ops.schema_migrations set checksum = 'tampered' where version = (select min(version) from ops.schema_migrations)" >/dev/null
MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "checksum 不符 → exit 4" "$?" 4
q $DB "delete from ops.schema_migrations" >/dev/null

echo "--- 4. 順序錯亂 ---"
# 只留最大版本的紀錄：其他版本變成「未套用但版本號較小」
MAX="$(basename "$(ls "$ROOT"/supabase/migrations/*.sql | tail -1)" .sql)"
q $DB "insert into ops.schema_migrations (version, checksum) values ('$MAX', 'x')" >/dev/null
if [ "$N" -gt 1 ]; then
  MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "較小版本未套用 → exit 5" "$?" 5
fi
dropdb "$DB"

echo "--- 5. 早期手動建立的庫 ---"
createdb "$DB"
q $DB "create table public.legacy_manual (id int)" >/dev/null
MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "有資料表沒有紀錄 → exit 3" "$?" 3
expect "拒絕時什麼都沒建立" "$(q $DB "select count(*) from pg_namespace where nspname in ('ops','app')")" 0
dropdb "$DB"

echo "--- 6. 失敗整筆回滾 ---"
createdb "$DB"
TMP="$(mktemp -d)"
echo 'create table public.t_ok (id int);' > "$TMP/0001_ok.sql"
printf 'create table public.t_bad (id int);\nselect 1/0;\n' > "$TMP/0002_bad.sql"
MIGRATIONS_DIR="$TMP" MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; rc=$?
check "失敗時 exit 非 0（實得 $rc）" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
expect "成功的那支留著" "$(q $DB "select to_regclass('public.t_ok') is not null")" t
expect "失敗的那支沒有留下任何東西" "$(q $DB "select to_regclass('public.t_bad') is null")" t
expect "紀錄只有成功的那支" "$(q $DB "select string_agg(version, ',' order by version) from ops.schema_migrations")" 0001_ok

echo "--- 7. 取不到鎖 ---"
rm "$TMP/0002_bad.sql"
echo 'alter table public.t_ok add column x int;' > "$TMP/0002_alter.sql"
psql -X -q -d "$DB" -c 'begin' -c 'lock table public.t_ok' -c 'select pg_sleep(8)' -c 'commit' >/dev/null 2>&1 &
BLOCKER=$!
sleep 1
START=$(date +%s)
MIGRATIONS_DIR="$TMP" MIGRATION_LOCK_TIMEOUT=1s MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; rc=$?
ELAPSED=$(( $(date +%s) - START ))
wait "$BLOCKER"
check "取不到鎖時失敗（exit $rc）" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
check "在 lock_timeout 附近失敗，不是等到對方放鎖（${ELAPSED} 秒）" "$([ "$ELAPSED" -lt 6 ] && echo 0 || echo 1)"
expect "逾時的那支沒有紀錄" "$(q $DB "select count(*) from ops.schema_migrations where version = '0002_alter'")" 0
MIGRATIONS_DIR="$TMP" MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "鎖釋放後重試成功" "$?" 0
rm -rf "$TMP"
dropdb "$DB"

if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
