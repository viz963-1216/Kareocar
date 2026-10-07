-- 回復 0015：設定函式改回 0010 的版本（只接受保存期限與條款版本），移除公開設定
drop function if exists app.public_settings();
delete from app_settings where key in ('login_methods', 'support_contact');

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
  else
    raise exception '不支援的設定：%', p_key using errcode = 'CR400';
  end if;
  insert into app_settings (key, value, updated_by_user_id, updated_at)
  values (p_key, p_value, app.current_user_id(), now())
  on conflict (key) do update set value = excluded.value, updated_by_user_id = excluded.updated_by_user_id, updated_at = now();
end $$;
grant execute on function app.set_platform_setting(text, jsonb) to care_ride_app;
