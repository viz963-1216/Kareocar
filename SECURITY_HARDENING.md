# 資安模型

目前系統的資安設計與驗證方式。舊版（Apps Script 與 Google Sheets 時期）的強化紀錄已不適用，
保留在 git 歷史中。

## 身分與 session

- 登入由 **Supabase Auth** 負責（手機＋密碼，或 Google、Facebook），資料庫不保存任何密碼。
- 社群登入走自己的 API（`oauth-start` → Supabase → Google／Facebook → `oauth-callback`），以 PKCE
  綁定發起登入的瀏覽器：verifier 只在簽章過的 `cr_oauth` cookie，別人塞過來的授權碼換不到 session。
  第一次登入還沒綁定手機時不發登入 cookie，只發簽章過的 `cr_bind`（15 分鐘），所有 API 都用不了；
  綁定既有帳號必須輸入那支手機的密碼（有失敗次數限制）。同一個社群帳號只能綁一個使用者。
- access token 與 refresh token 只放在 **HttpOnly cookie**（`cr_at` 只送到 `/api`，`cr_rt` 只送到
  `/api/v2/session`），瀏覽器的 JavaScript 讀不到。
- 每個請求驗證 JWT（JWKS 或 HS256），以 token 的 `sub` 作為使用者。停用帳號、改密碼、刪除帳號
  時更新 `users.sessions_valid_after`，舊的登入立即失效。
- 登入有速率限制（依手機與 IP）。不發簡訊：忘記密碼由平台超級管理者或機構負責人在後台重設，
  產生一次性顯示的臨時密碼；誰能重設誰由資料庫函式 `app.password_reset_target` 判斷（負責人只能
  重設工作身分全在自己機構的調度員、司機），重設後對方舊登入全部失效並寫稽核紀錄。

## 資料存取

- Netlify Function 一律以 **`care_ride_app`** 角色連線（`postgres` 會繞過 RLS，`_db.js` 啟動時
  拒絕）。每筆交易以 `set_config('app.user_id', …, true)` 帶入身分，只在該交易有效。
- **Row Level Security** 決定每一列誰讀得到、誰寫得了：需求者只看自己的；機構成員只看自己機構
  的；司機只看指派給自己的行程；平台管理者看全部。
- **需求池去識別**：接案前只看得到行政區、模糊地址（路段＋門牌去尾）、距離與車程，看不到姓名、
  電話、完整地址。退回公開池、不受理、取消後，原承接機構立即失去存取。
- **寫入分流**：預約、行程、接案、取消、司機執行、通知、補助、同意、刪除申請都有專用端點或
  security definer 函式，由伺服器檢查狀態轉換、機構歸屬與欄位；一般寫入端點 `state-mutate`
  只接受白名單內的集合。
- **伺服器決定的資料**：模糊地址與距離、補助估算與額度帳本、通知都由伺服器產生；前端送來的
  同名欄位一律不採用。通知、補助規則、帳本、同意紀錄、刪除申請的資料表，`care_ride_app` 只有
  SELECT。

## 瀏覽器

`_headers` 設定：

- **CSP**：`script-src 'self'`、`style-src-elem 'self'`、`connect-src 'self'`、
  `frame-ancestors 'none'`、`object-src 'none'`。index.html 不得有內嵌 script 或 inline 事件處理器
  （`tools/check-inline-js.js` 檢查）。畫面上仍有 `style="…"` 屬性，所以保留
  `style-src-attr 'unsafe-inline'`。
- `Strict-Transport-Security`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`。
- `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`、
  `Cross-Origin-Embedder-Policy: require-corp`。
- `Permissions-Policy`：只允許本站使用定位（司機回報位置與服務證明），相機、麥克風、付款等一律關閉。

瀏覽器端對端測試在實際的 `_headers` 下執行，任何 CSP 違規都會讓測試失敗。

## 個資保護

- 使用者同意的個資告知與服務條款版本、時間都有紀錄；條款改版要求重新同意。
- 行程日期超過保存期限（預設 5 年）的預約與行程每日自動匿名化，每筆寫稽核紀錄。
- 使用者可以申請刪除帳號與個資，由平台管理者核准後在同一交易內執行。

詳見 supabase/README.md 的「同意紀錄與保存期限」。

## 監控

伺服器與前端的未處理錯誤送到 Sentry，前端經本站的 `/api/v2/client-error` 轉送，不直接連外部；
送出前經 `_scrub.js` 清掉電話、Email、身分證號、地址與敏感欄位。告警送到 Email 與 Discord。
細節見 DEPLOYMENT.md 的「監控與告警」。

## 持續驗證

| 項目 | 在哪裡 |
|---|---|
| RLS 與權限（含攻擊模擬：偽造擁有者、跨機構讀寫、偽造通知、直接 SQL） | `isolated-sql-review.yml` 的整合測試，每個 PR 與 main |
| 依賴套件弱點 | `security.yml` 的 `npm audit`，high 以上失敗 |
| 網站被動掃描 | `security.yml` 的 ZAP baseline（Staging），高風險失敗，報告存 artifact |
| 瀏覽器實際行為 | 端對端測試在實際 CSP 下執行 |
| 備份可以還原 | `restore-drill.yml` 每月在拋棄式 Postgres 還原最新備份並逐表比對 |

## 備份

正式資料庫有 Supabase 每日備份（7 天）與每 6 小時的加密邏輯備份（GitHub Actions artifact，7 天）。
備份含個資，以 gpg 對稱加密（AES-256）後才離開 runner，明文只在暫存目錄；加密密碼是 repo secret，
另由 repo 擁有者保存。沒有 PITR，最多遺失約 6 小時的資料。見 [docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)。

## 已知、接受的風險

- 沒有外部滲透測試。
- `style-src-attr 'unsafe-inline'`（見上）。
- 稽核紀錄允許應用程式角色新增（`audit_insert with check (true)`），但沒有修改或刪除政策。
- 預約與行程仍以 jsonb 存在 `app_state`，授權靠 `app_state` 的 RLS 與觸發器；搬到正式資料表
  排在上線後（#43）。

發現資安問題請直接聯絡 repo 擁有者，不要開公開 issue。
