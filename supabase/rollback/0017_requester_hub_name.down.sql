-- 回復 0017：名字改回「需求者組織」（只改還是新名字的那一列）
update organizations set name = '需求者組織', updated_at = now()
 where id = 'ORG-REQ-001' and org_type = 'requester_hub' and name = '需求者群組';
