#!/usr/bin/env bash
# 本機維運：GitHub Actions 停用時，在自己的終端機做資料庫備份與套用 migration。
#
#   bash tools/ops-local.sh backup                 # 備份正式資料庫（加密）
#   bash tools/ops-local.sh migrate staging        # 套用 migration 到 Staging
#   bash tools/ops-local.sh migrate production     # 套用 migration 到正式資料庫（要輸入 apply-production 確認）
#
# 連線字串（Supabase 的 postgres 管理連線，session pooler）與加密密碼都用隱藏輸入，
# 不會出現在畫面、指令列參數、檔案或 shell 歷史裡。執行前用 tools/describe-db-url.py 確認連的是對的專案。
# 需要 psql／pg_dump（PG_BIN 可指定 Postgres 的 bin 目錄）；加密有 gpg 就用 gpg，沒有就用系統內建的 openssl。
set -euo pipefail

STAGING_REF=hffoakcgntggykvugfht
PRODUCTION_REF=vcbhtlwkzavqvxthicis
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 找 psql：PG_BIN、PATH、Postgres.app 常見位置
if [ -n "${PG_BIN:-}" ]; then PATH="$PG_BIN:$PATH"; fi
if ! command -v psql >/dev/null 2>&1; then
  for d in /Applications/Postgres.app/Contents/Versions/latest/bin \
           "$HOME"/Applications/Postgres.app/Contents/Versions/latest/bin \
           "$HOME"/Documents/Codex/*/new-chat/work/backup-tools/Postgres.app/Contents/Versions/*/bin \
           /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if [ -x "$d/psql" ]; then PATH="$d:$PATH"; break; fi
  done
fi
command -v psql >/dev/null 2>&1 || { echo '找不到 psql。請安裝 Postgres.app，或用 PG_BIN=<bin 目錄> 指定。' >&2; exit 2; }

read_url() { # $1 = 專案 ref；結果放在 MIGRATION_DATABASE_URL
  local ref="$1"
  read -rsp "貼上 ${ref} 的資料庫連線字串（Supabase → Connect → Session pooler，不會顯示）：" MIGRATION_DATABASE_URL; echo
  [ -n "$MIGRATION_DATABASE_URL" ] || { echo '沒有輸入連線字串' >&2; exit 2; }
  export MIGRATION_DATABASE_URL
  echo '--- 檢查連線字串（不含密碼）---'
  python3 "$ROOT/tools/describe-db-url.py" --expect-ref "$ref" || { echo '連線字串不是這個專案的，停止。' >&2; exit 1; }
  psql "$MIGRATION_DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1 -c 'select 1' >/dev/null || { echo '連不上資料庫，請確認連線字串與密碼。' >&2; exit 1; }
  echo '連線成功。'
}

cmd_migrate() {
  local target="${1:-}" ref
  case "$target" in
    staging) ref=$STAGING_REF ;;
    production) ref=$PRODUCTION_REF ;;
    *) echo '用法：ops-local.sh migrate staging|production' >&2; exit 2 ;;
  esac
  read_url "$ref"
  echo '--- 待套用的 migration ---'
  bash "$ROOT/tools/apply-migrations.sh" --dry-run
  if [ "$target" = production ]; then
    read -rp '這會修改正式資料庫。確定要套用請輸入 apply-production：' ok
    [ "$ok" = apply-production ] || { echo '沒有確認，停止，什麼都沒改。'; exit 1; }
  else
    read -rp '確定套用到 Staging？（y/N）' ok
    [ "$ok" = y ] || [ "$ok" = Y ] || { echo '停止，什麼都沒改。'; exit 1; }
  fi
  bash "$ROOT/tools/apply-migrations.sh"
  echo '--- 預約與行程報告（唯讀）---'
  bash "$ROOT/tools/typed-sync-report.sh" || true
}

cmd_backup() {
  local out="${1:-$HOME/Kareocar-backups/$(date +%Y%m%d-%H%M%S)}"
  read_url "$PRODUCTION_REF"
  read -rsp '設定這份備份的加密密碼（至少 20 個字元，不會顯示）：' p1; echo
  read -rsp '再輸入一次：' p2; echo
  [ "$p1" = "$p2" ] || { echo '兩次密碼不一樣' >&2; exit 2; }
  [ "${#p1}" -ge 20 ] || { echo '加密密碼至少 20 個字元' >&2; exit 2; }
  if command -v gpg >/dev/null 2>&1; then
    BACKUP_DATABASE_URL="$MIGRATION_DATABASE_URL" BACKUP_PASSPHRASE="$p1" bash "$ROOT/tools/db-backup.sh" "$out"
  else
    # 沒有 gpg：用系統內建的 openssl 加密（AES-256-CBC，PBKDF2 20 萬次）
    mkdir -p "$out"; chmod 700 "$out"
    local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' RETURN
    echo '備份中（public、app、ops 三個 schema）…'
    pg_dump "$MIGRATION_DATABASE_URL" --format=custom --no-owner --no-privileges \
      --schema=public --schema=app --schema=ops --file="$work/app.dump"
    if [ "$(psql "$MIGRATION_DATABASE_URL" -X -tA -c "select to_regclass('auth.users') is not null")" = t ]; then
      pg_dump "$MIGRATION_DATABASE_URL" --format=custom --no-owner --no-privileges --data-only \
        --table=auth.users --table=auth.identities --file="$work/auth.dump"
    fi
    for f in "$work"/*.dump; do
      openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$f" -out "$out/$(basename "$f").enc" -pass fd:3 3<<<"$p1"
    done
    (cd "$out" && shasum -a 256 ./*.enc > SHA256SUMS)
    cat > "$out/README.txt" <<TXT
安心接送正式資料庫備份（$(date '+%Y-%m-%d %H:%M:%S')，openssl AES-256-CBC + PBKDF2 20 萬次）
解密：openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in app.dump.enc -out app.dump
還原前請先比對 SHA256SUMS（shasum -a 256 -c SHA256SUMS）。
TXT
  fi
  unset p1 p2
  echo "完成：備份在 $out"
  ls -l "$out"
  echo '請把加密密碼存進密碼管理器；忘記密碼就無法還原。'
}

case "${1:-}" in
  backup) shift; cmd_backup "$@" ;;
  migrate) shift; cmd_migrate "$@" ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
