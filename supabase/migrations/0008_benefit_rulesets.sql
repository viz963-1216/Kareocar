-- =====================================================================
-- 0008：福利規則版本與補助試算改存資料表，由伺服器計算（#23 第一部分）
--
-- benefit_rulesets：規則版本。狀態 draft → approved／rejected；核准新版本時，同一個
--   program code 與服務類型原本的 approved 版本自動變成 superseded。任一時點同一個
--   program code 與服務類型只有一個 approved（部分唯一索引保證）。
-- benefit_assessments：補助試算。伺服器依當下的 approved 版本計算並記錄版本 ID。
--
-- care_ride_app 對兩張表都只有 SELECT；寫入只經 security definer 函式：
--   app.save_benefit_ruleset_draft、app.review_benefit_ruleset（只有平台超級管理者）
--   app.record_benefit_assessment（伺服器計算後寫入）
--
-- benefit_assessments 的服務對象外鍵指向尚未使用的 care_recipients 資料表（服務對象目前在
-- app_state），所以先拿掉。
-- =====================================================================

create table benefit_rulesets (
  id                   text primary key,
  code                 text not null,
  version              text not null,
  name                 text not null default '',
  service_type         text not null default 'transportation',
  jurisdiction_city    text,
  effective_from       date,
  effective_to         date,
  status               text not null default 'draft',
  conditions           jsonb not null default '{}'::jsonb,
  calculation          jsonb not null default '{}'::jsonb,
  source               jsonb not null default '{}'::jsonb,
  review_note          text,
  created_by_user_id   text references users(id),
  approved_by_user_id  text references users(id),
  approved_at          timestamptz,
  superseded_at        timestamptz,
  rejected_by_user_id  text references users(id),
  rejected_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint benefit_rulesets_status_check check (status in ('draft', 'approved', 'superseded', 'rejected')),
  constraint benefit_rulesets_effective_check check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create unique index benefit_rulesets_code_version_idx on benefit_rulesets (code, version);
create unique index benefit_rulesets_one_approved_idx on benefit_rulesets (code, service_type) where status = 'approved';

alter table benefit_rulesets enable row level security;
-- 規則是公開資訊：登入者都讀得到（需求者畫面要顯示試算依據）
create policy benefit_rulesets_read on benefit_rulesets for select using (app.current_user_id() is not null);
grant select on benefit_rulesets to care_ride_app;

-- ---------------------------------------------------------------------
-- 草稿：新增或修改（只有草稿能改）
-- ---------------------------------------------------------------------
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

grant execute on function app.save_benefit_ruleset_draft(text, jsonb) to care_ride_app;

-- ---------------------------------------------------------------------
-- 審核：核准（舊的 approved 變 superseded）或駁回。內容檢查在 v2-benefit-ruleset。
-- ---------------------------------------------------------------------
create or replace function app.review_benefit_ruleset(p_id text, p_decision text, p_note text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r benefit_rulesets%rowtype;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以審核補助規則' using errcode = '42501';
  end if;
  select * into r from benefit_rulesets where id = p_id for update;
  if not found then
    raise exception '找不到補助規則' using errcode = 'P0002';
  end if;
  if r.status <> 'draft' then
    raise exception '只有草稿可以審核（目前是 %）', r.status using errcode = 'CR400';
  end if;
  if p_decision = 'approve' then
    update benefit_rulesets
       set status = 'superseded', superseded_at = now(), updated_at = now()
     where code = r.code and service_type = r.service_type and status = 'approved';
    update benefit_rulesets
       set status = 'approved', approved_by_user_id = app.current_user_id(), approved_at = now(),
           review_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
     where id = p_id;
    return 'approved';
  elsif p_decision = 'reject' then
    if btrim(coalesce(p_note, '')) = '' then
      raise exception '駁回必須填寫原因' using errcode = 'CR400';
    end if;
    update benefit_rulesets
       set status = 'rejected', rejected_by_user_id = app.current_user_id(), rejected_at = now(),
           review_note = btrim(p_note), updated_at = now()
     where id = p_id;
    return 'rejected';
  end if;
  raise exception '不支援的審核決定：%', p_decision using errcode = 'CR400';
end $$;

grant execute on function app.review_benefit_ruleset(text, text, text) to care_ride_app;

-- ---------------------------------------------------------------------
-- 補助試算
-- ---------------------------------------------------------------------
alter table benefit_assessments drop constraint if exists benefit_assessments_care_recipient_id_fkey;
alter table benefit_assessments
  add column organization_id   text,
  add column program_code      text,
  add column requested_service text,
  add column service_date      date,
  add column status            text,
  add column ruleset_id        text references benefit_rulesets(id),
  add column facts             jsonb not null default '{}'::jsonb,
  add column currency          text not null default 'TWD';

drop policy if exists benefit_read on benefit_assessments;
drop policy if exists benefit_insert on benefit_assessments;
-- 讀取：平台管理者、建立者、服務對象的擁有者、正在服務這位服務對象的機構
create policy benefit_read on benefit_assessments for select
  using (app.is_super_admin()
         or created_by_user_id = app.current_user_id()
         or exists (select 1 from app_state s
                     where s.collection = 'careRecipients' and s.id = benefit_assessments.care_recipient_id
                       and s.owner_user_id = app.current_user_id())
         or exists (select 1 from app_state s
                     where s.collection = 'bookings' and not s.deleted
                       and s.data->>'recipientId' = benefit_assessments.care_recipient_id
                       and s.organization_id = any(app.my_ops_orgs())));
revoke insert, update, delete on benefit_assessments from care_ride_app;

create or replace function app.record_benefit_assessment(p jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into benefit_assessments (id, care_recipient_id, assessed_on, cms_level, identity_category,
                                   estimated_subsidy, estimated_copay, ruleset_version, source, result,
                                   created_by_user_id, data, organization_id, program_code, requested_service,
                                   service_date, status, ruleset_id, facts, currency)
  values (p->>'id', p->>'recipientId', current_date, p->'facts'->>'cmsLevel', p->'facts'->>'identityCategory',
          nullif(p->>'estimatedSubsidy', '')::numeric, nullif(p->>'estimatedCopay', '')::numeric,
          p->>'rulesetVersion', 'server', p->>'status', app.current_user_id(), p,
          nullif(p->>'organizationId', ''), p->>'programCode', p->>'requestedService',
          nullif(p->>'serviceDate', '')::date, p->>'status', nullif(p->>'rulesetId', ''),
          coalesce(p->'facts', '{}'::jsonb), coalesce(nullif(p->>'currency', ''), 'TWD'));
  return p->>'id';
end $$;

grant execute on function app.record_benefit_assessment(jsonb) to care_ride_app;
