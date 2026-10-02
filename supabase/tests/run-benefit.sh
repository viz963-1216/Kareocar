#!/usr/bin/env bash
# 補助規則版本與伺服器試算（#23）整合測試：建立全新的 careride_benefit_test，套用實際 migrations，
# 再以實際 handler（care_ride_app 連線）執行。
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

createdb careride_benefit_test
for migration in "$ROOT"/supabase/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d careride_benefit_test -f "$migration" >/dev/null
done

PGDATABASE=careride_benefit_test node "$ROOT/supabase/tests/benefit.test.js"
