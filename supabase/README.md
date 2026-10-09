# Supabase：schema、RLS、API 與業務規則

Postgres（Supabase）是唯一的真實資料來源。這份文件說明 migration、`care_ride_app` 連線角色、
API 端點與各項業務規則。部署流程與上線檢查清單見 [DEPLOYMENT.md](../DEPLOYMENT.md)。

## 檔案

| 檔案 | 內容 |
|---|---|
| `migrations/0001_baseline.sql` | 完整 schema：資料表、RLS 政策、`care_ride_app` 角色、身分與登入函式、`app_state`、接案／司機執行／需求者取消、通知來源證明。由原本的 0001–0008 壓縮而成 |
| `migrations/0002_supabase_auth.sql` | 身分改由 Supabase Auth：移除自製密碼、`sessions_valid_after` 撤銷 session |
| `migrations/0003_org_review.sql` | 機構申請與審核：`review_status`（pending／approved／rejected／suspended）、`app.apply_organization`、`app.review_organization`；需求池與接案只開放給已核准機構 |
| `migrations/0004_pool_fuzzy_address.sql` | 需求池多露出伺服器計算的模糊地址、行政區、距離、車程與報價狀態（來自預約的 `serverComputed`）；完整地址、姓名、電話、經緯度仍不露出 |
| `migrations/0005_booking_access_revoke.sql` | 退回公開池、不受理、重大修改需重新承接、需求者取消後，原承接機構立即失去預約存取（`app.revoke_booking_organization`）；取消的行程移除乘客個資；需求者只看得到承接單位名稱（`app.my_booking_service_organizations`） |
| `migrations/0006_trip_resource_scope.sql` | `app.trip_resource_scope`：行程寫入時查司機、車輛、預約歸屬哪個機構（只回傳歸屬與狀態） |
| `migrations/0007_server_notifications.sql` | 通知改存 `notifications` 資料表，只有後端函式（`app.enqueue_notification`、`app.notify_booking_requester`）寫得進去；收件人只讀得到自己的通知 |
| `migrations/0008_benefit_rulesets.sql` | 補助規則版本 `benefit_rulesets`（draft／approved／superseded／rejected，同一 program code 只有一個 approved）與伺服器試算；只能經受控函式寫入 |
| `migrations/0009_benefit_ledger.sql` | 正式核定額度 `benefit_authorizations` 與僅追加帳本 `benefit_ledger`：建立預約保留、取消／不受理／過期釋放、完成結算、修正回轉；只能經受控函式寫入 |
| `migrations/0010_consent_retention.sql` | 平台設定 `app_settings`（保存期限、條款版本）、同意紀錄 `consent_records`、到期資料匿名化 `app.anonymize_expired_records` |
| `migrations/0011_account_deletion.sql` | 刪除帳號與個資申請 `deletion_requests`（pending／cancelled／rejected／completed）；平台管理者核准時在同一交易內匿名化與停用帳號 |
| `migrations/0012_benefit_fetch.sql` | 福利公告抓取紀錄 `benefit_source_fetches`、自動抓取草稿（origin、內容雜湊、差異）；自動草稿不能手動修改 |
| `migrations/0013_admin_password_reset.sql` | 後台重設密碼的權限判斷 `app.password_reset_target`：平台管理者可重設自己以外的任何人；負責人只能重設工作身分全在自己機構的調度員、司機 |
| `migrations/0014_social_logins.sql` | 社群登入對應 `social_logins`（社群帳號 → 使用者）、綁定／解除／刪除帳號時清除的受控函式、Supabase 的 Custom Access Token Hook（`public.custom_access_token_hook`，加上 `app_user_id`） |
| `migrations/0015_public_settings.sql` | 登入方式開關 `login_methods`、客服聯絡 `support_contact`（`app_settings`），未登入可讀的 `app.public_settings()` |
| `migrations/0016_anonymize_completeness.sql` | 匿名化補齊：預約修改紀錄的快照、服務證明的自由文字與操作收據、行程的地點座標與執行快照、事件紀錄、所有預約都過期（或從沒預約、建立超過期限）的服務對象；核准刪除帳號每筆寫稽核紀錄 |
| `migrations/0017_requester_hub_name.sql` | 系統機構 ORG-REQ-001 改名「需求者群組」（畫面用語統一，#83） |
| `migrations/0018_anonymize_remaining.sql` | 匿名化補齊（#89）：預約去程／回程的地點只留縣市與行政區、執行快照的司機只留 ID、預約與行程的通知內容、到期服務對象的補助試算資料 |
| `migrations/0019_keep_active_recipients.sql` | 到期匿名化不清掉還在使用的帳號的服務對象（從沒預約的，只有建立的帳號停用或不存在才清） |
| `migrations/0020_ltc_contracts.sql` | 長照特約 `ltc_contracts`（機構、縣市、契約字號、有效期間，可多筆）；只能經 `app.save_ltc_contract`／`app.remove_ltc_contract`（平台超級管理者、寫稽核）；`app.ltc_contract_active(機構, 縣市, 日期)` |
| `migrations/0021_recipient_booking_benefit.sql` | 重新試算時更新預約的補助估算：`app.recipient_refreshable_bookings`（列出還沒完成的預約）、`app.set_booking_benefit`（寫入估算）；只有服務對象建立者與平台超級管理者，已取消／婉拒／過期或行程都已完成的不動 |
| `migrations/0022_drop_leg_assignment.sql` | 清掉預約去程／回程上的平台指定機構欄位（功能移除，#110；跨機構排車改走需求池，ADR 0004）；只有資料清理 |
| `migrations/0023_typed_booking_tables.sql` | 預約與行程搬到正式資料表的擴充（ADR 0005）：寫入 app_state 時觸發器同步到 `bookings`、`booking_legs`（新）、`trips`、`trip_bookings`、`cancellations`，並回填；讀取規則與 app_state 等價、`care_ride_app` 只能讀；`app.typed_sync_diff()` 列出不一致（測試與 `tools/typed-sync-report.sh` 用） |
| `migrations/0024_pool_reads_typed_bookings.sql` | 需求池 view 改讀 `bookings`（欄位與篩選不變）；`trips` 補 `version` 並更新同步與一致性檢查；`v2-state-load` 的預約與行程改讀正式資料表（#127） |
| `rollback/<名稱>.down.sql` | 每支 migration 的回復檔（`0001` 的回復會刪除所有資料，只用在空資料庫或 Staging 重建） |
| `migrations_archive/` | 壓縮成 baseline 之前的 0001–0008，只供查閱，不再套用 |
| `seed-test-org.sql` | 建立測試機構與負責人的一次性腳本（`tests/seed-test-org.test.sh` 驗證） |
| `tests/run-all.sh` | session／身分／機構／state／載入／接線／RLS 測試 |
| `tests/run-*.sh` | 各主題的整合測試（業務流程、機構審核、預約、行程存取、通知、補助、補助抓取、隱私、瀏覽器端對端），每支建立自己的拋棄式資料庫 |
| `tests/migrations.test.sh`、`tests/apply-migrations.test.sh` | 回復檔齊全、上→下→上 schema 相同；migration 執行器 |
| `tests/_auth-fixture.js` | 測試用的假外部服務：Supabase Auth、Google Maps |
| `tests/seed.sql`、`tests/pg-psql-shim.js` | 舊測試的資料與 pg 替身（以 psql 當傳輸層）；正式環境不使用 |

## 套用到你的 Supabase

在空的資料庫依檔名順序套用 `migrations/*.sql`。正式與 Staging 由 migration 的 CI 部署流程套用；手動在 **SQL Editor** 貼上只用在一次性的空資料庫。

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

Postgres 的資料表擁有者**預設會繞過所有 RLS 政策**。用 `postgres` 連線的話，所有 RLS 政策都不會生效——每個使用者都看得到全部資料，而且不會有任何錯誤訊息告訴你。

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

身分驗證由 Supabase Auth 負責（見下方「身分驗證」），Netlify Function 驗證 access token 後把 user id 放進上面這個設定（`_db.js` 的 `withUser`）。

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

**欄位用英文 snake_case。** 前端的資料模型（`bookings`、`requestedByUserId`…）本來就是英文。

**預約、行程等營運資料暫存在 `app_state`（jsonb）。** 每列一筆前端模型，`organization_id`、
`owner_user_id` 等授權用欄位由觸發器 `app.app_state_force_scope` 決定，呼叫端送什麼都不採用；
版本控制交給 `version`／`revision` 欄位與交易。身分、機構、通知、補助、同意等已經是正式資料表；
預約與行程搬到正式資料表見 #43。

**公開需求池是 view。** `app_state_booking_pool` 從一開始就只選得到行政區、模糊地址、距離、時間
等欄位，資料庫層面就沒有門牌與姓名可以外洩；只開放給已核准機構的成員。

**承接用 `app.claim_app_state_booking()`。** `SELECT … FOR UPDATE` 讓資料庫處理競爭，兩個調度員同
搶一張單時，後到的一定會收到「已被其他服務單位接走」。

**受控寫入用 security definer 函式。** 通知、補助、同意、刪除申請等資料表，`care_ride_app` 只有
SELECT；寫入只經檢查身分與狀態的函式，連有漏洞的 handler 也繞不過。

## API 端點

全部在 `netlify/functions/`，路由在 `netlify.toml`。除了 `health` 與登入、註冊以外都要登入。

| 路由 | 用途 |
|---|---|
| `GET /api/health` | 設定與資料庫連線狀態 |
| `POST /api/v2/password-login`、`logout`、`session` | 登入、登出、換新 token |
| `POST /api/v2/register-requester` | 需求者註冊 |
| `GET /api/v2/oauth-start`、`oauth-callback` | Google、Facebook 登入（PKCE；尚未綁定手機時轉到綁定畫面；平台設定關閉的方式回 `login_error=provider_disabled`） |
| `GET /api/v2/public-settings` | 不需登入：啟用的登入方式與客服聯絡（LINE、Email），其他平台設定不會從這裡讀到 |
| `GET`／`POST /api/v2/oauth-bind` | 社群帳號第一次登入後綁定手機：綁定既有帳號（要密碼，記到 `social_logins`，只確認一次）或建立需求者 |
| `GET`／`POST /api/v2/login-methods` | 我的帳戶：查看、綁定、解除綁定 Google／Facebook（手機＋密碼一定保留） |
| `POST /api/v2/admin-reset-password` | 後台重設密碼：平台管理者重設任何人、負責人重設自己機構的調度員與司機；回傳一次性臨時密碼（見 0013） |
| `POST /api/v2/update-account` | 改密碼、手機 |
| `POST /api/v2/create-staff` | 機構負責人建立人員帳號 |
| `GET /api/v2/state-load` | 載入這個身分看得到的全部資料（含需求池、同意狀態） |
| `POST /api/v2/state-mutate` | 一般資料寫入（白名單） |
| `POST /api/v2/identity-write` | 機構、成員資格、司機 |
| `POST /api/v2/organization-apply`、`organization-review` | 機構申請、平台審核 |
| `POST /api/v2/geocode-check` | 送出預約前檢查地址 |
| `POST /api/v2/booking-write` | 預約建立與修改 |
| `POST /api/v2/claim-booking` | 接案 |
| `POST /api/v2/cancel-booking` | 需求者取消 |
| `POST /api/v2/schedule-trips` | 排車：建立行程並把預約的去程／回程排進去，一筆交易（ADR 0003） |
| `POST /api/v2/trip-write` | 調度改派、中斷、取消既有行程；不能把預約排進行程。取消時，排在這趟的去程／回程退回待排車，已排車的預約退回部分排車 |
| `POST /api/v2/trip-execute` | 司機執行自己的行程 |
| `POST /api/v2/benefit-ruleset`、`benefit-assess`、`benefit-authorization` | 補助規則、試算、正式核定 |
| `POST /api/v2/consent` | 同意個資告知與服務條款 |
| `POST /api/v2/ltc-contracts` | 長照特約的新增、修改、移除（平台超級管理者）；讀取走 state-load 的 `ltcContracts`（平台管理者看全部，機構負責人、調度員看自己機構的） |
| `POST /api/v2/platform-settings` | 保存期限、條款版本、登入方式開關、客服聯絡、立即匿名化（平台管理者） |
| `POST /api/v2/account-deletion` | 刪除帳號申請與審核 |
| `POST /api/v2/client-error` | 前端未處理錯誤轉送 Sentry（不需登入，有大小與頻率限制） |

排程 `retention-anonymize`、`benefit-rules-fetch` 沒有對外路由，由 Netlify 依 `netlify.toml` 執行。

### 環境變數

完整清單與說明見 [DEPLOYMENT.md](../DEPLOYMENT.md#2-環境變數與設定)。

## 業務規則

### 身分驗證（Supabase Auth）

密碼、token 簽發與撤銷由 Supabase Auth 負責，資料庫不保存任何密碼。Netlify Function
驗證 access token（JWT）後，以 token 的 `sub` 作為 `app.user_id`，RLS 照常生效；
`users.id` 就是 Supabase Auth 的使用者 ID。token 只放在 HttpOnly cookie（`cr_at`、
`cr_rt`），瀏覽器的 JavaScript 讀不到。

Supabase 主控台要設定的：**Authentication → Sign In / Providers → Phone** 啟用（系統不發簡訊，
簡訊設定填假值即可，見 DEPLOYMENT.md）。

**建立超級管理者**（取代原本的 bootstrap 端點）：

1. 在自己的終端機執行 `bash tools/create-super-admin.sh`：輸入專案 ref、手機、service_role 金鑰
   與密碼（隱藏輸入），以 Supabase Auth 管理 API 建立已確認手機的帳號並測試登入，印出 User UID
   與下一步的 SQL。（主控台的 Add user 只能用 Email 建帳號，本系統以手機＋密碼登入，所以不用它。）
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

### 預約寫入（/api/v2/booking-write）

預約不再經 `state-mutate` 寫入（回 `COLLECTION_FORBIDDEN`），改走 `v2-booking-write`，規則在
`netlify/functions/_booking-rules.js`：

- 需求者：只能建立公開待接的預約；公開中可修改或過期；已承接時可修改，重大修改會回到公開池
- 承接機構的負責人、調度員：已承接 → 退回需求池、不受理；**不能排車**，排車狀態也不能改回（只走 `schedule-trips`）
- 去程／回程的排車欄位（狀態、行程、排車時間、排車機構）與舊版 `tripId` 一律沿用資料庫的值
- 進入排車後，需求者不能改時間與地址
- 接案走 `claim-booking`、取消走 `cancel-booking`、排車走 `schedule-trips`；預約不能刪除
- 需求者、承接人、取消紀錄等欄位一律沿用資料庫的值
- 預約帶服務對象（`recipientId`）時：新預約或改了服務對象，需求者必須是這位服務對象的建立者，且有未撤銷、可預約（`canBook`）的關係；否則 `FORBIDDEN`。承接機構的負責人、調度員不受此限。前端因此先送服務對象與關係，再送預約
- 替家人預約時的聯絡人（`contacts.requester`）：新預約由伺服器依登入的需求者寫入姓名與電話，前端送來的不採用；修改時沿用資料庫的值

退回公開池、不受理、重大修改時，同一交易內撤銷原承接機構，原機構立即讀不到。

### 預約的伺服器計算欄位（serverComputed）

建立預約或改了上下車地址時，`v2-booking-write` 用 Google 定位兩個地址並算路線，把結果
寫進預約的 `serverComputed`（模糊地址、行政區、經緯度、距離、車程、報價狀態）。前端送來
的 `serverComputed` 與報價金額一律被覆蓋；地址找不到回 400 `ADDRESS_NOT_FOUND`（`field`
指出是哪個地址），整批不寫入。地址沒改就沿用原本的結果，不重複呼叫 Google。

平台目前不訂車資，報價固定是 `pricing_pending`、沒有金額。送出前前端會先呼叫
`/api/v2/geocode-check` 提示地址問題，這支不保存任何東西。

### 行程寫入（/api/v2/trip-write）

排車（建立行程並把預約排進去）走 `v2-schedule-trips`，一筆交易寫入行程、預約與事件（ADR 0003）。
調度端改派、中斷、取消既有行程走 `v2-trip-write`（規則在 `_trip-rules.js`），它不接受帶預約的新行程，
也不能替既有行程加掛預約；司機執行自己的行程走 `v2-trip-execute`。行程與取消紀錄都不再接受從
`state-mutate` 寫入。

- 只有行程機構的負責人、調度員可以寫；行程的機構建立後不能改
- 新行程一律從 `scheduled` 開始；狀態照轉換表走，已開始的行程不能取消（請用中斷）
- 指派的司機、車輛都必須屬於行程的機構；排車時預約也必須屬於行程的機構
- 行程不能刪除；用 revision 做樂觀鎖

### 通知

通知只由後端流程建立，存在 `notifications` 資料表（`care_ride_app` 只有 SELECT），收件人只讀得到自己的：

| 事件 | 產生的地方 | 收件人 |
|---|---|---|
| 承接 `booking_claimed` | `claim-booking` | 需求者（帶承接單位名稱） |
| 排車 `booking_scheduled` | `schedule-trips` | 需求者 |
| 指派、改派 `trip_assigned`／`trip_unassigned` | `trip-write` | 新、舊司機 |
| 調度取消行程 `trip_cancelled` | `trip-write` | 司機 |
| 需求者取消 `booking_cancelled`、`trip_cancelled` | `cancel-booking` | 需求者、司機 |
| 完成 `trip_completed` | `trip-execute` | 需求者 |

每則通知有 `dedupe_key`，同一事件重試不會重複。目前只寫入站內（`channel = in_app`、`status = queued`），
不發簡訊；LINE 等推送管道之後再評估。

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

### 福利規則排程抓取（#24）

- 每日排程 `benefit-rules-fetch`（netlify.toml）經 `_benefit-fetch.js` 的窄介面抓：
  1966 長照專區「長照服務給付額度表」（解析等級門檻與交通接送四區月額度），以及給付辦法附表 PDF
  （只用內容雜湊偵測改版，自付比例沿用已核准版本，改版時草稿提醒人工核對）。
- 每次抓取都記在 `benefit_source_fetches`（網址、時間、HTTP 狀態、內容雜湊）。
- 解析出的內容與既有版本（含被駁回的）相同時不產生草稿；不同就建立「自動抓取」草稿，附與目前
  核准版本的差異，平台管理員在「補助規則與資格」審核。核准後舊版本 superseded，新估算用新版本。
- 抓取或解析失敗時經 `_alerts.js` 送出告警（目前寫稽核紀錄與 Function 記錄；#17 接 Email 與
  Discord），現行版本不變。平台管理員也可以按「立即抓取公告」。
- 計算方式 `transport_zone`（`_benefit-transport.js`）：月額度依居住地分區，自付比例依福利身分。
- 瀏覽器不再連政府網站或 r.jina.ai，CSP 的 `connect-src` 只剩 `'self'`。

### 同意紀錄與保存期限（#26）

- 條款版本在 `app_settings.legal_documents`，由平台超級管理者經 `/api/v2/platform-settings` 發布。
- 登入方式開關（`login_methods`，試營運 Facebook 預設關閉）與客服聯絡（`support_contact`）也在 `app_settings`（0015），改了立刻生效；未登入的人只能經 `app.public_settings()` 讀到這兩組。關閉某個登入方式後，`oauth-start` 與我的帳戶的綁定立即拒絕；關閉前已經開始、還在授權頁上的那一次（PKCE cookie 有效期內）仍可完成，不另外擋。
  律師文件完成前版本是 null，不要求同意；發布或改版後，沒同意最新版本的使用者不能建立預約
  （`CONSENT_REQUIRED`），前端會跳出同意視窗，經 `/api/v2/consent` 記錄版本與時間。
- 保存期限 `app_settings.retention_years`，預設 5 年，可設定 1–30 年。
- 每日排程 `retention-anonymize`（netlify.toml）把行程日期超過保存期限的預約與行程匿名化：
  清除姓名、電話、完整地址、座標、自由文字、定位軌跡、服務證明的收受人、照片與備註、執行快照的乘客個資；
  保留行政區、日期、距離、車程、金額。預約匿名化後一併清除它的修改紀錄快照；服務對象在所有預約都已
  匿名化後清除姓名、電話、地址、生日與需求文字（只留行政區與統計欄位），還有未到期預約的不動（0016）。
  每筆都寫稽核紀錄 `retention.anonymized`。平台管理者也能手動執行。
- 刪除帳號與個資：使用者在「我的帳戶」經 `/api/v2/account-deletion` 申請或撤回；平台超級管理者在
  「組織管理」核准或駁回（駁回要填原因）。核准時同一交易內匿名化他的預約（含修改紀錄）與行程（含服務證明）、清除服務對象與補助
  試算的事實資料、刪除寄給他的通知、撤銷成員資格、停用帳號並清除姓名電話，最後刪除 Supabase Auth
  帳號（失敗就整筆回滾）。同意紀錄與稽核紀錄保留。有未結束的預約或是機構負責人時不能核准。

### 資安掃描（#27，`.github/workflows/security.yml`）

- **依賴套件**：`npm audit --omit=dev --audit-level=high`，有 high 以上弱點就失敗。依 `package-lock.json` 安裝。
- **ZAP baseline**：被動掃描，有高風險（riskcode 3）就失敗，完整報告（HTML／JSON／Markdown）保存為
  artifact 30 天。PR 掃該 PR 的 Deploy Preview（指向 Staging 資料庫）；每週排程與手動執行掃
  repo 變數 `STAGING_URL`（沒設定就略過）。判斷邏輯在 `tools/zap-check-report.js`；確定不是實際風險的
  高風險規則寫進 `.zap/accepted-high.txt` 並註明原因。
- **RLS**：資料庫權限的整合測試在 `isolated-sql-review.yml`，每個 PR 與 main 都常態執行。

## 已知限制

- **預約與行程仍在 `app_state`**：寫入已改走專用端點並由伺服器檢查，搬到正式資料表見 #43。
- **給付辦法附表（自付比例）不自動解析**：附表是 PDF，排程只用內容雜湊偵測改版。
- **`kpi_daily` 的主鍵包含 `driver_id`**：組織層級（沒有司機）的彙總列需要一個代表「全組織」的
  driver_id，接線時要決定怎麼處理。
- **稽核紀錄允許應用程式角色新增**（`audit_insert with check (true)`），沒有修改或刪除政策。
