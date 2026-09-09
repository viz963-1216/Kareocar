# 安心接送 V12.25.79｜Release Audit

> **歷史文件。**這是 V12.25.79 當時的封版紀錄，未隨 V12.26.0 更新，其中的版本號、檔案雜湊與「byte-identical」等敘述已不適用於目前的程式碼。目前版本的說明請看 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)。

## 判定

**5 個本輪 production P0 已在程式層修正並通過自動化 regression。**

正式對外開站仍需完成真實 Netlify / Apps Script / Google Sheet / SMS provider 的 production E2E；在完成前，release 狀態應視為 **Release Candidate**，不是已驗證 production live。

## P0-1｜明文密碼／credential 進 AppState

**PASS**

- frontend `authoritativeSanitizeRecord_` 移除 password / credential / token 類欄位。
- backend `appStateSanitizeRecord_` 再次移除敏感欄位，不能只靠前端。
- 超級管理者正式改密碼走 `/api/identity/update-account`，不再透過 AppState `users.password`。
- backend smoke test 已驗證：刻意提交 `password` / `passwordHash` 到 AppState 後，Google Sheet mock 保存 JSON 不含兩欄。

## P0-2｜忘記密碼假成功

**PASS（需配置真 SMS provider 才可在 production 使用）**

- production 不再顯示 Demo OTP。
- OTP 由 Apps Script 伺服器產生。
- OTP 只保存 hash / salt / expiry / attempts。
- SMS delivery 走 `PASSWORD_RESET_SMS_WEBHOOK_URL`。
- provider 未設定／失敗 → `RESET_PROVIDER_UNAVAILABLE`，不宣告成功。
- reset 成功會更新 server credential、清除 rate state、提升 session version，使舊 Session 失效。

## P0-3｜UI 先顯示成功、後端其實失敗

**PASS（程式路徑 + static validation）**

- production authoritative mutation 有 pending 時，成功型 Toast 會先顯示「正在寫入 Google Sheet 正式資料庫…」。
- ACK 成功才顯示原成功訊息。
- server reject / network error 時執行 rollback，不能把 optimistic LocalStorage 視為正式成功。
- offline 時明確顯示尚未寫入正式資料庫。

## P0-4｜Trip fake ACK / 多裝置覆蓋

**PASS**

- production `TripSyncAdapter.mode` 已改為 `google_sheet_authoritative_ack`。
- 無 `prototype_local_ack` production path。
- Trip mutation 送 `expectedRevision`。
- server 以目前 authoritative revision 做 optimistic lock。
- stale revision → `TRIP_CONFLICT` → HTTP 409。
- backend regression 已驗證 rev1 → rev2 成功，第二個 stale rev1 寫入被拒絕。

## P0-5｜只在前端做登入防暴力破解

**PASS**

- password-login API 本身加入 server-side rate state。
- 失敗次數與鎖定狀態存 Apps Script Script Properties，而不是只存在瀏覽器。
- 達門檻回 `LOGIN_RATE_LIMITED`；更高門檻要求 `PASSWORD_RESET_REQUIRED`。
- 直接打 API 也不能繞過前端 CAPTCHA。
- 正確登入／成功 reset 會依規則清除 failure state。

## Backend regression：21 / 21 PASS

1. password login + wrong-password rejection
2. requester registration + cross-session login
3. signed session resume
4. owner creates driver + requester membership + driver profile
5. private database rejects anonymous access
6. Google first login + server session token
7. Google phone completion writes backend
8. WebApp gateway routing
9. row-level authorization: owner/requester/driver scope
10. authoritative state mutations persist to Google Sheet
11. server rejects cross-role/cross-organization mutations
12. authoritative state reads are row-scoped
13. public demand rows are server-side de-identified before claim
14. public booking claim uses backend lock/version conflict protection
15. winning organization unlocks full booking row after claim
16. AppState-only public booking is server-side de-identified
17. anonymized claim preserves original requester PII in authority store
18. server password reset + old-session invalidation
19. server account update + plaintext password stripping
20. server-side login rate limiting
21. Trip optimistic revision conflict protection

原始輸出：`backend_smoke_result.json`。

## 靜態封版驗證

- PASS：3 段 HTML inline JavaScript syntax
- PASS：14 支 Netlify function JavaScript `node --check`
- PASS：7 支 Apps Script `.gs` syntax
- PASS：319 / 319 實際靜態 DOM ID 唯一
- PASS：`index.html` 與 `index_v12_25_79_release_candidate.html` byte-identical
- PASS：無 `prototype_local_ack`
- PASS：frontend + backend AppState sensitive-field sanitizer 存在
- PASS：Trip `expectedRevision` + `TRIP_CONFLICT` guard 存在
- PASS：三支正式 Identity route 已加入 Netlify redirects
- PASS：health 包含 `passwordResetProviderConfigured`

原始輸出：`static_validation_result.json`。

## Browser smoke 狀態

本測試環境的 headless Chromium 對本機 smoke server 導覽被環境政策阻擋，CDP 回：

`net::ERR_BLOCKED_BY_ADMINISTRATOR`

因此 **沒有** 把 browser smoke 假報為 PASS。此項需在部署後以真實正式網域完成。

## Release Gate

程式碼 P0：**PASS**。

正式上線 Gate 尚需：

1. 真 SMS provider 配置並測一次 OTP。
2. `/api/health` 全部 production flags 正確。
3. 真實 Netlify → Apps Script → Google Sheet E2E。
4. 使用兩個瀏覽器／裝置實測 Trip revision 409。
5. 確認正式 Google Sheet 的 `應用狀態` 無 password / token 類敏感欄位。
