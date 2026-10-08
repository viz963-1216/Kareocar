-- 回復 0021：移除重新試算更新預約補助估算的函式
drop function if exists app.set_booking_benefit(text, jsonb);
drop function if exists app.recipient_refreshable_bookings(text);
drop function if exists app.can_refresh_recipient_benefit(text);
drop function if exists app.booking_benefit_refreshable(jsonb);
