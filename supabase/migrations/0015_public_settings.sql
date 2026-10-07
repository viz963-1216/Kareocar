-- =====================================================================
-- 0015：登入方式開關與客服聯絡（#79）
--
-- app_settings 多兩個鍵，平台管理者在平台設定頁修改，立刻生效、不用重新部署：
--   login_methods    { google: bool, facebook: bool }  登入頁顯示哪些社群登入；oauth-start 拒絕關閉的
--                    試營運期間 Facebook 預設關閉（等 Meta 審核通過再打開）
--   support_contact  { lineUrl: https 網址或 null, email: Email 或 null }
--                    忘記密碼、我的帳戶、隱私權政策顯示的客服聯絡
--
-- app_settings 的 RLS 只讓登入的人讀；登入頁還沒有登入，所以另外提供 app.public_settings()：
-- security definer，只回傳上面兩組，其他平台設定（保存期限、條款版本）不會被未登入的人讀到。
-- =====================================================================

insert into app_settings (key, value) values
  ('login_methods', '{"google": true, "facebook": false}'::jsonb),
  ('support_contact', '{"lineUrl": null, "email": null}'::jsonb)
on conflict (key) do nothing;

create or replace function app.set_platform_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以修改平台設定' using errcode = '42501';
  end if;
  if p_key = 'retention_years' then
    if jsonb_typeof(p_value) <> 'number' or (p_value::text)::numeric < 1 or (p_value::text)::numeric > 30
       or (p_value::text)::numeric <> round((p_value::text)::numeric) then
      raise exception '保存期限必須是 1 到 30 的整數年' using errcode = 'CR400';
    end if;
  elsif p_key = 'legal_documents' then
    if jsonb_typeof(p_value) <> 'object' then
      raise exception '條款設定格式錯誤' using errcode = 'CR400';
    end if;
  elsif p_key = 'login_methods' then
    if jsonb_typeof(p_value) <> 'object'
       or (select count(*) from jsonb_object_keys(p_value) k where k not in ('google', 'facebook')) > 0
       or jsonb_typeof(p_value->'google') is distinct from 'boolean'
       or jsonb_typeof(p_value->'facebook') is distinct from 'boolean' then
      raise exception '登入方式設定格式錯誤' using errcode = 'CR400';
    end if;
  elsif p_key = 'support_contact' then
    if jsonb_typeof(p_value) <> 'object'
       or (select count(*) from jsonb_object_keys(p_value) k where k not in ('lineUrl', 'email')) > 0 then
      raise exception '客服聯絡設定格式錯誤' using errcode = 'CR400';
    end if;
    if jsonb_typeof(p_value->'lineUrl') = 'string' then
      if p_value->>'lineUrl' !~ '^https://[^\s]+$' or length(p_value->>'lineUrl') > 300 then
        raise exception 'LINE 官方帳號連結必須是 https 網址' using errcode = 'CR400';
      end if;
    elsif coalesce(jsonb_typeof(p_value->'lineUrl'), 'null') <> 'null' then
      raise exception 'LINE 官方帳號連結格式錯誤' using errcode = 'CR400';
    end if;
    if jsonb_typeof(p_value->'email') = 'string' then
      if p_value->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_value->>'email') > 200 then
        raise exception '客服 Email 格式不正確' using errcode = 'CR400';
      end if;
    elsif coalesce(jsonb_typeof(p_value->'email'), 'null') <> 'null' then
      raise exception '客服 Email 格式錯誤' using errcode = 'CR400';
    end if;
  else
    raise exception '不支援的設定：%', p_key using errcode = 'CR400';
  end if;
  insert into app_settings (key, value, updated_by_user_id, updated_at)
  values (p_key, p_value, app.current_user_id(), now())
  on conflict (key) do update set value = excluded.value, updated_by_user_id = excluded.updated_by_user_id, updated_at = now();
end $$;
grant execute on function app.set_platform_setting(text, jsonb) to care_ride_app;

-- 登入頁（未登入）可讀的設定：只有登入方式與客服聯絡。沒有設定時用試營運的預設值。
create or replace function app.public_settings()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'loginMethods', jsonb_build_object(
      'google',   coalesce((select (value->>'google')::boolean   from app_settings where key = 'login_methods'), true),
      'facebook', coalesce((select (value->>'facebook')::boolean from app_settings where key = 'login_methods'), false)),
    'supportContact', jsonb_build_object(
      'lineUrl', (select value->'lineUrl' from app_settings where key = 'support_contact'),
      'email',   (select value->'email'   from app_settings where key = 'support_contact')))
$$;
revoke all on function app.public_settings() from public;
grant execute on function app.public_settings() to care_ride_app;
