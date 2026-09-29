# 安心接送 V12.26.1｜正式上線部署說明

> V12.26.0 移除全部 demo 程式碼，並修正 7 項安全問題（詳見 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)）。
>
> V12.26.1 另外改了資料存放位置（密碼憑證改存工作表、暫時狀態改用 CacheService），部署步驟見 [MIGRATION_12_26_1.md](MIGRATION_12_26_1.md)。
>
> **本輪改了前後端契約，必須整包部署**：`/identity/update-account` 新增 `currentPassword`、gateway envelope 新增 `clientIp`。只替換 `index.html` 會導致帳號更新失敗。

## 1. Apps Script（已移除）

Apps Script、Google Sheets 與社群登入（Google／Apple／Facebook）已從系統移除
（#15），身分與資料全部在 Postgres。不要再部署任何 `.gs` 檔。Netlify 上的
`APPS_SCRIPT_WEB_APP_URL`、`APPS_SCRIPT_GATEWAY_SECRET`、`GOOGLE_CLIENT_ID`
已經沒有程式讀取，可以刪除。

## 2. Netlify：整包部署

環境變數見 [supabase/README.md](supabase/README.md)（`DATABASE_URL`、
`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`AUTH_SESSION_SECRET`、
`AUTH_PASSWORD_PEPPER`、`PRODUCTION_SUPABASE_PROJECT_REF` 等）。`BOOTSTRAP_TOKEN` 與
`AUTH_PBKDF2_ITERATIONS` 已不再使用，可以刪除；超級管理者的建立方式見 supabase/README.md。部署內容：`index.html`、`_headers`、`netlify.toml`、`netlify/functions/`。

## 3. Health Gate

部署後開啟：

`https://你的正式網域/api/health`

正式開放使用者前至少要確認：

- `ok: true`
- `spreadsheetReady: true`
- `appStateReady: true`
- `rowAuthorizationVersion: "12.25.79"`
- `authConfigured: true`
- `googleClientConfigured: true`
- `passwordResetProviderConfigured: true`（若要開放忘記密碼）

如果 SMS 尚未配置，忘記密碼會明確回 `RESET_PROVIDER_UNAVAILABLE`，不會顯示假成功。

## 4. V12.25.79 P0 驗收流程

### A. 密碼與 Session

1. 正常帳密登入成功。
2. 連續輸入錯誤密碼：伺服器端會累計；達門檻後 API 本身也會鎖定，不能繞過前端 CAPTCHA。
3. 忘記密碼取得 OTP → 真實 SMS webhook 收到簡訊。
4. 使用錯 OTP 必須失敗。
5. 正確 OTP + 新密碼成功後：舊密碼失效，舊 Session Token 也失效。
6. 超級管理者在「我的帳戶」改密碼後，舊 Session 同樣失效並取得新 Session。
7. 檢查 Google Sheet `應用狀態`：任何 `users` JSON 都不得含 `password`、`passwordHash`、credential、access token、refresh token、id token。

### B. Server ACK

1. 建立／修改組織、車輛、服務對象、預約、派車、Trip 等。
2. Network 正常時：前端在 server 回覆前只可顯示「正在寫入」，取得 ACK 後才顯示完成。
3. 模擬 `/api/state-mutate` 失敗：畫面不得宣告成功；本機 optimistic change 必須 rollback 或明確保持未確認狀態。
4. 離線時不得把 LocalStorage 當成正式寫入成功。

### C. Trip revision / 多裝置

1. 裝置 A 取得 Trip revision 1。
2. 裝置 B 也取得 revision 1。
3. A 更新成 revision 2 成功。
4. B 再以 `expectedRevision:1` 寫入，後端必須回 HTTP 409 / `TRIP_CONFLICT`。
5. B 重新同步後才能再次修改。
6. Trip offline outbox 只有取得 Google Sheet authoritative ACK 後才能標示 synced；正式模式不可出現 `prototype_local_ack`。

### D. Row Authorization / Booking

延續 V12.25.78 的既有驗收：

- requester 僅本人資料
- driver 僅本人被指派行程與履約必要資料
- owner / dispatcher 僅自己組織資料
- super_admin 跨組織
- 公開需求接案前 server-side 去識別
- 公開需求競爭接案第二家必須收到 409 `BOOKING_CONFLICT`

## 5. 密碼安全模型

正式密碼不再由 AppState `users` JSON 保存。

- Google Sheet `使用者`：身分與聯絡欄位
- Apps Script Script Properties：salt + HMAC password credential
- Session：signed token + session version
- Password reset：OTP hash + TTL + attempt count
- AppState frontend + backend：雙重 sanitize password / credential / token 欄位

即使前端誤把敏感欄位帶到 `/api/state-mutate`，後端 `AppStateApi.gs` 也會再次移除。

## 6. 仍屬外部部署條件，不是程式碼 P0

- 必須實際提供可用的 HTTPS SMS webhook，否則正式忘記密碼會安全地拒絕服務。
- Apple / Facebook 若未完成 server-side token verification，正式版仍不應開放；Google + 手機密碼可先正式使用。
- 上線最後仍需在真正 Netlify domain → Netlify Function → Apps Script `/exec` → 正式 Google Sheet → 真 SMS provider 跑一次 production E2E。

本封版包的本地自動化驗證不等同於已部署 production E2E。

## 7. 資料庫 schema：baseline migration

`supabase/migrations/` 目前只有一支 `0001_baseline.sql`，由原本的 0001–0008 壓縮而成
（原檔在 `supabase/migrations_archive/`，只供查閱，不再套用）。每支 migration 都附
`supabase/rollback/<名稱>.down.sql`，隔離 CI 的 `migrations.test.sh` 驗證「上 → 下 → 上」
後 schema 完全相同。

- **套用到新資料庫**：依檔名順序套用 `supabase/migrations/*.sql`。之後的 schema 變更
  一律新增 `0002_…`、`0003_…`，不改寫已套用的檔案。
- **正式與預覽資料庫**：目前的正式 Supabase 是早期以 SQL Editor 手動貼上 0001–0008 建立的，
  沒有 migration 紀錄，裡面只有測試資料。改用 baseline 時從空資料庫重建，由 migration
  的 CI 部署流程（#13）套用；執行前需另行取得同意（見 [CLAUDE.md](CLAUDE.md) 授權邊界）。
- **回復**：`0001_baseline.down.sql` 會刪除所有資料表與資料，只用在空資料庫或 Staging 重建；
  正式環境有資料之後，改以新的 migration 往前修。

### 通知來源與可見範圍

| 來源 | 產生位置 | 寫入 | 收件人讀得到 |
|---|---|---|---|
| 需求者取消（trip_cancelled、booking_cancelled） | 後端 `app.cancel_app_state_booking` | 是，並寫入來源證明 `app.notification_provenance` | 是（收件人讀取政策比對來源證明上的收件人） |
| 派車建立、行程完成（含服務證明補齊、異常結案自動完成）、中斷、恢復、終止、交接（三種）、路線重排、資源重派 | 前端 `Notification.queue`，經 state-mutate | 是，與舊版相同；沒有來源證明，自帶任何欄位（`source`、`serverCreated`、`created_at`）都不影響 | 否，與舊版相同（只有寫入者本人與行程組織營運方讀得到） |

- 用戶端寫入、收件人是別人的通知，收件人讀不到（隔離 CI 業務流程測試情境 4 實測）。
- **尚未完成的遷移範圍**：要讓前端流程的通知也被收件人讀到，必須把這 11 處改由後端
  流程在對應交易內建立（派車建立、行程完成、中斷、恢復、終止、交接、路線重排、
  資源重派）。本輪未做；現況與舊版相同，沒有退化。


### 福利額度（原有的後端缺口，列為待辦與產品決策；本輪不修）

- **現況（程式靜態推導）**：福利核定 `benefitAuthorizations`、帳本 `benefitLedger`、
  核定事件 `benefitAuthorizationEvents` 沒有資料表、RLS 或端點，不在前端同步集合，
  state-mutate 也不接受；前端不再把整份資料存進 localStorage。扣額（建立預約）、釋放
  （修改、取消、過期、不受理）、結算（行程完成）、重開（正式修正）都只在當次頁面的
  記憶體裡計算，重新整理後消失。這是 PR #7 之前就存在的狀況。
- **本 PR 只修正**：取消改為非同步後，福利包裝沒有等待結果、不會呼叫本機釋放。改為
  `await` 後恢復呼叫，但**結果仍不持久化**，不能視為福利額度已修好。「成功只釋放一次、
  重試不重複、失敗不釋放、重新整理後一致」均未驗證，最後一項在現況下必然不成立。
- **最小修正範圍**：
  1. 資料表 `benefit_authorizations`、`benefit_ledger`（只增不改，唯一鍵防同一預約
     重複扣額或釋放）與 RLS。
  2. 後端流程在同一交易內處理：建立預約扣額、`app.cancel_app_state_booking` 以淨額
     釋放（淨額為 0 不寫）、行程完成結算、正式修正重開；不接受前端送來的餘額或金額。
  3. state-load 回傳核定與帳本，前端改讀伺服器，不再以本機試算值當餘額。
  4. 產品決定：核定資料由誰建立、是否已有正式核定資料需要匯入。
  5. 對應的整合與瀏覽器測試。
