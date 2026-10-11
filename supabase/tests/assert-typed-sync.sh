#!/usr/bin/env bash
# 預約與行程同步的一致性檢查（#126，ADR 0005）：跑完整合測試後，正式資料表必須和 app_state 一致。
# 用法：assert-typed-sync.sh <資料庫名稱>。app.typed_sync_diff() 不存在（0031 收斂之後）改成確認 app_state 沒有預約與行程。
set -uo pipefail
DB="$1"
has="$(psql -X -tAq -U postgres -d "$DB" -c "select to_regprocedure('app.typed_sync_diff()') is not null")"
if [ "$has" != "t" ]; then
  # 0031 收斂之後沒有同步：改成確認預約與行程沒有寫回 app_state
  left="$(psql -X -tAq -U postgres -d "$DB" -c "select count(*) from app_state where collection in ('bookings','trips')")"
  if [ "$left" != "0" ]; then echo "  FAIL app_state 還有 $left 筆預約或行程（$DB）"; exit 1; fi
  echo "  PASS 預約與行程只在正式資料表（$DB）"; exit 0
fi
diff="$(psql -X -tAq -U postgres -d "$DB" -c "select kind || ' ' || id || '：' || problem from app.typed_sync_diff() limit 20")"
if [ -n "$diff" ]; then
  echo "  FAIL 正式資料表與 app_state 不一致（$DB）："; echo "$diff" | sed 's/^/    /'; exit 1
fi
counts="$(psql -X -tAq -U postgres -d "$DB" -c "select (select count(*) from bookings) || ' 筆預約、' || (select count(*) from booking_legs) || ' 段、' || (select count(*) from trips) || ' 趟行程'")"
echo "  PASS 正式資料表與 app_state 一致（$DB：$counts）"
