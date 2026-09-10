# Supabase — schema 與 RLS

原本 Google Sheet 的 22 張工作表在 Postgres 的對應版本，加上取代手寫授權的 Row Level Security 政策。

**目前狀態**：schema 與 RLS 完成並通過 31 項測試。應用程式**還沒有**接上——Netlify Function 目前仍打 Apps Script。接線是下一步。

## 檔案

| 檔案 | 內容 |
|---|---|
| `migrations/0001_schema.sql` | 23 張表、外鍵、索引、updated_at 觸發器 |
| `migrations/0002_rls.sql` | 輔助函式、55 條 RLS 政策、公開需求池 view、`care_ride_app` 角色 |
| `migrations/0003_credentials_api.sql` | 密碼憑證的受控存取函式、`claim_booking` 交易函式 |
| `migrations/0004_bootstrap.sql` | 需求者集散組織；超級管理者的建立步驟（手動） |
| `tests/seed.sql` | 測試資料 |
| `tests/rls.test.sh` | 31 項 RLS 驗證，含攻擊模擬 |

## 套用到你的 Supabase

在 Supabase 主控台的 **SQL Editor**，依序貼上並執行 `0001` → `0002` → `0003` → `0004`。中間不要跳號，後面的檔案依賴前面建立的函式。

### 接著一定要做的兩件事

**1. 給 `care_ride_app` 設密碼**

`0002` 建立了這個角色但沒有密碼。在 SQL Editor 執行（密碼自己產一組長的，不要用這裡的範例字串）：

```sql
alter role care_ride_app with password '換成你自己產生的長密碼';
```

**2. 連線字串要用這個角色**

到 Supabase 的 Connect 頁面拿連線字串，然後**把使用者名稱從 `postgres` 換成 `care_ride_app`**，密碼換成上面設的：

```
postgresql://care_ride_app:<密碼>@<你的專案>.pooler.supabase.com:6543/postgres
```

放進 Netlify 的環境變數 `DATABASE_URL`。不要寫進任何檔案，不要進 git。

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

## 已知還沒處理

- **應用程式尚未接線**：Netlify Function 還在打 Apps Script
- **沒有資料遷移腳本**：這次是乾淨開始，沒有搬舊資料
- **`kpi_daily` 的主鍵包含 `driver_id`**，因此組織層級（沒有司機）的彙總列需要一個代表「全組織」的 driver_id，接線時要決定怎麼處理
- **稽核紀錄目前允許任何登入者新增**（`audit_insert with check (true)`），因為寫入者就是應用程式本身；若之後要更嚴格，可改為只允許 security definer 函式寫入
