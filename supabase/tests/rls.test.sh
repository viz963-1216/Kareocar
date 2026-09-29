#!/usr/bin/env bash
# RLS 政策的驗證測試。
#
# 每個案例都以 care_ride_app 角色連線、設定 app.user_id，然後檢查資料庫
# 實際回傳什麼。重點不是「政策寫得漂不漂亮」，是「攻擊真的被擋下來嗎」。
#
#   PGHOST=/tmp/pgrun PGPORT=5433 ./rls.test.sh
set -uo pipefail

PSQL="psql -h ${PGHOST:-/tmp/pgrun} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -d ${PGDATABASE:-careride} -tAq"

pass=0; fail=0
# as_raw：完整輸出（錯誤訊息會跨多行，錯誤檢查要用這個）
as_raw() {
  local uid="$1"; shift
  $PSQL -c "set role care_ride_app; select set_config('app.user_id','$uid',false); $*" 2>&1
}
# as：只取最後一行的純量值（數值比對用）
as() { as_raw "$@" | grep -v '^CONTEXT:' | tail -1; }
# 以 postgres（資料表擁有者）執行，用來示範它會繞過 RLS
as_owner() { $PSQL -c "select set_config('app.user_id','$1',false); $2" 2>&1 | grep -v '^CONTEXT:' | tail -1; }

check() { # check <說明> <實際> <預期>
  if [ "$2" == "$3" ]; then pass=$((pass+1)); printf "  PASS  %s\n" "$1"
  else fail=$((fail+1)); printf "  FAIL  %s（得到 %q，預期 %q）\n" "$1" "$2" "$3"; fi
}
# 錯誤檢查一律吃完整輸出
check_err() { # check_err <說明> <輸出> <應包含>
  if [[ "$2" == *"$3"* ]]; then pass=$((pass+1)); printf "  PASS  %s\n" "$1"
  else fail=$((fail+1)); printf "  FAIL  %s（輸出：%s）\n" "$1" "${2:0:90}"; fi
}

echo "═══ 攻擊模擬：這些就是上一輪修掉的漏洞 ═══"
check "攻擊者看不到他人的預約" \
  "$(as USR-ATTACK "select count(*) from bookings where id='BKG-VICTIM';")" "0"
check "攻擊者更新他人預約：影響 0 列" \
  "$(as USR-ATTACK "with u as (update bookings set state='cancelled' where id='BKG-VICTIM' returning 1) select count(*) from u;")" "0"
check "攻擊者無法把自己塞成他人預約的擁有者" \
  "$(as USR-ATTACK "with u as (update bookings set requested_by_user_id='USR-ATTACK' where id='BKG-VICTIM' returning 1) select count(*) from u;")" "0"
check "攻擊者看不到他人的服務對象" \
  "$(as USR-ATTACK "select count(*) from care_recipients where id='CR-1';")" "0"
check "攻擊者看不到他人的行程" \
  "$(as USR-ATTACK "select count(*) from trips;")" "0"
check_err "攻擊者無法自我提權為超級管理者" \
  "$(as_raw USR-ATTACK "update users set platform_role='super_admin' where id='USR-ATTACK';")" \
  "只有平台超級管理者可以變更平台角色"
check_err "攻擊者無法把自己加進別家公司" \
  "$(as_raw USR-ATTACK "insert into memberships (id,user_id,organization_id,role) values ('M-EVIL','USR-ATTACK','ORG-TP-001','dispatcher');")" \
  "violates row-level security policy"

echo
echo "═══ 正常權限必須維持 ═══"
check "需求者看得到自己的預約" \
  "$(as USR-VICTIM "select count(*) from bookings;")" "2"
check "需求者看得到自己的服務對象" \
  "$(as USR-VICTIM "select count(*) from care_recipients;")" "1"
check "需求者可以更新自己的預約" \
  "$(as USR-VICTIM "with u as (update bookings set special_needs='需要陪同' where id='BKG-VICTIM' returning 1) select count(*) from u;")" "1"
check "調度員看得到自家組織的預約" \
  "$(as USR-DISP1 "select count(*) from bookings where organization_id='ORG-TP-001';")" "1"
check "調度員看得到自家行程" \
  "$(as USR-DISP1 "select count(*) from trips;")" "1"
check "司機看得到自己被派的行程" \
  "$(as USR-DRV1 "select count(*) from trips;")" "1"
check "司機看得到該行程上的預約" \
  "$(as USR-DRV1 "select count(*) from bookings where id='BKG-VICTIM';")" "1"
check "B 隊負責人看不到 A 隊的行程" \
  "$(as USR-OWN2 "select count(*) from trips;")" "0"
check "超級管理者看得到全部預約" \
  "$(as USR-ROOT "select count(*) from bookings;")" "2"

echo
echo "═══ 公開需求池：只給營運方、且個資已遮蔽 ═══"
check "需求者看不到需求池" \
  "$(as USR-VICTIM "select count(*) from public_booking_pool;")" "0"
check "調度員看得到未承接的案件" \
  "$(as USR-DISP1 "select count(*) from public_booking_pool;")" "1"
check "需求池只露出到行政區" \
  "$(as USR-DISP1 "select pickup_area from public_booking_pool where id='BKG-OPEN';")" "新北市板橋區"
check "需求池不含門牌" \
  "$(as USR-DISP1 "select count(*) from public_booking_pool where pickup_area like '%文化路%';")" "0"
check "需求池沒有預約者欄位" \
  "$(as USR-DISP1 "select count(*) from information_schema.columns where table_name='public_booking_pool' and column_name in ('requested_by_user_id','care_recipient_id','pickup_address');")" "0"

echo
echo "═══ 承接競爭：資料庫層的交易保證 ═══"
check "調度員成功承接公開案件" \
  "$(as USR-DISP1 "select state from app.claim_booking('BKG-OPEN','ORG-TP-001');")" "claimed"
check_err "第二個人再搶同一張單會失敗" \
  "$(as_raw USR-OWN2 "select state from app.claim_booking('BKG-OPEN','ORG-TP-002');")" \
  "已被其他服務單位接走"
check_err "不能代表自己沒加入的公司承接" \
  "$(as_raw USR-DISP1 "select state from app.claim_booking('BKG-VICTIM','ORG-TP-002');")" \
  "沒有權限代表這個組織承接案件"

echo
echo "═══ 密碼不在資料庫；session 撤銷只能走受控函式 ═══"
check "資料庫沒有密碼憑證表（密碼由 Supabase Auth 保管）" \
  "$(as_owner USR-ROOT "select count(*) from pg_tables where tablename = 'password_credentials';")" "0"
check "應用角色讀得到自己的 session 狀態" \
  "$(as USR-VICTIM "select active from app.session_state('USR-VICTIM');")" "t"
check "撤銷 session 後，生效起點晚於現在（這一秒內簽發的 token 也失效）" \
  "$(as USR-VICTIM "select app.revoke_sessions('USR-VICTIM') > floor(extract(epoch from now()))::bigint;")" "t"

echo
echo "═══ 稽核紀錄不可竄改 ═══"
check_err "無法修改稽核紀錄" \
  "$(as_raw USR-ROOT "update audit_events set event_type='tampered' where id='AUD-1';")" "permission denied"
check_err "無法刪除稽核紀錄" \
  "$(as_raw USR-ROOT "delete from audit_events where id='AUD-1';")" "permission denied"

echo
echo "═══ ⚠️ 用 postgres 連線會繞過全部政策 ═══"
check "postgres 身分看得到所有預約（這就是不能用它連線的原因）" \
  "$(as_owner USR-ATTACK "select count(*) from bookings;")" "2"
check "care_ride_app 身分同一個查詢只看得到 0 筆" \
  "$(as USR-ATTACK "select count(*) from bookings;")" "0"

echo
echo "─────────────────────────────────────────"
echo "結果：$pass 通過 / $fail 失敗"
exit $((fail > 0))
