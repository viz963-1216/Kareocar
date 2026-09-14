'use strict';
/**
 * _trip-execution-rules.js 的離線測試：不連資料庫，直接餵「鎖定中的行程」與
 * 請求本體，確認合法的司機操作被接受、每一種越權或不合規則的變化被拒絕。
 *
 * 同一套規則經過實際 handler 與資料庫的驗證在 supabase/tests/business-flow.test.js。
 */
const assert = require('node:assert');
const rules = require('../netlify/functions/_trip-execution-rules');
const F = require('./_trip-fixtures');

const ORG = 'ORG-T';
const DRIVER = 'DRV-T';
const ME = 'USR-DRV-T';
const T0 = '2030-05-01T09:00:00.000Z';
const at = (minutes) => F.addMinutes(T0, minutes);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e && e.message); }
}

function plan(trip, request, { now = at(5), blocking = [], revision = trip.revision, actor = ME } = {}) {
  return rules.planExecution({
    command: request.command, body: request,
    current: { tripId: trip.id, data: trip, revision, organizationId: ORG, blockingIssueIds: blocking },
    actorUserId: actor, now: new Date(now)
  });
}
function rejects(fn, code = 'VALIDATION_ERROR', pattern = null) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, '預期被拒絕，但通過了');
  assert.strictEqual(err.code, code, `錯誤碼 ${err.code}：${err.message}`);
  if (pattern) assert.match(err.message, pattern);
}
const base = () => F.makeTrip({ id: 'TRP-T', organizationId: ORG, driverId: DRIVER, vehicleId: 'VEH-T', bookingId: 'BKG-T', startAt: at(10) });
/** 模擬伺服器寫入後的狀態（revision 與 receipts 由伺服器產生）。 */
const applied = (step) => step.trip;

console.log('--- 完成停靠點 ---');
const s0 = base();
const depart = F.completeStep(s0, ME, at(0));
t('完成出發站：接受，行程轉為進行中', () => {
  const r = plan(s0, depart.request);
  assert.strictEqual(r.duplicate, false);
  assert.strictEqual(r.patch.status, 'in_progress');
});
t('同一個冪等鍵已在 mutationReceipts：回報重複、不再驗證', () => {
  const r = plan(applied(depart), depart.request, { revision: applied(depart).revision });
  assert.strictEqual(r.duplicate, true);
});
t('revision 過期：TRIP_CONFLICT', () => rejects(() => plan(s0, depart.request, { revision: 3 }), 'TRIP_CONFLICT'));
t('expectedStepId 與目前站點不同：TRIP_CONFLICT', () =>
  rejects(() => plan(s0, { ...depart.request, expectedStepId: 'TRP-T_pickup' }), 'TRIP_CONFLICT'));
t('早於第一站前 60 分鐘：拒絕', () => {
  const early = F.completeStep(s0, ME, at(-100));
  rejects(() => plan(s0, early.request, { now: at(-100) }), 'VALIDATION_ERROR', /可執行時間/);
});
t('完成時間晚於伺服器時間超過容忍值：拒絕', () => {
  const future = F.completeStep(s0, ME, at(30));
  rejects(() => plan(s0, future.request, { now: at(0) }), 'VALIDATION_ERROR', /伺服器時間/);
});
t('跳站（完成接送站而不是出發站）：拒絕', () => {
  const req = F.clone(depart.request);
  req.trip.steps[0] = F.clone(s0.steps[0]);
  Object.assign(req.trip.steps[1], { status: 'completed', completedAt: at(0), actualAt: at(0), arrivedAt: at(0), serviceStartedAt: at(0), passengerBoardedAt: at(0), departedAt: at(0) });
  rejects(() => plan(s0, req));
});
for (const [label, mutate] of [
  ['改地址', (r) => { r.trip.steps[1].destination = '竄改地址'; }],
  ['改聯絡人', (r) => { r.trip.steps[1].contacts = [{ name: 'x', phone: '0900' }]; }],
  ['改排程', (r) => { r.trip.steps[2].scheduledAt = at(999); }],
  ['刪一個停靠點', (r) => { r.trip.steps.pop(); }],
  ['加一個停靠點', (r) => { r.trip.steps.push(F.clone(r.trip.steps[2])); }],
  ['停靠點加上新欄位', (r) => { r.trip.steps[0].driverId = 'DRV-OTHER'; }],
  ['乘客改名', (r) => { r.trip.passengers[0].name = '竄改'; }],
  ['乘客狀態與停靠點不一致', (r) => { r.trip.passengers[0].status = 'dropped_off'; }],
  ['currentStepIndex 亂填', (r) => { r.trip.currentStepIndex = 3; }],
  ['資源區段換成其他司機', (r) => { r.trip.resourceSegments[0].driverId = 'DRV-OTHER'; }],
  ['自行加服務證明', (r) => { r.trip.serviceProofs.push({ id: 'x' }); }]
]) {
  t(`${label}：拒絕`, () => { const req = F.clone(depart.request); mutate(req); rejects(() => plan(s0, req)); });
}
for (const key of ['driverId', 'vehicleId', 'organizationId', 'bookingIds', 'proofPolicy', 'revision', 'mutationReceipts']) {
  t(`行程執行資料帶 ${key}：拒絕`, () => {
    const req = F.clone(depart.request);
    req.trip[key] = key === 'bookingIds' ? [] : key === 'proofPolicy' ? { requiredPerDropoff: false } : 'X';
    rejects(() => plan(s0, req), 'VALIDATION_ERROR', /不允許修改的欄位/);
  });
}
t('中斷中的行程：拒絕', () => rejects(() => plan({ ...s0, status: 'interrupted' }, depart.request), 'VALIDATION_ERROR', /中斷/));

const s1 = applied(depart);
const pickup = F.completeStep(s1, ME, at(1));
const s2 = applied(pickup);
const dropoff = F.completeStep(s2, ME, at(2));
t('接送站：乘客變為車上', () => assert.strictEqual(plan(s1, pickup.request).patch.passengers[0].status, 'onboard'));
t('送達站缺服務證明：保持進行中並標記待完成', () => {
  const r = plan(s2, dropoff.request);
  assert.strictEqual(r.patch.status, 'in_progress');
  assert.ok(r.patch.completionPending);
});
t('送達站缺服務證明卻宣稱完成：拒絕', () => {
  const req = F.clone(dropoff.request);
  req.trip.status = 'completed'; req.trip.completedAt = at(2); req.trip.completionPending = null;
  rejects(() => plan(s2, req), 'VALIDATION_ERROR', /服務證明/);
});

console.log('--- 服務證明 ---');
const s3 = applied(dropoff);
const proof = F.addProof(s3, ME, at(3));
t('補上服務證明：行程完成', () => assert.strictEqual(plan(s3, proof.request).patch.status, 'completed'));
t('有未結案重大異常時宣稱完成：拒絕', () => rejects(() => plan(s3, proof.request, { blocking: ['iss_1'] }), 'VALIDATION_ERROR', /異常/));
t('有未結案重大異常時保持進行中：接受', () => {
  const held = F.addProof(s3, ME, at(3), { blocking: true });
  assert.strictEqual(plan(s3, held.request, { blocking: ['iss_1'] }).patch.status, 'in_progress');
});
t('服務證明帶照片描述資料：接受', () => {
  const p = F.addProof(s3, ME, at(3), { photo: { name: 'p.jpg', type: 'image/jpeg', size: 1024, storage: 'indexeddb', objectKey: 'proofblob_1' } });
  assert.strictEqual(plan(s3, p.request).duplicate, false);
});
t('服務證明夾帶照片內容（dataUrl）：拒絕', () => {
  const p = F.addProof(s3, ME, at(3), { photo: { objectKey: 'k', dataUrl: 'data:image/jpeg;base64,AAAA' } });
  rejects(() => plan(s3, p.request), 'VALIDATION_ERROR', /照片/);
});
t('服務證明的操作人不是本人：拒絕', () => {
  const req = F.clone(proof.request);
  req.trip.serviceProofs[0].actorUserId = 'USR-OTHER';
  rejects(() => plan(s3, req), 'VALIDATION_ERROR', /本人/);
});
t('服務證明綁在接送站：拒絕', () => {
  const p = F.addProof(s3, ME, at(3), { stepId: 'TRP-T_pickup' });
  rejects(() => plan(s3, p.request), 'VALIDATION_ERROR', /送達停靠點/);
});
t('一次新增兩份服務證明：拒絕', () => {
  const req = F.clone(proof.request);
  req.trip.serviceProofs.push({ ...req.trip.serviceProofs[0], id: 'proof_dup' });
  rejects(() => plan(s3, req));
});
t('GPS 座標超出範圍：拒絕', () => {
  const p = F.addProof(s3, ME, at(3), { gps: { lat: 123, lng: 121, accuracyMeters: 5, capturedAt: at(3), source: 'device_geolocation' } });
  rejects(() => plan(s3, p.request), 'VALIDATION_ERROR', /GPS/);
});

console.log('--- 返回上一步 ---');
const s4 = applied(proof);
t('完成後 15 分鐘內返回：接受，服務證明標記已被修正', () => {
  const u = F.undoStep(s4, ME, at(10));
  const r = plan(s4, u.request, { now: at(10) });
  assert.strictEqual(r.patch.status, 'in_progress');
  assert.strictEqual(r.patch.serviceProofs[0].status, 'superseded');
});
t('完成超過 15 分鐘後返回：拒絕（需調度正式修正）', () => {
  const u = F.undoStep(s4, ME, at(30));
  rejects(() => plan(s4, u.request, { now: at(30) }), 'VALIDATION_ERROR', /15 分鐘/);
});
t('離線時在期限內返回、稍後才同步：以操作時間判斷，接受', () => {
  const u = F.undoStep(s4, ME, at(10));
  assert.strictEqual(plan(s4, u.request, { now: at(120) }).duplicate, false);
});
t('返回時沒有把該站的服務證明標記為已被修正：拒絕', () => {
  const u = F.undoStep(s4, ME, at(10));
  const req = F.clone(u.request);
  req.trip.serviceProofs[0] = F.clone(s4.serviceProofs[0]);
  rejects(() => plan(s4, req, { now: at(10) }));
});
t('返回時順便清掉更早一站：拒絕', () => {
  const u = F.undoStep(s4, ME, at(10));
  const req = F.clone(u.request);
  Object.assign(req.trip.steps[1], { status: 'pending', arrivedAt: null, serviceStartedAt: null, passengerBoardedAt: null, departedAt: null, completedAt: null, actualAt: null });
  rejects(() => plan(s4, req, { now: at(10) }));
});
t('返回第一站：行程回到尚未開始', () => {
  const u = F.undoStep(s1, ME, at(1));
  const r = plan(s1, u.request, { now: at(1) });
  assert.strictEqual(r.patch.status, 'scheduled');
  assert.strictEqual(r.patch.startedAt, null);
});

console.log('--- 定位與異常 ---');
t('定位：接受並合併、不帶 revision', () => {
  const l = F.locationSample(s1, ME, at(1));
  const r = plan(s1, l.request);
  assert.deepStrictEqual(Object.keys(r.patch).sort(), ['liveNavigation', 'locationSamples']);
  assert.strictEqual(r.patch.locationSamples.length, 1);
});
t('定位的操作人不是本人：拒絕', () => {
  const l = F.locationSample(s1, 'USR-OTHER', at(1));
  rejects(() => plan(s1, l.request), 'VALIDATION_ERROR', /本人/);
});
t('回報一般異常：接受', () => {
  const i = F.reportIssue(s1, ME, at(1), '交通壅塞');
  assert.strictEqual(plan(s1, i.request).issue.severity, 'warning');
});
t('重大異常自行降級為一般：拒絕', () => {
  const i = F.reportIssue(s1, ME, at(1), '交通事故');
  const req = F.clone(i.request);
  req.issue.severity = 'info'; req.issue.requiresDispatch = false;
  rejects(() => plan(s1, req), 'VALIDATION_ERROR', /嚴重度/);
});
t('異常帶處理紀錄：拒絕', () => {
  const i = F.reportIssue(s1, ME, at(1), '交通壅塞');
  const req = F.clone(i.request);
  req.issue.resolvedAt = at(1);
  rejects(() => plan(s1, req));
});
t('事件的操作人不是本人：拒絕', () => {
  const req = F.clone(pickup.request);
  req.events[0].actorUserId = 'USR-OTHER';
  rejects(() => plan(s1, req), 'VALIDATION_ERROR', /本人/);
});
t('不支援的指令（interrupt）：拒絕', () => rejects(() => plan(s1, { ...pickup.request, command: 'interrupt' })));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
require('./_exit-watchdog').finishTest(fail ? 1 : 0, 'trip-execution-rules');
