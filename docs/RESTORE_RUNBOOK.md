# 備份與還原手冊（#28）

正式資料庫的備份方式、出事時怎麼還原，以及演練紀錄。

## 決定

2026-10-04 repo 擁有者決定**不加購 Supabase PITR**（7 天保留每月 US$100），改用下面兩層免費的
備份。代價是最多遺失約 6 小時的資料；營運量變大後再評估是否開 PITR。

## 兩層備份

| | Supabase 每日備份 | 定時加密備份（GitHub Actions） |
|---|---|---|
| 頻率 | 每天一次（專案所在地區的午夜） | 每 6 小時（UTC 00:17、06:17、12:17、18:17） |
| 保留 | 7 天（Pro 方案內含） | 7 天（Actions artifact） |
| 內容 | 整個資料庫（實體備份） | `public`、`app`、`ops` 的結構與資料，`auth.users`、`auth.identities` 的資料 |
| 還原方式 | Supabase 主控台一鍵還原整個專案 | 解密後用 `pg_restore` 還原整個或挑出部分資料 |
| 最多遺失 | 約 24 小時 | 約 6 小時 |
| 費用 | 0（Pro 內含） | 0（私人 repo 的免費 Actions 額度內） |

- 定時備份：`.github/workflows/db-backup.yml`，腳本 `tools/db-backup.sh`。用 gpg 對稱加密
  （AES-256），明文只存在 runner 的暫存目錄。`manifest.json` 只記錄表名與筆數。
- 備份失敗時：GitHub 寄失敗通知 Email 給 repo 擁有者；有設定 repo secret
  `DISCORD_ALERT_WEBHOOK_URL` 的話也會通知 Discord。
- 每月 1 日自動還原演練：`.github/workflows/restore-drill.yml`。在拋棄式 Postgres 還原最新備份、
  逐表比對筆數，並確認最新備份不超過 7 小時（定時備份沒有中斷）。

### 需要的 repo secrets

| 名稱 | 用途 |
|---|---|
| `PRODUCTION_MIGRATION_DATABASE_URL` | 正式專案的 postgres 管理連線（session pooler），與 migration 共用 |
| `BACKUP_ENCRYPTION_PASSPHRASE` | 加密密碼，至少 20 個字元。**repo 擁有者要在密碼管理器另存一份**：GitHub 的 secret 寫入後看不到，遺失就無法解密任何備份 |
| `DISCORD_ALERT_WEBHOOK_URL`（選用） | 備份失敗通知 |

## 還原

先判斷是哪一種情況，再決定用哪一層。**還原正式資料庫是正式環境寫入，要 repo 擁有者同意。**

### A. 整個資料庫壞掉或被大量誤刪

1. 先讓網站停止寫入：Netlify 停用正式站（或暫時移除 Production 的 `DATABASE_URL`），避免還原期間
   有新資料進來又被覆蓋。
2. Supabase 正式專案 → **Database → Backups → Scheduled backups**，選出事前最近的一筆，按
   **Restore**。還原期間專案無法使用，時間依資料量而定（演練紀錄見下方）。
3. 還原後確認：SQL Editor 執行 `select count(*) from ops.schema_migrations;` 等於 migration 支數；
   `/api/health` 回 200。
4. 每日備份之後到出事之間的資料（最多 24 小時）：用 B 的方式從定時備份找回需要的部分。
5. 恢復網站寫入，通知受影響的機構與需求者補登遺失的部分。

### B. 部分資料誤刪或被改錯（找回特定的列）

需要在自己的電腦上解密，必須有 `gh`、`gpg`、PostgreSQL 17 的 `pg_restore`（安裝軟體要先同意）。

1. 找到出事前最近一次成功的備份：
   ```bash
   gh run list --repo viz963-1216/Kareocar --workflow db-backup.yml --status success --limit 10
   ```
2. 下載（`<RUN_ID>` 換成上一步的 ID）：
   ```bash
   gh run download <RUN_ID> --repo viz963-1216/Kareocar -n db-backup-<RUN_ID> -D restore-work
   ```
3. 解密（會詢問 `BACKUP_ENCRYPTION_PASSPHRASE`）：
   ```bash
   gpg --decrypt --output restore-work/app.dump restore-work/app.dump.gpg
   ```
4. 把需要的表匯出成 SQL 檔檢查，例如 bookings：
   ```bash
   pg_restore --data-only --table=bookings --file=restore-work/bookings.sql restore-work/app.dump
   ```
5. 挑出要找回的列，在 Supabase SQL Editor 寫入。寫入前先確認不會和現有資料衝突。
6. **完成後刪掉 `restore-work` 整個資料夾**：裡面是含個資的明文。

## 演練

### 自動演練（每月）

GitHub → Actions → **Restore drill**，每月 1 日自動執行，也可以按 **Run workflow** 手動執行。
結果在該次執行的 Summary：備份時間、表數與筆數相符、migration 紀錄筆數、耗時。

### 演練紀錄

| 日期 | 方式 | 備份時間 | 耗時 | 結果 | 備註 |
|---|---|---|---|---|---|
| 2026-10-04 | Restore drill（定時備份） | 2026-10-04 09:24 UTC（[backup run](https://github.com/viz963-1216/Kareocar/actions/runs/37191988856)） | 還原 1 秒；整個 workflow 47 秒 | 通過：33 張表、15 筆全部相符，migration 紀錄 12 筆 | [drill run](https://github.com/viz963-1216/Kareocar/actions/runs/37192091197)。第一次手動執行；正式庫剛重建，只有 migration 寫入的資料，auth 0 列 |
| 2026-10-06 | Supabase 每日備份還原（Database → Backups → Restore，正式專案） | 2026-10-05 17:33:54 UTC 的每日備份 | 完成於 15:00（台灣）；資料庫重新啟動時間 07:00:57 UTC | 通過：還原前後 migration 14 筆、users 1、auth.users 1、超級管理者建立時間相同、app_state 0 筆；社群登入 Hook 函式存在；專案狀態 Healthy | 上線前、正式庫只有超級管理者時執行。選的是建立超級管理者（10/05 06:28 UTC）之後的備份，否則還原後要重建超級管理者。Authentication 的設定（Hook、登入方式）不在資料庫裡，還原不受影響 |
