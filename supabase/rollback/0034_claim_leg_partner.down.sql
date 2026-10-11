-- 回復 0034：拿掉接下單一段與協力機構的讀取函式
drop function if exists app.partner_booking_views();
drop function if exists app.claim_booking_leg(text, text, text);
