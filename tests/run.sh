#!/usr/bin/env bash
# 離線回歸測試：不需要資料庫、不需要部署的純 Node 測試
# （建置檢查、行程執行規則、前端接線、同步狀態、離線交易回歸等）。
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

# 逾時完全在主 shell 裡輪詢，不另開背景看門狗。
#
# 先前的寫法是 `( sleep N; kill ... ) &`，然後用 kill 終止那個背景 shell。
# 問題是那只殺得掉 subshell，`sleep` 子行程還活著，而且繼承了 run.sh 的
# stdout/stderr。呼叫端若用管線收輸出（例如 subprocess.run(capture_output=True)），
# 管線要等 sleep 結束才會收到 EOF——測試明明 0.04 秒就跑完，呼叫端卻要等滿
# 整個逾時秒數。Codex 以空 JS + TEST_TIMEOUT_SECONDS=3 重現：耗時 3.01 秒。
#
# 改成主 shell 輪詢之後，就沒有任何背景子行程可以殘留。
POLL_INTERVAL="${TEST_POLL_INTERVAL:-0.1}"

run_one() {
  local file="$1"
  node "$file" &
  local pid=$!

  local waited=0
  local limit
  # 用整數的輪詢次數表示逾時，避免依賴浮點運算
  limit=$(awk -v t="$TEST_TIMEOUT_SECONDS" -v p="$POLL_INTERVAL" 'BEGIN{printf "%d", (t/p)+0.5}')

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      echo ""
      echo "  ⏱ 超過 ${TEST_TIMEOUT_SECONDS} 秒仍未結束：$file"
      kill -TERM "$pid" 2>/dev/null
      # 給它兩秒把東西印出來，還不走就 SIGKILL
      local grace=0
      while kill -0 "$pid" 2>/dev/null && [ "$grace" -lt 20 ]; do
        sleep 0.1
        grace=$((grace + 1))
      done
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep "$POLL_INTERVAL"
    waited=$((waited + 1))
  done

  wait "$pid"
  return $?
}

for t in tests/*.test.js; do
  echo ""
  echo "─── $t ──────────────────────────────────────────"
  run_one "$t"
  rc=$?
  case "$rc" in
    0) ;;
    97)  # tests/_exit-watchdog.js 的退出碼
      echo "  ✗ $t 測試主體已完成但行程未退出（見上方 exit-watchdog 的資源清單）"
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
