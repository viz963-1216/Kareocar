#!/usr/bin/env bash
# 瀏覽器端對端測試：建立全新的 careride_e2e_test、套用實際 migrations，
# 啟動 tools/local-dev-server.js（同一個 Node 行程內）與 headless Chrome 操作 index.html。
#
# 本機執行需要：Postgres 16（localhost）、Node 22+、Google Chrome（或以 CHROME_PATH 指定）。
#
#   PGHOST=127.0.0.1 PGPORT=5432 bash supabase/tests/run-browser-e2e.sh
#
# 只允許本機隔離端點；測試庫名稱固定，已存在就失敗，不覆寫。
set -euo pipefail
case "${PGHOST:-}" in
  localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是 localhost 或 127.0.0.1'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

createdb careride_e2e_test
for migration in "$ROOT"/supabase/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d careride_e2e_test -f "$migration" >/dev/null
done

# 前端的營運日用瀏覽器本地時區，測試資料用 Node 的本地時區，兩邊固定成同一個
export TZ=UTC
export E2E_ARTIFACT_DIR="${E2E_ARTIFACT_DIR:-$(mktemp -d /tmp/care-ride-e2e-XXXXXX)}"
PGDATABASE=careride_e2e_test node "$ROOT/supabase/tests/browser-e2e.test.js"

bash "$ROOT/supabase/tests/assert-typed-sync.sh" careride_e2e_test
