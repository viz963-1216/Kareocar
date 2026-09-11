#!/usr/bin/env bash
#
# supabase/seed-test-org.sql 的情境測試。
#
# 跑在一個臨時 Postgres 上，schema 由 supabase/migrations/ 的實際 migration
# 依序建立——不用簡化 schema，否則相容性問題會被掩蓋掉。測試資料全部是合成
# 的，不使用任何正式帳號或正式庫連線。
#
# 用法（需要 PGHOST / PGPORT / PGUSER / PGDATABASE 或 PG* 等價設定）：
#
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=careride_ci \
#     bash supabase/tests/seed-test-org.test.sh
#
# 注意「預期失敗」的情境：那些情境裡 psql 回非零是正確結果，代表 SQL 有好好
# 報錯。腳本明確區分「預期成功卻失敗」與「預期失敗卻成功」，兩者都算測試失
# 敗；預期內的 SQL 失敗不會被當成整套測試失敗，也不會被忽略。
#
# 刻意不使用 set -e：預期失敗的指令必須讓腳本繼續跑下去。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SEED_SQL="$ROOT/supabase/seed-test-org.sql"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PHONE='+886900000010'
ORG='ORG-TEST-001'
MEM='MEM-TEST-OWNER'
ORG_NAME='測試服務單位（請勿使用）'
USER_ID='USR-CI-0001'
OTHER_USER_ID='USR-CI-0002'

pass=0
fail=0

ok()  { echo "  PASS $1"; pass=$((pass + 1)); }
ng()  { echo "  FAIL $1"; fail=$((fail + 1)); }
note(){ echo "      $1"; }

# 純量查詢
q() { psql -X -q -t -A -c "$1" 2>/dev/null; }

# 執行 SQL 檔，回傳 exit code，輸出留在 $TMP/psql.log
run_sql() {
  psql -X -q -v ON_ERROR_STOP=1 -f "$1" >"$TMP/psql.log" 2>&1
  echo $?
}

# 三張相關表的內容指紋，用來證明失敗情境確實回滾、既有資料未改動
snapshot() {
  q "select coalesce(md5(string_agg(x, e'\n' order by x)), 'EMPTY') from (
       select 'U:'||id||'|'||display_name||'|'||coalesce(phone_e164,'')||'|'||active::text from users
       union all
       select 'O:'||id||'|'||org_type||'|'||name||'|'||coalesce(contact_phone,'')||'|'||active::text
         from organizations
       union all
       select 'M:'||id||'|'||user_id||'|'||organization_id||'|'||role||'|'||status from memberships
     ) s(x)"
}

reset_data() {
  psql -X -q -v ON_ERROR_STOP=1 \
    -c "truncate memberships, organizations, users cascade" >/dev/null 2>&1
}

add_user() {   # id, phone, active
  psql -X -q -v ON_ERROR_STOP=1 -c \
    "insert into users (id, display_name, phone_e164, active)
     values ('$1', 'CI 合成測試帳號 $1', '$2', $3)" >/dev/null 2>&1
}

# --------------------------------------------------------------------------
echo "== 前置：從 seed SQL 取出各步驟 =="

sed -n '/\[CI\] STEP2_BEGIN/,/\[CI\] STEP2_END/p' "$SEED_SQL" > "$TMP/step2.sql"
sed -n '/\[CI\] STEP3_BEGIN/,/\[CI\] STEP3_END/p' "$SEED_SQL" > "$TMP/step3.sql"

if [ ! -s "$TMP/step2.sql" ] || [ ! -s "$TMP/step3.sql" ]; then
  echo "  取不到 STEP2 / STEP3 區塊，seed SQL 的 [CI] 標記可能被改動了"
  exit 1
fi
grep -q 'do \$\$' "$TMP/step2.sql" || { echo "  STEP2 區塊看起來不完整"; exit 1; }
echo "  step2 $(wc -l < "$TMP/step2.sql") 行、step3 $(wc -l < "$TMP/step3.sql") 行"

# step3 的第一欄（驗證結果）
verdict() { psql -X -q -t -A -f "$TMP/step3.sql" 2>/dev/null | head -1 | cut -d'|' -f1; }
# step3 回傳的列數
verdict_rows() { psql -X -q -t -A -f "$TMP/step3.sql" 2>/dev/null | grep -c . ; }

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 1：首次執行 ==="
reset_data
add_user "$USER_ID" "$PHONE" true

rc=$(run_sql "$TMP/step2.sql")
if [ "$rc" -eq 0 ]; then ok "執行成功"; else ng "預期成功卻失敗（rc=$rc）"; cat "$TMP/psql.log"; fi

[ "$(q "select count(*) from organizations where id='$ORG' and name='$ORG_NAME'
        and org_type='transport_provider' and contact_phone='0212345678' and active")" = "1" ] \
  && ok "組織已建立且欄位相符" || ng "組織欄位不符"

[ "$(q "select count(*) from memberships where id='$MEM' and user_id='$USER_ID'
        and organization_id='$ORG' and role='owner' and status='active'")" = "1" ] \
  && ok "負責人 membership 已建立" || ng "membership 不符"

v=$(verdict)
[ "$v" = "PASS" ] && ok "step3 驗證回 PASS" || ng "step3 回「$v」"
[ "$(verdict_rows)" = "1" ] && ok "step3 回傳剛好一列" || ng "step3 回傳 $(verdict_rows) 列"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 2：重複執行（承接情境 1 的狀態）==="
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")
if [ "$rc" -eq 0 ]; then ok "重跑成功（安全跳過）"; else ng "重跑失敗（rc=$rc）"; cat "$TMP/psql.log"; fi

after=$(snapshot)
[ "$before" = "$after" ] && ok "重跑未改動任何資料" || ng "重跑改動了資料"

[ "$(q "select count(*) from memberships where organization_id='$ORG'")" = "1" ] \
  && ok "沒有產生重複 membership" || ng "membership 變成 $(q "select count(*) from memberships where organization_id='$ORG'") 筆"

grep -q '已存在且內容相符' "$TMP/psql.log" && ok "有輸出「已存在，跳過」訊息" \
  || ng "未見跳過訊息"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 3：使用者不存在 ==="
reset_data
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc，這是正確結果）"; else ng "預期失敗卻成功了"; fi
grep -q '找不到 phone_e164' "$TMP/psql.log" && ok "錯誤訊息指出找不到使用者" \
  || { ng "錯誤訊息不符"; note "$(tail -3 "$TMP/psql.log")"; }

[ "$(snapshot)" = "$before" ] && ok "資料未被改動" || ng "資料被改動了"
[ "$(q "select count(*) from organizations where id='$ORG'")" = "0" ] \
  && ok "組織未被建立" || ng "組織竟然被建立了"

v=$(verdict)
case "$v" in FAIL*) ok "step3 回 FAIL：$v" ;; *) ng "step3 回「$v」，預期 FAIL" ;; esac
[ "$(verdict_rows)" = "1" ] && ok "組織不存在時 step3 仍回剛好一列" || ng "step3 回 $(verdict_rows) 列"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 4：使用者已停用 ==="
reset_data
add_user "$USER_ID" "$PHONE" false
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc）"; else ng "預期失敗卻成功了"; fi
grep -q 'active = false' "$TMP/psql.log" && ok "錯誤訊息指出帳號已停用" \
  || { ng "錯誤訊息不符"; note "$(tail -3 "$TMP/psql.log")"; }
[ "$(snapshot)" = "$before" ] && ok "資料未被改動" || ng "資料被改動了"
[ "$(q "select count(*) from organizations where id='$ORG'")" = "0" ] \
  && ok "組織未被建立" || ng "組織竟然被建立了"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 5：組織主鍵已被內容不符的資料占用 ==="
reset_data
add_user "$USER_ID" "$PHONE" true
psql -X -q -c "insert into organizations (id, org_type, name, contact_phone, active)
               values ('$ORG','transport_provider','某個真實單位','0299999999',true)" >/dev/null 2>&1
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc）"; else ng "預期失敗卻成功了"; fi
grep -q '內容與預期不符' "$TMP/psql.log" && ok "錯誤訊息指出內容不符" \
  || { ng "錯誤訊息不符"; note "$(tail -3 "$TMP/psql.log")"; }
[ "$(snapshot)" = "$before" ] && ok "既有組織未被覆寫" || ng "既有組織被改動了"
[ "$(q "select name from organizations where id='$ORG'")" = "某個真實單位" ] \
  && ok "組織名稱維持原值" || ng "組織名稱被改掉"
[ "$(q "select count(*) from memberships")" = "0" ] \
  && ok "未建立任何 membership" || ng "竟然建立了 membership"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 6：membership 主鍵被占用（驗證部分寫入確實回滾）==="
# 這個情境刻意讓組織不存在：SQL 會先 INSERT 組織，再在 membership 段落報錯。
# 如果交易沒有回滾，組織就會殘留下來。
reset_data
add_user "$USER_ID" "$PHONE" true
add_user "$OTHER_USER_ID" '+886900000099' true
psql -X -q -c "insert into organizations (id, org_type, name, active)
               values ('ORG-OTHER','transport_provider','別的單位',true);
               insert into memberships (id, user_id, organization_id, role, status)
               values ('$MEM','$OTHER_USER_ID','ORG-OTHER','owner','active')" >/dev/null 2>&1
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc）"; else ng "預期失敗卻成功了"; fi
grep -q '主鍵 .* 已被其他資料占用' "$TMP/psql.log" && ok "錯誤訊息指出主鍵被占用" \
  || { ng "錯誤訊息不符"; note "$(tail -3 "$TMP/psql.log")"; }

[ "$(q "select count(*) from organizations where id='$ORG'")" = "0" ] \
  && ok "先前已插入的組織確實被回滾" || ng "組織殘留，交易沒有回滾"
[ "$(snapshot)" = "$before" ] && ok "既有資料完全未改動" || ng "既有資料被改動了"
[ "$(q "select user_id from memberships where id='$MEM'")" = "$OTHER_USER_ID" ] \
  && ok "他人的 membership 未被奪取" || ng "他人的 membership 被改動"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 7：相同關聯但 membership ID 不同 ==="
reset_data
add_user "$USER_ID" "$PHONE" true
psql -X -q -c "insert into organizations (id, org_type, name, contact_phone, active)
               values ('$ORG','transport_provider','$ORG_NAME','0212345678',true);
               insert into memberships (id, user_id, organization_id, role, status)
               values ('MEM-OTHER','$USER_ID','$ORG','owner','active')" >/dev/null 2>&1
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc）"; else ng "預期失敗卻成功了"; fi
grep -q 'MEM-OTHER' "$TMP/psql.log" && ok "錯誤訊息點出實際的 membership ID" \
  || { ng "錯誤訊息未指出實際 ID"; note "$(tail -3 "$TMP/psql.log")"; }
[ "$(q "select count(*) from memberships where organization_id='$ORG'")" = "1" ] \
  && ok "未新增重複關聯" || ng "產生了重複關聯"
[ "$(snapshot)" = "$before" ] && ok "資料未被改動" || ng "資料被改動了"

# --------------------------------------------------------------------------
echo ""
echo "=== 情境 8：組織已有另一位啟用中負責人 ==="
reset_data
add_user "$USER_ID" "$PHONE" true
add_user "$OTHER_USER_ID" '+886900000099' true
psql -X -q -c "insert into organizations (id, org_type, name, contact_phone, active)
               values ('$ORG','transport_provider','$ORG_NAME','0212345678',true);
               insert into memberships (id, user_id, organization_id, role, status)
               values ('MEM-OTHER','$OTHER_USER_ID','$ORG','owner','active')" >/dev/null 2>&1
before=$(snapshot)
rc=$(run_sql "$TMP/step2.sql")

if [ "$rc" -ne 0 ]; then ok "如預期報錯（rc=$rc）"; else ng "預期失敗卻成功了"; fi
grep -q '已經有另一位啟用中的負責人' "$TMP/psql.log" && ok "錯誤訊息指出已有其他負責人" \
  || { ng "錯誤訊息不符"; note "$(tail -3 "$TMP/psql.log")"; }
[ "$(q "select count(*) from memberships where user_id='$USER_ID'")" = "0" ] \
  && ok "未提升目標帳號的權限" || ng "目標帳號竟然拿到了 membership"
[ "$(q "select user_id from memberships where organization_id='$ORG' and role='owner'")" = "$OTHER_USER_ID" ] \
  && ok "既有負責人未被取代" || ng "既有負責人被取代了"
[ "$(snapshot)" = "$before" ] && ok "資料未被改動" || ng "資料被改動了"

# --------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════"
echo "結果：$pass 通過 / $fail 失敗"
if [ "$fail" -eq 0 ]; then
  echo "全部通過"
  exit 0
fi
echo "有失敗項目"
exit 1
