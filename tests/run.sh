#!/usr/bin/env bash
# Backend regression suite for the Apps Script layer.
#
# The .gs files are plain ES5, so they run under Node against the small
# Google Apps Script stand-in in shim.js / sheets.js. No deployment needed.
#
#   ./tests/run.sh
#
# 每個測試檔都有硬性逾時（預設 120 秒，用 TEST_TIMEOUT_SECONDS 覆寫）。
#
# 為什麼要這個：2026-09-13 在 main 上的 push CI，Node 24 的 job 卡在這一步，
# 15 分鐘沒有任何輸出，最後被 job timeout 取消——日誌裡看不出是哪一支卡住、
# 也沒有任何診斷資訊。有了逾時之後，卡住會在 2 分鐘內失敗，而且會明講是哪個
# 檔案；測試檔本身另外掛了 exit watchdog，會印出還活著的資源。
#
# macOS 沒有 coreutils 的 timeout，所以用背景行程自己實作，不引入相依。
set -uo pipefail
cd "$(dirname "$0")/.."

TEST_TIMEOUT_SECONDS="${TEST_TIMEOUT_SECONDS:-120}"

fail=0
timed_out=()

run_one() {
  local file="$1"
  node "$file" &
  local pid=$!

  # 看門狗：超時就先 SIGTERM 給它機會印東西，兩秒後 SIGKILL。
  (
    sleep "$TEST_TIMEOUT_SECONDS"
    if kill -0 "$pid" 2>/dev/null; then
      echo ""
      echo "  ⏱ 超過 ${TEST_TIMEOUT_SECONDS} 秒仍未結束：$file"
      kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL "$pid" 2>/dev/null
    fi
  ) &
  local watcher=$!

  wait "$pid"
  local rc=$?

  kill -KILL "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null

  return "$rc"
}

for t in tests/*.test.js; do
  echo ""
  echo "─── $t ──────────────────────────────────────────"
  run_one "$t"
  rc=$?
  case "$rc" in
    0) ;;
    97)  # tests/_exit-watchdog.js 的退出碼：主體跑完但行程不結束
      echo "  ✗ $t 的測試主體通過，但行程沒有結束（見上方 exit-watchdog 的資源清單）"
      fail=1 ;;
    124|137|143)
      echo "  ✗ $t 逾時被終止（rc=$rc）"
      timed_out+=("$t")
      fail=1 ;;
    *)
      fail=1 ;;
  esac
done

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  echo "全部通過"
else
  if [ "${#timed_out[@]}" -gt 0 ]; then
    echo "逾時的測試檔：${timed_out[*]}"
  fi
  echo "有測試失敗"
fi
exit "$fail"
