-- 回復 0020：移除長照特約（資料會一併刪除）
drop function if exists app.ltc_contract_active(text, text, date);
drop function if exists app.remove_ltc_contract(text);
drop function if exists app.save_ltc_contract(text, text, text, text, date, date);
drop table if exists ltc_contracts;
drop function if exists app.normalize_city(text);
