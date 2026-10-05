#!/usr/bin/env bash
# 建立平台超級管理者的登入帳號（手機＋密碼）。
#
#   bash tools/create-super-admin.sh
#
# Supabase 主控台的 Add user 只能用 Email 建帳號，但本系統以「手機＋密碼」登入，所以改用
# Supabase Auth 的管理 API 建立已確認手機的帳號。專案 ref、手機在畫面上輸入；service_role
# 金鑰與密碼以隱藏輸入讀取，只經由標準輸入與暫存的標頭傳給 curl，不會出現在指令列參數、
# 畫面或檔案裡。
#
# 這支只建立 Supabase Auth 的帳號並測試能否登入；最後印出要在 SQL Editor 執行的 SQL，
# 由執行的人自己貼上，在 users 表建立對應的超級管理者（見 supabase/README.md「身分驗證」）。
set -euo pipefail

read -rp 'Supabase 專案 ref（正式：vcbhtlwkzavqvxthicis）：' REF
[[ "$REF" =~ ^[a-z0-9]{20}$ ]] || { echo '專案 ref 格式不對（20 個小寫英數字）' >&2; exit 2; }
read -rp '顯示名稱（例如 平台超級管理者）：' NAME
[ -n "$NAME" ] || NAME='平台超級管理者'
read -rp '手機號碼（09 開頭 10 碼）：' PHONE
[[ "$PHONE" =~ ^09[0-9]{8}$ ]] || { echo '手機號碼格式不對' >&2; exit 2; }
read -rsp 'service_role 金鑰（Project Settings → API Keys，不會顯示）：' KEY; echo
[ -n "$KEY" ] || { echo '沒有輸入金鑰' >&2; exit 2; }
read -rsp '設定登入密碼（至少 8 碼，不會顯示）：' PW; echo
read -rsp '再輸入一次密碼：' PW2; echo
[ "$PW" = "$PW2" ] || { echo '兩次密碼不一樣' >&2; exit 2; }
[ "${#PW}" -ge 8 ] || { echo '密碼至少 8 碼' >&2; exit 2; }

# SUPABASE_AUTH_BASE 只給本機測試用
BASE="${SUPABASE_AUTH_BASE:-https://$REF.supabase.co/auth/v1}"
E164="+886${PHONE:1}"
HEADERS="$(mktemp)"; trap 'rm -f "$HEADERS"' EXIT; chmod 600 "$HEADERS"
printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\n' "$KEY" "$KEY" > "$HEADERS"

json_body() { E164="$E164" PW="$PW" python3 -c '
import json, os, sys
mode = sys.argv[1]
body = {"phone": os.environ["E164"], "password": os.environ["PW"]}
if mode == "create": body["phone_confirm"] = True
print(json.dumps(body))' "$1"; }

echo '建立帳號中…'
RESP="$(json_body create | curl -sS -w '\n%{http_code}' -H @"$HEADERS" --data-binary @- "$BASE/admin/users")"
CODE="$(tail -n1 <<<"$RESP")"; BODY="$(sed '$d' <<<"$RESP")"
if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  echo "建立失敗（HTTP $CODE）：$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print(d.get("msg") or d.get("message") or d.get("error_code") or d)' <<<"$BODY" 2>/dev/null)" >&2
  exit 1
fi
UID_="$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("id") or d["user"]["id"])' <<<"$BODY")"

echo '測試用手機＋密碼登入…'
CODE="$(json_body login | curl -sS -o /dev/null -w '%{http_code}' -H @"$HEADERS" --data-binary @- "$BASE/token?grant_type=password")"
[ "$CODE" = "200" ] && echo '登入測試成功。' || echo "登入測試失敗（HTTP $CODE），請確認 Phone 登入方式已啟用。" >&2

NAME_SQL="$(sed "s/'/''/g" <<<"$NAME")"
cat <<SQL

帳號已建立，User UID：$UID_

請到 Supabase 的 SQL Editor（同一個專案）貼上執行下面這段，建立超級管理者：

insert into users (id, display_name, phone_e164, platform_role, auth_provider, auth_subject_id, active)
values ('$UID_', '$NAME_SQL', '$E164', 'super_admin', 'supabase', '$UID_', true);

SQL
