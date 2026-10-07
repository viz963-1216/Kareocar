# 部署與上線

系統架構見 [README.md](README.md)；資料庫、API 與業務規則見 [supabase/README.md](supabase/README.md)。

依 [CLAUDE.md](CLAUDE.md) 的授權邊界：正式資料庫寫入、正式部署、安裝軟體都要另外取得同意；
金鑰與密碼只在 Netlify、Supabase、GitHub 的設定畫面或本機終端機的隱藏輸入裡處理，不貼進
對話、不進 git。

## 1. 部署流程

### 前端與 API（Netlify）

- 合併到 `main` 時，Netlify 依 `netlify.toml` 建置並部署：靜態檔（`index.html`、`js/`、`css/`、
  `_headers`）、`netlify/functions/` 的 API 與排程。
- PR 會產生 Deploy Preview，連的是 **Staging** 資料庫。
- 建置時 `tools/check-db-config.js` 只解析連線設定（不連線）：非 production 的建置若指向正式
  Supabase 專案就失敗。
- 前端、API、migration 必須一起更新：只換其中一個會造成前後端契約不一致。所以 migration 要先
  套用（見下一節），再讓 API 上線。

### 資料庫 migration（GitHub Actions）

`.github/workflows/deploy-migrations.yml`，執行器 `tools/apply-migrations.sh`：

1. 合併到 main、且動到 `supabase/migrations/` 時，先在拋棄式 Postgres 上驗證每支 migration 的
   「上 → 下 → 上」與執行器。
2. 自動套用到 **Staging**（repo secret `STAGING_MIGRATION_DATABASE_URL`）。
3. **Production 只在人工觸發時套用**：GitHub → Actions → Deploy migrations → Run workflow，
   `target` 選 `production`、`confirm` 輸入 `apply-production`
   （repo secret `PRODUCTION_MIGRATION_DATABASE_URL`）。先在 Staging 確認沒問題再觸發。

- 連線用 Supabase 的 **Session pooler**（port 5432，`postgres.<ref>` 使用者）：GitHub Actions
  沒有 IPv6，連不到直連位址。
- 紀錄在 `ops.schema_migrations`。每支 migration 與它的紀錄在同一個交易，設 `lock_timeout`，
  取不到鎖就整筆回滾，可以直接重試。已套用的檔案被改寫時，執行器以 checksum 發現並拒絕。
- 新增 migration：用下一個編號，附 `supabase/rollback/<同名>.down.sql`。正式環境有資料之後，
  出錯以新的 migration 往前修，不跑回復檔。
- 本機預覽待套用清單：`MIGRATION_DATABASE_URL=… bash tools/apply-migrations.sh --dry-run`。

### 排程（Netlify Scheduled Functions）

| Function | 頻率 | 做什麼 |
|---|---|---|
| `retention-anonymize` | 每日 | 行程日期超過保存期限的預約與行程匿名化，每筆寫稽核紀錄 |
| `benefit-rules-fetch` | 每日 | 抓長照交通補助公告；內容有變就產生規則草稿；失敗時告警，現行版本不變 |

兩者也可以由平台管理者在畫面上手動執行（「組織管理 → 個資保存與條款」、「補助規則與資格 →
立即抓取公告」）。

### 備份（GitHub Actions）

| Workflow | 頻率 | 做什麼 |
|---|---|---|
| `db-backup.yml` | 每 6 小時 | 正式資料庫的加密邏輯備份，存成 artifact 保留 7 天 |
| `restore-drill.yml` | 每月 1 日 | 在拋棄式 Postgres 還原最新備份、逐表比對筆數，確認備份沒有中斷 |

加上 Supabase Pro 內含的每日備份。還原步驟與演練紀錄見 [docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)。

## 2. 環境變數與設定

### Netlify（每個 deploy context 各自設定）

| 變數 | 用途 | 機密 |
|---|---|---|
| `DATABASE_URL` | `care_ride_app` 角色的 Transaction pooler 連線字串（不能用 `postgres`） | 是 |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | 否 |
| `SUPABASE_ANON_KEY` | 公開金鑰，密碼登入與換 token 用 | 否 |
| `SUPABASE_SERVICE_ROLE_KEY` | 秘密金鑰，建立、更新、刪除登入帳號用 | **是** |
| `SUPABASE_JWT_SECRET` | 選用；舊版 HS256 專案才需要，新版自動用 JWKS | 是 |
| `AUTH_SESSION_SECRET` | 速率限制鍵的 HMAC 金鑰 | 是 |
| `PRODUCTION_SUPABASE_PROJECT_REF` | 正式專案 ref；所有 context 設同一個值，建置檢查用 | 否 |
| `GOOGLE_MAPS_API_KEY` | Geocoding API 與 Routes API；沒設定時建立預約會失敗 | 是 |
| `SENTRY_DSN` | Sentry 專案的 DSN；沒設定就不回報錯誤 | 否（但不要公開） |
| `DISCORD_ALERT_WEBHOOK_URL` | 告警送到 Discord 頻道的 webhook | **是** |
| `RESEND_API_KEY` | 告警 Email（Resend） | **是** |
| `ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO` | 告警寄件人（Resend 驗證過的網域）、收件人（逗號分隔） | 否 |

### Supabase

- 每個專案都要給 `care_ride_app` 設密碼（`alter role care_ride_app with password …`）。
- **Authentication → Sign In / Providers → Phone** 啟用（手機＋密碼登入需要）。系統不發簡訊
  （#58），Staging 與正式專案的簡訊設定都填假值即可；有人直接呼叫 Supabase 的簡訊驗證碼 API
  也只會發送失敗，不會產生簡訊費用。
- 已不使用的環境變數可以從 Netlify 刪除：`AUTH_PASSWORD_PEPPER`、`PASSWORD_RESET_SMS_WEBHOOK_URL`、
  `PASSWORD_RESET_SMS_WEBHOOK_SECRET`。
- 超級管理者的建立方式見 supabase/README.md 的「身分驗證」。
- **Google、Facebook 登入**（#58，Staging 與正式專案各設一次）：
  - **Authentication → Sign In / Providers → Google**：啟用，填入 Google Cloud 的用戶端 ID 與密鑰
  - **Authentication → Sign In / Providers → Facebook**：啟用，填入 Meta app 的應用程式編號與密鑰
  - **Authentication → Hooks → Customize Access Token (JWT) Claims**：啟用，類型選 Postgres，
    函式選 `public.custom_access_token_hook`（migration 0014 建立）。綁定的社群帳號登入時，token 會
    帶 `app_user_id`；**沒啟用的話，綁定既有帳號後用社群登入會被當成未綁定**
  - **Allow new users to sign up** 保持打開（第一次社群登入會先建立帳號，綁定手機後才能使用）。
    Allow manual linking 不再需要（綁定改由 social_logins 記錄，只確認一次）
  - **Authentication → URL Configuration → Redirect URLs** 加入
    `https://<正式網域>/api/v2/oauth-callback`；Staging 專案加入 `https://*--kareocar.netlify.app/api/v2/oauth-callback`
    （Deploy Previews）
- **Google Cloud**（API 和服務 → 憑證 → 建立 OAuth 用戶端 ID，類型「網頁應用程式」）：已授權的重新導向
  URI 填 `https://<Supabase 專案 ref>.supabase.co/auth/v1/callback`。OAuth 同意畫面只需要 email、
  profile，不必送審；要顯示 logo 才需要品牌驗證。
  - 2026-10-04 已建立：專案 `kareocar`、用戶端「Kareocar Supabase」（正式與 Staging 的 Supabase 回呼網址
    都在同一個用戶端），已填入兩個 Supabase 專案。
  - **目前是「測試」狀態**：只有 Google Auth Platform → 目標對象 → 測試使用者（最多 100 人）能用
    Google 登入。發布前要在「品牌」頁填應用程式首頁與隱私權政策網址（律師文件完成後），再按
    「發布應用程式」；只用非機密範圍、沒有 logo，不需要 Google 審查。
- **Meta 開發者後台**（建立應用程式 → 使用 Facebook 登入）：有效的 OAuth 重新導向 URI 填同一個
  Supabase 回呼網址；切換成「上線」前要填隱私權政策網址與資料刪除說明（律師文件完成後）。
  - 2026-10-05 已建立：應用程式「安心接送」（編號 955307740981434），使用案例「使用 Facebook 登入」，
    權限 `email`、`public_profile`；有效的 OAuth 重新導向 URI 為正式與 Staging 的 Supabase 回呼網址
    （Strict 模式、強制 HTTPS）。
  - **目前是「開發」模式**：只有應用程式角色（管理員、開發者、測試人員）能用 Facebook 登入。切換成
    「上線」前要填隱私權政策、資料刪除說明網址、應用程式圖示與類別。本系統只用 `email` 與
    `public_profile`，這兩項權限 Meta 自動給予，**不需要商家驗證**；個人名義的應用程式也能上線。
    要用其他進階權限才需要商家驗證與應用程式審查。

### GitHub

| 名稱 | 種類 | 用途 |
|---|---|---|
| `STAGING_MIGRATION_DATABASE_URL` | secret | 套用 migration 到 Staging |
| `PRODUCTION_MIGRATION_DATABASE_URL` | secret | 套用 migration 到 Production（人工觸發）；定時備份也用它 |
| `BACKUP_ENCRYPTION_PASSPHRASE` | secret | 備份的加密密碼；另存一份在密碼管理器，遺失就無法解密 |
| `DISCORD_ALERT_WEBHOOK_URL` | secret，選用 | 備份失敗時通知 Discord |
| `STAGING_URL` | variable，選用 | 每週 ZAP 排程掃描的網址；PR 的掃描不需要 |

### 平台設定（上線後在畫面上設定）

- **條款版本**：律師完成個資告知與服務條款後，平台管理者在「組織管理 → 個資保存與條款」填入
  版本與網址。版本空白時不要求同意；發布後沒同意最新版本的使用者不能建立預約。
- **保存期限**：預設 5 年，同一個畫面可以改（1–30 年）。
- **補助規則**：第一次排程抓取會產生草稿，平台管理者核對自付比例（附表五）後核准，補助估算
  才會開始有金額。

## 3. 監控與告警（#17）

程式端已接好，帳號與設定由 repo 擁有者操作：

| 項目 | 程式端 | 要你設定 |
|---|---|---|
| 伺服器錯誤 | 所有 5xx 經 `_http.handleError` 送到 Sentry，回應帶 `errorId` 方便對照 | 在 Sentry 建專案（平台選 Node.js），把 DSN 填進 `SENTRY_DSN` |
| 前端錯誤 | `js/monitoring.js` 送到 `/api/v2/client-error`，伺服器轉給 Sentry（瀏覽器不直接連 Sentry） | 同上，同一個 DSN |
| 錯誤率告警 | — | Sentry → Alerts 建規則：新錯誤、錯誤數超過門檻時通知 Email；Discord 用 Sentry 的 Discord 整合或 webhook |
| 存活檢查 | `/api/health` 支援 GET 與 HEAD，資料庫或設定有問題時回 503 | 在外部服務（例如 UptimeRobot 免費方案）建 HTTP 監測，每 5 分鐘檢查 `https://<正式網域>/api/health`，告警聯絡人設 Email 與 Discord |
| 應用程式告警（補助公告抓取失敗等） | `_alerts.js` 送到 Discord 與 Email，另寫稽核紀錄 | `DISCORD_ALERT_WEBHOOK_URL`、`RESEND_API_KEY`、`ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO` |

**個資**：送出前經 `_scrub.js` 清掉電話、Email、身分證號、地址，敏感欄位（姓名、電話、地址、
聯絡人、備註、生日、token 等；鍵名拆成單字比對，primaryPhone、emergencyContacts 這類 camelCase 也算，
tripId、pickupAt 這類 ID 與時間不算）整個拿掉；不送請求內容、cookie、查詢字串與使用者資料。Sentry 專案設定另外建議：
關閉 IP 記錄（Settings → Security & Privacy → Prevent Storing of IP Addresses），開啟
Data Scrubber。

**驗收**：平台管理者在「組織管理 → 個資保存與條款 → 監控與告警」按「觸發測試錯誤」（Sentry
應出現一筆錯誤、錯誤告警寄出）與「送出測試告警」（Email 與 Discord 都收到）；存活檢查可以暫時把
監測網址改成不存在的路徑，確認收到失敗通知後改回。

## 4. 部署後確認

1. `GET https://<網域>/api/health` 回 HTTP 200，內容 `ok: true`、`configured: true`、
   `database: true`。缺任何必要變數或連不到資料庫時回 503。
2. 以 Staging 跑一次冒煙測試：`node tools/smoke-supabase-auth.js`（註冊、登入、更新 session、
   登出、撤銷）。
3. 用一般帳號走一次：註冊 → 同意條款（若已發布）→ 建立預約 → 機構接案 → 排車 → 司機執行到
   完成 → 需求者看到通知。
4. GitHub Actions 的「資安掃描」在最新的 main 上是綠的。

## 上線檢查清單

### 需要外部帳號或人工決定

- [ ] **律師文件**：草稿已在 `legal/privacy.html`（隱私權政策暨個資告知，含 Google／Facebook 登入取得的
      資料與資料刪除說明 `#data-deletion`）與 `legal/terms.html`（服務條款），登入畫面下方有連結。發布前：
      1. 律師審閱，補上所有【待填】（經營者、統一編號、聯絡 Email、Supabase 區域、管轄法院、版本與生效日），
         並移除頁面上的「草稿」提示
      2. 平台設定 → 條款版本：`privacy_notice`、`terms` 填版本與網址（`/legal/privacy.html`、`/legal/terms.html`）；
         填了版本之後，沒有同意的使用者不能建立預約
      3. Google 品牌頁填首頁、隱私權政策、服務條款網址；Meta 基本設定填隱私權政策、服務條款與資料刪除說明網址
         （`/legal/privacy.html#data-deletion`）
- [x] **社群登入 Hook**（#58）：正式專案套用 migration 0014 後，在 Authentication → Hooks 啟用
      Customize Access Token，函式 `public.custom_access_token_hook`（Staging 同樣要開）。兩個專案都已啟用
- [ ] **Facebook 登入發布**：填隱私權政策與資料刪除說明網址、圖示與類別，切換成「上線」（只用 email、
      public_profile，不需要商家驗證）。目前只有應用程式角色能用；試營運期間畫面先隱藏 Facebook 按鈕
- [ ] **Google 登入發布**：隱私權政策網址填進 Google 品牌頁，按「發布應用程式」（目前只有測試使用者能用）
- [ ] **登入方式**（#58）：不接簡訊廠商。程式已完成（後台重設密碼、Google／Facebook 登入與綁定
      手機）；依上方「Supabase」設定 Google Cloud、Meta 與 Supabase 的登入提供者，並在 Staging 實際
      走一次：新帳號、綁定既有帳號、我的帳戶綁定與解除
- [ ] **監控與告警**（#17）：程式端已完成，依「3. 監控與告警」建 Sentry 專案與告警規則、外部存活
      檢查、Discord webhook、Resend 寄件網域，並完成驗收（測試錯誤、測試告警、存活檢查失敗各一次）
- [x] **Google Maps 金鑰**（2026-10-05）：Google Cloud 專案 `kareocar` 啟用 Geocoding API、Routes API；
      金鑰「Maps Platform API Key」限制只能呼叫這兩個 API（來源不限制：Netlify 伺服器沒有固定 IP）；
      已填入 Netlify 的 `GOOGLE_MAPS_API_KEY`（機密，所有 context）；帳單帳戶設 1 美元預算警示
- [ ] **Google Cloud 免費試用到期（2026-11-28）前升級**：試用結束不升級的話地圖 API 會停止，建立預約會
      失敗。升級後在 Google 地圖平台 → 配額，把 Geocoding（v3 requests per day）與 Routes 設每日上限
      （例如各 300 次；每筆預約約 3 次呼叫），試用期間配額不能修改。每月約 1 萬次免費額度，以 Google 價格頁為準
- [x] **備份與還原演練**（#28）：不加購 PITR，改用 Supabase 每日備份＋每 6 小時的加密備份
      （見 [docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)）。設定 `BACKUP_ENCRYPTION_PASSPHRASE`、
      手動跑一次 Database backup 與 Restore drill，並在上線前做一次 Supabase 每日備份的還原演練
      （2026-10-04 定時備份演練、2026-10-06 每日備份還原演練都已通過，紀錄見 RESTORE_RUNBOOK）
- [ ] **Netlify 方案**：正式上線前確認團隊方案與額度（目前降為免費方案時合併不會部署）

### 正式資料庫

- [x] （已完成：清空後以 migration 重建，目前 0001–0014）目前的正式 Supabase 是早期以 SQL Editor 手動建立的，沒有 migration 紀錄，執行器會拒絕
      （exit 3）。**這是正式資料庫寫入，需另外取得同意。** 步驟：
      1. 確認 Database → Backups 有最近的每日備份
      2. SQL Editor 執行 `tools/reset-legacy-production.sql`：一個交易內刪掉 public（擴充套件的物件除外）
         與 app、ops schema，不碰 auth 等 Supabase 自己的 schema；已有 migration 紀錄的庫會拒絕。
         CI 的 `supabase/tests/reset-legacy.test.sh` 以模擬的舊庫驗證過整個流程
      3. 選擇性：Authentication → Users 刪掉舊的測試帳號（沒有對應的 users 資料，留著登入後狀態不完整）
      4. 以人工觸發套用全部 migration（見「資料庫 migration」）
- [ ] 套用後在 SQL Editor 給 `care_ride_app` 設密碼，更新 Netlify production 的 `DATABASE_URL`。
      Netlify 的 `DATABASE_URL` 已有 3 個 context 的值，但正式值是重建前設的，沒有紀錄顯示重建後設過新密碼。
      **恢復 Netlify 正式部署前**：重新給正式專案的 `care_ride_app` 設一組新密碼，同步更新 Production 的值
      （使用者名稱應為 `care_ride_app.vcbhtlwkzavqvxthicis`），部署後以 `/api/health` 回 200 確認
- [x] 建立平台超級管理者帳號（`tools/create-super-admin.sh`，2026-10-05）

### 營運設定

- [ ] 第一家機構經「機構申請 → 平台審核」上線（試營運）
- [ ] 第一次補助規則草稿核對附表五並核准
- [ ] 確認保存期限（預設 5 年）符合律師意見
- [ ] 選擇性：設定 `STAGING_URL` 讓 ZAP 每週掃描；Netlify 的 Deploy Previews 若不需要協作工具列
      可關閉（ZAP 對它的三項低風險提示會消失）

### 已知、接受的限制

- **預約與行程仍存在 `app_state`（jsonb）**：寫入已改走專用端點並由伺服器檢查，搬到正式資料表
  排在上線後（#43）。
- **平台使用費**：向機構依筆數收費的功能排在上線後（#40）。平台不訂車資，報價固定是「由雙方議定」。
- **給付辦法附表（自付比例）不自動解析**：附表是 PDF，伺服器只偵測改版；改版時草稿會要求人工核對。
- **畫面上仍有 `style="…"` 屬性**：CSP 保留 `style-src-attr 'unsafe-inline'`；內嵌 `<style>`
  與 script 都已禁止。
- **沒有外部滲透測試**：資安以內部的 RLS 測試、依賴套件掃描與 ZAP baseline 為主。
