#!/usr/bin/env bash
# 重設既有帳號的登入密碼（手機＋密碼），用在平台超級管理者忘記密碼、沒有人能從後台替他重設時。
#
#   bash tools/reset-auth-password.sh
#
# 用 Supabase Auth 的管理 API：依手機找到帳號，只更新密碼，帳號、權限與資料都不動。
# 專案 ref、手機在畫面上輸入；service_role 金鑰與新密碼以隱藏輸入讀取，只經由標準輸入與
# 暫存的標頭傳給 curl，不會出現在指令列參數、畫面或檔案裡（與 create-super-admin.sh 相同做法）。
# 一般使用者忘記密碼請由機構負責人或平台管理者在後台重設，不需要這支。
set -euo pipefail

read -rp 'Supabase 專案 ref（正式：vcbhtlwkzavqvxthicis）：' REF
[[ "$REF" =~ ^[a-z0-9]{20}$ ]] || { echo '專案 ref 格式不對（20 個小寫英數字）' >&2; exit 2; }
read -rp '要重設的帳號手機號碼（09 開頭 10 碼）：' PHONE
[[ "$PHONE" =~ ^09[0-9]{8}$ ]] || { echo '手機號碼格式不對' >&2; exit 2; }
read -rsp 'service_role 金鑰（Project Settings → API Keys，不會顯示）：' KEY; echo
[ -n "$KEY" ] || { echo '沒有輸入金鑰' >&2; exit 2; }
read -rsp '新密碼（至少 8 碼，不會顯示）：' PW; echo
read -rsp '再輸入一次新密碼：' PW2; echo
[ "$PW" = "$PW2" ] || { echo '兩次密碼不一樣' >&2; exit 2; }
[ "${#PW}" -ge 8 ] || { echo '密碼至少 8 碼' >&2; exit 2; }

# SUPABASE_AUTH_BASE 只給本機測試用
BASE="${SUPABASE_AUTH_BASE:-https://$REF.supabase.co/auth/v1}"
E164="+886${PHONE:1}"
HEADERS="$(mktemp)"; trap 'rm -f "$HEADERS"' EXIT; chmod 600 "$HEADERS"
printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\n' "$KEY" "$KEY" > "$HEADERS"

echo '尋找帳號中…'
UID_=""
for page in $(seq 1 20); do
  RESP="$(curl -sS -w '\n%{http_code}' -H @"$HEADERS" "$BASE/admin/users?page=$page&per_page=200")"
  CODE="$(tail -n1 <<<"$RESP")"; BODY="$(sed '$d' <<<"$RESP")"
  if [ "$CODE" != "200" ]; then
    echo "讀取帳號清單失敗（HTTP $CODE）。HTTP 401 代表金鑰不是這個專案的 service_role。" >&2
    exit 1
  fi
  FOUND="$(E164="$E164" python3 -c '
import json, os, sys
d = json.loads(sys.stdin.read() or "{}")
users = d.get("users", d if isinstance(d, list) else [])
want = os.environ["E164"].lstrip("+")
hit = [u["id"] for u in users if str(u.get("phone") or "").lstrip("+") == want]
print(hit[0] if hit else ("END" if not users else ""))' <<<"$BODY")"
  [ "$FOUND" = "END" ] && break
  if [ -n "$FOUND" ]; then UID_="$FOUND"; break; fi
done
[ -n "$UID_" ] || { echo "找不到手機 $PHONE 的帳號（請確認專案 ref 與手機）" >&2; exit 1; }
echo "找到帳號（User UID：$UID_）"

echo '更新密碼中…'
CODE="$(PW="$PW" python3 -c 'import json, os; print(json.dumps({"password": os.environ["PW"]}))' \
  | curl -sS -o /dev/null -w '%{http_code}' -X PUT -H @"$HEADERS" --data-binary @- "$BASE/admin/users/$UID_")"
[ "$CODE" = "200" ] || { echo "更新密碼失敗（HTTP $CODE）" >&2; exit 1; }

echo '測試用手機＋新密碼登入…'
CODE="$(E164="$E164" PW="$PW" python3 -c 'import json, os; print(json.dumps({"phone": os.environ["E164"], "password": os.environ["PW"]}))' \
  | curl -sS -o /dev/null -w '%{http_code}' -H @"$HEADERS" --data-binary @- "$BASE/token?grant_type=password")"
if [ "$CODE" = "200" ]; then
  echo '完成：新密碼可以登入。請把新密碼存進密碼管理器。'
else
  echo "密碼已更新，但登入測試失敗（HTTP $CODE），請確認 Phone 登入方式已啟用。" >&2
  exit 1
fi
