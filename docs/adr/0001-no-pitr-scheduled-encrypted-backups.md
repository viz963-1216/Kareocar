# 不加購 PITR，改用每 6 小時的加密備份

Supabase 的時間點還原（PITR）要另外付費，對還沒有收入的試營運不划算。我們改用 Supabase Pro 內含的每日備份，加上 GitHub Actions 每 6 小時一次的 `pg_dump` 加密備份（保存 7 天、每月自動還原演練），所以最多可能遺失 6 小時的資料，而不是幾秒。資料量與營收成長、遺失 6 小時變得無法接受時，再重新評估 PITR。還原步驟與演練紀錄見 `docs/RESTORE_RUNBOOK.md`。
