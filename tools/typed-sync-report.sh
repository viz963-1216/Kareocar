#!/usr/bin/env bash
# 預約與行程同步報告（#126，ADR 0005）：比對 app_state 與正式資料表的筆數與內容。
# 唯讀：連線設定成只能讀（default_transaction_read_only），不會寫入任何資料。
#
#   MIGRATION_DATABASE_URL=… bash tools/typed-sync-report.sh
#
# 不一致時列出前 20 筆並以 exit 1 結束；資料庫還沒有 0023 就略過。
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?需要 MIGRATION_DATABASE_URL}"
export PGOPTIONS='-c default_transaction_read_only=on'
q() { psql "$MIGRATION_DATABASE_URL" -X -tAq -v ON_ERROR_STOP=1 -c "$1"; }

if [ "$(q "select to_regprocedure('app.typed_sync_diff()') is not null")" != "t" ]; then
  echo '還沒有 0023（app.typed_sync_diff），略過同步報告'; exit 0
fi
echo '== 筆數（app_state → 正式資料表）=='
q "select '預約：' || (select count(*) from app_state where collection = 'bookings') || ' → ' || (select count(*) from bookings)"
q "select '行程：' || (select count(*) from app_state where collection = 'trips') || ' → ' || (select count(*) from trips)"
q "select '去程／回程：' || (select count(*) from booking_legs) || '；行程與預約關聯：' || (select count(*) from trip_bookings) || '；取消紀錄：' || (select count(*) from cancellations)"
diff="$(q "select kind || ' ' || id || '：' || problem from app.typed_sync_diff() limit 20")"
if [ -n "$diff" ]; then
  echo '== 不一致 =='; echo "$diff"; exit 1
fi
echo '一致'
