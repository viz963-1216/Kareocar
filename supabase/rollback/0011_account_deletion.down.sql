-- 回復 0011（已執行的刪除無法還原）
drop function if exists app.review_account_deletion(text, text, text);
drop function if exists app.cancel_account_deletion(text);
drop function if exists app.request_account_deletion(text);
drop table if exists deletion_requests;
