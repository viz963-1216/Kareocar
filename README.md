# 安心接送

長照接送媒合平台。Netlify 提供前端與 API（Netlify Functions），資料、身分與授權都在 Postgres（Supabase），由 RLS 把關。

- 目前版本：`12.26.1`
- 展示網站：https://care-ride-commercial-readiness.netlify.app
- 私有原始碼：https://github.com/viz963-1216/care-ride-commercial-readiness

## 架構

```
瀏覽器 (index.html)
   │  只走 /api/*，帶 Bearer session token
   ▼
Netlify Functions
   │  驗證 session，以 care_ride_app 角色連線
   ▼
Postgres（Supabase）           ← RLS 政策做 row-level 授權
```

瀏覽器不直接連資料庫，也沒有內建資料快照；未登入時讀不到任何資料。

## 開發

```bash
# 需要本機 Postgres 16
PGHOST=/tmp/pgrun PGPORT=5433 supabase/tests/run-all.sh   # 全套接線與 RLS 測試
npm test                                                  # 離線回歸測試（不需要資料庫）
node tools/check-inline-js.js    # js/*.js 語法檢查；index.html 不得有內嵌 script 或 inline 事件處理器
node tools/check-dom-refs.js     # DOM id 交叉檢查
node tools/check-id-mapping.js   # 後端／前端識別碼對應（權限會壞在這裡）
```

`supabase/tests/run-all.sh` 會從乾淨的資料庫依序跑完所有測試套件。它跑的是
`netlify/functions/` 底下的實際程式碼，接在真實 Postgres 上、以真實的
`care_ride_app` 角色連線，所以 RLS 是真的在把關，不是模擬的。

`tests/` 是不需要資料庫的離線測試：建置檢查、行程執行規則、前端接線等。

## 資料庫

執行中的系統跑在 **Postgres（Supabase）** 上：身分、預約、行程、稽核全部在
`supabase/migrations/` 定義的 schema 與 RLS 政策之下。

套用步驟與注意事項見 [supabase/README.md](supabase/README.md)。最重要的一點：
Netlify Function 必須用 `care_ride_app` 角色連線，用 `postgres` 會繞過全部 RLS 政策。

## 部署

見 [DEPLOYMENT.md](DEPLOYMENT.md)。`index.html`、`netlify/functions/` 與
`supabase/migrations/` 必須一起更新——只換其中一個會造成前後端契約不一致。

## 版本紀錄

### 12.26.0 — 商用化強化

移除全部 demo 程式碼，並修正 7 項安全問題。詳見 [SECURITY_HARDENING.md](SECURITY_HARDENING.md)。

- AppState 的寫入授權改為以伺服器端既有狀態判斷，不再採信請求內容宣稱的擁有者
- 密碼改用迭代雜湊（可調整成本），舊憑證於下次登入自動升級
- 忘記密碼的驗證碼改用密碼學安全亂數，並加上索取節流
- 變更密碼或登入手機需通過目前密碼驗證
- 登入鎖定改為會自動解除的軟鎖，並加入來源 IP 維度
- 移除內建 demo 帳密、90KB 假資料快照、瀏覽器直讀公開試算表的備援路徑

### 12.26.1 — 容量與併發

- 密碼憑證改存專用工作表（原本在 Script Properties，約 885 人就會撞到 500KB 上限）
- 速率限制等暫時狀態改用 CacheService，不再永久累積
- AppState 批次寫入改為單次讀入／單次寫回：50 筆變更的全表讀取從 132 次降到 4 次
- 批次寫入具備原子性，中途失敗不會留下寫到一半的資料
- 登入與簡訊發送不再抓全域鎖
- 稽核寫入失敗不再靜默，`/api/health` 會回報 `auditWriteFailures`

### 12.25.x

早期版本開發紀錄，歷史細節請參閱 git commit log。

## 正式對外前仍待處理

以下項目不在 12.26.0 的範圍內，上線前應逐項確認，詳細說明見 SECURITY_HARDENING.md 的「尚未處理」章節。

1. ~~Apps Script 專案中有 6 支函式尚未納入版本控制~~：Apps Script 已整個移除，不再適用。
2. ~~`index.html` 仍是單一檔案且 CSP 帶 `'unsafe-inline'`；session token 存在 `sessionStorage`~~：JS 已拆到 `js/`，`script-src` 不再允許 `'unsafe-inline'`（#14）；登入改由 Supabase Auth，token 只在 HttpOnly cookie（#18）。
3. 一次資料同步仍是 23 個獨立請求，各自重算一次權限範圍（批次寫入已優化，讀取路徑尚未）。
4. 「從已發布試算表匯入預約」功能仍由瀏覽器直接讀取公開試算表。
5. 沒有監控與告警：後端開始出錯時不會有人知道。
6. 個資告知、服務條款、資料保存與刪除流程、備份與資安測試。
