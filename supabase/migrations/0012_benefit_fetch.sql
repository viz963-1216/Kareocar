-- =====================================================================
-- 0012：福利規則排程抓取、草稿與差異（#24）
--
-- 後端排程（benefit-rules-fetch）抓政府公告頁面，每次抓取都記在 benefit_source_fetches
-- （網址、時間、HTTP 狀態、內容雜湊）。內容雜湊和上一次產生草稿或目前 approved 的版本相同時
-- 不產生新草稿；不同就解析成「自動抓取」草稿，附上與目前 approved 版本的差異，由平台管理員
-- 審核（0008 的 app.review_benefit_ruleset）。抓取或解析失敗時送出告警，現行版本不變。
--
-- 寫入只經 security definer 函式，只允許系統排程（沒有登入者）或平台超級管理者。
-- =====================================================================

create table benefit_source_fetches (
  id            text primary key,
  source_id     text not null,
  url           text not null,
  fetched_at    timestamptz not null default now(),
  status        text not null,
  http_status   int,
  content_hash  text,
  bytes         int,
  error         text,
  run_id        text not null,
  constraint benefit_source_fetches_status_check check (status in ('ok', 'failed'))
);
create index benefit_source_fetches_run_idx on benefit_source_fetches (run_id);
alter table benefit_source_fetches enable row level security;
-- 平台管理者，以及系統排程（沒有登入者）判斷附表是否改版時讀得到
create policy benefit_source_fetches_read on benefit_source_fetches for select
  using (app.is_super_admin() or app.current_user_id() is null);
grant select on benefit_source_fetches to care_ride_app;

-- 規則版本是公開資訊；系統排程（沒有登入者）也要讀得到目前核准的版本來比對差異
drop policy if exists benefit_rulesets_read on benefit_rulesets;
create policy benefit_rulesets_read on benefit_rulesets for select using (true);

alter table benefit_rulesets
  add column origin       text not null default 'manual',
  add column source_hash  text,
  add column diff         jsonb,
  add column fetch_run_id text,
  add constraint benefit_rulesets_origin_check check (origin in ('manual', 'auto_fetch'));

create or replace function app.assert_system_or_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is not null and not app.is_super_admin() then
    raise exception '只有系統排程或平台超級管理者可以執行' using errcode = '42501';
  end if;
end $$;

create or replace function app.record_benefit_fetch(p jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id text := 'bfetch_' || replace(gen_random_uuid()::text, '-', '');
begin
  perform app.assert_system_or_admin();
  insert into benefit_source_fetches (id, source_id, url, status, http_status, content_hash, bytes, error, run_id)
  values (v_id, p->>'sourceId', p->>'url', p->>'status', nullif(p->>'httpStatus', '')::int, p->>'contentHash',
          nullif(p->>'bytes', '')::int, left(p->>'error', 500), p->>'runId');
  return v_id;
end $$;

-- 自動抓取的草稿：同一個內容雜湊已經有任何版本（含被駁回的）時不重複建立，回傳 null
create or replace function app.create_auto_benefit_draft(p jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id text := 'brule_auto_' || replace(gen_random_uuid()::text, '-', '');
begin
  perform app.assert_system_or_admin();
  if exists (select 1 from benefit_rulesets
              where source_hash = p->>'sourceHash') then
    return null;
  end if;
  insert into benefit_rulesets (id, code, version, name, service_type, effective_from, conditions, calculation, source,
                                origin, source_hash, diff, fetch_run_id, created_by_user_id)
  values (v_id, p->>'code', p->>'version', p->>'name', 'transportation', (p->>'effectiveFrom')::date,
          coalesce(p->'conditions', '{}'::jsonb), coalesce(p->'calculation', '{}'::jsonb), coalesce(p->'source', '{}'::jsonb),
          'auto_fetch', p->>'sourceHash', p->'diff', p->>'runId', app.current_user_id());
  return v_id;
end $$;

-- 0008 的草稿儲存：自動抓取的草稿不能手動修改（只能核准或駁回）
create or replace function app.save_benefit_ruleset_draft(p_id text, p_data jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_origin text;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以管理補助規則' using errcode = '42501';
  end if;
  select status, origin into v_status, v_origin from benefit_rulesets where id = p_id for update;
  if found and v_status <> 'draft' then
    raise exception '只有草稿可以修改；已核准的規則要新增版本' using errcode = 'CR400';
  end if;
  if found and v_origin = 'auto_fetch' then
    raise exception '自動抓取的草稿不能手動修改，只能核准或駁回' using errcode = 'CR400';
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

grant execute on function app.assert_system_or_admin() to care_ride_app;
grant execute on function app.record_benefit_fetch(jsonb) to care_ride_app;
grant execute on function app.create_auto_benefit_draft(jsonb) to care_ride_app;
