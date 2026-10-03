#!/usr/bin/env bash
# tools/reset-legacy-production.sql 的行為，在隔離資料庫上實測：
#
#   1. 模擬早期手動建立的正式庫：直接以 psql 貼上 0001–0008（沒有 migration 紀錄），
#      加上資料、public 裡的額外函式與型別、auth.users 上呼叫 public 函式的觸發器
#   2. 執行器拒絕（exit 3）
#   3. 清空：public／app 沒有資料表或 view；auth 與擴充套件（pgcrypto）不受影響
#   4. 執行器從頭套用全部 migration 成功，每支都有紀錄
#   5. 已有 migration 紀錄的庫再跑清空 → 拒絕，什麼都沒刪
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
RESET="$ROOT/tools/reset-legacy-production.sql"
url() { echo "postgresql://postgres@$PGHOST:$PGPORT/$1"; }
q() { psql -X -tA -d "$1" -c "$2"; }

fail=0
check() { if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; fail=1; fi; }
expect() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1（實得 '$2'，預期 '$3'）" 1; fi; }
relations() { q "$1" "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname in ('public','app') and c.relkind in ('r','v','m','p')"; }

DB=careride_reset_test
createdb "$DB" || exit 1
N="$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')"

echo "--- 1. 模擬早期手動建立的庫 ---"
# Supabase 的 auth schema 與帳號：清空時不能碰
q $DB "create schema auth; create table auth.users (id uuid primary key, phone text);
       insert into auth.users values (gen_random_uuid(), '+886900000000')" >/dev/null
for f in "$ROOT"/supabase/migrations/000[1-8]_*.sql; do
  psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "  手動貼上 $(basename "$f") 失敗"; exit 1; }
done
q $DB "insert into organizations (id, name) values ('ORG-LEGACY', '舊測試機構')" >/dev/null
expect "舊庫有測試資料" "$(q $DB "select count(*) from organizations where id = 'ORG-LEGACY'")" 1
q $DB "create type public.legacy_status as enum ('a','b');
       create function public.legacy_touch() returns trigger language plpgsql as \$\$ begin return new; end \$\$;
       create trigger legacy_auth_touch before insert on auth.users for each row execute function public.legacy_touch();
       create table public.legacy_manual (id serial primary key, s public.legacy_status)" >/dev/null
check "舊庫有資料表" "$([ "$(relations $DB)" -gt 0 ] && echo 0 || echo 1)"

echo "--- 2. 執行器拒絕舊庫 ---"
MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "沒有紀錄的舊庫 → exit 3" "$?" 3

echo "--- 3. 清空 ---"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RESET" >/dev/null 2>&1; expect "清空成功" "$?" 0
expect "public／app 沒有資料表或 view" "$(relations $DB)" 0
expect "app schema 已刪除" "$(q $DB "select count(*) from pg_namespace where nspname in ('app','ops')")" 0
expect "public 沒有自訂函式" "$(q $DB "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')")" 0
expect "public 沒有自訂型別" "$(q $DB "select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype in ('e','d')")" 0
expect "auth.users 帳號還在" "$(q $DB 'select count(*) from auth.users')" 1
expect "auth.users 上呼叫 public 函式的觸發器已一併移除" "$(q $DB "select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal")" 0
expect "pgcrypto 仍可用" "$(q $DB "select length(encode(digest('x', 'sha256'), 'hex'))")" 64
expect "care_ride_app 角色保留" "$(q $DB "select count(*) from pg_roles where rolname = 'care_ride_app'")" 1

echo "--- 4. 從頭套用全部 migration ---"
MIGRATION_DATABASE_URL="$(url $DB)" bash "$RUN" >/dev/null 2>&1; expect "套用成功" "$?" 0
expect "每支 migration 都有紀錄" "$(q $DB 'select count(*) from ops.schema_migrations')" "$N"
expect "舊資料沒有留下" "$(q $DB "select count(*) from organizations where id = 'ORG-LEGACY'")" 0
expect "最新的資料表存在（benefit_source_fetches）" "$(q $DB "select to_regclass('public.benefit_source_fetches') is not null")" t

echo "--- 5. 已由 migration 管理的庫拒絕清空 ---"
BEFORE="$(relations $DB)"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RESET" >/dev/null 2>&1; rc=$?
check "有 migration 紀錄 → 拒絕（exit $rc）" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
expect "什麼都沒刪" "$(relations $DB)" "$BEFORE"
expect "紀錄還在" "$(q $DB 'select count(*) from ops.schema_migrations')" "$N"

dropdb "$DB"

if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
