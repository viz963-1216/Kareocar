#!/usr/bin/env bash
# 本機 CI：在這台電腦跑跟 GitHub Actions 相同的 PR 檢查（GitHub Actions 停用時使用）。
#
#   PGHOST=127.0.0.1 PGPORT=55432 bash tools/ci-local.sh [--report] [git ref，預設 HEAD]
#
# - 被測的程式碼用 git worktree 取出到暫存目錄，不動目前的工作目錄
# - 需要本機隔離的 Postgres（PGHOST 只能是 localhost／127.0.0.1）、psql、node 22 以上；
#   瀏覽器端對端需要 Google Chrome（CHROME_PATH 可覆寫）
# - 沒有安裝 npm 的 pg 時改用 psql 替身（supabase/tests/pg-psql-shim.js）：
#   它會檢查 SQL 沒用到的參數、回傳修改筆數，與真正的 pg 行為一致；
#   只有真正的 pg 才能驗的測試（db-ssl：pg 解析連線字串的結果）標示略過
# - 每個測試庫跑之前先刪掉（測試庫名稱固定，只會是 careride_*_test）
# - --report：把結果標回 GitHub 的 commit 狀態（PR 上看得到的勾勾），用 gh；不使用 GitHub Actions
# - 不跑：ZAP 安全掃描（需要 Docker）、npm audit（需要能連線 npm registry；有網路時另外跑）
set -uo pipefail

REPORT=0
if [ "${1:-}" = "--report" ]; then REPORT=1; shift; fi
REF="${1:-HEAD}"
case "${PGHOST:-}" in
  localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是 localhost 或 127.0.0.1（本機隔離的 Postgres）'; exit 2 ;;
esac
: "${PGPORT:?請設定 PGPORT（本機隔離的 Postgres）}"
export PGUSER=postgres

TOOL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="$(git -C "$TOOL_ROOT" rev-parse "$REF")" || { echo "找不到 $REF"; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/careride-ci-XXXXXX")"
LOGS="$WORK/logs"; mkdir -p "$LOGS"
cleanup() { git -C "$TOOL_ROOT" worktree remove --force "$WORK/src" >/dev/null 2>&1; }
trap cleanup EXIT
git -C "$TOOL_ROOT" worktree add -q --detach "$WORK/src" "$SHA" || exit 2
SRC="$WORK/src"

if [ ! -d "$SRC/node_modules/pg" ] && [ ! -d "$TOOL_ROOT/node_modules/pg" ]; then
  export NODE_PATH="$TOOL_ROOT/tools/ci-local${NODE_PATH:+:$NODE_PATH}"
  export NODE_OPTIONS="--require $TOOL_ROOT/tools/ci-local/skip-real-pg-only.js${NODE_OPTIONS:+ $NODE_OPTIONS}"
  DRIVER='psql 替身'
else
  DRIVER='pg'
fi
if [ -z "${CHROME_PATH:-}" ] && [ -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]; then
  export CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
fi
echo "本機 CI：$(git -C "$TOOL_ROOT" log --oneline -1 "$SHA")（驅動：$DRIVER）"

declare -a NAMES=() RESULTS=()
step() { # step 名稱 指令…
  local name="$1"; shift
  local log="$LOGS/$(echo "$name" | tr -c 'a-zA-Z0-9-' '_').log"
  # 這一步會建立的測試庫：先刪掉
  for db in $(grep -ho 'careride_[a-z0-9_]*' "$SRC/$1" 2>/dev/null | sort -u); do
    psql -X -q -d postgres -c "drop database if exists $db" >/dev/null 2>&1
  done
  local start=$SECONDS
  if (cd "$SRC" && bash "$@") >"$log" 2>&1; then
    RESULTS+=(pass); printf '  PASS %-28s %4ss\n' "$name" "$((SECONDS - start))"
  else
    RESULTS+=(fail); printf '  FAIL %-28s %4ss  （紀錄：%s）\n' "$name" "$((SECONDS - start))" "$log"
    grep -E '^\s*FAIL|Error|錯誤' "$log" | head -5 | sed 's/^/        /'
  fi
  NAMES+=("$name")
}

echo '--- 資料庫與單元測試 ---'
step '單元測試' tests/run.sh
for s in isolated-review business-flow org-review booking-geo booking-access schedule-trips split-legs \
         notifications benefit privacy oauth benefit-fetch all; do
  [ -f "$SRC/supabase/tests/run-$s.sh" ] && step "$s" "supabase/tests/run-$s.sh"
done
step 'migrations' supabase/tests/migrations.test.sh
[ -f "$SRC/supabase/tests/apply-migrations.test.sh" ] && step 'apply-migrations' supabase/tests/apply-migrations.test.sh
DB_FAIL=0; for r in "${RESULTS[@]}"; do [ "$r" = fail ] && DB_FAIL=1; done
echo '--- 瀏覽器端對端 ---'
E2E_FAIL=0
if [ -n "${CHROME_PATH:-}" ]; then
  step '瀏覽器端對端' supabase/tests/run-browser-e2e.sh || true
  [ "${RESULTS[${#RESULTS[@]}-1]}" = fail ] && E2E_FAIL=1
else
  echo '  略過：找不到 Google Chrome（設定 CHROME_PATH）'; E2E_FAIL=2
fi

PASS=0; FAIL=0; for r in "${RESULTS[@]}"; do [ "$r" = pass ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1)); done
echo "結果：$PASS 項通過、$FAIL 項失敗（紀錄在 $LOGS）"
SKIPPED="$(grep -ho '略過（需要真正的 pg）：[^ ]*' "$LOGS"/*.log 2>/dev/null | sort -u | sed 's/^略過（需要真正的 pg）：//' | paste -sd '、' -)"
[ -n "$SKIPPED" ] && echo "略過（需要真正的 pg，GitHub Actions 恢復後才會驗）：$SKIPPED"

if [ "$REPORT" = 1 ]; then
  REPO="$(git -C "$TOOL_ROOT" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"
  post() { # context state description
    gh api -X POST "repos/$REPO/statuses/$SHA" -f context="$1" -f state="$2" -f description="$3" >/dev/null \
      && echo "已標回 GitHub：$1 → $2"
  }
  if [ "$DB_FAIL" = 0 ]; then post '本機 CI／資料庫與單元測試' success "全部通過（$DRIVER${SKIPPED:+；略過 $SKIPPED}）"
  else post '本機 CI／資料庫與單元測試' failure '有測試失敗，見本機紀錄'; fi
  case "$E2E_FAIL" in
    0) post '本機 CI／瀏覽器端對端' success '全部通過' ;;
    1) post '本機 CI／瀏覽器端對端' failure '有測試失敗，見本機紀錄' ;;
    *) post '本機 CI／瀏覽器端對端' error '沒有跑（找不到 Chrome）' ;;
  esac
fi
[ "$FAIL" = 0 ]
