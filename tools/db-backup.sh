#!/usr/bin/env bash
# 把資料庫備份成加密檔，輸出到指定目錄（#28；取代 PITR 的定時邏輯備份）。
#
#   BACKUP_DATABASE_URL=postgresql://... BACKUP_PASSPHRASE=... bash tools/db-backup.sh <輸出目錄>
#
# 輸出：
#   app.dump.gpg   public、app、ops 三個 schema 的結構與資料（pg_dump custom 格式，不含擁有者與權限）
#   auth.dump.gpg  auth.users、auth.identities 的資料（只在資料庫有這兩張表時；Supabase 才有）
#   manifest.json  建立時間、伺服器版本、備份裡每張表的筆數（只有表名與數字，不含個資）
#   SHA256SUMS     上面加密檔的雜湊
#
# 備份含個資，所以明文只存在暫存目錄、結束就刪；輸出目錄只有 gpg 對稱加密（AES-256）後的檔案。
# 筆數是從備份檔本身數出來的（pg_restore 的 COPY 區塊），所以和備份內容一定一致，
# 演練時以 tools/db-restore-verify.sh 還原後逐表比對。
#
# BACKUP_DATABASE_URL 是有權讀全部資料的管理連線（Supabase 的 postgres 角色，session pooler）。
# 連線字串含密碼，所有輸出都不印它。
set -euo pipefail

OUT="${1:-}"
URL="${BACKUP_DATABASE_URL:-}"
PASS="${BACKUP_PASSPHRASE:-}"
[ -n "$OUT" ] || { echo '用法：db-backup.sh <輸出目錄>' >&2; exit 2; }
[ -n "$URL" ] || { echo '缺少 BACKUP_DATABASE_URL' >&2; exit 2; }
[ "${#PASS}" -ge 20 ] || { echo 'BACKUP_PASSPHRASE 缺少或太短（至少 20 個字元）' >&2; exit 2; }

mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

encrypt() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$2" "$1" 3<<<"$PASS"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  else shasum -a 256 "$@"; fi
}

started=$(date +%s)
server_version="$(psql "$URL" -X -tA -v ON_ERROR_STOP=1 -c 'show server_version_num')"

pg_dump "$URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=app --schema=ops --file="$WORK/app.dump"

has_auth="$(psql "$URL" -X -tA -v ON_ERROR_STOP=1 -c \
  "select to_regclass('auth.users') is not null and to_regclass('auth.identities') is not null")"
if [ "$has_auth" = "t" ]; then
  pg_dump "$URL" --format=custom --data-only \
    --table=auth.users --table=auth.identities --file="$WORK/auth.dump"
fi

# 從備份檔數每張表的筆數：COPY 的文字格式一列一行（值裡的換行會被跳脫），以 \. 結束
pg_restore --data-only --file=- "$WORK/app.dump" | awk '
  /^COPY / { table = $2; n = 0; inside = 1; next }
  inside && /^\\\.$/ { printf "%s\t%d\n", table, n; inside = 0; next }
  inside { n++ }
' > "$WORK/counts.tsv"
[ -s "$WORK/counts.tsv" ] || { echo '備份裡沒有任何資料表，停止' >&2; exit 1; }

python3 - "$WORK/counts.tsv" "$server_version" "$has_auth" "$(( $(date +%s) - started ))" > "$OUT/manifest.json" <<'PY'
import json, sys, datetime
counts_file, server_version, has_auth, seconds = sys.argv[1:5]
tables = {}
for line in open(counts_file, encoding='utf-8'):
    name, n = line.rstrip('\n').split('\t')
    tables[name] = int(n)
print(json.dumps({
    'created_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'server_version_num': int(server_version),
    'includes_auth': has_auth == 't',
    'dump_seconds': int(seconds),
    'tables': tables,
}, ensure_ascii=False, indent=2))
PY

encrypt "$WORK/app.dump" "$OUT/app.dump.gpg"
[ -f "$WORK/auth.dump" ] && encrypt "$WORK/auth.dump" "$OUT/auth.dump.gpg"
( cd "$OUT" && sha256 ./*.gpg > SHA256SUMS )

total=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$WORK/counts.tsv")
echo "備份完成：$(wc -l < "$WORK/counts.tsv" | tr -d ' ') 張表、共 $total 筆；auth：$([ "$has_auth" = t ] && echo 有 || echo 無)"
