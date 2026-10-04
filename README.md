# 安心接送

多機構的長照接送媒合平台：需求者建立預約，經平台審核的接送機構從共享需求池承接、排車、
由司機執行。Netlify 提供前端與 API（Netlify Functions）；資料、授權都在 Postgres（Supabase），
由 Row Level Security 把關；登入由 Supabase Auth 負責。

- 原始碼：https://github.com/viz963-1216/Kareocar
- 部署與上線檢查清單：[DEPLOYMENT.md](DEPLOYMENT.md)
- 資料庫、API 與業務規則：[supabase/README.md](supabase/README.md)
- 資安模型：[SECURITY_HARDENING.md](SECURITY_HARDENING.md)

## 架構

```
瀏覽器（index.html、js/*.js、css/app.css）
   │  只呼叫同網域的 /api/*；登入憑證只在 HttpOnly cookie（cr_at、cr_rt）
   │  CSP：script-src 'self'、connect-src 'self'，不連任何外部網站
   ▼
Netlify Functions（netlify/functions/）
   │  驗證 Supabase Auth 的 JWT，以 care_ride_app 角色連線，
   │  每筆交易設定 app.user_id，金額、狀態轉換、通知都由伺服器決定
   ├──► Supabase Auth（手機＋密碼、建立／停用帳號）
   ├──► Google Maps（建立預約時定位與算距離，結果存進預約）
   ├──► 政府長照公告（每日排程抓取，產生規則草稿）
   ├──► Sentry（伺服器與前端錯誤，送出前清除個資）
   ├──► Discord、Email（告警）
   ▼
Postgres（Supabase）            ← 唯一的真實資料來源；RLS 做列層級授權
```

- **唯一真實來源是 Postgres**。瀏覽器的本機資料只是暫存；未登入讀不到任何資料。
- **寫入分流**：預約、行程、接案、取消、司機執行、補助、同意、刪除申請都有專用端點，
  由伺服器檢查狀態轉換與機構歸屬；其他一般資料經 `state-mutate`，由 RLS 與觸發器把關。
- **伺服器計算**：模糊地址與距離、補助估算（依已核准的規則版本）、補助額度帳本、通知，
  前端送來的同名欄位一律不採用。
- **排程**（netlify.toml）：每日把超過保存期限的資料匿名化（`retention-anonymize`）、
  每日抓長照交通補助公告（`benefit-rules-fetch`）。

## 環境

| 環境 | 前端與 API | 資料庫 | migration |
|---|---|---|---|
| Production | Netlify 正式站 | 正式 Supabase 專案 | 人工觸發（見 DEPLOYMENT.md） |
| Staging | Netlify Deploy Previews 與 Branch deploys | Staging Supabase 專案 | 合併到 main 後自動套用 |
| 本機與 CI | `tools/local-dev-server.js` | 拋棄式 Postgres | 每次從頭套用全部 migration |

建置檢查（`tools/check-db-config.js`）會擋下「非 production 的建置連到正式資料庫」。

## 開發與測試

```bash
npm test                          # 離線回歸測試（不需要資料庫）
node tools/check-inline-js.js     # js/*.js 語法；index.html 不得有內嵌 script 或 inline 事件處理器
node tools/check-dom-refs.js      # DOM id 交叉檢查
node tools/check-id-mapping.js    # 後端／前端識別碼對應

# 需要本機 Postgres 16（啟動方式見 supabase/README.md 的「本機測試」）
PGHOST=/tmp/pgrun PGPORT=5433 bash supabase/tests/run-all.sh
```

CI（`.github/workflows/`）：

| Workflow | 內容 |
|---|---|
| `isolated-sql-review.yml` | 離線測試、在拋棄式 Postgres 上跑全部整合測試（RLS、業務流程、預約、行程、通知、補助、隱私）、migration 往返、瀏覽器端對端測試（在實際的 CSP 下） |
| `security.yml` | `npm audit`（high 以上失敗）、ZAP baseline 掃描 Staging（高風險失敗，報告存 artifact） |
| `deploy-migrations.yml` | migration 驗證後自動套用到 Staging；Production 人工觸發 |
| `db-backup.yml`、`restore-drill.yml` | 正式資料庫每 6 小時加密備份；每月在拋棄式 Postgres 還原演練（見 [docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)） |

整合測試跑的是 `netlify/functions/` 的實際程式碼，接在真實 Postgres 上、以 `care_ride_app`
角色連線，所以 RLS 是真的在把關。外部服務（Supabase Auth、Google Maps、政府網站、告警）
在測試中以假實作替換（`supabase/tests/_auth-fixture.js`）。

## 目錄

| 路徑 | 內容 |
|---|---|
| `index.html`、`js/`、`css/` | 前端 |
| `_headers` | 安全標頭與 CSP |
| `netlify.toml` | API 路由、排程、建置檢查 |
| `netlify/functions/` | API 與排程；`_` 開頭是共用模組 |
| `supabase/migrations/`、`supabase/rollback/` | schema 與每支 migration 的回復檔 |
| `supabase/tests/` | 資料庫整合測試與瀏覽器端對端測試 |
| `tests/` | 離線測試 |
| `tools/` | 建置檢查、migration 執行器、本機開發伺服器、ZAP 報告判斷 |

## 上線前

尚未完成的項目與需要人工確認的事項，見 [DEPLOYMENT.md 的上線檢查清單](DEPLOYMENT.md#上線檢查清單)。
