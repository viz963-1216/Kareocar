-- =====================================================================
-- 應用狀態表：前端資料模型的權威儲存
--
-- 為什麼是一張通用表而不是攤平成欄位：
--   前端的資料模型是巢狀的（一筆預約有 locations、serviceNeeds、
--   commercialSnapshots…），而 0001 那些 typed 資料表是照 Google 試算表的
--   欄位設計的。兩邊從來就不是同一套。硬把前端記錄逐欄塞進 typed 欄位，
--   28 個集合每一個都要人工對應一次，對錯一欄就是不會報錯的資料損毀。
--
--   所以這裡忠實移植目前實際在運作的模型（Apps Script 的「應用狀態」工作表），
--   整包記錄存成 jsonb；伺服器需要自己判斷的欄位（狀態、時間、地區、組織）
--   用 generated column 從 jsonb 算出來——是「同一份資料的投影」而不是
--   「另一份要同步的副本」，所以不會有兩邊不一致的問題。
--
-- 身分相關的四個集合（users / memberships / organizations / drivers）不走這裡：
-- 它們已經有 typed 資料表，而且登入、成員資格、RLS 全都依賴那些表。寫入端會
-- 明確拒絕，避免同一件事有兩個真相。
-- =====================================================================

create table if not exists app_state (
  collection           text not null,
  id                   text not null,
  organization_id      text,
  owner_user_id        text,
  trip_id              text,
  booking_id           text,
  data                 jsonb not null default '{}'::jsonb,
  deleted              boolean not null default false,
  version              integer not null default 1,
  revision             integer not null default 0,
  updated_by_user_id   text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists app_state_owner_idx on app_state (owner_user_id) where not deleted;
create index if not exists app_state_org_idx   on app_state (organization_id) where not deleted;
create index if not exists app_state_trip_idx  on app_state (trip_id) where trip_id is not null;
create index if not exists app_state_booking_idx on app_state (booking_id) where booking_id is not null;

-- 預約的投影欄位。用 generated 而不是另外寫一張表：資料只有一份，
-- 不可能對不起來，也不需要靠寫入端記得同步。
alter table app_state
  add column if not exists booking_state text
    generated always as (nullif(data->>'state', '')) stored,
  add column if not exists pickup_at text
    generated always as (nullif(data->>'pickupDate', '')) stored;

create index if not exists app_state_pool_idx
  on app_state (collection, booking_state) where not deleted;

-- ---------------------------------------------------------------------
-- 寫入時強制決定「這筆資料屬於誰」
--
-- 這是整張表最重要的一段。範圍絕對不能相信呼叫端送什麼就是什麼——
-- 否則任何人都可以把 organizationId 改成別人的公司，或把 ownerUserId 改成
-- 自己，一步就把別人的資料變成自己的。上一輪修掉的就是這個等級的漏洞。
--
--   新增：擁有者一律是目前登入者；組織只有在你真的是那間公司的營運方時才採納
--   更新：範圍完全不可變，沿用原本那一列的值
-- ---------------------------------------------------------------------
create or replace function app.app_state_force_scope() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- 唯一可以改變組織歸屬的路徑是 app.claim_app_state_booking，它會在自己的
    -- 交易內設定這個旗標。沒有這個例外的話，承接公開案件會被下面兩行還原掉。
    if coalesce(current_setting('app.state_scope_override', true), '') <> '1' then
      new.organization_id := old.organization_id;
    end if;
    new.owner_user_id   := old.owner_user_id;
    new.created_at      := old.created_at;
    new.version         := old.version + 1;
  else
    new.owner_user_id := coalesce(app.current_user_id(), new.owner_user_id);
    if new.organization_id is not null
       and not (app.is_super_admin()
                or app.has_role_in(new.organization_id, array['owner','dispatcher'])) then
      new.organization_id := null;
    end if;
    new.version := greatest(1, coalesce(new.version, 1));
  end if;
  new.updated_by_user_id := coalesce(app.current_user_id(), new.updated_by_user_id);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_state_force_scope on app_state;
create trigger app_state_force_scope before insert or update on app_state
  for each row execute function app.app_state_force_scope();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table app_state enable row level security;

drop policy if exists app_state_read on app_state;
create policy app_state_read on app_state for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         -- 未被承接的公開需求：營運方看得到，但只透過遮蔽過的 view
         or (collection = 'bookings' and organization_id is null
             and booking_state = 'open' and app.operates_any()));

drop policy if exists app_state_insert on app_state;
-- 範圍由觸發器決定，呼叫端寫什麼都會被覆蓋，所以這裡不需要再限制
create policy app_state_insert on app_state for insert with check (true);

drop policy if exists app_state_update on app_state;
create policy app_state_update on app_state for update
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or (collection = 'bookings' and organization_id is null
             and booking_state = 'open' and app.operates_any()))
  with check (app.is_super_admin()
              or owner_user_id = app.current_user_id()
              or organization_id = any(app.my_ops_orgs()));

-- 刻意沒有 DELETE 政策：刪除一律是 deleted = true 的軟刪除，保留稽核軌跡

grant select, insert, update on app_state to care_ride_app;

-- ---------------------------------------------------------------------
-- 公開需求池：改讀 app_state，內容遮蔽到行政區
-- ---------------------------------------------------------------------
drop view if exists app_state_booking_pool;
create view app_state_booking_pool
with (security_invoker = true)
as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         s.pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     -- 需求池是給營運方瀏覽待承接需求用的。少了這一行，需求者會在池子裡
     -- 看到自己那筆（RLS 允許他讀自己的資料），跟原本「需求者看到空池」的
     -- 行為不一致，前端拿池子是否為空來決定畫面時就會怪怪的。
     and (app.is_super_admin() or app.operates_any());

grant select on app_state_booking_pool to care_ride_app;

-- ---------------------------------------------------------------------
-- 承接公開案件：交易級的搶單保護
--
-- SELECT ... FOR UPDATE 讓資料庫自己處理競爭：兩個調度員同時搶同一張單，
-- 後到的那個一定會看到已經被接走的狀態，不需要應用層的全域鎖。
-- ---------------------------------------------------------------------
create or replace function app.claim_app_state_booking(p_id text, p_organization_id text)
returns table (id text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  row_state text;
  row_org   text;
begin
  if not (app.is_super_admin()
          or app.has_role_in(p_organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限代表這個組織承接案件' using errcode = '42501';
  end if;

  select s.booking_state, s.organization_id into row_state, row_org
    from app_state s
   where s.collection = 'bookings' and s.id = p_id and not s.deleted
     for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;
  if row_org is not null then
    raise exception '已被其他服務單位接走' using errcode = '55006';
  end if;
  if row_state is distinct from 'open' then
    raise exception '不是可承接的狀態' using errcode = '55006';
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = p_organization_id,
         data = s.data || jsonb_build_object(
                  'organizationId', p_organization_id,
                  'state', 'claimed',
                  'claimStatus', 'claimed',
                  'claimedByUserId', app.current_user_id(),
                  'claimedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where s.collection = 'bookings' and s.id = p_id;

  perform set_config('app.state_scope_override', '0', true);

  return query
    select s.id, s.organization_id, s.version
      from app_state s where s.collection = 'bookings' and s.id = p_id;
end $$;

grant execute on function app.claim_app_state_booking(text, text) to care_ride_app;
