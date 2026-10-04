-- =====================================================================
-- 0013：後台重設密碼的權限判斷（#58 第一部分，取代簡訊重設密碼）
--
-- 不再發簡訊驗證碼。忘記密碼時由有權限的人在後台重設，產生一組臨時密碼交給本人：
--   - 平台超級管理者：自己以外的任何帳號
--   - 機構負責人：只限「所有工作身分都在自己擔任負責人的機構、而且只是調度員或司機」的人
--     （需求者身分不算工作身分）。對象若同時是別家機構的成員、或在任何地方是負責人，
--     負責人就不能重設：否則等於可以接管別家機構的帳號。
--   - 其他人（調度員、司機、需求者）都不能重設別人
-- 任何人都不能用這個方式重設自己（改自己的密碼走「我的帳戶」，要現行密碼）。
--
-- 對象不在權限範圍內、或根本不存在時一律回傳 0 列，呼叫端無從分辨，不洩漏帳號是否存在。
-- security definer：負責人看不到對象在別家機構的成員資格，必須在這裡判斷。
-- =====================================================================

create function app.password_reset_target(p_target text)
returns table (phone_e164 text, scope text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_me text := app.current_user_id();
  v_phone text;
  v_platform_role text;
begin
  if v_me is null or p_target is null or p_target = v_me then
    return;
  end if;

  select u.phone_e164, u.platform_role into v_phone, v_platform_role
    from users u where u.id = p_target;
  if not found then
    return;
  end if;

  if app.is_super_admin() then
    return query select v_phone, 'platform'::text;
    return;
  end if;

  if v_platform_role <> 'none' then
    return;
  end if;

  -- 停權（suspended）的成員資格也算：之後恢復時不能變成別家機構的帳號被接管
  if exists (
       select 1 from memberships m
        where m.user_id = p_target and m.status in ('active', 'suspended') and m.role <> 'requester')
     and not exists (
       select 1 from memberships m
        where m.user_id = p_target and m.status in ('active', 'suspended') and m.role <> 'requester'
          and (m.role not in ('dispatcher', 'driver')
               or not app.has_role_in(m.organization_id, array['owner'])))
  then
    return query select v_phone, 'owner'::text;
  end if;
end
$$;

revoke all on function app.password_reset_target(text) from public;
grant execute on function app.password_reset_target(text) to care_ride_app;
