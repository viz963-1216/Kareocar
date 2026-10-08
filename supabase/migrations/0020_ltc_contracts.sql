-- =====================================================================
-- 0020：長照特約（#99）
--
-- 用語表：長照特約是接送機構與縣市政府簽約、提供長照交通接送服務的資格，限定縣市與有效期間，
-- 由平台管理者看過契約後標記。只有長照特約的接送，服務對象才能使用長照交通補助（#101 使用）。
--
--   ltc_contracts         一家機構可以有多筆（不同縣市或續約）；縣市一律存成「台」字
--   app.save_ltc_contract / app.remove_ltc_contract
--                         只有平台超級管理者能呼叫，每次寫稽核紀錄；資料表本身不開放寫入
--   app.ltc_contract_active(機構, 縣市, 日期)
--                         這家機構在這個縣市、這一天是否有有效的長照特約
-- 讀取：平台管理者看全部；機構的負責人、調度員看自己機構的。
-- =====================================================================

create or replace function app.normalize_city(p_city text) returns text
language sql immutable
as $$ select nullif(btrim(replace(coalesce(p_city, ''), '臺', '台')), '') $$;

create table ltc_contracts (
  id                  text primary key,
  organization_id     text not null references organizations(id) on delete cascade,
  city                text not null,
  contract_no         text not null,
  valid_from          date not null,
  valid_to            date,
  created_by_user_id  text references users(id) on delete set null,
  updated_by_user_id  text references users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create index ltc_contracts_org_idx on ltc_contracts (organization_id);
alter table ltc_contracts enable row level security;
create policy ltc_contracts_read on ltc_contracts for select
  using (app.is_super_admin() or organization_id = any(app.my_ops_orgs()));
grant select on ltc_contracts to care_ride_app;

create or replace function app.save_ltc_contract(p_id text, p_organization_id text, p_city text, p_contract_no text,
                                                 p_valid_from date, p_valid_to date)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id     text := coalesce(nullif(btrim(coalesce(p_id, '')), ''), 'LTC-' || replace(gen_random_uuid()::text, '-', ''));
  v_city   text := app.normalize_city(p_city);
  v_before jsonb;
  v_after  jsonb;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以標記長照特約' using errcode = '42501';
  end if;
  if not exists (select 1 from organizations where id = p_organization_id and org_type <> 'requester_hub') then
    raise exception '找不到可標記長照特約的接送機構' using errcode = 'CR400';
  end if;
  if v_city is null or v_city not in ('台北市','新北市','桃園市','台中市','台南市','高雄市','基隆市','新竹市','嘉義市',
      '新竹縣','苗栗縣','彰化縣','南投縣','雲林縣','嘉義縣','屏東縣','宜蘭縣','花蓮縣','台東縣','澎湖縣','金門縣','連江縣') then
    raise exception '縣市不正確' using errcode = 'CR400';
  end if;
  if nullif(btrim(coalesce(p_contract_no, '')), '') is null or length(p_contract_no) > 100 then
    raise exception '請填寫契約字號' using errcode = 'CR400';
  end if;
  if p_valid_from is null or (p_valid_to is not null and p_valid_to < p_valid_from) then
    raise exception '有效期間不正確' using errcode = 'CR400';
  end if;
  select to_jsonb(c) into v_before from ltc_contracts c where c.id = v_id;
  if v_before is not null and v_before->>'organization_id' <> p_organization_id then
    raise exception '不能把長照特約改到其他機構' using errcode = 'CR400';
  end if;
  insert into ltc_contracts (id, organization_id, city, contract_no, valid_from, valid_to, created_by_user_id, updated_by_user_id)
  values (v_id, p_organization_id, v_city, btrim(p_contract_no), p_valid_from, p_valid_to, app.current_user_id(), app.current_user_id())
  on conflict (id) do update set city = excluded.city, contract_no = excluded.contract_no, valid_from = excluded.valid_from,
    valid_to = excluded.valid_to, updated_by_user_id = excluded.updated_by_user_id, updated_at = now();
  select to_jsonb(c) into v_after from ltc_contracts c where c.id = v_id;
  insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'ltc_contract.saved', app.current_user_id(), p_organization_id,
          'ltc_contract', v_id, jsonb_build_object('before', v_before, 'after', v_after));
  return v_id;
end $$;

create or replace function app.remove_ltc_contract(p_id text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not app.is_super_admin() then
    raise exception '只有平台超級管理者可以移除長照特約' using errcode = '42501';
  end if;
  select to_jsonb(c) into v_before from ltc_contracts c where c.id = p_id;
  if v_before is null then
    raise exception '找不到長照特約' using errcode = 'P0002';
  end if;
  delete from ltc_contracts where id = p_id;
  insert into audit_events (id, event_type, actor_user_id, organization_id, entity_type, entity_id, details)
  values ('AUD-' || replace(gen_random_uuid()::text, '-', ''), 'ltc_contract.removed', app.current_user_id(),
          v_before->>'organization_id', 'ltc_contract', p_id, jsonb_build_object('before', v_before));
end $$;

-- 這家機構在這個縣市、這一天是否有有效的長照特約（給補助資訊判斷用，任何人都能問，不回傳契約內容）
create or replace function app.ltc_contract_active(p_organization_id text, p_city text, p_date date)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from ltc_contracts c
                  where c.organization_id = p_organization_id and c.city = app.normalize_city(p_city)
                    and c.valid_from <= p_date and (c.valid_to is null or c.valid_to >= p_date))
$$;

grant execute on function app.save_ltc_contract(text, text, text, text, date, date) to care_ride_app;
grant execute on function app.remove_ltc_contract(text) to care_ride_app;
grant execute on function app.ltc_contract_active(text, text, date) to care_ride_app;
