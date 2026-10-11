-- =====================================================================
-- 0028：預約的異動紀錄與修改快照，依預約「現在」的承接機構決定誰看得到（#131，ADR 0005）
--
-- 原本 bookingEvents、bookingRevisions 跟其他集合一樣，看資料列自己的 organization_id
-- （寫入當下的承接機構）。預約退回需求池或換機構之後，原機構還讀得到這筆預約的異動紀錄與
-- 修改快照（快照裡有完整地址），跟「退回後原機構立即失去存取」（#41）不一致。
--
-- 改成：營運方能不能讀，看正式資料表裡那筆預約現在的承接機構；新接手的機構也看得到之前的紀錄。
-- 本人（owner_user_id）與平台管理者照舊。服務證明跟著行程，行程的機構建立後不能改，不受影響。
-- =====================================================================

drop policy if exists app_state_read on app_state;
create policy app_state_read on app_state for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or (organization_id = any(app.my_ops_orgs())
             and collection not in ('bookingEvents', 'bookingRevisions')));

create policy app_state_booking_child_read on app_state for select
  using (collection in ('bookingEvents', 'bookingRevisions')
         and exists (select 1 from bookings b
                      where b.id = coalesce(app_state.booking_id, app_state.data->>'bookingId')
                        and b.organization_id = any(app.my_ops_orgs())));
