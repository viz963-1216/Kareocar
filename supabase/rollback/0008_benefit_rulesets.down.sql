-- 回復 0008
drop function if exists app.record_benefit_assessment(jsonb);
drop policy if exists benefit_read on benefit_assessments;
create policy benefit_read on benefit_assessments for select
  using (app.is_super_admin()
         or created_by_user_id = app.current_user_id()
         or app.owns_recipient(care_recipient_id)
         or exists (select 1 from bookings b
                    where b.care_recipient_id = benefit_assessments.care_recipient_id
                      and b.organization_id = any(app.my_ops_orgs())));
create policy benefit_insert on benefit_assessments for insert
  with check (app.is_super_admin() or app.owns_recipient(care_recipient_id) or app.operates_any());
grant insert, update, delete on benefit_assessments to care_ride_app;
delete from benefit_assessments where source = 'server';
alter table benefit_assessments
  drop column currency,
  drop column facts,
  drop column ruleset_id,
  drop column status,
  drop column service_date,
  drop column requested_service,
  drop column program_code,
  drop column organization_id;
alter table benefit_assessments
  add constraint benefit_assessments_care_recipient_id_fkey foreign key (care_recipient_id) references care_recipients(id) on delete cascade;

drop function if exists app.review_benefit_ruleset(text, text, text);
drop function if exists app.save_benefit_ruleset_draft(text, jsonb);
drop table if exists benefit_rulesets;
