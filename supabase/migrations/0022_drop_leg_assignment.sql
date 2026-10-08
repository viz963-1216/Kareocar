-- =====================================================================
-- 0022：清掉預約去程／回程上的「平台指定機構」欄位（#110）
--
-- 平台管理者把某一段指定給別家機構的功能已移除：被指定的機構在權限下讀不到那筆預約，
-- 從來沒辦法真的排車，而且這個欄位一般預約寫入就能改。跨機構排車改走需求池（ADR 0004）。
-- 這裡把既有資料的 assignedOrganizationId／assignedAt／assignedByUserId 移除。
-- app.trip_resource_scope 回傳的 leg_organization_ids 之後一律是空陣列，API 已不再使用。
-- =====================================================================

update app_state s
   set data = jsonb_set(s.data, '{legs}', (
         select coalesce(jsonb_agg(case when jsonb_typeof(l) = 'object'
                                        then l - 'assignedOrganizationId' - 'assignedAt' - 'assignedByUserId'
                                        else l end order by n), '[]'::jsonb)
           from jsonb_array_elements(s.data->'legs') with ordinality as x(l, n)))
 where s.collection = 'bookings'
   and jsonb_typeof(s.data->'legs') = 'array'
   and exists (select 1 from jsonb_array_elements(s.data->'legs') l
                where jsonb_typeof(l) = 'object'
                  and (l ? 'assignedOrganizationId' or l ? 'assignedAt' or l ? 'assignedByUserId'));
