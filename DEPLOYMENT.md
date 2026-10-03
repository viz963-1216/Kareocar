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
| `AUTH_PASSWORD_PEPPER` | 忘記密碼驗證碼的雜湊 pepper | 是 |
| `PRODUCTION_SUPABASE_PROJECT_REF` | 正式專案 ref；所有 context 設同一個值，建置檢查用 | 否 |
| `GOOGLE_MAPS_API_KEY` | Geocoding API 與 Routes API；沒設定時建立預約會失敗 | 是 |
| `PASSWORD_RESET_SMS_WEBHOOK_URL`、`PASSWORD_RESET_SMS_WEBHOOK_SECRET` | 忘記密碼簡訊（#19 換成台灣廠商） | 是 |
| `SENTRY_DSN` | Sentry 專案的 DSN；沒設定就不回報錯誤 | 否（但不要公開） |
| `DISCORD_ALERT_WEBHOOK_URL` | 告警送到 Discord 頻道的 webhook | **是** |
| `RESEND_API_KEY` | 告警 Email（Resend） | **是** |
| `ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO` | 告警寄件人（Resend 驗證過的網域）、收件人（逗號分隔） | 否 |

### Supabase

- 每個專案都要給 `care_ride_app` 設密碼（`alter role care_ride_app with password …`）。
- **Authentication → Sign In / Providers → Phone** 啟用。Staging 用 Twilio 假值即可（手機＋密碼
  登入不發簡訊）；**正式專案不可用假值**，等 #19 接上真的簡訊廠商。
- 超級管理者的建立方式見 supabase/README.md 的「身分驗證」。

### GitHub

| 名稱 | 種類 | 用途 |
|---|---|---|
| `STAGING_MIGRATION_DATABASE_URL` | secret | 套用 migration 到 Staging |
| `PRODUCTION_MIGRATION_DATABASE_URL` | secret | 套用 migration 到 Production（人工觸發） |
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
token 等）整個拿掉；不送請求內容、cookie、查詢字串與使用者資料。Sentry 專案設定另外建議：
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

- [ ] **律師文件**：個資告知、服務條款完成；在平台設定填入版本與網址
- [ ] **簡訊廠商**（#19）：選定台灣廠商並開通；Supabase 正式專案的 Phone provider 改用真的廠商；
      忘記密碼的簡訊測試成功
- [ ] **監控與告警**（#17）：程式端已完成，依「3. 監控與告警」建 Sentry 專案與告警規則、外部存活
      檢查、Discord webhook、Resend 寄件網域，並完成驗收（測試錯誤、測試告警、存活檢查失敗各一次）
- [ ] **Google Maps**：正式與 Staging 的 `GOOGLE_MAPS_API_KEY`，在 Google Cloud 限制可用的 API
      與用量上限
- [ ] **Supabase Pro 與 PITR**（#28）：正式專案開啟 point-in-time recovery，在 Staging 做一次還原
      演練並把步驟寫成文件
- [ ] **Netlify 方案**：正式上線前確認團隊方案與額度（目前降為免費方案時合併不會部署）

### 正式資料庫

- [ ] 目前的正式 Supabase 是早期以 SQL Editor 手動建立的，沒有 migration 紀錄，執行器會拒絕
      （exit 3）。上線前需清空 public 與 app schema 後，以人工觸發套用全部 migration。
      **這是正式資料庫寫入，需另外取得同意。**
- [ ] 套用後在 SQL Editor 給 `care_ride_app` 設密碼，更新 Netlify production 的 `DATABASE_URL`
- [ ] 建立平台超級管理者帳號

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
