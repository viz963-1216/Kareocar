#!/usr/bin/env bash
# 「新資料庫 + 舊程式」相容性（部署順序：先 migration、後程式，中間這段的實測）。
#
#   1. 從 COMPAT_OLD_REF（預設 origin/main）取出舊版程式到暫存 worktree
#   2. 確認舊版的 0001–0007 與本分支完全相同（本分支只新增 0008）
#   3. 舊版 handler 分別對「0001–0007」與「0001–0008」兩個庫跑同一組操作，比對結果
#   4. 舊版自己的隔離測試（run-isolated-review.sh）在含 0008 的 schema 上再跑一次
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
OLD_REF="${COMPAT_OLD_REF:-origin/main}"
WORK="$(mktemp -d /tmp/care-ride-compat-XXXXXX)"
cleanup() { git -C "$ROOT" worktree remove --force "$WORK/old" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

git -C "$ROOT" worktree add --detach "$WORK/old" "$OLD_REF" >/dev/null
echo "舊程式：$OLD_REF = $(git -C "$WORK/old" rev-parse HEAD)"
echo "新 migration：$(git -C "$ROOT" rev-parse HEAD)"

echo "--- 舊版 0001–0007 與本分支相同 ---"
for f in "$WORK"/old/supabase/migrations/*.sql; do
  cmp -s "$f" "$ROOT/supabase/migrations/$(basename "$f")" || { echo "  FAIL $(basename "$f") 與本分支不同"; exit 1; }
  echo "  PASS $(basename "$f")"
done

createdb careride_compat_old
createdb careride_compat_new
for f in "$WORK"/old/supabase/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d careride_compat_old -f "$f" >/dev/null
done
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d careride_compat_new -f "$f" >/dev/null
done

# 舊版程式沒有自己的 node_modules，pg 從本分支的安裝解析
export NODE_PATH="$ROOT/node_modules"
export COMPAT_FUNCTIONS_DIR="$WORK/old/netlify/functions"
echo "--- 舊程式 × 舊庫 ---"
PGDATABASE=careride_compat_old COMPAT_RESULT_FILE="$WORK/old.json" node "$ROOT/supabase/tests/compat-old-code.test.js"
echo "--- 舊程式 × 新庫 ---"
PGDATABASE=careride_compat_new COMPAT_RESULT_FILE="$WORK/new.json" node "$ROOT/supabase/tests/compat-old-code.test.js"
echo "--- 比對 ---"
node "$ROOT/supabase/tests/compat-old-code.test.js" --compare "$WORK/old.json" "$WORK/new.json"

echo "--- 舊版自己的隔離測試，跑在含 0008 的 schema 上 ---"
cp "$ROOT/supabase/migrations/0008_business_flow_endpoints.sql" "$WORK/old/supabase/migrations/"
(cd "$WORK/old" && bash supabase/tests/run-isolated-review.sh)
echo "結果：舊程式在含 0008 的資料庫上的隔離測試通過"
