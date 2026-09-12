-- =====================================================================
-- 建立一組測試服務單位：ORG-TEST-001 與它的負責人
--
-- 執行位置：Supabase Dashboard → SQL Editor
-- 目標資料庫：Netlify 環境變數 DATABASE_URL 指向的那個 Supabase 專案
--             （本專案沒有獨立的測試環境，這是正式庫）
--
-- ---------------------------------------------------------------------
-- 為什麼這一步一定要用 SQL 而不是走網站
--
--   supabase/migrations/0002_rls.sql:173
--     org_insert 政策 with check (app.is_super_admin())
--     → 只有超級管理者能建立組織
--
--   supabase/migrations/0002_rls.sql:238
--     memberships_write 政策 with check (... and role <> 'owner')
--     → 連組織本身的 owner 都不能再指派另一位 owner
--
--   兩條合起來，網站端沒有任何角色做得到「建立組織 + 指派負責人」。
--
--   注意 SQL Editor 能執行的真正原因：它以 postgres 角色連線，是資料表
--   擁有者，直接繞過「全部」RLS 政策——不是因為它通過了 is_super_admin()
--   檢查。也就是說這條路上沒有任何政策會幫你擋錯誤，貼什麼就寫什麼。
--   （netlify/functions/_db.js:22 特地禁止 DATABASE_URL 使用 postgres
--   角色，就是為了避免應用程式走到這條沒有防護的路。）
--
-- ---------------------------------------------------------------------
-- 這份 SQL 不做的事
--
--   * 不寫密碼。密碼是加了 pepper 的雜湊，SQL 算不出來。
--   * 不建車輛。車輛實際存在 app_state，由網站／API 寫入；直接塞進 typed
--     的 vehicles 表前端看不到，只會製造「資料明明有卻不顯示」的假象。
--   * 不覆寫任何既有資料，不提升任何其他帳號的權限。
--     任何預期外的狀況一律報錯回滾，不靜默跳過。
--
-- ---------------------------------------------------------------------
-- 執行順序：三步，請「分別」執行，不要一次全選跑完。
--
--   第一步  唯讀。列出目標使用者，由人確認是否確為測試帳號。
--   第二步  單一交易。有任何前置或結果不符就 raise exception 並回滾。
--   第三步  唯讀。固定回傳一列驗證結果，不需要人工數列數。
--
-- 常數集中在這裡，三步都用同一組值：
--   手機        +886900000010
--   組織        ORG-TEST-001
--   membership  MEM-TEST-OWNER
-- =====================================================================


-- =====================================================================
-- [CI] STEP1_BEGIN
-- 第一步（唯讀）：確認目標使用者
--
-- 這一步刻意不由程式判斷「這是不是測試帳號」——手機號碼或顯示名稱都不足
-- 以證明。請人工看過下面這列，確認是你要指派為負責人的那個測試帳號，
-- 再執行第二步。
--
-- 預期：剛好一列，且 active = true。
-- 若回傳零列或 active = false，不要執行第二步。
-- =====================================================================

select
  u.id,
  u.display_name,
  u.phone_e164,
  u.email,
  u.auth_provider,
  u.platform_role,
  u.active,
  u.created_at,
  (select count(*) from memberships m
    where m.user_id = u.id and m.status = 'active') as 目前啟用中的身分數,
  (select string_agg(m.organization_id || ':' || m.role, ', ' order by m.organization_id)
     from memberships m
    where m.user_id = u.id and m.status = 'active')  as 目前的身分
from users u
where u.phone_e164 = '+886900000010';


-- [CI] STEP1_END


-- =====================================================================
-- 第二步（單一交易，會寫入）
--
-- 確認第一步的結果無誤之後再執行這一段。
-- 整段包在一個交易裡，任何 raise exception 都會讓全部回滾。
-- =====================================================================

-- [CI] STEP2_BEGIN
-- 註：DO 區塊本身就是原子的，任何 exception 都會讓整段寫入回滾。
-- 外面再包一層 begin/commit 是為了在 SQL Editor 裡意圖明確。若編輯器已經
-- 自己開了交易，這裡的 begin 會出現「already a transaction in progress」
-- 警告，可以忽略，不影響回滾語意。
begin;

do $$
declare
  -- 目標值
  c_phone     constant text := '+886900000010';
  c_org_id    constant text := 'ORG-TEST-001';
  c_mem_id    constant text := 'MEM-TEST-OWNER';
  c_org_type  constant text := 'transport_provider';
  c_org_name  constant text := '測試服務單位（請勿使用）';
  c_org_phone constant text := '0212345678';

  v_user_cnt    integer;
  v_user_id     text;
  v_user_active boolean;
  v_user_name   text;

  v_org         organizations%rowtype;
  v_mem         memberships%rowtype;
  v_owner       memberships%rowtype;

  v_org_created boolean := false;
  v_mem_created boolean := false;
  v_owner_cnt   integer;
begin
  ------------------------------------------------------------------
  -- 1. 使用者：必須恰好一位，且啟用中
  ------------------------------------------------------------------
  select count(*) into v_user_cnt
    from users where phone_e164 = c_phone;

  if v_user_cnt = 0 then
    raise exception
      '找不到 phone_e164 = % 的使用者。請先確認測試帳號已註冊、且號碼格式是 E.164（+886 開頭，不是 09 開頭）。不要改用其他號碼。',
      c_phone;
  end if;

  if v_user_cnt > 1 then
    -- 0001_schema.sql:42 phone_e164 是 unique，理論上不會發生；
    -- 真的發生代表 schema 與預期不符，必須人工釐清。
    raise exception
      '手機 % 對應 % 位使用者，超出預期（phone_e164 應為唯一鍵）。請人工釐清後再執行。',
      c_phone, v_user_cnt;
  end if;

  select id, active, display_name
    into v_user_id, v_user_active, v_user_name
    from users where phone_e164 = c_phone;

  if not v_user_active then
    raise exception
      '使用者 %（%）存在但 active = false。停用中的帳號不指派為負責人；請先確認該帳號狀態。',
      v_user_id, v_user_name;
  end if;

  raise notice '目標使用者：% / % / %', v_user_id, v_user_name, c_phone;

  ------------------------------------------------------------------
  -- 2. 組織：不存在才建立；已存在則必須完全相符才允許跳過
  ------------------------------------------------------------------
  select * into v_org from organizations where id = c_org_id;

  if not found then
    insert into organizations (id, org_type, name, contact_phone, active)
    values (c_org_id, c_org_type, c_org_name, c_org_phone, true);
    v_org_created := true;
    raise notice '已新增組織 %', c_org_id;
  else
    -- 主鍵被其他資料占用，或既有內容與預期不符：報錯，不覆寫。
    if v_org.org_type      is distinct from c_org_type
    or v_org.name          is distinct from c_org_name
    or v_org.contact_phone is distinct from c_org_phone
    or v_org.active        is distinct from true then
      raise exception
        '組織 % 已存在但內容與預期不符，不自動覆寫。實際值：org_type=%, name=%, contact_phone=%, active=%。預期值：org_type=%, name=%, contact_phone=%, active=true。請人工確認這個 ID 是否已被其他資料占用。',
        c_org_id, v_org.org_type, v_org.name, v_org.contact_phone, v_org.active,
        c_org_type, c_org_name, c_org_phone;
    end if;
    raise notice '組織 % 已存在且內容相符，跳過', c_org_id;
  end if;

  ------------------------------------------------------------------
  -- 3. 負責人 membership
  --
  -- 相關唯一約束（0001_schema.sql:85-89）：
  --   memberships_single_owner_idx  (organization_id) where role='owner' and status='active'
  --     → 一個組織同時只能有一位有效負責人
  --   memberships_unique_active_idx (user_id, organization_id, role) where status='active'
  --     → 同一人在同一組織的同一角色不重複
  --
  -- 所以「同樣的關聯換一個 membership ID 再插一筆」會直接違反約束，
  -- 底下明確擋掉，不讓它變成執行期的 unique violation。
  ------------------------------------------------------------------
  select * into v_mem from memberships where id = c_mem_id;

  select * into v_owner
    from memberships
   where organization_id = c_org_id
     and role = 'owner'
     and status = 'active';

  if v_mem.id is not null then
    -- 3a. 目標主鍵已被使用：必須完全是我們要的那筆，否則報錯
    if v_mem.user_id         is distinct from v_user_id
    or v_mem.organization_id is distinct from c_org_id
    or v_mem.role           is distinct from 'owner'
    or v_mem.status         is distinct from 'active' then
      raise exception
        'membership 主鍵 % 已被其他資料占用，不覆寫。實際值：user_id=%, organization_id=%, role=%, status=%。預期值：user_id=%, organization_id=%, role=owner, status=active。',
        c_mem_id, v_mem.user_id, v_mem.organization_id, v_mem.role, v_mem.status,
        v_user_id, c_org_id;
    end if;
    raise notice 'membership % 已存在且關聯相符，跳過', c_mem_id;

  elsif v_owner.id is not null then
    -- 3b. 主鍵沒被用，但這個組織已經有一位啟用中的負責人
    if v_owner.user_id = v_user_id then
      -- 同一個人、同一個組織、同樣是 owner，只是 membership ID 不同。
      -- 關聯本身已經正確，但再插一筆會違反 memberships_unique_active_idx，
      -- 所以不新增，也不擅自改 ID——交由人決定要沿用既有 ID 還是先撤銷。
      raise exception
        '使用者 % 已經是組織 % 的啟用中負責人，但 membership ID 是 %，不是預期的 %。關聯本身正確，只是 ID 不同；新增會違反 memberships_unique_active_idx（user_id, organization_id, role）。不新增重複關聯。請決定：沿用既有 ID %，或先處理該筆再重跑。',
        v_user_id, c_org_id, v_owner.id, c_mem_id, v_owner.id;
    else
      -- 別人是負責人：絕不奪取、不覆寫、不提升任何帳號權限
      raise exception
        '組織 % 已經有另一位啟用中的負責人（membership=%, user_id=%）。不覆寫既有負責人，也不提升其他帳號權限。請人工確認後再決定。',
        c_org_id, v_owner.id, v_owner.user_id;
    end if;

  else
    -- 3c. 兩個約束都沒被占用：可以安全新增
    insert into memberships (id, user_id, organization_id, role, status)
    values (c_mem_id, v_user_id, c_org_id, 'owner', 'active');
    v_mem_created := true;
    raise notice '已新增 membership %（user_id=%）', c_mem_id, v_user_id;
  end if;

  ------------------------------------------------------------------
  -- 4. 結果驗證：在交易內重查，不符就回滾
  --    （前面每個分支都檢查過前置條件，這裡驗的是「寫完之後的實際狀態」）
  ------------------------------------------------------------------
  perform 1 from organizations
   where id = c_org_id
     and org_type = c_org_type
     and name = c_org_name
     and contact_phone = c_org_phone
     and active;
  if not found then
    raise exception '結果驗證失敗：組織 % 寫入後狀態不符預期，回滾。', c_org_id;
  end if;

  select count(*) into v_owner_cnt
    from memberships
   where organization_id = c_org_id
     and role = 'owner'
     and status = 'active';
  if v_owner_cnt <> 1 then
    raise exception
      '結果驗證失敗：組織 % 的啟用中負責人有 % 位，預期 1 位，回滾。',
      c_org_id, v_owner_cnt;
  end if;

  perform 1 from memberships
   where organization_id = c_org_id
     and role = 'owner'
     and status = 'active'
     and user_id = v_user_id;
  if not found then
    raise exception
      '結果驗證失敗：組織 % 的負責人不是預期的使用者 %，回滾。',
      c_org_id, v_user_id;
  end if;

  raise notice '完成。組織新增=%，membership 新增=%（兩個都是 f 代表本來就存在且相符）',
    v_org_created, v_mem_created;
end $$;

commit;
-- [CI] STEP2_END


-- =====================================================================
-- [CI] STEP3_BEGIN
-- 第三步（唯讀）：驗證
--
-- 固定回傳一列，不論成功或失敗，也不論組織／使用者／負責人是否存在。
-- 只要看第一欄 驗證結果：PASS 才算成功，其餘都是 FAIL 並附原因。
-- 不需要人工數列數。
-- =====================================================================

with p as (
  select '+886900000010'::text  as phone,
         'ORG-TEST-001'::text   as org_id,
         'MEM-TEST-OWNER'::text as mem_id
),
f as (
  select
    p.*,
    (select count(*)        from users x where x.phone_e164 = p.phone)      as user_cnt,
    (select max(x.id)       from users x where x.phone_e164 = p.phone)      as user_id,
    (select bool_or(x.active) from users x where x.phone_e164 = p.phone)    as user_active,
    (select max(x.display_name) from users x where x.phone_e164 = p.phone)  as user_name,
    (select count(*)        from organizations g where g.id = p.org_id)     as org_cnt,
    (select max(g.name)     from organizations g where g.id = p.org_id)     as org_name,
    (select max(g.org_type) from organizations g where g.id = p.org_id) as org_type,
    (select max(g.contact_phone) from organizations g where g.id = p.org_id) as org_phone,
    (select bool_or(g.active) from organizations g where g.id = p.org_id)   as org_active,
    (select count(*) from memberships s
      where s.organization_id = p.org_id and s.role = 'owner'
        and s.status = 'active')                                            as owner_cnt,
    (select max(s.user_id) from memberships s
      where s.organization_id = p.org_id and s.role = 'owner'
        and s.status = 'active')                                            as owner_user_id,
    (select max(s.id) from memberships s
      where s.organization_id = p.org_id and s.role = 'owner'
        and s.status = 'active')                                            as owner_mem_id
  from p
)
select
  case
    when org_cnt = 0            then 'FAIL：組織 ' || org_id || ' 不存在'
    when org_active is not true then 'FAIL：組織存在但 active = false'
    when org_name is distinct from '測試服務單位（請勿使用）'
      or org_type is distinct from 'transport_provider'
      or org_phone is distinct from '0212345678'
                                then 'FAIL：組織內容與預期不符'
    when user_cnt = 0           then 'FAIL：找不到 phone_e164 = ' || phone || ' 的使用者'
    when user_cnt > 1           then 'FAIL：該手機對應 ' || user_cnt || ' 位使用者'
    when user_active is not true then 'FAIL：使用者 ' || user_id || ' 已停用'
    when owner_cnt = 0          then 'FAIL：組織沒有啟用中的負責人'
    when owner_cnt > 1          then 'FAIL：組織有 ' || owner_cnt || ' 位啟用中負責人'
    when owner_user_id is distinct from user_id
                                then 'FAIL：負責人是 ' || coalesce(owner_user_id, '(null)')
                                     || '，不是預期的 ' || coalesce(user_id, '(null)')
    when owner_mem_id is distinct from mem_id
                                then 'FAIL：membership ID 是 ' || coalesce(owner_mem_id, '(null)')
                                     || '，不是 ' || mem_id
    else 'PASS'
  end                as 驗證結果,
  org_id             as 組織ID,
  org_name           as 組織名稱,
  org_active         as 組織啟用,
  user_id            as 使用者ID,
  user_name          as 使用者名稱,
  user_active        as 使用者啟用,
  owner_cnt          as 啟用中負責人數,
  owner_user_id      as 負責人使用者ID,
  owner_mem_id       as 負責人membershipID
from f;
-- [CI] STEP3_END
