-- 回復 0023：拿掉同步、清空正式資料表（套用前本來就沒有資料），結構與讀寫規則回到 baseline 的樣子
set client_min_messages = warning;
drop trigger if exists app_state_sync_typed on app_state;
drop function if exists app.app_state_sync_typed();
drop function if exists app.typed_sync_diff();
drop function if exists app.sync_typed_row(text, text);

drop policy if exists booking_legs_read on booking_legs;
drop table if exists booking_legs;

-- 子表（booking_events、quote_snapshots、service_proofs、issues、telemetry_events）在 API 也沒用，同樣是空的
truncate bookings, trips, trip_bookings, cancellations cascade;

drop policy if exists bookings_read on bookings;
drop policy if exists trips_read on trips;
drop policy if exists tb_read on trip_bookings;
drop policy if exists cancels_read on cancellations;

alter table cancellations add constraint cancellations_cancelled_by_user_id_fkey
  foreign key (cancelled_by_user_id) references users(id);

alter table trip_bookings drop column leg_id;
alter table trip_bookings add constraint trip_bookings_trip_id_booking_id_key unique (trip_id, booking_id);
alter table trip_bookings add constraint trip_bookings_booking_id_fkey
  foreign key (booking_id) references bookings(id) on delete cascade;

alter table trips drop column owner_user_id, drop column deleted;
alter table trips alter column organization_id set not null;
alter table trips add constraint trips_driver_id_fkey foreign key (driver_id) references drivers(id) on delete set null;
alter table trips add constraint trips_vehicle_id_fkey foreign key (vehicle_id) references vehicles(id) on delete set null;

drop index if exists bookings_owner_idx;
alter table bookings drop column owner_user_id, drop column market_expires_at, drop column deleted;
alter table bookings add constraint bookings_care_recipient_id_fkey
  foreign key (care_recipient_id) references care_recipients(id) on delete set null;
alter table bookings add constraint bookings_requested_by_user_id_fkey
  foreign key (requested_by_user_id) references users(id) on delete set null;

grant select, insert, update, delete on bookings, trips, trip_bookings, cancellations to care_ride_app;

create policy bookings_read on bookings for select
  using (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or exists (select 1 from trip_bookings tb join trips t on t.id = tb.trip_id
                    where tb.booking_id = bookings.id
                      and t.driver_id = any(app.my_driver_ids())));
create policy bookings_insert on bookings for insert
  with check (app.is_super_admin()
              or requested_by_user_id = app.current_user_id()
              or app.operates(organization_id));
create policy bookings_update on bookings for update
  using (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs())
         or (organization_id is null and state = 'open' and app.operates_any()))
  with check (app.is_super_admin()
         or requested_by_user_id = app.current_user_id()
         or organization_id = any(app.my_ops_orgs()));

create policy cancels_read on cancellations for select using (app.can_see_booking(booking_id));
create policy cancels_insert on cancellations for insert with check (app.can_see_booking(booking_id));
create policy cancels_update on cancellations for update
  using (app.can_see_booking(booking_id)) with check (app.can_see_booking(booking_id));

create policy trips_read on trips for select using (app.can_see_trip(id));
create policy trips_write on trips for insert
  with check (app.is_super_admin() or app.operates(organization_id));
create policy trips_update on trips for update
  using (app.is_super_admin() or app.operates(organization_id) or app.drives_trip(id))
  with check (app.is_super_admin() or app.operates(organization_id) or app.drives_trip(id));

create policy tb_read on trip_bookings for select
  using (app.can_see_trip(trip_id) and app.can_see_booking(booking_id));
create policy tb_write on trip_bookings for all
  using (app.is_super_admin() or exists (select 1 from trips t
          where t.id = trip_bookings.trip_id and app.operates(t.organization_id)))
  with check (app.is_super_admin() or exists (select 1 from trips t
          where t.id = trip_bookings.trip_id and app.operates(t.organization_id)));

drop function if exists app.booking_pickup_at(jsonb);
drop function if exists app.try_int(text, int);
drop function if exists app.try_timestamptz(text);
