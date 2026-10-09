#!/usr/bin/env bash
# 效能測試（#125）：建立全新的 careride_perf_test，套用實際 migrations、塞入合成資料，
# 量測關鍵查詢的查詢計畫與時間。結果寫到 PERF_OUT（預設 supabase/tests/perf/results.json）。
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

createdb careride_perf_test
for migration in "$ROOT"/supabase/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d careride_perf_test -f "$migration" >/dev/null
done
psql -X -q -v ON_ERROR_STOP=1 -v scale="${PERF_SCALE:-1}" -d careride_perf_test -f "$ROOT/supabase/tests/perf/seed.sql" >/dev/null

PGDATABASE=careride_perf_test node "$ROOT/supabase/tests/perf.test.js"
