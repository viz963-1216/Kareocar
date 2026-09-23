# PostgreSQL 遷移與測試

## 哪些檔案是資料庫來源

- `migrations/0001_*.sql` 至目前最新編號依序定義 schema、資料庫函式及 RLS 政策。每個正式環境的實際遷移狀態需另行核實。
- 每個 migration 是唯一維護來源。不要另外編輯或套用舊的合併 SQL 快照；初始設定與更新都應依序使用遷移檔。
- `tests/` 使用合成資料驗證 migration、API、交易與 RLS。實際覆蓋以測試檔和 CI 結果為準。

## 本機 PostgreSQL 測試

完整測試需本機 PostgreSQL 16。先確保使用的是隔離、可丟棄的本機叢集，再執行：

```bash
PGHOST=/tmp/pgrun PGPORT=5433 PGDATABASE=careride_test \
  bash supabase/tests/run-all.sh
```

**注意：** `run-all.sh` 會刪除並重建 `PGDATABASE` 指定的資料庫，再依序套用所有 migrations 與合成測試資料。只可對本機測試資料庫執行，不能指向 Supabase 或其他正式資料庫。

CI 使用一次性 PostgreSQL 16 容器。其他隔離測試腳本會建立固定名稱的測試資料庫；若資料庫已存在，腳本會停止，需先確認並清理本機測試環境。

## 連線安全

- Netlify Functions 應以 `care_ride_app` 角色連線，讓 RLS 正常生效。不可使用資料庫擁有者 `postgres` 作為應用程式連線帳號。
- 連線字串與密碼只放在部署環境的 Secret，不寫入 repo、測試輸出或聊天。
- 本機和 CI 測試通過不代表正式資料庫已套用遷移，也不等於已驗收正式部署。

## 正式資料庫

正式庫遷移屬於正式資料寫入。執行前必須確認目標環境、目前 schema 版本、備份及回復方案，並依專案授權流程辦理。`migrations/` 是程式來源；不得把測試腳本或文件中的本機命令直接對正式庫執行。
