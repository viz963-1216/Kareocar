#!/usr/bin/env bash
# 一次跑完所有接線測試，每一輪都從乾淨的資料庫開始。
#
# 需要一個本機 Postgres 16（不會碰到 Supabase 上的正式資料）：
#
#   PGHOST=/tmp/pgrun PGPORT=5433 ./run-all.sh
#
# 測試之間有順序相依：bootstrap 會替超級管理者設定密碼，session 才有帳號可以
# 登入。所以這支腳本固定順序執行，不要單獨挑一支跑就下結論。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

export PGHOST="${PGHOST:-/tmp/pgrun}"
export PGPORT="${PGPORT:-5433}"
export PGDATABASE="${PGDATABASE:-careride}"
PSQL_ADMIN="psql -h $PGHOST -p $PGPORT -U postgres -tAq"

echo "== 重建資料庫 $PGDATABASE =="
$PSQL_ADMIN -d postgres -c "drop database if exists $PGDATABASE" >/dev/null
$PSQL_ADMIN -d postgres -c "create database $PGDATABASE" >/dev/null

for f in "$ROOT"/supabase/migrations/*.sql; do
  if ! $PSQL_ADMIN -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/mig.err; then
    echo "  migration 失敗：$(basename "$f")"; cat /tmp/mig.err; exit 1
  fi
  echo "  已套用 $(basename "$f")"
done

echo "== 種子資料 =="
$PSQL_ADMIN -d "$PGDATABASE" >/dev/null <<'SQL'
insert into organizations (id, org_type, name, active)
values ('ORG-TP-001','operator','台北服務單位',true) on conflict (id) do nothing;
-- 超級管理者：先建帳號、不設密碼，交給 bootstrap 測試去設定
insert into users (id, display_name, phone_e164, platform_role, active)
values ('USR-ROOT-0001','平台超級管理者','+886912345678','super_admin',true) on conflict (id) do nothing;
insert into users (id, display_name, phone_e164, platform_role, active)
values ('USR-DISP1','調度員小陳','+886922333444','none',true) on conflict (id) do nothing;
insert into memberships (id, user_id, organization_id, role, status)
values ('MEM-001','USR-DISP1','ORG-TP-001','dispatcher','active') on conflict (id) do nothing;
SQL

total_fail=0
for suite in bootstrap session identity; do
  echo
  echo "== $suite =="
  if ! node "$HERE/$suite.test.js"; then total_fail=$((total_fail+1)); fi
done

echo
echo "== RLS 政策測試 =="
bash "$HERE/rls.test.sh" || total_fail=$((total_fail+1))

echo
if [ "$total_fail" -eq 0 ]; then echo "全部通過"; else echo "$total_fail 個測試檔有失敗"; fi
exit "$total_fail"
