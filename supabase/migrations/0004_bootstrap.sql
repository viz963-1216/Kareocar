-- =====================================================================
-- 最小可運作的初始資料
--
-- 只建立應用程式假設一定存在的東西。沒有任何示範帳號、沒有預設密碼。
-- 超級管理者請在建立之後，用 Netlify 環境變數裡的 pepper 走
-- authBootstrapSuperAdminFromProperties_ 的等價流程設定密碼。
-- =====================================================================

-- 需求者集散組織：所有自助註冊的需求者都掛在這裡，程式碼多處硬編此 ID。
insert into organizations (id, org_type, name, active)
values ('ORG-REQ-001', 'requester_hub', '需求者組織', true)
on conflict (id) do nothing;

-- =====================================================================
-- 建立超級管理者（手動執行，不要留在 migration 裡自動跑）
--
-- 1. 先在這裡建帳號（沒有密碼，登入不了）：
--
--      insert into users (id, display_name, phone_e164, platform_role, active)
--      values ('USR-ROOT-0001', '平台超級管理者', '+886900000000', 'super_admin', true);
--
-- 2. 再由應用程式呼叫 app.set_credential() 寫入密碼雜湊。雜湊必須由
--    Netlify Function 用環境變數裡的 AUTH_PASSWORD_PEPPER 算出來——
--    絕對不要在 SQL 裡放明文密碼，那會留在 Supabase 的查詢紀錄裡。
-- =====================================================================
