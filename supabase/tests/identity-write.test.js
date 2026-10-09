/**
 * v2-identity-write：組織、成員資格、司機的寫入路徑。
 *
 * 這支端點補的是先前的缺口——那三個集合被 state-mutate 擋掉之後，網站上就
 * 沒有任何路徑可以開新服務單位、加司機、停用成員資格了。
 *
 * 驗證重點是「授權真的由 RLS 決定」，而不是端點自己憑良心判斷。
 */
const path = require('path');
const { execFileSync } = require('child_process');
// 預設用真正的 pg；裝不了 pg 的環境才退回 psql 替身（見 _pg-driver.js）
require('./_pg-driver');
const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const PGHOST = process.env.PGHOST || '/tmp/pgrun';
const PGPORT = process.env.PGPORT || '5433';
const PGDATABASE = process.env.PGDATABASE || 'careride';
process.env.DATABASE_URL = `postgresql://care_ride_app@${encodeURIComponent(PGHOST)}:${PGPORT}/${PGDATABASE}`;
process.env.AUTH_SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const sql = (q) => execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres',
  '-d', PGDATABASE, '-tAc', q]).toString().trim();

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const idw = fx.adapt(require(path.join(FN, 'v2-identity-write.js')));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (r) => ({ status: r.statusCode, ...JSON.parse(r.body) });
const send = (tok, changes) => idw.handler({ httpMethod: 'POST',
  headers: tok ? { authorization: `Bearer ${tok}` } : {}, body: JSON.stringify({ changes }) });
const doLogin = async (p, pw, ip) => parse(await login.handler({ httpMethod: 'POST',
  body: JSON.stringify({ phone: p, password: pw }), headers: { 'x-nf-client-connection-ip': ip } }));

(async () => {
  await withoutUser(async (c) => {
    for (const [u, p] of [['USR-ROOT', 'RootPass2026!!'], ['USR-OWN2', 'Own2Pass123'],
                          ['USR-DISP1', 'DispatchPass123'], ['USR-VICTIM', 'VictimPass123']]) {
      await fx.setSeedPassword(u, p);
    }
  });
  const root = (await doLogin('0912000009', 'RootPass2026!!', '198.51.100.70')).data.sessionToken;
  const owner = (await doLogin('0912000005', 'Own2Pass123', '198.51.100.71')).data.sessionToken;
  const dispatcher = (await doLogin('0912000003', 'DispatchPass123', '198.51.100.72')).data.sessionToken;
  const requester = (await doLogin('0912000001', 'VictimPass123', '198.51.100.73')).data.sessionToken;

  console.log('--- 建立組織：只有平台管理者可以 ---');
  await t('平台管理者可以建立新組織（這就是原本完全做不到的事）', async () => {
    const r = parse(await send(root, [{ collection:'organizations', id:'ORG-NEW-1',
      record:{ id:'ORG-NEW-1', name:'新服務單位', type:'transport_provider', contactPhone:'0212345678', active:true } }]));
    return r.ok === true && sql("select name from organizations where id='ORG-NEW-1'") === '新服務單位';
  });
  await t('負責人不能建立新組織', async () => {
    const r = parse(await send(owner, [{ collection:'organizations', id:'ORG-EVIL-1',
      record:{ id:'ORG-EVIL-1', name:'偷開的', type:'transport_provider' } }]));
    return r.ok !== true && sql("select count(*) from organizations where id='ORG-EVIL-1'") === '0';
  });
  await t('需求者不能建立新組織', async () => {
    const r = parse(await send(requester, [{ collection:'organizations', id:'ORG-EVIL-2',
      record:{ id:'ORG-EVIL-2', name:'偷開的', type:'transport_provider' } }]));
    return r.ok !== true && sql("select count(*) from organizations where id='ORG-EVIL-2'") === '0';
  });
  await t('負責人可以改自己組織的名稱', async () => {
    const r = parse(await send(owner, [{ collection:'organizations', id:'ORG-TP-002',
      record:{ id:'ORG-TP-002', name:'樂行車隊（改名）', type:'transport_provider' } }]));
    return r.ok === true && sql("select name from organizations where id='ORG-TP-002'") === '樂行車隊（改名）';
  });
  await t('負責人不能改別家組織的名稱', async () => {
    const before = sql("select name from organizations where id='ORG-TP-001'");
    const r = parse(await send(owner, [{ collection:'organizations', id:'ORG-TP-001',
      record:{ id:'ORG-TP-001', name:'被別人改掉', type:'transport_provider' } }]));
    return r.ok !== true && sql("select name from organizations where id='ORG-TP-001'") === before;
  });

  console.log('--- 成員資格 ---');
  await t('負責人可以指派調度員', async () => {
    const r = parse(await send(owner, [{ collection:'memberships', id:'MEM-NEW-D',
      record:{ id:'MEM-NEW-D', userId:'USR-VICTIM', organizationId:'ORG-TP-002', role:'dispatcher', status:'active' } }]));
    return r.ok === true && sql("select role from memberships where id='MEM-NEW-D'") === 'dispatcher';
  });
  await t('負責人不能指派第二個負責人（自我提權的防線）', async () => {
    const r = parse(await send(owner, [{ collection:'memberships', id:'MEM-NEW-O',
      record:{ id:'MEM-NEW-O', userId:'USR-VICTIM', organizationId:'ORG-TP-002', role:'owner', status:'active' } }]));
    return r.ok !== true && sql("select count(*) from memberships where id='MEM-NEW-O'") === '0';
  });
  await t('調度員不能指派任何人', async () => {
    const r = parse(await send(dispatcher, [{ collection:'memberships', id:'MEM-EVIL',
      record:{ id:'MEM-EVIL', userId:'USR-ATTACK', organizationId:'ORG-TP-001', role:'dispatcher', status:'active' } }]));
    return r.ok !== true && sql("select count(*) from memberships where id='MEM-EVIL'") === '0';
  });
  await t('負責人可以撤銷自家成員資格，並記下撤銷時間', async () => {
    const r = parse(await send(owner, [{ collection:'memberships', id:'MEM-NEW-D',
      record:{ id:'MEM-NEW-D', userId:'USR-VICTIM', organizationId:'ORG-TP-002', role:'dispatcher', status:'revoked' } }]));
    return r.ok === true && sql("select status from memberships where id='MEM-NEW-D'") === 'revoked'
      && sql("select revoked_at is not null from memberships where id='MEM-NEW-D'") === 't';
  });
  await t('不支援硬刪除，會明確擋下來', async () => {
    const r = parse(await send(owner, [{ collection:'memberships', id:'MEM-NEW-D',
      record:{ id:'MEM-NEW-D' }, deleted:true }]));
    return r.ok !== true && /不支援刪除/.test(r.error.message)
      && sql("select count(*) from memberships where id='MEM-NEW-D'") === '1';
  });

  console.log('--- 司機 ---');
  await t('負責人可以新增自家司機', async () => {
    const r = parse(await send(owner, [{ collection:'drivers', id:'DRV-NEW-1',
      record:{ id:'DRV-NEW-1', userId:'USR-OWN2', organizationId:'ORG-TP-002', dutyStatus:'off_duty', active:true } }]));
    return r.ok === true && sql("select organization_id from drivers where id='DRV-NEW-1'") === 'ORG-TP-002';
  });
  await t('司機開始執勤：前端送 status，資料庫記成執勤中（舊的 dutyStatus 不蓋過它）', async () => {
    const r = parse(await send(owner, [{ collection:'drivers', id:'DRV-NEW-1',
      record:{ id:'DRV-NEW-1', userId:'USR-OWN2', organizationId:'ORG-TP-002', status:'on_duty', dutyStatus:'off_duty', active:true } }]));
    return r.ok === true && sql("select duty_status from drivers where id='DRV-NEW-1'") === 'on_duty';
  });
  await t('司機狀態只接受執勤中、休息、結束執勤、不可派車', async () => {
    const r = parse(await send(owner, [{ collection:'drivers', id:'DRV-NEW-1',
      record:{ id:'DRV-NEW-1', userId:'USR-OWN2', organizationId:'ORG-TP-002', status:'flying', active:true } }]));
    return r.ok !== true && sql("select duty_status from drivers where id='DRV-NEW-1'") === 'on_duty';
  });
  await t('負責人不能把司機塞進別家組織', async () => {
    const r = parse(await send(owner, [{ collection:'drivers', id:'DRV-EVIL',
      record:{ id:'DRV-EVIL', userId:'USR-OWN2', organizationId:'ORG-TP-001', dutyStatus:'off_duty' } }]));
    return r.ok !== true && sql("select count(*) from drivers where id='DRV-EVIL'") === '0';
  });

  console.log('--- 識別碼換算與把關 ---');
  await t('前端的 org_requesters 會換回資料庫的 ORG-REQ-001', async () => {
    const r = parse(await send(root, [{ collection:'memberships', id:'MEM-REQ-MAP',
      record:{ id:'MEM-REQ-MAP', userId:'USR-DRV1', organizationId:'org_requesters', role:'requester', status:'active' } }]));
    return r.ok === true && sql("select organization_id from memberships where id='MEM-REQ-MAP'") === 'ORG-REQ-001';
  });
  await t('不接受不在白名單的集合', async () => {
    const r = parse(await send(root, [{ collection:'users', id:'USR-X', record:{ id:'USR-X' } }]));
    return r.error.code === 'COLLECTION_FORBIDDEN';
  });
  await t('不支援的角色被拒', async () => {
    const r = parse(await send(root, [{ collection:'memberships', id:'MEM-BAD',
      record:{ id:'MEM-BAD', userId:'USR-ATTACK', organizationId:'ORG-TP-001', role:'superuser' } }]));
    return r.error.code === 'VALIDATION_ERROR';
  });
  await t('沒有 token 回 401', async () => parse(await send(null, [{ collection:'organizations', id:'X', record:{} }])).status === 401);
  await t('整批原子性：一筆壞的就全部不落地', async () => {
    const before = sql("select count(*) from organizations");
    const r = parse(await send(root, [
      { collection:'organizations', id:'ORG-BATCH-1', record:{ id:'ORG-BATCH-1', name:'甲', type:'transport_provider' } },
      { collection:'memberships', id:'MEM-BATCH-BAD', record:{ id:'MEM-BATCH-BAD', userId:'USR-ATTACK', organizationId:'ORG-BATCH-1', role:'invalid' } }
    ]));
    return r.ok !== true && sql("select count(*) from organizations") === before;
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
