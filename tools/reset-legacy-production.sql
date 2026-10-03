-- =====================================================================
-- 清空「早期以 SQL Editor 手動建立、沒有 migration 紀錄」的資料庫，讓
-- tools/apply-migrations.sh 可以從頭套用全部 migration。
--
-- 只為正式專案的一次性重建而寫（#28）。會刪掉 public 與 app 的所有資料，
-- 執行前要取得 repo 擁有者同意，並確認 Database → Backups 有最近的每日備份。
--
-- 執行方式：Supabase 正式專案 → SQL Editor，整份貼上執行（以 postgres 角色）。
--
-- 會刪：
--   * app、ops 兩個 schema（含裡面的一切）
--   * public 裡不屬於擴充套件的資料表、view、materialized view、sequence、函式、型別
--     （資料表上的 RLS 政策、觸發器一併刪除；auth.users 上呼叫這些函式的觸發器也會被 cascade）
-- 不碰：
--   * Supabase 自己的 schema（auth、storage、extensions、realtime …）與 Auth 帳號
--   * 擴充套件的物件（例如裝在 public 的 pgcrypto 函式）
--   * care_ride_app 角色（角色是整個叢集共用的；baseline 以「不存在才建立」處理）
--
-- 安全機制：
--   * 已有 migration 紀錄（ops.schema_migrations 有資料）就拒絕：那種庫要用新的 migration 往前修
--   * 全部在一個交易裡；最後檢查 public／app 已沒有任何資料表或 view，不是的話整筆回滾
-- =====================================================================

begin;

do $$
declare
  recorded boolean := false;
begin
  -- 資料表可能不存在，所以用動態 SQL，避免函式編譯時就找不到資料表
  if to_regclass('ops.schema_migrations') is not null then
    execute 'select exists (select 1 from ops.schema_migrations)' into recorded;
  end if;
  if recorded then
    raise exception '拒絕執行：這個資料庫已由 migration 管理（ops.schema_migrations 有紀錄），不能用這支清空';
  end if;
end $$;

drop schema if exists app cascade;
drop schema if exists ops cascade;

do $$
declare
  r record;
begin
  -- 先 view 再資料表、最後 sequence：cascade 會順帶刪掉相依物件，所以都用 if exists
  for r in
    select c.relkind, format('%I.%I', n.nspname, c.relname) as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm', 'r', 'p', 'f', 'S')
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    order by case c.relkind when 'v' then 1 when 'm' then 2 when 'S' then 4 else 3 end
  loop
    execute format('drop %s if exists %s cascade',
      case r.relkind when 'v' then 'view' when 'm' then 'materialized view'
                     when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end,
      r.name);
  end loop;

  for r in
    select p.oid::regprocedure::text as sig, p.prokind
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('drop %s if exists %s cascade',
      case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.sig);
  end loop;

  -- 獨立的型別（enum、domain、composite）；資料表的列型別已隨資料表刪除
  for r in
    select format('%I.%I', n.nspname, t.typname) as name, t.typtype
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typtype in ('e', 'd', 'c', 'r')
      and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
  loop
    execute format('drop %s if exists %s cascade',
      case r.typtype when 'd' then 'domain' else 'type' end, r.name);
  end loop;
end $$;

do $$
declare
  remaining int;
begin
  select count(*) into remaining
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'app') and c.relkind in ('r', 'v', 'm', 'p', 'f')
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
  if remaining <> 0 then
    raise exception '清空後 public／app 仍有 % 個資料表或 view，整筆回滾', remaining;
  end if;
end $$;

commit;

select '清空完成：可以用 Deploy migrations（target=production）套用全部 migration' as result;
