#!/usr/bin/env bash
# 把 supabase/migrations/ 裡尚未套用的 migration 依檔名順序套用到指定的資料庫。
#
#   MIGRATION_DATABASE_URL=postgresql://... bash tools/apply-migrations.sh            # 套用
#   MIGRATION_DATABASE_URL=postgresql://... bash tools/apply-migrations.sh --dry-run  # 只列出待套用的
#
# MIGRATION_DATABASE_URL 是有權建立資料表、函式與政策的管理連線（Supabase 的
# postgres 角色，直連或 session pooler），不是 Netlify 上 care_ride_app 的 DATABASE_URL。
#
# 紀錄：ops.schema_migrations（版本、檔案 SHA-256、套用時間）。放在獨立的 ops schema，
# 回復 baseline 時不會一起被刪掉。
#
# 會拒絕執行、什麼都不改的情況：
#   * 已套用的檔案內容被改過（checksum 不符）——已上線的 migration 不能改寫，要新增一支
#   * 新檔案的版本號比已套用的最大版本還小——順序錯亂
#   * 資料庫裡已經有資料表，卻沒有任何 migration 紀錄——例如早期手動貼上 schema 的
#     資料庫。直接套用 baseline 會撞到既有物件；這種資料庫要先人工重建（見 DEPLOYMENT.md）
#
# 每支 migration 與它的紀錄寫在同一個交易裡，並設 lock_timeout：取不到鎖就失敗、整筆
# 回滾，可以安全重試。
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

URL="${MIGRATION_DATABASE_URL:-}"
if [ -z "$URL" ]; then
  echo '缺少 MIGRATION_DATABASE_URL' >&2
  exit 2
fi
LOCK_TIMEOUT="${MIGRATION_LOCK_TIMEOUT:-5s}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 測試用：可以指定另一個 migration 目錄
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT/supabase/migrations}"

# 連線字串含密碼，所有輸出都不印它
q() { psql "$URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

has_history_table="$(q -c "select to_regclass('ops.schema_migrations') is not null")"
applied_count=0
if [ "$has_history_table" = "t" ]; then
  applied_count="$(q -c 'select count(*) from ops.schema_migrations')"
fi

if [ "$applied_count" = "0" ]; then
  existing="$(q -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname in ('public', 'app') and c.relkind in ('r', 'v', 'm')")"
  if [ "$existing" != "0" ]; then
    echo "拒絕執行：資料庫的 public／app 已有 $existing 個資料表或 view，卻沒有任何 migration 紀錄。" >&2
    echo '這通常是早期以 SQL Editor 手動建立的資料庫。請依 DEPLOYMENT.md 先人工重建，再執行這支。' >&2
    exit 3
  fi
fi

if [ "$DRY_RUN" = "0" ] && [ "$has_history_table" != "t" ]; then
  q -c 'create schema if not exists ops' \
    -c 'create table if not exists ops.schema_migrations (
          version    text primary key,
          checksum   text not null,
          applied_at timestamptz not null default now())'
  has_history_table=t
fi

max_applied=""
if [ "$has_history_table" = "t" ]; then
  max_applied="$(q -c 'select coalesce(max(version), $$$$) from ops.schema_migrations')"
fi

pending=()
for file in "$MIGRATIONS_DIR"/*.sql; do
  version="$(basename "$file" .sql)"
  # 版本號會直接寫進 SQL 字面值，只接受安全的檔名
  if ! [[ "$version" =~ ^[0-9]{4}_[a-z0-9_]+$ ]]; then
    echo "拒絕執行：migration 檔名不符合 NNNN_名稱.sql：$version" >&2
    exit 6
  fi
  sum="$(sha256 "$file")"
  recorded=""
  if [ "$has_history_table" = "t" ]; then
    recorded="$(q -c "select checksum from ops.schema_migrations where version = '$version'")"
  fi
  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$sum" ]; then
      echo "拒絕執行：$version 已經套用過，但檔案內容與當時不同（checksum 不符）。" >&2
      echo '已上線的 migration 不能改寫；請改回原內容，另外新增一支 migration。' >&2
      exit 4
    fi
    continue
  fi
  if [ -n "$max_applied" ] && [[ "$version" < "$max_applied" ]]; then
    echo "拒絕執行：$version 尚未套用，但版本號小於已套用的 $max_applied（順序錯亂）。" >&2
    exit 5
  fi
  pending+=("$file")
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo '沒有待套用的 migration。'
  exit 0
fi

echo "待套用的 migration（${#pending[@]} 支）："
for file in "${pending[@]}"; do echo "  $(basename "$file" .sql)"; done
[ "$DRY_RUN" = "1" ] && exit 0

for file in "${pending[@]}"; do
  version="$(basename "$file" .sql)"
  sum="$(sha256 "$file")"
  echo "套用 $version ..."
  # migration 本體與紀錄在同一個交易；失敗整筆回滾
  script="$(mktemp)"
  {
    echo 'begin;'
    echo "set local lock_timeout = '$LOCK_TIMEOUT';"
    printf '\\i %s\n' "'$file'"
    echo "insert into ops.schema_migrations (version, checksum) values ('$version', '$sum');"
    echo 'commit;'
  } > "$script"
  if ! psql "$URL" -X -q -v ON_ERROR_STOP=1 -f "$script" >/dev/null; then
    rm -f "$script"
    echo "  套用 $version 失敗，已整筆回滾" >&2
    exit 1
  fi
  rm -f "$script"
  echo "  已套用 $version"
done
echo '完成。'
