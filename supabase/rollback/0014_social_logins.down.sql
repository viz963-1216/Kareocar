-- 回復 0014（回復前先在 Supabase 主控台停用 Custom Access Token Hook）
drop function if exists public.custom_access_token_hook(jsonb);
drop function if exists app.social_login_user(text);
drop function if exists app.purge_social_logins(text);
drop function if exists app.unlink_social_login(text);
drop function if exists app.link_social_login(text, text, text);
drop table if exists social_logins;
