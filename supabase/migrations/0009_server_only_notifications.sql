-- =====================================================================
-- 0009：通知只能由後端流程建立；收件人可讀自己的通知
--
-- 本檔在「新程式部署之後」才套用（見 DEPLOYMENT.md 第 7 節）。舊版前端會在
-- 派車、中斷、恢復、交接等操作時把本機產生的通知經 state-mutate 寫入，而且和行程
-- 寫入同一批送出；先套用本檔會讓那些整批寫入失敗回滾。新版前端與 state-mutate 已
-- 不再寫入 notifications。
--
-- 為什麼要在資料庫層擋：app_state 的 INSERT 政策是 with check (true)，通知的
-- recipientId、template、payload、source 都由寫入者決定。只要有收件人讀取政策，
-- 任何登入者就能投遞內容給別人讀。所以：
--   1. 觸發器 app_state_guard_notifications：collection = 'notifications' 的
--      INSERT、UPDATE（含軟刪除）必須帶交易級旗標 app.notification_writer = '1'。
--      旗標只由 security definer 的後端函式設定（目前是
--      app.cancel_app_state_booking）；handler 不接受用戶端的 SQL，用戶端送來的
--      source／eventType 不影響判斷。與 0007 的 app.state_scope_override 是同一種
--      信任模型。
--   2. 收件人讀取政策只放行本檔安裝之後建立的通知。安裝之後只有後端能建立通知，
--      安裝之前的資料列可能由用戶端寫入（含偽造），不因這條政策而外露。
--      created_at 由資料表預設值與 0007 觸發器決定，handler 不寫這個欄位。
--
-- 不新增欄位或索引，不改寫 app_state。CREATE TRIGGER 對 app_state 取
-- SHARE ROW EXCLUSIVE、CREATE POLICY 取 ACCESS EXCLUSIVE，都要以 lock_timeout 套用。
-- 重複套用會把「安裝時間」往後移，只會讓更少的舊通知可讀，不會擴大。
-- =====================================================================

create or replace function app.app_state_guard_notifications() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.notification_writer', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.collection = 'notifications' then
    raise exception '通知只能由系統流程建立' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.collection = 'notifications' or new.collection = 'notifications') then
    raise exception '通知不能由用戶端修改或刪除' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists app_state_guard_notifications on app_state;
create trigger app_state_guard_notifications before insert or update on app_state
  for each row execute function app.app_state_guard_notifications();

do $do$
begin
  execute format(
    'create or replace function app.notification_guard_since() returns timestamptz
       language sql stable set search_path = public, pg_temp as %L',
    format('select %L::timestamptz', now()));
end $do$;

grant execute on function app.notification_guard_since() to care_ride_app;

drop policy if exists app_state_notification_recipient_read on app_state;
create policy app_state_notification_recipient_read on app_state for select
  using (collection = 'notifications'
         and created_at >= (select app.notification_guard_since())
         and data->>'recipientId' = (select app.current_user_id()));
