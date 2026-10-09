/**
 * 寫入路徑測試：v2-state-mutate 跑在真實 Postgres + 真實 RLS 上。
 * 重點不是「功能會動」，是「越權寫入真的被擋下來、而且不會假裝成功」。
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

// 預期會失敗的查詢：psql 以非零狀態結束時 execFileSync 會丟例外並吃掉 stdout，
// 所以錯誤訊息要自己從例外裡撈出來，否則測試會誤判成「指令壞了」。
const psqlOutput = (q) => {
  try {
    return execFileSync('psql', ['-h', PGHOST, '-p', PGPORT, '-U', 'postgres',
      '-d', PGDATABASE, '-tAc', q], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
};

// 假的 Supabase Auth 與測試簽章金鑰；舊測試的 token 寫法由 fx.adapt 轉成 cookie
const fx = require('./_auth-fixture');
const auth = require(path.join(FN, '_auth-pg.js'));
const { withoutUser, getPool } = require(path.join(FN, '_db.js'));
const login = fx.adapt(require(path.join(FN, 'v2-password-login.js')));
const mutate = fx.adapt(require(path.join(FN, 'v2-state-mutate.js')));
const bookingWrite = fx.adapt(require(path.join(FN, 'v2-booking-write.js')));
const tripWrite = fx.adapt(require(path.join(FN, 'v2-trip-write.js')));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const ok = await fn(); if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
  catch (e) { fail++; console.log('  FAIL', name, '->', e.message); }
};
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });
const send = (token, changes) => mutate.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify({ changes })
});
// 預約不再走 state-mutate（#22），由 booking-write 寫入
const sendBooking = (token, changes) => bookingWrite.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify({ changes })
});
const sendTrip = (token, changes) => tripWrite.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify({ changes })
});
const recipient = (id) => ({ collection: 'careRecipients', id, record: { id, displayName: '合成服務對象' } });
const doLogin = async (phone, pw, ip) => parse(await login.handler({ httpMethod: 'POST',
  body: JSON.stringify({ phone, password: pw }), headers: { 'x-nf-client-connection-ip': ip } }));

const booking = (id, extra = {}) => ({
  collection: 'bookings', id,
  record: { id, state: 'open', pickupDate: '2026-10-01', pickupAddress: '新北市板橋區文化路一段100號',
            destination: '台北市中正區公園路20號', tripType: 'single', passengerCount: 1,
            wheelchairSlots: 0, rideshareConsent: true, ...extra }
});

(async () => {
  // seed.sql 的角色都沒有密碼，這裡補上
  await withoutUser(async (c) => {
    for (const [uid, pw] of [['USR-VICTIM', 'VictimPass123'], ['USR-ATTACK', 'AttackPass123'],
                             ['USR-DISP1', 'DispatchPass123'], ['USR-OWN2', 'Own2Pass123']]) {
      await fx.setSeedPassword(uid, pw);
    }
  });
  const victim = (await doLogin('0912000001', 'VictimPass123', '203.0.113.1')).data.sessionToken;
  const attacker = (await doLogin('0912000002', 'AttackPass123', '203.0.113.2')).data.sessionToken;
  const dispatcher = (await doLogin('0912000003', 'DispatchPass123', '203.0.113.3')).data.sessionToken;
  const owner2 = (await doLogin('0912000005', 'Own2Pass123', '203.0.113.5')).data.sessionToken;

  console.log('--- 基本寫入 ---');
  await t('需求者可以建立預約', async () => {
    const r = parse(await sendBooking(victim, [booking('BKG-A')]));
    return r.ok === true && r.data.count === 1 && r.data.results[0].version === 1;
  });
  await t('擁有者由伺服器決定，不是呼叫端說了算', () =>
    sql("select owner_user_id from app_state where id='BKG-A'") === 'USR-VICTIM');
  await t('沒帶組織的預約進入公開池（organization_id 為空）', () =>
    sql("select coalesce(organization_id,'<null>') from app_state where id='BKG-A'") === '<null>');
  await t('再寫一次同一筆會累加版本', async () => {
    const r = parse(await sendBooking(victim, [booking('BKG-A', { passengerCount: 2 })]));
    return r.data.results[0].version === 2;
  });
  await t('沒有 token 回 401', async () => parse(await sendBooking(null, [booking('BKG-X')])).status === 401);

  console.log('--- 越權寫入 ---');
  await t('攻擊者無法竄改他人的預約（不是假裝成功）', async () => {
    const r = parse(await sendBooking(attacker, [booking('BKG-A', { destination: '攻擊者改的' })]));
    const untouched = sql("select data->>'destination' from app_state where id='BKG-A'");
    return r.ok !== true && r.error.code === 'FORBIDDEN' && untouched !== '攻擊者改的';
  });
  await t('攻擊者無法把別人的預約塞給自己的組織', async () => {
    const r = parse(await sendBooking(attacker, [booking('BKG-A', { organizationId: 'ORG-TP-002' })]));
    return r.ok !== true && sql("select coalesce(organization_id,'<null>') from app_state where id='BKG-A'") === '<null>';
  });
  await t('需求者謊報 organizationId 被拒（不能替不是自己的機構建立已承接預約）', async () => {
    const r = parse(await sendBooking(victim, [booking('BKG-LIE', { organizationId: 'ORG-TP-001' })]));
    return r.ok !== true && r.error.code === 'FORBIDDEN'
      && sql("select count(*) from app_state where id='BKG-LIE'") === '0';
  });
  await t('需求者建立第二筆預約', async () =>
    parse(await sendBooking(victim, [booking('BKG-B')])).ok === true);
  await t('預約不能從一般寫入端點寫（COLLECTION_FORBIDDEN）', async () => {
    const r = parse(await send(victim, [booking('BKG-VIA-STATE')]));
    return r.error.code === 'COLLECTION_FORBIDDEN' && sql("select count(*) from app_state where id='BKG-VIA-STATE'") === '0';
  });
  await t('調度員為自家組織建立的資料才留得住組織', async () => {
    const r = parse(await send(dispatcher, [{ collection: 'issues', id: 'ISS-1',
      record: { id: 'ISS-1', organizationId: 'ORG-TP-001', description: '車輛延誤' } }]));
    return r.ok === true && sql("select organization_id from app_state where id='ISS-1'") === 'ORG-TP-001';
  });
  await t('調度員不能替別家組織建立資料（組織被清成空）', async () => {
    const r = parse(await send(dispatcher, [{ collection: 'issues', id: 'ISS-2',
      record: { id: 'ISS-2', organizationId: 'ORG-TP-002', description: '越權' } }]));
    return r.ok === true && sql("select coalesce(organization_id,'<null>') from app_state where id='ISS-2'") === '<null>';
  });

  console.log('--- 集合白名單 ---');
  await t('身分集合（users）被拒絕', async () => {
    const r = parse(await send(victim, [{ collection: 'users', id: 'USR-VICTIM',
      record: { id: 'USR-VICTIM', platformRole: 'super_admin' } }]));
    return r.error.code === 'COLLECTION_FORBIDDEN';
  });
  await t('身分集合（memberships）被拒絕', async () => {
    const r = parse(await send(victim, [{ collection: 'memberships', id: 'M-EVIL',
      record: { id: 'M-EVIL', organizationId: 'ORG-TP-001', role: 'owner' } }]));
    return r.error.code === 'COLLECTION_FORBIDDEN';
  });
  await t('未知集合被拒絕', async () => {
    const r = parse(await send(victim, [{ collection: 'evilCollection', id: 'X', record: { id: 'X' } }]));
    return r.error.code === 'COLLECTION_FORBIDDEN';
  });
  await t('平台角色沒有因為上面那些嘗試而改變', () =>
    sql("select platform_role from users where id='USR-VICTIM'") === 'none');

  console.log('--- 整批原子性 ---');
  await t('一筆壞的就整批不落地', async () => {
    const before = sql("select count(*) from app_state");
    const r = parse(await send(victim, [
      recipient('CR-GOOD-1'), recipient('CR-GOOD-2'),
      { collection: 'users', id: 'USR-VICTIM', record: { id: 'USR-VICTIM' } }
    ]));
    return r.ok !== true && sql("select count(*) from app_state") === before
      && sql("select count(*) from app_state where id like 'CR-GOOD-%'") === '0';
  });
  await t('超過 200 筆被拒絕', async () => {
    const many = Array.from({ length: 201 }, (_, i) => recipient(`CR-BULK-${i}`));
    return parse(await send(victim, many)).error.code === 'VALIDATION_ERROR';
  });
  await t('空的異動清單被拒絕', async () =>
    parse(await send(victim, [])).error.code === 'VALIDATION_ERROR');

  console.log('--- 敏感欄位絕不落地 ---');
  await t('密碼類欄位被剝掉', async () => {
    await send(victim, [{ collection: 'careRecipients', id: 'CR-9',
      record: { id: 'CR-9', displayName: '王阿嬤', password: 'hunter2', sessionToken: 'leaked' } }]);
    const stored = sql("select data::text from app_state where id='CR-9'");
    return !/hunter2|leaked|password|sessionToken/.test(stored);
  });

  console.log('--- 行程樂觀鎖 ---');
  await t('建立行程', async () => {
    const r = parse(await sendTrip(dispatcher, [{ collection: 'trips', id: 'TRP-1',
      record: { id: 'TRP-1', organizationId: 'ORG-TP-001', state: 'scheduled' } }]));
    return r.ok === true;
  });
  await t('行程不能從一般寫入端點寫（COLLECTION_FORBIDDEN）', async () => {
    const r = parse(await send(dispatcher, [{ collection: 'trips', id: 'TRP-VIA-STATE',
      record: { id: 'TRP-VIA-STATE', organizationId: 'ORG-TP-001' } }]));
    return r.error.code === 'COLLECTION_FORBIDDEN';
  });
  await t('用過期的 revision 更新會被擋（不是覆蓋掉別人的修改）', async () => {
    await sendTrip(dispatcher, [{ collection: 'trips', id: 'TRP-1',
      record: { id: 'TRP-1', organizationId: 'ORG-TP-001', state: 'in_progress' }, expectedRevision: 1 }]);
    const r = parse(await sendTrip(dispatcher, [{ collection: 'trips', id: 'TRP-1',
      record: { id: 'TRP-1', organizationId: 'ORG-TP-001', state: '被覆蓋' }, expectedRevision: 1 }]));
    return r.ok !== true && r.error.code === 'TRIP_CONFLICT'
      && sql("select data->>'state' from app_state where id='TRP-1'") !== '被覆蓋';
  });

  console.log('--- 軟刪除 ---');
  await t('刪除是標記而不是真的移除', async () => {
    // 預約不能刪除（只能取消），改用一般資料示範軟刪除
    await send(victim, [recipient('CR-DEL')]);
    const r = parse(await send(victim, [{ collection: 'careRecipients', id: 'CR-DEL',
      record: { id: 'CR-DEL' }, deleted: true }]));
    return r.ok === true && sql("select deleted from app_state where id='CR-DEL'") === 't'
      && sql("select count(*) from app_state where id='CR-DEL'") === '1';
  });
  await t('預約不能刪除', async () => {
    const r = parse(await sendBooking(victim, [{ collection: 'bookings', id: 'BKG-B', record: { id: 'BKG-B' }, deleted: true }]));
    return r.error.code === 'VALIDATION_ERROR' && sql("select deleted from app_state where id='BKG-B'") === 'f';
  });

  console.log('--- 公開需求池 ---');
  await t('調度員看得到未承接的案件', () =>
    Number(sql("set role care_ride_app; select set_config('app.user_id','USR-DISP1',false); select count(*) from app_state_booking_pool").split('\n').pop()) >= 1);
  await t('需求池只露出到行政區，不含門牌', () => {
    const out = sql("set role care_ride_app; select set_config('app.user_id','USR-DISP1',false); select coalesce(string_agg(pickup_area,','),'') from app_state_booking_pool");
    return !/文化路|100號/.test(out);
  });
  await t('需求者看不到需求池', () =>
    sql("set role care_ride_app; select set_config('app.user_id','USR-VICTIM',false); select count(*) from app_state_booking_pool").split('\n').pop() === '0');

  console.log('--- 承接競爭 ---');
  await t('調度員成功承接公開案件', () => {
    const out = sql("set role care_ride_app; select set_config('app.user_id','USR-DISP1',false); select organization_id from app.claim_app_state_booking('BKG-A','ORG-TP-001')");
    return out.split('\n').pop() === 'ORG-TP-001';
  });
  await t('第二個人再搶同一張單會失敗', () => {
    const out = psqlOutput("set role care_ride_app; select set_config('app.user_id','USR-OWN2',false); select * from app.claim_app_state_booking('BKG-A','ORG-TP-002')");
    return /已被其他服務單位接走|沒有權限/.test(out);
  });
  await t('承接後組織確實寫進去了（觸發器沒有把它還原）', () =>
    sql("select organization_id from app_state where id='BKG-A'") === 'ORG-TP-001');
  await t('不能代表自己沒加入的公司承接', () => {
    const out = psqlOutput("set role care_ride_app; select set_config('app.user_id','USR-ATTACK',false); select * from app.claim_app_state_booking('BKG-B','ORG-TP-001')");
    return /沒有權限/.test(out);
  });

  console.log('--- 遮蔽不能被繞過 ---');
  // 這條是回歸測試。原本的讀取政策為了讓需求池能運作，放行了「未承接的公開
  // 預約」，結果營運方可以直接查原始表拿到完整門牌與預約者是誰——遮蔽只做在
  // view 上，繞過 view 就沒了。現在需求池改由 security definer 的 view 提供。
  await t('營運方無法直接從原始表讀到未承接預約的門牌', () => {
    const out = psqlOutput("set role care_ride_app; select set_config('app.user_id','USR-DISP1',false); select coalesce(string_agg(data->>'pickupAddress',','),'<none>') from app_state where collection='bookings' and organization_id is null");
    return !/文化路|100號/.test(out);
  });
  await t('營運方仍然看得到遮蔽後的需求池', async () => {
    // 這時候 BKG-A 已被承接、BKG-B 已軟刪除，池子是空的；另開一筆未承接的來驗
    await sendBooking(victim, [booking('BKG-POOL')]);
    const out = psqlOutput("set role care_ride_app; select set_config('app.user_id','USR-DISP1',false); select count(*) from app_state_booking_pool");
    return Number(out.trim().split('\n').pop()) >= 1;
  });

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  await getPool().end();
  process.exit(fail ? 1 : 0);
})();
