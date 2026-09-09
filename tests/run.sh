#!/usr/bin/env bash
# Backend regression suite for the Apps Script layer.
#
# The .gs files are plain ES5, so they run under Node against the small
# Google Apps Script stand-in in shim.js / sheets.js. No deployment needed.
#
#   ./tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
for t in tests/*.test.js; do
  echo ""
  echo "─── $t ──────────────────────────────────────────"
  node "$t" || fail=1
done

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  echo "全部通過"
else
  echo "有測試失敗"
fi
exit "$fail"
