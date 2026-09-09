# V12.25.79｜P0 驗證摘要

> **歷史文件。**這是 V12.25.79 當時的封版紀錄，未隨 V12.26.0 更新，其中的版本號、檔案雜湊與「byte-identical」等敘述已不適用於目前的程式碼。目前版本的說明請看 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)。

## 本輪 5 個 P0

- [PASS] 密碼／credential 不得進 AppState；frontend + backend 雙重 sanitize
- [PASS] 忘記密碼改為 server OTP + SMS webhook；無 production Demo OTP
- [PASS] 關鍵 authoritative write 等 server ACK 才宣告成功；失敗 rollback
- [PASS] Trip 正式同步改為 Google Sheet authoritative ACK + revision conflict 409
- [PASS] Password Login 加 server-side rate limiting，API 不可繞過前端防護

## Regression

- Backend smoke tests：**21 / 21 PASS**
- HTML inline JS syntax：**3 / 3 PASS**
- Netlify function syntax：**14 / 14 PASS**
- Apps Script syntax：**7 / 7 PASS**
- Static DOM ID：**319 / 319 unique**
- Release candidate 與 index.html：**byte-identical**

## 正式發布前的外部條件

程式碼 P0 已清除，但 production release 仍需實際部署後確認：

- `rowAuthorizationVersion: "12.25.79"`
- `passwordResetProviderConfigured: true`（若啟用忘記密碼）
- Netlify → Apps Script → Google Sheet 真實讀寫成功
- 真 SMS OTP 可收到並完成 reset
- Trip 兩裝置 stale revision 確實收到 409 `TRIP_CONFLICT`

本環境的 Chromium local-host smoke test 被 browser policy 以 `ERR_BLOCKED_BY_ADMINISTRATOR` 阻擋，故此項不列 PASS，需以正式網域 E2E 補驗。
