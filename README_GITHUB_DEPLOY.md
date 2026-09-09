# 安心接送 V12.25.79｜GitHub / Netlify 上線包

此資料夾內容就是 GitHub repository root 應有的結構。請解壓縮後上傳「裡面的檔案」，不要把最外層資料夾再包一層上傳。

## GitHub root

- `index.html`：正式前端 V12.25.79
- `netlify.toml`：Netlify redirects / functions 設定
- `netlify/functions/`：Netlify API Proxy
- `apps_script/`：Apps Script 正式後端原始碼（僅供版本控管；不會因 GitHub push 自動部署到 Apps Script）
- `DEPLOYMENT.md`：完整部署與 health gate
- `P0_VALIDATION.md`：P0 驗證紀錄
- `RELEASE_AUDIT.md`：封版驗證

## 上線順序

1. 先更新 Apps Script 7 個 `.gs` 檔案與 Script Properties。
2. 將 Apps Script Web App 建立新版本／重新部署，取得最新 `/exec` URL。
3. 在 Netlify 設定環境變數。
4. 把本資料夾 root 內容 push 到 GitHub。
5. 讓 Netlify 從 GitHub 重新部署。
6. 開啟 `/api/health` 驗證版本與設定。
7. 做正式網址 E2E：註冊 → 登入 → 登出換瀏覽器 → 新增員工 → 預約 → Trip → Google Sheet。

## Apps Script 必須更新

全部替換同一 Apps Script 專案中的：

- `AuthCore.gs`
- `IdentityApi.gs`
- `GoogleAuth.gs`
- `DatabaseApi.gs`
- `AppStateApi.gs`
- `Router.gs`
- `WebApp.gs`

不要同時保留舊版同名 `doPost`、`routeRequest_`、`readDatabaseTable_` 實作。

### Script Properties

必要：

- `GOOGLE_CLIENT_ID`
- `AUTH_PASSWORD_PEPPER`（至少 32 個隨機字元）
- `AUTH_SESSION_SECRET`（至少 32 個隨機字元）
- `NETLIFY_GATEWAY_SECRET`（至少 32 個隨機字元）
- `SPREADSHEET_ID`（若目前專案使用此名稱）

若正式開放忘記密碼：

- `PASSWORD_RESET_SMS_WEBHOOK_URL`
- `PASSWORD_RESET_SMS_WEBHOOK_SECRET`

所有 secret 禁止 commit 到 GitHub。

## Netlify 必須更新

部署：

- `index.html`
- `netlify.toml`
- `netlify/functions/` 全部

環境變數：

- `APPS_SCRIPT_WEB_APP_URL` = 最新 Apps Script `/exec`
- `APPS_SCRIPT_GATEWAY_SECRET` = Apps Script 的 `NETLIFY_GATEWAY_SECRET`
- `GOOGLE_CLIENT_ID` = 同一個 Google OAuth Web Client ID

V12.25.79 新增／需要的 API 包含：

- `/api/identity/request-password-reset`
- `/api/identity/confirm-password-reset`
- `/api/identity/update-account`
- `/api/state-mutate`

## Health Gate

正式站：`https://你的網域/api/health`

至少確認：

- `ok: true`
- `spreadsheetReady: true`
- `appStateReady: true`
- `rowAuthorizationVersion: "12.25.79"`
- `authConfigured: true`
- `googleClientConfigured: true`
- `passwordResetProviderConfigured: true`（若要啟用忘記密碼）

若 `rowAuthorizationVersion` 仍是舊版，通常代表 Apps Script 改碼後沒有重新部署 Web App 新版本，或 Netlify 還指向舊 `/exec`。
