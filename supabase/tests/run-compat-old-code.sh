#!/usr/bin/env bash
# 「新資料庫 + 舊程式」與「回復之後 + 舊程式」相容性。
#
#   1. 從 COMPAT_OLD_REF（預設固定發布版本 6539c75）取出舊版程式到暫存 worktree
#   2. 確認舊版的 0001–0007 與本分支完全相同
#   3. 舊版 handler 分別跑三個庫，比對結果：
#        careride_compat_old       0001–0007
#        careride_compat_new       0001–0008（部署程式前的狀態）
#        careride_compat_rollback  0001–0008 → 回復 0008 並重新套用 0007
#      old × new 只允許列出的預期差異；old × rollback 必須完全相同
#   4. 舊版自己的隔離測試跑在含 0008 的 schema 上
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
OLD_REF="${COMPAT_OLD_REF:-6539c75b4c4131bb2eef1304db0c21100fd888b8}"
WORK="$(mktemp -d /tmp/care-ride-compat-XXXXXX)"
cleanup() { git -C "$ROOT" worktree remove --force "$WORK/old" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
M8="$ROOT/supabase/migrations/0008_business_flow_endpoints.sql"

git -C "$ROOT" worktree add --detach "$WORK/old" "$OLD_REF" >/dev/null
echo "舊程式：$OLD_REF = $(git -C "$WORK/old" rev-parse HEAD)"
echo "新 migration：$(git -C "$ROOT" rev-parse HEAD)"

echo "--- 舊版 0001–0007 與本分支相同 ---"
for f in "$WORK"/old/supabase/migrations/*.sql; do
  cmp -s "$f" "$ROOT/supabase/migrations/$(basename "$f")" || { echo "  FAIL $(basename "$f") 與本分支不同"; exit 1; }
  echo "  PASS $(basename "$f")"
done

apply() { psql -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" >/dev/null; }
createdb careride_compat_old
createdb careride_compat_new
createdb careride_compat_rollback
for f in "$WORK"/old/supabase/migrations/*.sql; do apply careride_compat_old "$f"; done
for f in "$WORK"/old/supabase/migrations/*.sql "$M8"; do apply careride_compat_new "$f"; done
for f in "$ROOT"/supabase/migrations/*.sql; do apply careride_compat_rollback "$f"; done
echo "--- 回復 0008（重新套用 0007） ---"
psql -X -q -v ON_ERROR_STOP=1 -d careride_compat_rollback -c "set lock_timeout = '5s'" -c 'begin' \
  -f "$ROOT/supabase/rollback/0008_business_flow_endpoints.down.sql" \
  -f "$ROOT/supabase/migrations/0007_app_state.sql" -c 'commit' >/dev/null
echo "  已回復"

# 舊版程式沒有自己的 node_modules，pg 從本分支的安裝解析
export NODE_PATH="$ROOT/node_modules"
export COMPAT_FUNCTIONS_DIR="$WORK/old/netlify/functions"
for db in old new rollback; do
  echo "--- 舊程式 × careride_compat_$db ---"
  PGDATABASE="careride_compat_$db" COMPAT_RESULT_FILE="$WORK/$db.json" node "$ROOT/supabase/tests/compat-old-code.test.js"
done
echo "--- 比對：舊庫 × 含 0008 的庫 ---"
node "$ROOT/supabase/tests/compat-old-code.test.js" --compare "$WORK/old.json" "$WORK/new.json"
echo "--- 比對：舊庫 × 回復 0008 之後的庫（必須完全相同） ---"
node "$ROOT/supabase/tests/compat-old-code.test.js" --compare --expect-identical "$WORK/old.json" "$WORK/rollback.json"

echo "--- 舊版自己的隔離測試，跑在含 0008 的 schema 上 ---"
cp "$M8" "$WORK/old/supabase/migrations/"
(cd "$WORK/old" && bash supabase/tests/run-isolated-review.sh)
echo "結果：舊程式在含 0008 的資料庫上的隔離測試通過"
