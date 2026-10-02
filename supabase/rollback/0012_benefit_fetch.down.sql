-- 回復 0012：草稿儲存函式回到 0008 的版本
create or replace function app.save_benefit_ruleset_draft(p_id text, p_data jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以管理補助規則' using errcode = '42501';
  end if;
  select status into v_status from benefit_rulesets where id = p_id for update;
  if found and v_status <> 'draft' then
    raise exception '只有草稿可以修改；已核准的規則要新增版本' using errcode = 'CR400';
  end if;
  insert into benefit_rulesets (id, code, version, name, service_type, jurisdiction_city, effective_from, effective_to,
                                conditions, calculation, source, created_by_user_id)
  values (p_id, p_data->>'code', p_data->>'version', coalesce(p_data->>'name', ''),
          coalesce(nullif(p_data->>'serviceType', ''), 'transportation'), nullif(p_data->>'jurisdictionCity', ''),
          nullif(p_data->>'effectiveFrom', '')::date, nullif(p_data->>'effectiveTo', '')::date,
          coalesce(p_data->'conditions', '{}'::jsonb), coalesce(p_data->'calculation', '{}'::jsonb),
          coalesce(p_data->'source', '{}'::jsonb), app.current_user_id())
  on conflict (id) do update
    set code = excluded.code, version = excluded.version, name = excluded.name,
        service_type = excluded.service_type, jurisdiction_city = excluded.jurisdiction_city,
        effective_from = excluded.effective_from, effective_to = excluded.effective_to,
        conditions = excluded.conditions, calculation = excluded.calculation, source = excluded.source,
        updated_at = now();
  return p_id;
end $$;

drop function if exists app.create_auto_benefit_draft(jsonb);
drop function if exists app.record_benefit_fetch(jsonb);
drop function if exists app.assert_system_or_admin();
delete from benefit_rulesets where origin = 'auto_fetch';
alter table benefit_rulesets
  drop constraint benefit_rulesets_origin_check,
  drop column fetch_run_id,
  drop column diff,
  drop column source_hash,
  drop column origin;
drop table if exists benefit_source_fetches;
