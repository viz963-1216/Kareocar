#!/usr/bin/env bash
# Fresh disposable cluster only; databases must not already exist.
set -euo pipefail
# 這支腳本會 createdb 並在測試庫裡 TRUNCATE，只允許本機隔離端點。
# 真正的保護是下面固定的測試庫名稱（careride_*_test）；正式 Supabase 的
# 主機名稱永遠不會是 localhost，所以兩層合起來足夠。
case "${PGHOST:-}" in
  /tmp/care-ride-*|localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是本機隔離端點（/tmp/care-ride-*、localhost 或 127.0.0.1）'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for task_db in careride_seed_test careride_reset_test; do
  # Fail rather than overwrite any existing database.
  createdb "$task_db"
  for migration in "$ROOT"/supabase/migrations/*.sql; do
    psql -X -v ON_ERROR_STOP=1 -d "$task_db" -f "$migration"
  done
done
PGDATABASE=careride_seed_test bash "$ROOT/supabase/tests/seed-test-org.test.sh"
psql -X -v ON_ERROR_STOP=1 -d careride_reset_test -f "$ROOT/supabase/tests/seed.sql"
PGDATABASE=careride_reset_test node "$ROOT/supabase/tests/reset-transaction.test.js"
