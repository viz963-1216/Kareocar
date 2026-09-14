-- =====================================================================
-- 0008：接案、司機執行、需求者取消的專用路徑
--
-- 新增 migration，不改寫已部署的 0001–0007。本檔尚未部署到任何環境。
--
-- 背景（PR #6 的整合測試重現）：
--   * 調度員透過 state-mutate 接案 → 403。app_state_update 不放行未承接預約，
--     而且 app_state_force_scope 會還原 UPDATE 的 organization_id。
--   * 被指派司機讀不到自己的行程、寫入 403。app_state 的政策沒有司機條款。
--   * 需求者同批取消預約與行程 → 403。需求者無權改調度員建立的行程。
--
-- 做法：一般寫入管道（state-mutate）的權限維持不變；三個流程改走 security
-- definer 函式，由函式自己驗證身分、狀態與允許的欄位，只改必要的鍵。
--
-- 鎖與改寫（部署前必讀，細節見 PR 描述與 DEPLOYMENT.md）：
--   * 本檔「不」新增或刪除任何資料表欄位、不建立索引，所以不會改寫 app_state。
--     早期草稿曾新增 stored generated column，會整張表改寫並長時間持有
--     ACCESS EXCLUSIVE 鎖，已移除；隔離 CI 以 pg_relation_filenode 驗證不改寫。
--   * 仍會短暫取得的鎖：CREATE TRIGGER（SHARE ROW EXCLUSIVE）、CREATE POLICY／
--     DROP POLICY IF EXISTS 對 app_state
--     取 ACCESS EXCLUSIVE；CREATE OR REPLACE VIEW 對 app_state_booking_pool 取
--     ACCESS EXCLUSIVE。都是只改系統目錄、瞬間完成，但會在鎖佇列裡等前面的長
--     交易結束，等待期間後面所有讀寫 app_state 的請求都會排隊。部署時必須設
--     lock_timeout，取不到鎖就失敗重試，不能無限等。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 接案：沿用 0007 的 app.claim_app_state_booking，額外驗證承接組織
--
-- 0007 只檢查呼叫者是否為該組織的 owner／dispatcher。這裡補上：組織必須存在、
-- 啟用中、且是可承接案件的服務組織類型。其餘邏輯（FOR UPDATE 搶單、55006
-- 衝突碼、交易級 scope override）與 0007 完全相同，函式簽名與回傳形狀不變。
-- ---------------------------------------------------------------------
create or replace function app.claim_app_state_booking(p_id text, p_organization_id text)
returns table (id text, organization_id text, version int)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  row_state text;
  row_org   text;
begin
  if not (app.is_super_admin()
          or app.has_role_in(p_organization_id, array['owner','dispatcher'])) then
    raise exception '沒有權限代表這個組織承接案件' using errcode = '42501';
  end if;
  if not exists (select 1 from organizations o
                  where o.id = p_organization_id
                    and o.active
                    and o.org_type in ('transport_provider','care_facility')) then
    raise exception '此組織不是可承接案件的有效服務組織' using errcode = '42501';
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


-- ---------------------------------------------------------------------
-- 2. 需求池補上前端接案畫面需要、但不識別個人的欄位
--
-- create or replace view 只能在最後面新增欄位，前 10 欄與 0007 完全相同，
-- 所以只選前 10 欄的舊版 state-load 不受影響。
-- 新增的都是時間與服務需求的列舉值；門牌、姓名、電話、備註、自由文字的
-- 特殊需求一律不露出。companions 只接受純數字，避免異常資料讓整個 view 失敗。
-- ---------------------------------------------------------------------
create or replace view app_state_booking_pool as
  select s.id,
         app.approx_area(s.data->>'pickupAddress') as pickup_area,
         app.approx_area(s.data->>'destination')   as destination_area,
         s.pickup_at,
         s.data->>'tripType'        as trip_type,
         (s.data->>'passengerCount')::int  as passenger_count,
         (s.data->>'wheelchairSlots')::int as wheelchair_slots,
         (s.data->>'rideshareConsent')::boolean as rideshare_consent,
         s.version,
         s.created_at,
         nullif(s.data->>'pickupTime', '')      as pickup_time,
         nullif(s.data->>'returnDate', '')      as return_date,
         nullif(s.data->>'returnTime', '')      as return_time,
         nullif(s.data->>'marketExpiresAt', '') as market_expires_at,
         left(nullif(s.data->>'aidNeed', ''), 20) as aid_need,
         case when coalesce(s.data->>'companions', '') ~ '^[0-9]{1,2}$'
              then (s.data->>'companions')::int else 0 end as companions
    from app_state s
   where s.collection = 'bookings'
     and not s.deleted
     and s.organization_id is null
     and s.booking_state = 'open'
     and (app.is_super_admin() or app.operates_any());

grant select on app_state_booking_pool to care_ride_app;


-- ---------------------------------------------------------------------
-- 3. 司機讀取：只放行「本人、啟用中、同組織、有效 driver 成員資格」的指派行程
--
-- 0002 的 my_driver_ids() 只比對 user_id，不檢查司機或成員資格是否啟用，
-- 也不檢查組織。這裡另寫嚴格版本，不改動 0002。
-- 只放行 SELECT；司機的寫入一律走下面第 4 節的函式。
--
-- 政策用 in (select unnest(app.my_active_driver_keys()))：不依賴資料列的子查詢，
-- 規劃器會做成只算一次的 SubPlan，而不是每一列行程都查一次司機表。
-- 不新增欄位或索引（見檔頭「鎖與改寫」）。
-- ---------------------------------------------------------------------
create or replace function app.is_my_active_trip_driver(p_driver_id text, p_organization_id text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_driver_id is not null
     and p_organization_id is not null
     and exists (
       select 1
         from drivers d
         join memberships m
           on m.user_id = d.user_id and m.organization_id = d.organization_id
        where d.id = p_driver_id
          and d.user_id = app.current_user_id()
          and d.organization_id = p_organization_id
          and d.active
          and m.role = 'driver'
          and m.status = 'active')
$$;

grant execute on function app.is_my_active_trip_driver(text, text) to care_ride_app;

create or replace function app.my_active_driver_keys()
returns text[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct d.organization_id || '|' || d.id), '{}'::text[])
    from drivers d
    join memberships m
      on m.user_id = d.user_id and m.organization_id = d.organization_id
   where d.user_id = app.current_user_id()
     and d.active
     and m.role = 'driver'
     and m.status = 'active'
$$;

grant execute on function app.my_active_driver_keys() to care_ride_app;

drop policy if exists app_state_driver_read on app_state;
create policy app_state_driver_read on app_state for select
  using (collection = 'trips'
         and (organization_id || '|' || coalesce(data->>'driverId', ''))
             in (select unnest(app.my_active_driver_keys())));


-- ---------------------------------------------------------------------
-- 4. 司機執行：現有司機畫面的操作，逐一經伺服器驗證後寫入
--
-- 指令與前端 Trip 方法的對應：
--   complete_step    Trip.completeCurrentStep（完成目前停靠點；首站會開始行程、
--                    末站且條件滿足會完成行程）
--   undo_step        Trip.undoLastStep（司機限時返回上一步，不含調度正式修正）
--   proof_service    Trip.captureProof（服務證明；照片本體仍在裝置，只收描述資料）
--   location_sample  Trip.recordLocationSample／refreshNavigation（定位、ETA）
--   report_issue     Trip.reportIssue（現場異常；中斷行程仍由調度處理）
--
-- 刻意沒有「中斷」：現行產品只有 trip.manage（調度／負責人）能中斷、恢復、
-- 終止、交接，司機是回報異常。早期草稿給司機 interrupt 等於擴權，已移除。
--
-- 分工：
--   app.lock_driver_trip           鎖定行程、確認本人為指派司機、回傳驗證需要的
--                                  資料（含未結案的重大異常）
--   netlify/functions/_trip-execution-rules.js
--                                  逐欄比對停靠點、乘客、服務證明、資源區段的
--                                  合法變化（同一交易、同一把鎖之內）
--   app.apply_driver_trip_execution
--                                  寫入前再驗一次不依賴 JS 的核心條件：指派司機、
--                                  冪等鍵、revision、允許的鍵、狀態轉換、事件
--                                  類型與操作人；再由伺服器自己寫 revision、
--                                  mutationReceipts 與事件／異常的組織歸屬
--
-- 組織、指派司機／車輛、預約關聯、服務證明規則（proofPolicy）等欄位不在允許
-- 的鍵裡，送了就拒絕，不是忽略。
--
-- 錯誤碼：42501 非指派司機、P0002 找不到、CR409 revision 不符、CR400 其他驗證。
-- ---------------------------------------------------------------------
create or replace function app.lock_driver_trip(p_trip_id text)
returns table (trip_data jsonb, trip_revision int, trip_organization_id text, blocking_issue_ids text[])
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r app_state%rowtype;
begin
  select * into r
    from app_state s
   where s.collection = 'trips' and s.id = p_trip_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到行程' using errcode = 'P0002';
  end if;
  if not app.is_my_active_trip_driver(r.data->>'driverId', r.organization_id) then
    raise exception '只有本趟指派司機可以執行此行程' using errcode = '42501';
  end if;

  return query
    select r.data, r.revision, r.organization_id,
           coalesce((select array_agg(i.id order by i.id)
                       from app_state i
                      where i.collection = 'issues'
                        and not i.deleted
                        and i.trip_id = p_trip_id
                        and coalesce(i.data->>'status', 'open') <> 'resolved'
                        and (i.data->>'requiresDispatch' = 'true'
                             or i.data->>'severity' in ('critical', 'emergency'))),
                    '{}'::text[]);
end $$;

grant execute on function app.lock_driver_trip(text) to care_ride_app;

create or replace function app.apply_driver_trip_execution(
  p_trip_id text, p_command text, p_expected_revision int, p_idempotency_key text,
  p_patch jsonb, p_events jsonb, p_issue jsonb)
returns table (out_trip_id text, out_revision int, out_status text, out_duplicate boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r           app_state%rowtype;
  patch       jsonb := coalesce(p_patch, '{}'::jsonb);
  events      jsonb := coalesce(p_events, '[]'::jsonb);
  me          text := app.current_user_id();
  revisioned  boolean := p_command in ('complete_step', 'undo_step', 'proof_service');
  allowed     text[];
  ev_types    text[];
  k           text;
  e           jsonb;
  old_status  text;
  new_status  text;
  receipts    jsonb;
  event_ids   text[];
  now_iso     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  select * into r
    from app_state s
   where s.collection = 'trips' and s.id = p_trip_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到行程' using errcode = 'P0002';
  end if;
  if not app.is_my_active_trip_driver(r.data->>'driverId', r.organization_id) then
    raise exception '只有本趟指派司機可以執行此行程' using errcode = '42501';
  end if;

  allowed := case
    when revisioned then array['status','stateChangedAt','startedAt','completedAt','currentStepIndex',
                               'completionPending','steps','passengers','serviceProofs','resourceSegments',
                               'actualMetrics','lastInvariantCheck','invariantViolation','updatedAt']
    when p_command = 'location_sample' then array['locationSamples','liveNavigation']
    when p_command = 'report_issue'    then array[]::text[]
    else null end;
  if allowed is null then
    raise exception '不支援的執行動作' using errcode = 'CR400';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or length(p_idempotency_key) > 180 then
    raise exception '缺少冪等鍵' using errcode = 'CR400';
  end if;
  if jsonb_typeof(patch) <> 'object' or jsonb_typeof(events) <> 'array' then
    raise exception 'patch 必須是物件、events 必須是陣列' using errcode = 'CR400';
  end if;
  if jsonb_array_length(events) > 50 then
    raise exception '單次事件數量過多' using errcode = 'CR400';
  end if;
  for k in select jsonb_object_keys(patch) loop
    if not (k = any(allowed)) then
      raise exception '不允許修改的欄位：%', left(k, 40) using errcode = 'CR400';
    end if;
  end loop;

  old_status := coalesce(nullif(r.data->>'status', ''), 'scheduled');

  -- 冪等：同一個操作重送（例如回應在網路上遺失後重試）直接回報已處理，不再寫入
  if revisioned then
    if jsonb_typeof(r.data->'mutationReceipts') = 'array'
       and exists (select 1 from jsonb_array_elements(r.data->'mutationReceipts') x
                    where x->>'key' = p_idempotency_key) then
      return query select r.id, r.revision, old_status, true;
      return;
    end if;
    if p_expected_revision is distinct from r.revision then
      raise exception '行程已被其他操作更新，請重新整理' using errcode = 'CR409';
    end if;
  elsif p_command = 'report_issue' then
    if p_issue is null or jsonb_typeof(p_issue) <> 'object'
       or btrim(coalesce(p_issue->>'id', '')) = '' or length(p_issue->>'id') > 180 then
      raise exception '異常資料格式不符' using errcode = 'CR400';
    end if;
    if exists (select 1 from app_state s where s.collection = 'issues' and s.id = p_issue->>'id') then
      if exists (select 1 from app_state s
                  where s.collection = 'issues' and s.id = p_issue->>'id'
                    and s.trip_id = p_trip_id and s.owner_user_id = me) then
        return query select r.id, r.revision, old_status, true;
        return;
      end if;
      raise exception '異常 ID 與其他資料衝突' using errcode = 'CR400';
    end if;
  end if;

  -- 狀態轉換
  if revisioned then
    new_status := coalesce(nullif(patch->>'status', ''), old_status);
    if not ((old_status || '>' || new_status) = any (case p_command
         when 'complete_step' then array['scheduled>in_progress','scheduled>completed',
                                         'in_progress>in_progress','in_progress>completed']
         when 'undo_step'     then array['in_progress>in_progress','in_progress>scheduled',
                                         'completed>in_progress']
         when 'proof_service' then array['in_progress>in_progress','in_progress>completed',
                                         'completed>completed'] end)) then
      raise exception '行程狀態不可由 % 轉為 %', old_status, new_status using errcode = 'CR400';
    end if;
  elsif p_command = 'report_issue' then
    if old_status in ('completed', 'cancelled', 'aborted') then
      raise exception '已完成、取消或終止的行程不能再新增現場異常' using errcode = 'CR400';
    end if;
    if p_issue->>'tripId' is distinct from p_trip_id
       or p_issue->>'driverId' is distinct from r.data->>'driverId'
       or coalesce(p_issue->>'status', '') <> 'open'
       or btrim(coalesce(p_issue->>'type', '')) = '' then
      raise exception '異常資料與行程不符' using errcode = 'CR400';
    end if;
  end if;

  -- 事件：類型必須屬於這個指令，而且操作人就是呼叫者
  ev_types := case p_command
    when 'complete_step'   then array['trip_step_completed','trip_passenger_state_changed','trip_state_transitioned']
    when 'undo_step'       then array['trip_event_corrected','trip_proof_of_service_superseded',
                                      'trip_state_transitioned','trip_passenger_state_changed']
    when 'proof_service'   then array['trip_proof_of_service_captured','trip_state_transitioned']
    when 'location_sample' then array['trip_route_deviation_detected','trip_route_deviation_cleared']
    when 'report_issue'    then array['trip_issue_reported'] end;
  for e in select x.value from jsonb_array_elements(events) x loop
    if jsonb_typeof(e) <> 'object'
       or btrim(coalesce(e->>'id', '')) = '' or length(e->>'id') > 180
       or e->>'tripId' is distinct from p_trip_id
       or not (coalesce(e->>'eventType', '') = any(ev_types))
       or e->>'actorUserId' is distinct from me then
      raise exception '事件格式不符或不屬於此操作' using errcode = 'CR400';
    end if;
  end loop;

  -- 寫入行程：revision 與 mutationReceipts 由伺服器產生，不採用呼叫端的值
  if revisioned then
    receipts := coalesce(case when jsonb_typeof(r.data->'mutationReceipts') = 'array'
                              then r.data->'mutationReceipts' end, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                     'key', p_idempotency_key, 'action', p_command, 'at', now_iso,
                     'actorUserId', me, 'resultRevision', r.revision + 1,
                     'source', 'trip_execute_endpoint'));
    if jsonb_array_length(receipts) > 80 then
      select jsonb_agg(x.value order by x.ord) into receipts
        from jsonb_array_elements(receipts) with ordinality x(value, ord)
       where x.ord > jsonb_array_length(receipts) - 80;
    end if;
    update app_state s
       set data = s.data || patch
                  || jsonb_build_object('mutationReceipts', receipts, 'revision', s.revision + 1),
           revision = s.revision + 1
     where s.collection = 'trips' and s.id = p_trip_id;
  elsif p_command = 'location_sample' then
    -- 定位是遙測，不動 revision：不會讓司機接下來的停靠點操作變成 409
    update app_state s
       set data = s.data || patch
     where s.collection = 'trips' and s.id = p_trip_id;
  end if;

  -- 事件與異常：觸發器會把非營運方 INSERT 的 organization_id 清空，
  -- 所以先寫入、再以交易級旗標補上行程的組織，調度端才看得到
  select coalesce(array_agg(distinct x.value->>'id'), '{}'::text[]) into event_ids
    from jsonb_array_elements(events) x;
  if array_length(event_ids, 1) > 0 then
    insert into app_state (collection, id, trip_id, data)
      select 'tripEvents', x.value->>'id', p_trip_id, x.value
        from jsonb_array_elements(events) x
      on conflict (collection, id) do nothing;
    if (select count(*) from app_state s
         where s.collection = 'tripEvents' and s.id = any(event_ids) and s.trip_id = p_trip_id)
       <> array_length(event_ids, 1) then
      raise exception '事件 ID 與其他資料衝突' using errcode = 'CR400';
    end if;
  end if;
  if p_command = 'report_issue' then
    insert into app_state (collection, id, trip_id, data)
    values ('issues', p_issue->>'id', p_trip_id,
            p_issue || jsonb_build_object('organizationId', r.organization_id,
                                          'tripId', p_trip_id,
                                          'driverId', r.data->>'driverId'));
  end if;

  perform set_config('app.state_scope_override', '1', true);
  update app_state s
     set organization_id = r.organization_id
   where s.trip_id = p_trip_id
     and s.organization_id is null
     and s.owner_user_id = me
     and ((s.collection = 'tripEvents' and s.id = any(event_ids))
          or (p_command = 'report_issue' and s.collection = 'issues' and s.id = p_issue->>'id'));
  perform set_config('app.state_scope_override', '0', true);

  return query
    select s.id, s.revision, coalesce(nullif(s.data->>'status', ''), 'scheduled'), false
      from app_state s where s.collection = 'trips' and s.id = p_trip_id;
end $$;

grant execute on function app.apply_driver_trip_execution(text, text, int, text, jsonb, jsonb, jsonb) to care_ride_app;


-- ---------------------------------------------------------------------
-- 5. 需求者取消：同一交易內取消預約與關聯行程、保留歷史關聯、排入站內通知
--
-- 驗證：預約擁有者是呼叫者本人、呼叫者是需求者、原因必填、預約在可取消狀態。
-- 關聯行程以 id 排序逐筆鎖定並處理：已取消的略過；scheduled 的單人行程改為
-- cancelled；已開始／已結束或共乘行程一律中止整筆取消。處理到一半才遇到不能
-- 取消的行程時，前面已改的行程會隨交易一起回滾。
--
-- 保留歷史：預約的 tripId、行程的 bookingIds／driverId／vehicleId 都不清除；
-- 預約另記 cancelledTripIds。共乘行程目前一律拒絕，產品決策見 PR 描述。
--
-- 通知：沿用前端既有的 notifications 集合與資料形狀（trip_cancelled 給司機、
-- booking_cancelled 給需求者），只寫入 status = 'queued' 的資料列，不呼叫任何
-- 外部服務。與取消在同一交易：取消失敗就沒有通知。ID 由預約與行程決定，
-- ON CONFLICT DO NOTHING，重試不會重複。
--
-- 通知的完整性與收件人讀取在第 6 節。
-- ---------------------------------------------------------------------
create or replace function app.cancel_app_state_booking(
  p_booking_id text, p_reason_code text, p_reason_text text)
returns table (out_booking_id text, out_cancelled_trip_ids text[], out_notification_ids text[])
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  b         app_state%rowtype;
  st        text;
  t         record;
  t_status  text;
  trip_ids  text[] := '{}';
  ntf_ids   text[] := '{}';
  ntf_id    text;
  ntf_org   text;
  drv_user  text;
  recipient text;
  now_iso   text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  reason    text := left(btrim(coalesce(p_reason_text, '')), 500);
  code      text := left(btrim(coalesce(p_reason_code, '')), 60);
begin
  select * into b
    from app_state s
   where s.collection = 'bookings' and s.id = p_booking_id and not s.deleted
     for update;
  if not found then
    raise exception '找不到預約' using errcode = 'P0002';
  end if;
  if b.owner_user_id is distinct from app.current_user_id()
     or not app.has_role_in('ORG-REQ-001', array['requester']) then
    raise exception '只能取消自己的預約' using errcode = '42501';
  end if;
  if code = '' then
    raise exception '請選擇取消原因' using errcode = 'CR400';
  end if;
  st := coalesce(nullif(b.data->>'state', ''), 'open');
  if st not in ('open', 'claimed', 'partially_scheduled', 'scheduled') then
    raise exception '此預約目前不可取消' using errcode = 'CR400';
  end if;

  for t in
    select s.id, s.data
      from app_state s
     where s.collection = 'trips'
       and not s.deleted
       and (s.booking_id = p_booking_id
            or (jsonb_typeof(s.data->'bookingIds') = 'array'
                and s.data->'bookingIds' ? p_booking_id))
     order by s.id
       for update
  loop
    t_status := coalesce(nullif(t.data->>'status', ''), 'scheduled');
    continue when t_status = 'cancelled';
    if t_status <> 'scheduled' then
      raise exception '行程已開始或已結束，無法由需求者取消' using errcode = 'CR400';
    end if;
    if jsonb_typeof(t.data->'bookingIds') = 'array'
       and jsonb_array_length(t.data->'bookingIds') > 1 then
      raise exception '共乘行程需由調度處理取消' using errcode = 'CR400';
    end if;
    update app_state s
       set data = s.data || jsonb_build_object(
                    'status', 'cancelled',
                    'cancelledAt', now_iso,
                    'stateChangedAt', now_iso,
                    'updatedAt', now_iso,
                    'cancelledByUserId', app.current_user_id(),
                    'cancelReason', reason,
                    'cancelReasonCode', 'booking_cancelled'),
           revision = s.revision + 1
     where s.collection = 'trips' and s.id = t.id;
    trip_ids := trip_ids || t.id;
  end loop;

  update app_state s
     set data = s.data || jsonb_build_object(
                  'state', 'cancelled',
                  'claimStatus', 'cancelled',
                  'status', 'cancelled',
                  'cancelledAt', now_iso,
                  'stateChangedAt', now_iso,
                  'updatedAt', now_iso,
                  'cancelledByUserId', app.current_user_id(),
                  'cancelReasonCode', code,
                  'cancelReasonText', reason,
                  'cancelledTripIds', to_jsonb(trip_ids))
   where s.collection = 'bookings' and s.id = p_booking_id;

  if jsonb_typeof(b.data->'legs') = 'array' then
    update app_state s
       set data = jsonb_set(s.data, '{legs}',
                    (select coalesce(jsonb_agg(l || jsonb_build_object('status', 'cancelled')), '[]'::jsonb)
                       from jsonb_array_elements(s.data->'legs') l))
     where s.collection = 'bookings' and s.id = p_booking_id;
  end if;

  -- 站內通知（只寫資料列，不送出）
  perform set_config('app.state_scope_override', '1', true);

  for t in
    select s.id, s.organization_id, s.data
      from app_state s
     where s.collection = 'trips' and s.id = any(trip_ids)
     order by s.id
  loop
    select d.user_id into drv_user from drivers d where d.id = t.data->>'driverId';
    continue when drv_user is null;
    ntf_id := 'ntf_bc_' || md5(p_booking_id || '|trip_cancelled|' || t.id);
    insert into app_state (collection, id, trip_id, booking_id, data)
    values ('notifications', ntf_id, t.id, p_booking_id, jsonb_build_object(
              'id', ntf_id, 'organizationId', t.organization_id, 'recipientId', drv_user,
              'channel', 'line', 'template', 'trip_cancelled', 'eventType', 'trip_cancelled',
              'payload', jsonb_build_object('tripId', t.id, 'tripCode', coalesce(t.data->>'code', ''),
                                            'reason', '需求者取消預約', 'bookingId', p_booking_id,
                                            'bookingOrganizationId', b.organization_id),
              'status', 'queued', 'createdAt', now_iso, 'sentAt', null, 'error', null,
              'source', 'cancel_booking_endpoint'))
    on conflict (collection, id) do nothing;
    update app_state s set organization_id = t.organization_id
     where s.collection = 'notifications' and s.id = ntf_id and s.organization_id is null;
    ntf_ids := ntf_ids || ntf_id;
  end loop;

  recipient := coalesce(nullif(b.data->>'requestedByUserId', ''), b.owner_user_id);
  if recipient is not null then
    ntf_id  := 'ntf_bc_' || md5(p_booking_id || '|booking_cancelled');
    ntf_org := coalesce(b.organization_id, 'ORG-REQ-001');
    insert into app_state (collection, id, booking_id, data)
    values ('notifications', ntf_id, p_booking_id, jsonb_build_object(
              'id', ntf_id, 'organizationId', ntf_org, 'recipientId', recipient,
              'channel', 'line', 'template', 'booking_cancelled', 'eventType', 'booking_cancelled',
              'payload', jsonb_build_object('bookingId', p_booking_id,
                                            'reason', coalesce(nullif(reason, ''), code),
                                            'reasonCode', code,
                                            'cancelledTripIds', to_jsonb(trip_ids)),
              'status', 'queued', 'createdAt', now_iso, 'sentAt', null, 'error', null,
              'source', 'cancel_booking_endpoint'))
    on conflict (collection, id) do nothing;
    update app_state s set organization_id = ntf_org
     where s.collection = 'notifications' and s.id = ntf_id and s.organization_id is null;
    ntf_ids := ntf_ids || ntf_id;
  end if;

  perform set_config('app.state_scope_override', '0', true);

  return query select p_booking_id, trip_ids, ntf_ids;
end $$;

grant execute on function app.cancel_app_state_booking(text, text, text) to care_ride_app;


-- ---------------------------------------------------------------------
-- 6. 通知完整性與收件人讀取
--
-- 通知有兩種來源：
--   * 後端流程：app.cancel_app_state_booking（security definer）
--   * 前端 Notification.queue 經 state-mutate（派車、中斷、恢復、交接、完成等）；
--     這條路徑保留，與舊版一樣寫入，可見範圍也與舊版相同（擁有者、行程組織）
-- 收件人讀取只能開放給後端建立的通知，否則任何登入者都能寫一筆 recipientId 是別人
-- 的通知讓對方讀到。
--
-- 「是不是後端建立」不看資料內容（source、eventType 都由寫入者決定），也不看工作
-- 階段變數（care_ride_app 可以自己 set_config）。判斷的是觸發器執行時的
-- current_user：security definer 函式內是函式擁有者，care_ride_app 直接寫入時是
-- care_ride_app，而 care_ride_app 不是擁有者的成員，無法 SET ROLE。
--
-- 觸發器 app_state_guard_notifications（INSERT／UPDATE／DELETE）：
--   * 後端建立的通知寫入 data.serverCreated = true；其他寫入者送來的
--     serverCreated 一律移除
--   * 非後端寫入者：不能把資料列的 collection 改成或改離 notifications、不能改 id；
--     不能修改、軟刪除或刪除 serverCreated 的通知
--   * 實體 DELETE 另受 0007 權限限制（care_ride_app 沒有 DELETE 權限）
-- 收件人讀取政策只放行 serverCreated、而且在本檔安裝之後建立的通知：安裝之前的
-- 資料列可能自帶 serverCreated（當時沒有觸發器移除），不因這條政策外露。
-- 重複套用本檔會把安裝時間往後移，只會讓更少的通知可讀，不會擴大。
-- ---------------------------------------------------------------------
create or replace function app.notification_server_writer() returns name
language sql stable set search_path = public, pg_temp
as $$
  select pg_get_userbyid(p.proowner)
    from pg_proc p
   where p.oid = 'app.cancel_app_state_booking(text, text, text)'::regprocedure
$$;

create or replace function app.app_state_guard_notifications() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare
  server_writer boolean := current_user = app.notification_server_writer();
begin
  if tg_op = 'DELETE' then
    if old.collection = 'notifications' and not server_writer then
      raise exception '通知不能刪除' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and not server_writer
     and (old.collection = 'notifications' or new.collection = 'notifications') then
    if old.collection is distinct from new.collection or old.id is distinct from new.id then
      raise exception '通知的集合與 ID 不能修改' using errcode = '42501';
    end if;
    if coalesce(old.data->>'serverCreated', '') = 'true' then
      raise exception '系統通知不能由用戶端修改或刪除' using errcode = '42501';
    end if;
  end if;

  if new.collection = 'notifications' then
    if server_writer then
      if tg_op = 'INSERT' then
        new.data := new.data || jsonb_build_object('serverCreated', true);
      end if;
    else
      new.data := new.data - 'serverCreated';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists app_state_guard_notifications on app_state;
create trigger app_state_guard_notifications before insert or update or delete on app_state
  for each row execute function app.app_state_guard_notifications();

do $do$
begin
  execute format(
    'create or replace function app.notification_guard_since() returns timestamptz
       language sql stable set search_path = public, pg_temp as %L',
    format('select %L::timestamptz', now()));
end $do$;

grant execute on function app.notification_guard_since() to care_ride_app;
grant execute on function app.notification_server_writer() to care_ride_app;

drop policy if exists app_state_notification_recipient_read on app_state;
create policy app_state_notification_recipient_read on app_state for select
  using (collection = 'notifications'
         and data->>'serverCreated' = 'true'
         and created_at >= (select app.notification_guard_since())
         and data->>'recipientId' = (select app.current_user_id()));
