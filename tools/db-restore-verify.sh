#!/usr/bin/env bash
# 還原演練：把 tools/db-backup.sh 產生的加密備份還原到一個空的資料庫，逐表比對筆數（#28）。
#
#   RESTORE_DATABASE_URL=postgresql://... BACKUP_PASSPHRASE=... bash tools/db-restore-verify.sh <備份目錄>
#
# RESTORE_DATABASE_URL 必須是空的資料庫（例如 CI 的拋棄式 Postgres），不能是正式或 Staging：
# 目標資料庫的 public、app、ops 已有資料表就拒絕。
#
# 步驟：檢查 SHA256SUMS → 解密（gpg 會驗證完整性，密碼錯或檔案被改都會失敗）→ 準備角色與擴充
# → pg_restore（任何錯誤都中止）→ 每張表的筆數與 manifest.json 相同 → auth 備份可以完整讀出。
# 最後印出耗時，寫進演練紀錄。
set -euo pipefail

DIR="${1:-}"
URL="${RESTORE_DATABASE_URL:-}"
PASS="${BACKUP_PASSPHRASE:-}"
[ -n "$DIR" ] && [ -f "$DIR/manifest.json" ] || { echo '用法：db-restore-verify.sh <含 manifest.json 的備份目錄>' >&2; exit 2; }
[ -n "$URL" ] || { echo '缺少 RESTORE_DATABASE_URL' >&2; exit 2; }
[ -n "$PASS" ] || { echo '缺少 BACKUP_PASSPHRASE' >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
q() { psql "$URL" -X -tA -v ON_ERROR_STOP=1 "$@"; }
started=$(date +%s)

existing="$(q -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname in ('public','app','ops') and c.relkind in ('r','v','m','p')")"
if [ "$existing" != "0" ]; then
  echo "拒絕執行：目標資料庫已有 $existing 個資料表或 view，演練只能還原到空的資料庫" >&2
  exit 3
fi

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DIR" && sha256sum --check --quiet SHA256SUMS )
else
  ( cd "$DIR" && shasum -a 256 --check --quiet SHA256SUMS )
fi

decrypt() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --decrypt --output "$2" "$1" 3<<<"$PASS"
}
decrypt "$DIR/app.dump.gpg" "$WORK/app.dump"
[ -f "$DIR/auth.dump.gpg" ] && decrypt "$DIR/auth.dump.gpg" "$WORK/auth.dump"

# 政策與授權引用 care_ride_app；函式用到 pgcrypto。Supabase 上兩者都已存在
q -c "do \$\$ begin
        if not exists (select 1 from pg_roles where rolname = 'care_ride_app') then
          create role care_ride_app nologin;
        end if;
      end \$\$" \
  -c 'create extension if not exists pgcrypto' >/dev/null

# 每個資料庫本來就有 public schema：略過備份裡的 CREATE SCHEMA public 與它的註解，其餘照單全收
pg_restore --list "$WORK/app.dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public |COMMENT - SCHEMA public )' > "$WORK/toc.list"
pg_restore --dbname="$URL" --no-owner --no-privileges --exit-on-error \
  --use-list="$WORK/toc.list" "$WORK/app.dump"

python3 - "$DIR/manifest.json" > "$WORK/expected.tsv" <<'PY'
import json, sys
for name, n in json.load(open(sys.argv[1], encoding='utf-8'))['tables'].items():
    print(f'{name}\t{n}')
PY

mismatch=0
while IFS=$'\t' read -r table expected; do
  actual="$(q -c "select count(*) from $table")"
  if [ "$actual" != "$expected" ]; then
    echo "筆數不符：$table 還原後 $actual，備份時 $expected" >&2
    mismatch=1
  fi
done < "$WORK/expected.tsv"
[ "$mismatch" = "0" ] || exit 1

auth_rows="無"
if [ -f "$WORK/auth.dump" ]; then
  pg_restore --file=/dev/null "$WORK/auth.dump"
  auth_rows="$(pg_restore --data-only --file=- "$WORK/auth.dump" | awk '
    /^COPY / { inside = 1; next } inside && /^\\\.$/ { inside = 0; next } inside { n++ } END { print n + 0 }')"
fi

tables=$(wc -l < "$WORK/expected.tsv" | tr -d ' ')
rows=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$WORK/expected.tsv")
migrations="$(q -c "select count(*) from ops.schema_migrations")"
created="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['created_at'])" "$DIR/manifest.json")"
echo "還原演練通過：備份時間 $created；$tables 張表、共 $rows 筆全部相符；migration 紀錄 $migrations 筆；auth 列數 $auth_rows；耗時 $(( $(date +%s) - started )) 秒"
