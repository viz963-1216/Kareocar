# Supabase — schema 與 RLS

原本 Google Sheet 的 22 張工作表在 Postgres 的對應版本，加上取代手寫授權的 Row Level Security 政策。

**目前狀態**：schema 與 RLS 完成（31 項測試），「登入 + 讀預約」已接線並通過 18 項端到端測試。其餘路徑仍走 Apps Script，兩套並存，前端可逐條切換。

## 檔案

| 檔案 | 內容 |
|---|---|
| `migrations/0001_baseline.sql` | 完整 schema：資料表、RLS 政策、`care_ride_app` 角色、身分與登入函式、`app_state`、接案／司機執行／需求者取消、通知來源證明。由原本的 0001–0008 壓縮而成 |
| `migrations/0002_supabase_auth.sql` | 身分改由 Supabase Auth：移除自製密碼、`sessions_valid_after` 撤銷 session |
| `migrations/0003_org_review.sql` | 機構申請與審核：`review_status`（pending／approved／rejected／suspended）、`app.apply_organization`、`app.review_organization`；需求池與接案只開放給已核准機構 |
| `migrations/0009_benefit_ledger.sql` | 正式核定額度 `benefit_authorizations` 與僅追加帳本 `benefit_ledger`：建立預約保留、取消／不受理／過期釋放、完成結算、修正回轉；只能經受控函式寫入 |
| `migrations/0008_benefit_rulesets.sql` | 補助規則版本 `benefit_rulesets`（draft／approved／superseded／rejected，同一 program code 只有一個 approved）與伺服器試算；只能經受控函式寫入 |
| `migrations/0007_server_notifications.sql` | 通知改存 `notifications` 資料表，只有後端函式（`app.enqueue_notification`、`app.notify_booking_requester`）寫得進去；收件人只讀得到自己的通知 |
| `migrations/0006_trip_resource_scope.sql` | `app.trip_resource_scope`：行程寫入時查司機、車輛、預約歸屬哪個機構（只回傳歸屬與狀態） |
| `migrations/0005_booking_access_revoke.sql` | 退回公開池、不受理、重大修改需重新承接、需求者取消後，原承接機構立即失去預約存取（`app.revoke_booking_organization`）；取消的行程移除乘客個資；需求者只看得到承接單位名稱（`app.my_booking_service_organizations`） |
| `migrations/0004_pool_fuzzy_address.sql` | 需求池多露出伺服器計算的模糊地址、行政區、距離、車程與報價狀態（來自預約的 `serverComputed`）；完整地址、姓名、電話、經緯度仍不露出 |
| `rollback/0001_baseline.down.sql` | 回復 baseline（刪除所有資料表與資料；只用在空資料庫或 Staging 重建） |
| `migrations_archive/` | 原本的 0001–0008，只供查閱，不再套用 |
| `tests/migrations.test.sh` | 回復檔齊全、上→下→上 schema 相同、司機政策執行計畫、通知觸發器 |
| `tests/seed.sql` | 測試資料 |
| `tests/rls.test.sh` | 31 項 RLS 驗證，含攻擊模擬 |
| `tests/wiring.test.js` | 18 項端到端測試：Function 實際程式碼跑在真實 Postgres 上 |
| `tests/pg-psql-shim.js` | 測試用的 pg 替身（以 psql 當傳輸層）；正式環境不使用 |

## 套用到你的 Supabase

在空的資料庫依檔名順序套用 `migrations/*.sql`（目前只有 `0001_baseline.sql`）。正式與 Staging 由 migration 的 CI 部署流程套用；手動在 **SQL Editor** 貼上只用在一次性的空資料庫。

### 接著一定要做的兩件事

**1. 給 `care_ride_app` 設密碼**

baseline 建立了這個角色但沒有密碼。在 SQL Editor 執行（密碼自己產一組長的，不要用這裡的範例字串）：

```sql
alter role care_ride_app with password '換成你自己產生的長密碼';
```

**2. 連線字串要用這個角色**

在 Supabase 主控台上方點 **Connect**，選 **Transaction pooler**（port 6543，適合
Netlify Function 這種短生命週期的連線）。它給你的字串長這樣：

```
postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
                     ~~~~~~~~~~~~~~~~
                     這串是你的 project ref
```

⚠️ **pooler 的使用者名稱是「角色.專案ref」的形式**，所以要換的是前半段：

```
postgresql://care_ride_app.abcdefghijklmnop:<你設的密碼>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
             ~~~~~~~~~~~~~ 只換這裡        ~~~~~~~~~~~~ 專案 ref 保持原樣
```

密碼裡若含 `@ : / ?` 等字元要做 URL encode，否則字串會被解析錯。

放進 Netlify 的環境變數 `DATABASE_URL`。不要寫進任何檔案，不要進 git。

`_db.js` 啟動時會檢查角色名稱，`postgres` 與 `supabase_admin`（含帶 project ref 的
形式）都會被拒絕。

## ⚠️ 為什麼一定要換掉 postgres

Postgres 的資料表擁有者**預設會繞過所有 RLS 政策**。用 `postgres` 連線的話，上面 55 條政策一條都不會生效——每個使用者都看得到全部資料，而且不會有任何錯誤訊息告訴你。

測試裡有一項就是在證明這件事：

```
PASS  postgres 身分看得到所有預約（這就是不能用它連線的原因）
PASS  care_ride_app 身分同一個查詢只看得到 0 筆
```

同一個查詢、同一份資料，差別只在連線角色。這是整個設計最容易出錯、後果也最嚴重的一個點。

## 應用程式怎麼帶入身分

RLS 靠 `app.user_id` 這個連線設定判斷「現在是誰」。每筆交易開頭設定一次：

```js
await client.query('BEGIN');
await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
//                                                        ↑ true = 只在這筆交易內有效
const { rows } = await client.query('SELECT * FROM bookings');   // RLS 自動過濾
await client.query('COMMIT');
```

第三個參數 `true` 很重要：它讓設定隨交易結束而消失。用 `false` 的話，在連線池裡這個身分會殘留到下一個借到同一條連線的請求上——那是一個很難察覺的跨使用者資料外洩。

身分驗證本身維持現在的手機＋密碼流程（`AuthCore.gs` 那套已經硬化並有 65 項測試），Netlify Function 驗證通過後把 user id 放進上面這個設定即可。

## 本機測試

不需要連到 Supabase，本機起一個 Postgres 就能跑：

```bash
initdb -D /tmp/pgdata -U postgres --auth=trust
pg_ctl -D /tmp/pgdata -o "-p 5433 -k /tmp/pgrun" -l /tmp/pg.log start
createdb -h /tmp/pgrun -p 5433 -U postgres careride

for f in supabase/migrations/*.sql; do
  psql -h /tmp/pgrun -p 5433 -U postgres -d careride -v ON_ERROR_STOP=1 -f "$f"
done
psql -h /tmp/pgrun -p 5433 -U postgres -d careride -f supabase/tests/seed.sql

PGHOST=/tmp/pgrun PGPORT=5433 bash supabase/tests/rls.test.sh
```

## 設計上的幾個決定

**欄位改用英文 snake_case。** 前端的資料模型（`bookings`、`requestedByUserId`…）本來就是英文，只有 Sheet 那層是中文，所以這樣反而少一層翻譯。

**每張主要表有一個 `data jsonb`。** 原本 AppState 的 JSON 比正規化的 Sheet 欄位豐富（`legs`、`commercialSnapshots`、`cancellation`…），這些放進 `data`；需要查詢或授權用到的才升格成正式欄位。不會掉資料。

**「應用狀態」覆蓋層不再需要。** 它存在是因為 Sheet 沒辦法好好更新一列。Postgres 直接 UPDATE 就好，版本控制交給 `version` / `revision` 欄位加上真正的交易。這會讓 `AppStateApi.gs` 那 400 多行在接線完成後整個消失。

**公開需求池改成 view。** 原本是把整列讀出來再用程式把姓名電話清掉——那是「先拿到再遮蔽」。現在 `public_booking_pool` 這個 view 從一開始就只選得到已模糊化的欄位，資料庫層面就沒有門牌號碼可以外洩。

**承接改用 `app.claim_booking()`。** `SELECT ... FOR UPDATE` 讓資料庫處理競爭，取代原本的「版本號比對 + 全域鎖」。兩個調度員同搶一張單時，後到的一定會收到「已被其他服務單位接走」。

## 已接線的路徑

| 路由 | Function | 取代 |
|---|---|---|
| `POST /api/v2/password-login` | `v2-password-login.js` | Apps Script 的 `passwordLogin_` |
| `GET /api/v2/bookings` | `v2-bookings.js` | `databaseFilterRows_` 對 bookings 的那一段 |

`?pool=1` 讀公開需求池。舊的 `/api/*` 路由完全沒動，兩套可以並存。

需要的 Netlify 環境變數：

| 變數 | 用途 | 機密 |
|---|---|---|
| `DATABASE_URL` | `care_ride_app` 角色的連線字串 | 是 |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | 否 |
| `SUPABASE_ANON_KEY` | 公開金鑰（anon 或 `sb_publishable_…`），密碼登入與換 token 用 | 否 |
| `SUPABASE_SERVICE_ROLE_KEY` | 秘密金鑰（service_role 或 `sb_secret_…`），建立、更新使用者用 | **是** |
| `SUPABASE_JWT_SECRET` | 選用。舊版 HS256 簽章金鑰；新版專案用非對稱金鑰，會自動從 JWKS 取公鑰 | 是 |
| `AUTH_SESSION_SECRET` | 速率限制鍵的 HMAC 金鑰（名稱沿用） | 是 |
| `AUTH_PASSWORD_PEPPER` | 忘記密碼驗證碼的雜湊 pepper | 是 |
| `PRODUCTION_SUPABASE_PROJECT_REF` | 正式專案 ref，建置檢查用 | 否 |
| `GOOGLE_MAPS_API_KEY` | Google Maps 金鑰（要開 Geocoding API 與 Routes API）。建立預約或改地址時定位、算距離；沒設定時建立預約會回 503 | 是 |

### 預約寫入（/api/v2/booking-write）

預約不再經 `state-mutate` 寫入（回 `COLLECTION_FORBIDDEN`），改走 `v2-booking-write`，規則在
`netlify/functions/_booking-rules.js`：

- 需求者：只能建立公開待接的預約；公開中可修改或過期；已承接時可修改，重大修改會回到公開池
- 承接機構的負責人、調度員：已承接 → 排車、退回公開池、不受理
- 進入排車後，需求者不能改時間與地址
- 接案走 `claim-booking`、取消走 `cancel-booking`；預約不能刪除
- 需求者、承接人、取消紀錄等欄位一律沿用資料庫的值

退回公開池、不受理、重大修改時，同一交易內撤銷原承接機構，原機構立即讀不到。

### 長照交通補助（#23）

- 規則版本由平台超級管理者經 `/api/v2/benefit-ruleset` 建立草稿、核准或駁回。核准新版本時，
  同一 program code 原本的 approved 自動變成 superseded；資料庫的部分唯一索引保證只有一個 approved。
- 補助試算經 `/api/v2/benefit-assess`，伺服器依目前 approved 版本計算並記錄版本 ID。
- 建立預約、改日期或改服務對象時，`booking-write` 用服務對象最近一次試算的資料（不是金額）依預約
  日期重新估算，存在 `serverComputed.benefit`。前端送來的補助金額一律換成伺服器的結果。
- 規則與試算不再接受 `state-mutate` 寫入。
- 正式核定額度經 `/api/v2/benefit-authorization` 登錄、調整、撤銷：平台超級管理者，或正在服務這位服務對象的
  機構負責人／調度員（該機構有他的預約）。核定文號必填。
- 帳本（`benefit_ledger`，僅追加）由各流程在同一交易內寫入，金額取自預約的伺服器估算：

  | 事件 | 帳本 | 端點 |
  |---|---|---|
  | 建立預約、改日期重新估算 | 保留（不超過可用額度） | booking-write |
  | 需求者取消 | 釋放 | cancel-booking |
  | 不受理、過期 | 釋放 | booking-write |
  | 行程完成 | 保留轉為已結算 | trip-execute |
  | 完成後修正 | 結算回轉為保留 | trip-execute |

  同一個核定以 `FOR UPDATE` 鎖住，同時建立的預約不會超出可用額度。

### 通知

通知只由後端流程建立，存在 `notifications` 資料表（`care_ride_app` 只有 SELECT），收件人只讀得到自己的：

| 事件 | 產生的地方 | 收件人 |
|---|---|---|
| 承接 `booking_claimed` | `claim-booking` | 需求者（帶承接單位名稱） |
| 排車 `booking_scheduled` | `booking-write` | 需求者 |
| 指派、改派 `trip_assigned`／`trip_unassigned` | `trip-write` | 新、舊司機 |
| 調度取消行程 `trip_cancelled` | `trip-write` | 司機 |
| 需求者取消 `booking_cancelled`、`trip_cancelled` | `cancel-booking` | 需求者、司機 |
| 完成 `trip_completed` | `trip-execute` | 需求者 |

每則通知有 `dedupe_key`，同一事件重試不會重複。目前只寫入站內（`channel = in_app`、`status = queued`），
簡訊或 LINE 推送在 #19 接上。

### 行程寫入（/api/v2/trip-write）

調度端建立、改派、中斷、取消行程走 `v2-trip-write`（規則在 `_trip-rules.js`）；司機執行自己的
行程走 `v2-trip-execute`。行程與取消紀錄都不再接受從 `state-mutate` 寫入。

- 只有行程機構的負責人、調度員可以寫；行程的機構建立後不能改
- 新行程一律從 `scheduled` 開始；狀態照轉換表走，已開始的行程不能取消（請用中斷）
- 指派的司機、車輛、新關聯的預約都必須屬於行程的機構
- 行程不能刪除；用 revision 做樂觀鎖

### 預約的伺服器計算欄位（serverComputed）

建立預約或改了上下車地址時，`v2-state-mutate` 用 Google 定位兩個地址並算路線，把結果
寫進預約的 `serverComputed`（模糊地址、行政區、經緯度、距離、車程、報價狀態）。前端送來
的 `serverComputed` 與報價金額一律被覆蓋；地址找不到回 400 `ADDRESS_NOT_FOUND`（`field`
指出是哪個地址），整批不寫入。地址沒改就沿用原本的結果，不重複呼叫 Google。

平台目前不訂車資，報價固定是 `pricing_pending`、沒有金額。送出前前端會先呼叫
`/api/v2/geocode-check` 提示地址問題，這支不保存任何東西。

### 身分驗證（Supabase Auth）

密碼、token 簽發與撤銷由 Supabase Auth 負責，資料庫不保存任何密碼。Netlify Function
驗證 access token（JWT）後，以 token 的 `sub` 作為 `app.user_id`，RLS 照常生效；
`users.id` 就是 Supabase Auth 的使用者 ID。token 只放在 HttpOnly cookie（`cr_at`、
`cr_rt`），瀏覽器的 JavaScript 讀不到。

Supabase 主控台要設定的：**Authentication → Sign In / Providers → Phone** 啟用（簡訊廠商
在 #19 接上）。

**建立超級管理者**（取代原本的 bootstrap 端點）：

1. 在 **Authentication → Users → Add user** 以手機號碼（+8869…）與密碼建立帳號，勾選自動確認，
   複製它的 User UID。
2. 在 SQL Editor 建立對應的使用者列（`guard_user_insert` 只擋應用角色，SQL Editor 可以建）：

   ```sql
   insert into users (id, display_name, phone_e164, platform_role, auth_provider, auth_subject_id, active)
   values ('<User UID>', '平台超級管理者', '+8869xxxxxxxx', 'super_admin', 'supabase', '<User UID>', true);
   ```

`PRODUCTION_SUPABASE_PROJECT_REF` 是正式 Supabase 專案的 ref（主控台網址
`/project/<ref>` 那一段），不是機密，所有 deploy context 設同一個值。建置檢查
用它擋下「非 production 的建置連到正式資料庫」：pooler 連線比對使用者名後綴
（`care_ride_app.<ref>`），直連比對主機名（`db.<ref>.supabase.co`）。非 production
context 沒設定這個變數時，建置會失敗，因為無從判斷。

## 已知還沒處理

- **前端還沒改**：仍呼叫舊的 `/api/*`；v2 路由已可用但沒有人打
- **其餘路徑未接線**：註冊、忘記密碼、寫入預約與行程都還在 Apps Script
- **沒有資料遷移腳本**：這次是乾淨開始，沒有搬舊資料
- **`kpi_daily` 的主鍵包含 `driver_id`**，因此組織層級（沒有司機）的彙總列需要一個代表「全組織」的 driver_id，接線時要決定怎麼處理
- **稽核紀錄目前允許任何登入者新增**（`audit_insert with check (true)`），因為寫入者就是應用程式本身；若之後要更嚴格，可改為只允許 security definer 函式寫入
