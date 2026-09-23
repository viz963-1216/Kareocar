# V12.26.0 — 商用化強化紀錄

這一輪做兩件事：**移除所有 demo 程式碼**，以及**修正 7 項安全問題**。

所有修正都有對應的自動化測試（`npm test`，共 44 項）。授權漏洞另外做了控制組驗證：同一組攻擊腳本在修正前確實成功，修正後被擋下。

---

## 一、已修正的安全問題

### 1. AppState 寫入授權採信了請求內容（嚴重）

`apps-script/AppStateApi.gs`

**原本**：判斷「這筆資料屬於誰」時，優先讀請求內容裡的 `record.requestedByUserId`、`record.userId`、`record.governance.createdByUserId`，資料庫既有值只是 fallback。而授權判斷是 `owner === ctx.userId`。

任何登入帳號只要把自己的 userId 填進請求，就能通過授權並覆寫他人的預約。

**現在**：擁有者與所屬組織一律依序從伺服器端解析——先看既有的「應用狀態」列，再看正規化工作表，兩者都沒有才視為新建，而新建時擁有者由伺服器指派為操作者本人。請求內容中的欄位只當作指標（「這筆事件屬於預約 X」），不再當作權限證明。

公開需求池的承接流程有特別保留：未承接的案件仍可被接走，但只能接進操作者實際隸屬的組織，而且伺服器端狀態必須確實還是 `open`。

**驗證**（`tests/appstate-authz.test.js`）：

| 攻擊 | 修正前 | 修正後 |
|---|---|---|
| 覆寫他人已承接的預約 | 成功 | 擋下 |
| 覆寫他人的公開待媒合預約 | 成功 | 擋下 |
| 冒充成為他人服務對象的關係人 | 成功 | 擋下 |
| 把自己加進別家公司當負責人 | 原本已擋 | 擋下 |

同時驗證正常功能未受影響：本人可改自己的預約、需求者可建立新預約、調度員可承接公開案件與管理自家行程。

### 2. 密碼雜湊只有單輪 HMAC（嚴重）

`apps-script/AuthCore.gs`

**原本**：`HMAC-SHA256(salt + "|" + password, pepper)`，單輪、無 key stretching。

**現在**：改用 PBKDF2 的 F 函式（迭代 HMAC + XOR 累加），迭代次數由 `AUTH_PBKDF2_ITERATIONS` 這個 Script Property 控制，預設 6000。每組憑證會記錄自己的迭代次數，因此**調高成本不會讓既有帳號無法登入**。

舊的 v1 憑證仍可驗證，並在下次成功登入時自動改寫為 v2——不需要要求任何使用者重設密碼。

> 一個刻意的設計差異：HMAC 的 key 是 pepper、訊息是 salt|password，與教科書 PBKDF2 相反。這保留了 peppering 的性質（沒有 pepper 連算都算不了），同時完整保留 stretching 成本。

**部署後請執行一次** `authBenchmarkPbkdf2_()`，把單次驗證調到 200–500ms 之間。

### 3. 忘記密碼的驗證碼使用 Math.random()（高）

**原本**：`Math.floor(100000 + Math.random() * 900000)`。`Math.random()` 可預測，而這是帳號接管路徑上唯一的憑證。

**現在**：改為對兩個 `Utilities.getUuid()`（SecureRandom 支援）取 SHA-256 後導出。驗證碼錯誤次數上限也從 5 次收到 3 次。

### 4. 忘記密碼端點無節流（高）

**原本**：沒有任何限制，每次呼叫都實際發一則簡訊。知道手機號碼的人可以無限灌簡訊，對營運方是直接的費用損失。

**現在**：同一手機 60 秒內只能索取一次、一小時內最多 5 次。未過期的驗證碼會直接沿用並回報剩餘時間——使用者重按「重新發送」不會被擋、也不會多花一則簡訊。

### 5. 變更密碼不需要舊密碼（高）

`apps-script/IdentityApi.gs`、`index.html`

**原本**：只驗 session token 就能改密碼，也能把登入手機換成任意號碼。session token 一旦外洩即等於永久失去帳號。

**現在**：變更密碼或登入手機時必須通過目前密碼驗證。前端表單已同步新增「目前密碼」欄位。社群登入帳號沒有密碼憑證，這類帳號維持以 session token 為唯一憑證。

### 6. 登入鎖定可被用來永久鎖死他人帳號（高）

**原本**：累積 10 次失敗會設定永不自動解除的 `resetRequired`。任何知道對方手機號碼的人，連打 10 次就能讓對方無法登入，且必須收簡訊重設才能恢復。

**現在**：改為會自動解除的階梯式軟鎖（5 次→3 分鐘，10 次→30 分鐘，20 次→60 分鐘，上限 60 分鐘），並加入來源 IP 維度以阻擋跨帳號撞庫（同一 IP 30 次失敗→鎖 30 分鐘）。Netlify Function 透過 `x-nf-client-connection-ip` 轉送來源 IP。

### 7. 錯誤訊息洩漏內部結構（低）

`apps-script/WebApp.gs`：只有帶 `code` 的預期錯誤才把訊息回傳給前端，其餘一律回通用訊息加 `requestId`，詳細內容寫入 Logger。

---

## 二、移除的 demo 程式碼

`index.html` 從 1,335 KB 降到 1,144 KB（減少 191 KB，14%）。

| 項目 | 說明 |
|---|---|
| 內建 super_admin 帳密 | `0999999999` / `123456` 曾直接寫在 `seedDB()` |
| 登入頁 demo 帳號清單 | 四組角色帳號與共用密碼的說明區塊 |
| 90 KB 內建資料快照 | `GOOGLE_DB_EMBEDDED_TABLES`，22 張表的合成測試資料 |
| Demo 資料產生器 | 531 行，會把所有使用者密碼設成 `123456` |
| 直讀公開試算表的備援 | `fetchGoogleSheetCsv` / `fetchGoogleSheetJsonp` 與 gviz 端點 |
| 預覽模式分支 | 40 餘處 `previewSafe || demo` 條件，全部收斂為正式路徑 |
| 測試資料清理 UI | `clearDemoDataKeepCurrentSuperAdmin` 與對應按鈕 |
| 預覽開機橫幅 | `previewSafeBootNote` |

因為正式環境本來就把兩個旗標設為 false，這些分支在線上從未執行——移除它們對正式行為沒有影響，只是不再把模擬身分與預設密碼打包進公開的 bundle。

讀取資料現在一律要求已登入的 session，沒有任何離線或預覽的例外路徑。

---

## 三、尚未處理

這些不在本輪範圍內，但正式對外前應逐項處理。

### 1. Apps Script 有 6 支函式未納入版本控制

`getSpreadsheet_`、`readTable_`、`writeAudit_`、`requireConfig_`、`createBooking_`、`updateBooking_` 被呼叫但不在 repo 內。

影響：**repo 目前不是完整的後端來源**，Apps Script 專案若出問題無法從 GitHub 復原。也因為看不到 `readTable_` 是否有快取，下面第 3 點的實際嚴重程度無法評估。

建議：把 Apps Script 專案剩下的 `.gs` 檔補進 `apps-script/`，長期改用 [clasp](https://github.com/google/clasp) 做雙向同步。

### 2. 前端單檔與 XSS 風險面

`index.html` 仍是單一檔案，CSP 因此必須帶 `'unsafe-inline'`；session token 存在 `sessionStorage`，JavaScript 讀得到。

建議順序：把內嵌 JS 拆成獨立檔案 → 移除 `'unsafe-inline'` → session 改為 `HttpOnly; Secure; SameSite=Strict` cookie 由 Netlify Function 設定。另外 `href="tel:${...}"` 這類屬性插值仍未跳脫。

### 3. 效能結構問題

- 批次寫入時每筆變更都重讀整張「應用狀態」工作表：200 筆上限 ≈ 400 次全表讀 + 200 次單列寫，Netlify 端 12 秒逾時會固定觸發。
- 一次同步 23 張表 = 23 個獨立請求，每個都重算一次權限範圍（各讀 7 張表），單次刷新約 180 次全表讀。

建議：批次操作改為「單次讀入 + Map 索引 + 單次 setValues 寫回」；新增 `POST /database/tables` 批次端點，只算一次授權範圍後一併回傳。

### 4. 從已發布試算表匯入預約

`syncFromPublishedSheet` 仍由瀏覽器直接讀取公開的 Google 試算表 CSV。這是既有功能而非 demo 備援，因此本輪保留未動，但它意味著該試算表對任何取得網址的人都是可讀的。**請確認該試算表內是否含有個資**；若有，應改為由後端代理讀取，並把試算表改為非公開。這也是 CSP 的 `connect-src` 目前仍需保留 `https://docs.google.com` 的唯一原因。

### 5. 法遵與營運

個資告知、服務條款、資料保存與刪除流程、備份與還原演練、資安測試。這些需要法律專業協助，不是程式碼層面能完成的。

---

## 四、部署注意事項

1. **必須整包部署**，Apps Script 與 Netlify 一起更新。本輪改了前後端契約（`/identity/update-account` 新增 `currentPassword`、gateway envelope 新增 `clientIp`）。
2. Apps Script 新增一個選用的 Script Property：`AUTH_PBKDF2_ITERATIONS`（預設 6000）。部署後執行一次 `authBenchmarkPbkdf2_()` 決定數值。
3. 根目錄原本重複的 `AuthCore.gs` 已刪除，唯一來源是 `apps-script/AuthCore.gs`。
4. `package.json` 移除了 `"type": "module"`（與 CommonJS 的 Netlify Function 衝突）與未使用的 `google-auth-library`。
5. 既有使用者的密碼不需要重設，會在下次登入時自動升級雜湊。
