#!/usr/bin/env bash
# tools/db-backup.sh 與 tools/db-restore-verify.sh 的行為，在隔離資料庫上實測：
#
#   1. 備份：輸出只有加密檔、manifest、SHA256SUMS；加密檔與 manifest 裡找不到個資明文；
#      manifest 的筆數與來源資料庫相同（含值裡有換行的列）；有 auth 表時一併備份
#   2. 還原到空資料庫：逐表筆數相符、migration 紀錄完整、auth 備份可讀出
#   3. 密碼錯 → 失敗；加密檔被改 → 失敗；manifest 筆數不符 → 失敗
#   4. 目標資料庫不是空的 → 拒絕（exit 3），什麼都沒改
#
# 只允許本機隔離端點；測試庫名稱固定，已存在就失敗，不覆寫。
set -uo pipefail
case "${PGHOST:-}" in
  /tmp/care-ride-*|localhost|127.0.0.1) ;;
  *) echo '拒絕執行：PGHOST 必須是本機隔離端點（/tmp/care-ride-*、localhost 或 127.0.0.1）'; exit 1 ;;
esac
export PGUSER=postgres
: "${PGPORT:?Specify isolated Postgres port}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
url() { echo "postgresql://postgres@$PGHOST:$PGPORT/$1"; }
q() { psql -X -tA -d "$1" -c "$2"; }

fail=0
check() { if [ "$2" = "0" ]; then echo "  PASS $1"; else echo "  FAIL $1"; fail=1; fi; }
expect() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1（實得 '$2'，預期 '$3'）" 1; fi; }

SRC=careride_backup_src
DST=careride_backup_dst
createdb "$SRC" || exit 1
createdb "$DST" || { dropdb "$SRC"; exit 1; }
OUT="$(mktemp -d)"
export BACKUP_PASSPHRASE='test-passphrase-0123456789abcdef'
PHONE='+886911222333'

echo "--- 準備來源資料庫 ---"
q $SRC "create schema auth;
        create table auth.users (id uuid primary key, phone text);
        create table auth.identities (id uuid primary key, user_id uuid references auth.users);
        insert into auth.users values ('11111111-1111-1111-1111-111111111111', '$PHONE');
        insert into auth.identities values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111')" >/dev/null
MIGRATION_DATABASE_URL="$(url $SRC)" bash "$ROOT/tools/apply-migrations.sh" >/dev/null || { echo '  套用 migration 失敗'; exit 1; }
psql -X -q -d $SRC -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/seed.sql" >/dev/null || { echo '  seed 失敗'; exit 1; }
q $SRC "insert into organizations (id, name, data) values ('ORG-BACKUP', E'備份測試\n第二行', '{\"phone\": \"$PHONE\"}')" >/dev/null
N="$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')"

echo "--- 1. 備份 ---"
BACKUP_DATABASE_URL="$(url $SRC)" bash "$ROOT/tools/db-backup.sh" "$OUT" >/dev/null; expect "備份成功" "$?" 0
expect "輸出檔案" "$(cd "$OUT" && ls | sort | tr '\n' ' ')" "SHA256SUMS app.dump.gpg auth.dump.gpg manifest.json "
grep -qa "$PHONE" "$OUT"/*; check "輸出裡找不到個資明文（電話）" "$([ $? -ne 0 ] && echo 0 || echo 1)"
grep -qa "ORG-BACKUP" "$OUT/app.dump.gpg"; check "加密檔裡找不到資料明文" "$([ $? -ne 0 ] && echo 0 || echo 1)"
manifest_count() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['tables'].get(sys.argv[2], 'missing'))" "$OUT/manifest.json" "$1"; }
expect "manifest：organizations 筆數（含換行的值）" "$(manifest_count public.organizations)" "$(q $SRC 'select count(*) from organizations')"
expect "manifest：users 筆數" "$(manifest_count public.users)" "$(q $SRC 'select count(*) from users')"
expect "manifest：migration 紀錄筆數" "$(manifest_count ops.schema_migrations)" "$N"
expect "manifest：記錄有 auth" "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['includes_auth'])" "$OUT/manifest.json")" True

echo "--- 2. 還原到空資料庫 ---"
OUTPUT="$(RESTORE_DATABASE_URL="$(url $DST)" bash "$ROOT/tools/db-restore-verify.sh" "$OUT" 2>&1)"; rc=$?
expect "還原演練通過" "$rc" 0
echo "$OUTPUT" | grep -q "auth 列數 2"; check "auth 備份可讀出（2 列）" $?
expect "還原後 migration 紀錄完整" "$(q $DST 'select count(*) from ops.schema_migrations')" "$N"
expect "含換行的值原樣還原" "$(q $DST "select name = E'備份測試\n第二行' from organizations where id = 'ORG-BACKUP'")" t
expect "RLS 政策一併還原" "$(q $DST "select count(*) > 0 from pg_policies where schemaname = 'public'")" t

echo "--- 3. 竄改與錯誤 ---"
dropdb $DST && createdb $DST
BACKUP_PASSPHRASE='wrong-passphrase-0123456789abcdef' RESTORE_DATABASE_URL="$(url $DST)" \
  bash "$ROOT/tools/db-restore-verify.sh" "$OUT" >/dev/null 2>&1; rc=$?
check "密碼錯 → 失敗（exit $rc）" "$([ $rc -ne 0 ] && echo 0 || echo 1)"
expect "密碼錯時沒有還原任何東西" "$(q $DST "select count(*) from pg_namespace where nspname in ('app','ops')")" 0

TAMPER="$(mktemp -d)"; cp "$OUT"/* "$TAMPER"/
printf 'x' >> "$TAMPER/app.dump.gpg"
RESTORE_DATABASE_URL="$(url $DST)" bash "$ROOT/tools/db-restore-verify.sh" "$TAMPER" >/dev/null 2>&1; rc=$?
check "加密檔被改 → 失敗（exit $rc）" "$([ $rc -ne 0 ] && echo 0 || echo 1)"

cp "$OUT"/* "$TAMPER"/
python3 - "$TAMPER/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); m['tables']['public.organizations'] += 1
json.dump(m, open(sys.argv[1], 'w'))
PY
RESTORE_DATABASE_URL="$(url $DST)" bash "$ROOT/tools/db-restore-verify.sh" "$TAMPER" >/dev/null 2>&1; rc=$?
expect "筆數不符 → exit 1" "$rc" 1
rm -rf "$TAMPER"

echo "--- 4. 目標不是空的 ---"
BEFORE="$(q $DST 'select count(*) from organizations')"
RESTORE_DATABASE_URL="$(url $DST)" bash "$ROOT/tools/db-restore-verify.sh" "$OUT" >/dev/null 2>&1; expect "已有資料表 → exit 3" "$?" 3
expect "什麼都沒改" "$(q $DST 'select count(*) from organizations')" "$BEFORE"

rm -rf "$OUT"
dropdb "$SRC"; dropdb "$DST"

if [ "$fail" -eq 0 ]; then echo "結果：全部通過"; else echo "結果：有失敗"; fi
exit "$fail"
