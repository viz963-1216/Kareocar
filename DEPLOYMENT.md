# 安心接送 V12.26.1｜正式上線部署說明

> V12.26.0 移除全部 demo 程式碼，並修正 7 項安全問題（詳見 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)）。
>
> V12.26.1 另外改了資料存放位置（密碼憑證改存工作表、暫時狀態改用 CacheService），部署步驟見 [MIGRATION_12_26_1.md](MIGRATION_12_26_1.md)。
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

## 7. migration 0008（接案、司機執行、需求者取消）部署順序

0008 尚未部署到任何環境。正式資料庫執行 SQL 與部署都需另行取得同意（見
[CLAUDE.md](CLAUDE.md) 授權邊界）；以下是取得同意後的操作順序。

### 為什麼一定是「先 migration、後程式」

- 新程式的三個端點（claim-booking、trip-execute、cancel-booking）呼叫 0008 建立
  或更新的函式，函式不存在時會回 5xx；新版司機畫面的同步也改走 trip-execute。
  先部署程式會讓這三個流程在 migration 套用前全部失敗。
- 反過來「舊程式 + 已套用 0008 的資料庫」這段期間，隔離 CI 的
  `compat-old-code` job 用固定發布版本 `6539c75` 的 handler 分別對 0001–0007 與 0001–0008 兩個庫
  跑同一組操作並比對，main 自己的隔離測試也在含 0008 的 schema 上重跑。刻意的
  行為差異只有一項：被指派司機讀得到自己的行程（舊庫讀不到）。

### 0008 會拿哪些鎖、會不會改寫資料表

- 不新增或刪除欄位、不建立索引，不會改寫 `app_state`（CI 以
  `pg_relation_filenode`、欄位、索引、筆數前後比對）。
- 仍會短暫取鎖：`CREATE TRIGGER`（通知完整性）對 `app_state` 取 SHARE ROW EXCLUSIVE；
  `CREATE POLICY`／`DROP POLICY IF EXISTS`（司機讀取、通知收件人讀取兩條）對 `app_state`
  取 ACCESS EXCLUSIVE，`CREATE OR REPLACE VIEW` 對 `app_state_booking_pool`。只改系統目錄，
  本身瞬間完成，但會排在任何還開著、碰過 `app_state` 的交易後面；排隊期間後面所有
  讀寫 `app_state` 的請求都會跟著卡住。所以「離峰」不夠，必須設 `lock_timeout`。
  實際持有的鎖以 CI `migration-0008-deploy` 步驟印出的清單為準。

### 步驟

1. **確認目標庫**：Production 與 Deploy preview／Branch deploy 的 `DATABASE_URL`
   是否同一個庫尚未核實。未核實前不在預覽環境做寫入驗收。
2. **套用前檢查長交易**（有結果就先等它結束或查明原因，不要直接套用）：

   ```sql
   select pid, now() - xact_start as age, state, left(query, 80)
     from pg_stat_activity
    where xact_start < now() - interval '30 seconds' and pid <> pg_backend_pid();
   ```

3. **記錄套用前狀態**（之後比對用）：

   ```sql
   select pg_relation_filenode('app_state'), count(*) from app_state;
   select policyname from pg_policies where tablename = 'app_state' order by 1;
   ```

4. **單一交易 + lock_timeout 套用**。取不到鎖會在逾時後失敗，整份回滾、什麼都
   不留下，等長交易結束後可以直接重試（0008 可重複套用，CI 已實測兩者）：

   ```bash
   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
     -c "set lock_timeout = '3s'" -c "set statement_timeout = '60s'" \
     -c 'begin' -f supabase/migrations/0008_business_flow_endpoints.sql -c 'commit'
   ```

   `MIGRATION_DATABASE_URL` 是有權建立函式與政策的管理連線，不是 Netlify 上
   `care_ride_app` 的 `DATABASE_URL`。若改用 Supabase SQL Editor，要在同一段
   SQL 最前面自己加上 `set lock_timeout = '3s'; begin;`、最後加 `commit;`。

5. **驗證**：第 3 步的 filenode 與筆數不變；`app_state_driver_read`、
   `app_state_notification_recipient_read` 政策、`app_state_guard_notifications` 觸發器、`app.notification_provenance` 表與
   `app.lock_driver_trip`、`app.apply_driver_trip_execution`、
   `app.cancel_app_state_booking` 存在；線上舊版網站登入與載入正常。
6. **部署程式**：`index.html`、`netlify.toml`、`netlify/functions/` 同一次部署。
   main 已開啟 Netlify 自動發布（Codex 已在 Netlify UI 核實）：合併 PR 就等於部署，
   所以必須先完成正式 migration 與第 5 步驗證，並另行取得發布授權後才可合併。
7. **部署後驗收**：三個流程各實際操作一次（調度接案、司機完成停靠點與服務證明、
   需求者取消），並確認沒有 5xx。取消通知目前沒有畫面列表，要以資料庫確認
   `notifications` 有司機與需求者各一列、`status = queued`。

### 通知來源與可見範圍

| 來源 | 產生位置 | 寫入 | 收件人讀得到 |
|---|---|---|---|
| 需求者取消（trip_cancelled、booking_cancelled） | 後端 `app.cancel_app_state_booking` | 是，並寫入來源證明 `app.notification_provenance` | 是（0008 收件人讀取政策比對來源證明上的收件人） |
| 派車建立、行程完成（含服務證明補齊、異常結案自動完成）、中斷、恢復、終止、交接（三種）、路線重排、資源重派 | 前端 `Notification.queue`，經 state-mutate | 是，與舊版相同；沒有來源證明，自帶任何欄位（`source`、`serverCreated`、`created_at`）都不影響 | 否，與舊版相同（只有寫入者本人與行程組織營運方讀得到） |

- 0008 套用前、「0008＋舊程式」、「0008＋新程式」三個狀態下，用戶端寫入、收件人是
  別人的通知，收件人都讀不到（隔離 CI `migration-0008-deploy` 第 6 段與
  `compat-old-code` 實測）。
- **尚未完成的遷移範圍**：要讓前端流程的通知也被收件人讀到，必須把這 11 處改由後端
  流程在對應交易內建立（派車建立、行程完成、中斷、恢復、終止、交接、路線重排、
  資源重派）。本輪未做；現況與舊版相同，沒有退化。

### 部署時的已知行為

- 部署前已在司機裝置離線佇列、由舊版前端產生的行程操作沒有指令快照，新版不會
  補送（舊版送 state-mutate 本來就會被拒）；同一趟行程司機需重新操作。
- 需求者取消產生的通知只寫入 `notifications`（`status = queued`）。三件事分開看：
  - **已排入資料列**：隔離 CI 實測（司機 `trip_cancelled`、需求者 `booking_cancelled`；
    取消失敗、回滾、重試、同時兩次取消都不會多出通知）。
  - **收件人讀得到**：API（state-load）層級實測：需求者讀得到自己的、被指派司機讀得到
    自己的、承接組織調度讀得到司機那則；其他司機、其他組織讀不到。需求者因為是
    資料列擁有者，也讀得到寫給司機的那則。**前端目前沒有通知列表畫面**，所以使用者
    在畫面上看不到通知內容（版本庫靜態推導）。
  - **已送出**：版本庫內未找到讀取這些資料列並對外發送的程式；正式 Supabase 是否有
    版本庫外的 trigger、webhook 或排程會處理 `notifications`，尚未核實。

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

### 回復

隔離 CI `compat-old-code` 以「0001–0008 → 移除 0008 並重新套用 0007」建庫後，
實際以固定舊版 `6539c75` 的 handler 重跑相容性比對，結果必須與從未套用 0008 的庫
完全相同。

- **只回復程式**：部署回前一版即可，0008 可以留著（見上方相容性比對）。
- **移除 0008**：先回復程式（新前端與新端點依賴 0008），再在單一交易內執行移除
  SQL 並重新套用 0007（還原接案函式與 10 欄的需求池 view）：

  ```bash
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "set lock_timeout = '3s'" -c 'begin' \
    -f supabase/rollback/0008_business_flow_endpoints.down.sql \
    -f supabase/migrations/0007_app_state.sql -c 'commit'
  ```

  隔離 CI 的 `migration-0008-deploy` 第 5 段以同一組指令演練：0008 的政策與函式
  全部移除、需求池 view 回到 10 欄、`app_state` 不改寫，之後可再次套用 0008。
  已由 0008 寫入的行程事件、異常、通知資料列不會被刪除；舊程式仍可讀寫這些資料列。
  回復後收件人讀取政策與通知觸發器都已移除，後端通知回到舊版的可見範圍；通知來源證明
  `app.notification_provenance` 保留。回復期間沒有觸發器，資料列擁有者或營運方可以改動
  通知內容或收件人；來源證明記錄了建立時的內容雜湊，再套用 0008 後，**被改動過的通知
  不會恢復可讀**，未被改動的才恢復（隔離 CI 實測：以原本有權修改的 care_ride_app 使用者
  在回復期間改內容與收件人）。

## 8. migration 0009（需求者看得到承接單位名稱）部署順序

0009 尚未部署。正式資料庫執行 SQL 與部署都需另行取得同意。

- **內容**：只新增 security definer 函式 `app.my_booking_service_orgs()`，回傳目前使用者
  擁有、未刪除、已綁定承接組織的預約所對應組織的 id 與名稱。不改資料表、政策或既有函式，
  不取資料表的強鎖；不放寬 `organizations` 讀取政策。
- **順序**：先套用 0009，再部署程式。新版 `v2-state-load` 以 savepoint 呼叫這個函式；函式
  尚未存在時（SQLSTATE 42883）回傳空清單，需求者畫面暫時顯示「尚未指定承接單位」，不會讓
  整個載入失敗。舊版程式不呼叫這個函式（隔離 CI `compat-old-code` 以含 0009 的庫比對）。
- **套用**：

  ```bash
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "set lock_timeout = '3s'" -c 'begin' \
    -f supabase/migrations/0009_requester_booking_service_orgs.sql -c 'commit'
  ```

- **驗證**：函式存在且 `care_ride_app` 有 EXECUTE；需求者載入後已接案預約顯示承接單位名稱。
- **回復**：先回復程式或直接移除函式皆可（新版程式在函式不存在時退回空清單）：

  ```bash
  psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "set lock_timeout = '3s'" -c 'begin' \
    -f supabase/rollback/0009_requester_booking_service_orgs.down.sql -c 'commit'
  ```

  若同時要回復 0008，先移除 0009 再依第 7 節回復 0008。
