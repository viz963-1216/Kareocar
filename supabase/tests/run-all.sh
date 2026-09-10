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
$PSQL_ADMIN -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$HERE/seed.sql" >/dev/null

total_fail=0
# 順序有相依：bootstrap 會替 seed 裡那個沒有密碼的超級管理者設定密碼，
# session 才有帳號可以登入；identity 借用 seed 的 B 隊負責人建立員工。
for suite in bootstrap session identity state wiring; do
  echo
  echo "== $suite =="
  if ! node "$HERE/$suite.test.js"; then total_fail=$((total_fail+1)); fi
done

# RLS 測試比對的是精確筆數，前面幾支已經加了資料，所以先把種子重灌回去
echo
echo "== RLS 政策測試 =="
$PSQL_ADMIN -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$HERE/seed.sql" >/dev/null
bash "$HERE/rls.test.sh" || total_fail=$((total_fail+1))

echo
if [ "$total_fail" -eq 0 ]; then echo "全部通過"; else echo "$total_fail 個測試檔有失敗"; fi
exit "$total_fail"
