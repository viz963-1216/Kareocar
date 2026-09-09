# 安心接送 V12.26.0｜正式上線部署說明

> V12.26.0 移除全部 demo 程式碼，並修正 7 項安全問題（詳見 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)）。
>
> **本輪改了前後端契約，必須整包部署**：`/identity/update-account` 新增 `currentPassword`、gateway envelope 新增 `clientIp`。只替換 `index.html` 會導致帳號更新失敗。

## 1. Apps Script：整包更新

同一個 Apps Script 專案中更新下列檔案：

- `AuthCore.gs`（根目錄原本重複的那份已刪除，唯一來源是 `apps-script/AuthCore.gs`）
- `IdentityApi.gs`
- `GoogleAuth.gs`
- `DatabaseApi.gs`
- `AppStateApi.gs`
- `Router.gs`
- `WebApp.gs`

保留既有 Google Sheet schema / Booking / Audit helper；不要同時留另一份同名 `routeRequest_`、`readDatabaseTable_` 或 `doPost` 實作。

### 必要 Script Properties

至少設定：

- `GOOGLE_CLIENT_ID`
- `AUTH_PASSWORD_PEPPER`：至少 32 個隨機字元
- `AUTH_SESSION_SECRET`：至少 32 個隨機字元
- `NETLIFY_GATEWAY_SECRET`：至少 32 個隨機字元
- `SPREADSHEET_ID`（若目前專案使用此名稱指定正式 Sheet）

選用（V12.26.0 新增）：

- `AUTH_PBKDF2_ITERATIONS`：密碼雜湊迭代次數，預設 6000。部署後執行一次 `authBenchmarkPbkdf2_()`，把單次驗證調到 200–500ms。調高不會讓既有帳號失效。

正式啟用忘記密碼時另需：

- `PASSWORD_RESET_SMS_WEBHOOK_URL`：HTTPS SMS webhook
- `PASSWORD_RESET_SMS_WEBHOOK_SECRET`：與 SMS gateway 約定的 secret

系統只會把 `{phone, message}` POST 到此 webhook，並帶 `X-Care-Ride-Secret`。OTP 本身只以 salt + HMAC hash 保存在 Apps Script Script Properties，Google Sheet 不保存 OTP 明文。

> 所有 secret 都不可放進 HTML、公開 GitHub repo 或 Google Sheet。

### 超級管理者正式密碼

若尚未初始化，可在 Apps Script 編輯器手動執行：

```javascript
authBootstrapSuperAdminPassword_("你的09手機", "至少12碼的強密碼")
```

或設定 `BOOTSTRAP_SUPERADMIN_PHONE` / `BOOTSTRAP_SUPERADMIN_PASSWORD` 兩個 Script Property 後執行 `authBootstrapSuperAdminFromProperties_()`，執行完屬性會自動刪除。

舊名稱 `bootstrapSuperAdminPassword_v12_25_77` 與 `bootstrapSuperAdminFromProperties_v12_25_79` 保留為別名。

### 重新部署 Apps Script Web App

部署 → 管理部署作業 → 建立新版本／更新 Web App：

- 執行身分：你自己
- 可存取範圍：依目前 Netlify gateway 架構設定
- 外部 API 仍需 `NETLIFY_GATEWAY_SECRET`
- 記錄最新 `/exec` URL

Apps Script 改碼後若沒有更新部署，Netlify 仍會命中舊程式。

## 2. Netlify：整包部署

環境變數：

- `APPS_SCRIPT_WEB_APP_URL` = 最新 Apps Script `/exec`
- `APPS_SCRIPT_GATEWAY_SECRET` = Apps Script 的 `NETLIFY_GATEWAY_SECRET`
- `GOOGLE_CLIENT_ID` = 同一組 Google OAuth Web Client ID

部署以下全部內容：

- `index.html`
- `netlify.toml`
- `netlify/functions/`

V12.25.79 新增／使用的 Identity API：

- `/api/identity/request-password-reset`
- `/api/identity/confirm-password-reset`
- `/api/identity/update-account`

既有正式資料寫入：

- `/api/state-mutate`

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
