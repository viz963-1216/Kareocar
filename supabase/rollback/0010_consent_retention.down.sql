-- 回復 0010（已匿名化的資料無法還原）
drop function if exists app.anonymize_expired_records(date);
drop function if exists app.anonymize_trip_data(jsonb);
drop function if exists app.anonymize_booking_data(jsonb);
drop function if exists app.accept_consent(text, text, text);
drop function if exists app.consent_missing();
drop table if exists consent_records;
drop function if exists app.set_platform_setting(text, jsonb);
drop table if exists app_settings;
