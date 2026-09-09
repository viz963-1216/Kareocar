# Apps Script 後端

這個目錄是 Apps Script Web App 的原始碼。所有檔案屬於**同一個** Apps Script 專案，必須一起部署。

## ⚠️ 這個目錄目前不完整

以下 6 支函式在程式碼中被呼叫，但**不在這個 repo 裡**：

| 函式 | 用途 |
|---|---|
| `getSpreadsheet_()` | 取得正式 Google Sheet |
| `readTable_(sheetName)` | 整個資料層的核心讀取函式 |
| `writeAudit_(entry)` | 稽核紀錄的唯一寫入點 |
| `requireConfig_(name)` | 設定值讀取（`authConfig_` 會優先使用它） |
| `createBooking_(body, req)` | 正規化預約建立 |
| `updateBooking_(body, req)` | 正規化預約更新 |

它們存在於已部署的 Apps Script 專案中（可能在 `Code.gs` 或類似檔名），但從未被加入版本控制。

**後果**：目前無法只靠這個 repo 重建後端。Apps Script 專案若被誤刪或帳號出問題，這幾支函式就沒有備份。

**請這樣補上**：

1. 打開 Apps Script 專案，把清單以外的每個 `.gs` 檔內容複製出來
2. 存成 `apps-script/<原檔名>.gs`
3. 執行 `npm test` 確認測試仍然通過（測試目前是用 `tests/shim.js` 模擬這幾支函式）
4. 長期建議改用 [clasp](https://github.com/google/clasp) 做雙向同步，避免再次分岔

## 檔案

| 檔案 | 職責 |
|---|---|
| `WebApp.gs` | `doPost` 進入點，驗證 gateway secret |
| `Router.gs` | 路由表與健康檢查 |
| `AuthCore.gs` | 密碼雜湊、session token、速率限制、密碼重設 |
| `IdentityApi.gs` | 註冊、登入、人員建立、帳號更新 |
| `GoogleAuth.gs` | Google ID Token 驗證與社群登入 |
| `DatabaseApi.gs` | 讀取 API 與 row-level 授權 |
| `AppStateApi.gs` | 操作狀態的權威寫入與授權 |

## Script Properties

必要：

| 名稱 | 說明 |
|---|---|
| `NETLIFY_GATEWAY_SECRET` | 至少 32 個隨機字元，需與 Netlify 的 `APPS_SCRIPT_GATEWAY_SECRET` 相同 |
| `AUTH_SESSION_SECRET` | 至少 32 個隨機字元。變更會使所有 session 立即失效 |
| `AUTH_PASSWORD_PEPPER` | 至少 32 個隨機字元。**變更會使所有密碼失效**，只能在初次設定時決定 |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `SPREADSHEET_ID` | 正式 Google Sheet（若專案使用此名稱） |

選用：

| 名稱 | 預設 | 說明 |
|---|---|---|
| `AUTH_PBKDF2_ITERATIONS` | `6000` | 密碼雜湊成本。調高不會讓既有帳號失效 |
| `PASSWORD_RESET_SMS_WEBHOOK_URL` | — | HTTPS SMS webhook；未設定則忘記密碼會回 `RESET_PROVIDER_UNAVAILABLE` |
| `PASSWORD_RESET_SMS_WEBHOOK_SECRET` | — | 與 SMS gateway 約定的 secret，以 `X-Care-Ride-Secret` 送出 |

一次性（執行後會自動刪除）：

| 名稱 | 說明 |
|---|---|
| `BOOTSTRAP_SUPERADMIN_PHONE` | 09 開頭的 10 碼手機 |
| `BOOTSTRAP_SUPERADMIN_PASSWORD` | 至少 12 碼 |

## 部署後要做的事

### 1. 決定密碼雜湊成本

在編輯器執行一次：

```javascript
authBenchmarkPbkdf2_()
```

回傳值會告訴你目前設定大約要花幾毫秒。把 `AUTH_PBKDF2_ITERATIONS` 調到單次驗證落在 **200–500ms**——太低保護不足，太高會讓登入撞到 Netlify 的 12 秒逾時。

### 2. 初始化超級管理者密碼

設好兩個 `BOOTSTRAP_SUPERADMIN_*` 屬性後執行：

```javascript
authBootstrapSuperAdminFromProperties_()
```

執行完屬性會自動刪除（即使失敗也會刪）。舊的函式名稱 `bootstrapSuperAdminPassword_v12_25_77` 與 `bootstrapSuperAdminFromProperties_v12_25_79` 保留為別名。

### 3. 確認健康檢查

`GET /api/health` 應該回報：

- `authConfigured: true`
- `rowAuthorizationVersion`
- `passwordResetProviderConfigured: true`（若啟用忘記密碼）

## 本機測試

`.gs` 是純 ES5，可以在 Node 上對著 `tests/` 的 Apps Script 模擬層直接執行：

```bash
npm test
```

不需要部署，也不會碰到正式資料。
