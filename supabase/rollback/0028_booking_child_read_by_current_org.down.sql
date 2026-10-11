-- 回復 0028：異動紀錄與修改快照回到看資料列自己的機構（baseline 的 app_state_read）
drop policy if exists app_state_booking_child_read on app_state;
drop policy if exists app_state_read on app_state;
create policy app_state_read on app_state for select
  using (app.is_super_admin()
         or owner_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));
