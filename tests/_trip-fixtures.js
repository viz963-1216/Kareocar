'use strict';
/**
 * 測試用的行程資料與「司機在裝置上操作後會送出什麼」的模擬。
 *
 * 形狀照 index.html 的 makeTripStop／buildTripPassengers／completeStopCompatInDb／
 * undoLastStep／captureProof／reportIssue／recordLocationSample 寫，但這是手寫
 * 的替身，不是前端程式本身：這裡通過只代表伺服器規則接受「照前端規則算出來的
 * 結果」，前端實際送出的內容仍要靠瀏覽器端對端測試確認。
 *
 * 給 tests/trip-execution-rules.test.js（離線）與
 * supabase/tests/business-flow.test.js（實際 handler + 資料庫）共用。
 */
const { TRIP_PATCH_KEYS, classifyIssueSeverity } = require('../netlify/functions/_trip-execution-rules');

const clone = (v) => JSON.parse(JSON.stringify(v));
const addMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function makeStop(tripId, type, sequence, scheduledAt, extra = {}) {
  return {
    id: `${tripId}_${type}`, type, sequence, schemaVersion: 8,
    scheduledAt,
    scheduledArrivalAt: type === 'depart' ? null : scheduledAt,
    scheduledDepartureAt: type === 'depart' ? scheduledAt : null,
    title: `合成${type}`, name: `合成${type}`, destination: '台北市中正區公園路20號',
    contacts: [{ name: '合成乘客', phone: '0911000001' }], note: '',
    bookingId: null, bookingLegId: null, passengerId: null,
    arrivedAt: null, serviceStartedAt: null, passengerBoardedAt: null, passengerDroppedOffAt: null,
    departedAt: null, completedAt: null, actualAt: null, status: 'pending',
    ...extra
  };
}

/** 一趟單人行程：出發 → 接送 → 送達。startAt 是接送時間。 */
/** 預約的去程（單程預約只有這一段）；排車 command 需要它。 */
function outboundLeg(bookingId, requestedPickupAt = '2099-01-01T01:00:00.000Z') {
  return { id: `${bookingId}_outbound`, schemaVersion: 1, sequence: 1, direction: 'outbound', label: '去程', status: 'pending',
    requestedPickupAt, tripId: null, scheduledOrganizationId: null, scheduledAt: null };
}
/** 排車 command 用的行程：把這些預約的去程排進去。 */
function legRefsFor(bookingIds) {
  return bookingIds.map((bookingId) => ({ bookingId, legId: `${bookingId}_outbound` }));
}

function makeTrip({ id, organizationId, driverId, vehicleId, bookingId = null, startAt, extra = {} }) {
  const pid = `tpax_${id}_${bookingId || 'manual_0'}`;
  const link = { bookingId, passengerId: pid };
  return {
    id, organizationId, driverId, vehicleId,
    status: 'scheduled', code: `CR-${id}`, date: startAt.slice(0, 10),
    bookingIds: bookingId ? [bookingId] : [], bookingLegRefs: [],
    passengerSummary: '合成乘客', passengerCount: 1, isPooled: false, needs: '一般乘客',
    pickupAddress: '台北市信義區松仁路1號', dropoffAddress: '台北市中正區公園路20號',
    currentStepIndex: 0, runtimeSchemaVersion: 8, revision: 0, mutationReceipts: [],
    stateChangedAt: startAt, startedAt: null, completedAt: null, createdAt: startAt, updatedAt: startAt,
    steps: [
      makeStop(id, 'depart', 1, addMinutes(startAt, -20)),
      makeStop(id, 'pickup', 2, startAt, link),
      makeStop(id, 'dropoff', 3, addMinutes(startAt, 30), link)
    ],
    passengers: [{
      id: pid, schemaVersion: 1, bookingId, bookingLegId: null, recipientId: null,
      name: '合成乘客', phone: '0911000001', seatUnits: 1, wheelchairUnits: 0,
      status: 'waiting', boardedAt: null, droppedOffAt: null, cancelledAt: null,
      pickupStepId: `${id}_pickup`, dropoffStepId: `${id}_dropoff`, updatedAt: null
    }],
    serviceProofs: [], resourceSegments: [],
    proofPolicy: { version: 1, requiredPerDropoff: true, requireGps: false, requirePhoto: false, source: 'platform_default' },
    ...extra
  };
}

const stepDone = (s) => s.status === 'completed';
const firstPending = (t) => { const i = t.steps.findIndex((s) => !stepDone(s)); return i < 0 ? t.steps.length : i; };

function snapshotOf(trip) {
  const out = {};
  for (const k of TRIP_PATCH_KEYS) if (k in trip) out[k] = clone(trip[k]);
  return out;
}

function tripEvent(trip, eventType, at, actorUserId, stepId = null, metadata = null) {
  return { id: nextId('tev'), schemaVersion: 1, tripId: trip.id, sequence: 0, eventType, at, actorUserId,
    clientRecordedAt: at, serverRecordedAt: null, stepId, reason: '', metadata, targetEventIds: [] };
}

/** 與前端 rebuildTripPassengerProjection 相同的推導。 */
function rebuildPassengers(trip, at, actorUserId, events) {
  for (const p of trip.passengers) {
    const pickup = trip.steps.find((s) => s.id === p.pickupStepId);
    const dropoff = trip.steps.find((s) => s.id === p.dropoffStepId);
    const next = dropoff && dropoff.completedAt ? 'dropped_off' : pickup && pickup.completedAt ? 'onboard' : 'waiting';
    if (next === p.status) continue;
    events.push(tripEvent(trip, 'trip_passenger_state_changed', at, actorUserId, null, { passengerId: p.id, from: p.status, to: next }));
    p.status = next;
    p.updatedAt = at;
    p.boardedAt = next === 'waiting' ? null : (p.boardedAt || pickup.completedAt);
    p.droppedOffAt = next === 'dropped_off' ? (p.droppedOffAt || dropoff.completedAt) : null;
  }
}

function proofSatisfied(trip) {
  return trip.steps.filter((s) => s.type === 'dropoff' && stepDone(s)).every((s) =>
    trip.serviceProofs.some((p) => p.status !== 'superseded' && p.stepId === s.id && Date.parse(p.capturedAt) >= Date.parse(s.completedAt)));
}

function transition(trip, to, at, actorUserId, events) {
  if (trip.status === to) return;
  events.push(tripEvent(trip, 'trip_state_transitioned', at, actorUserId, null, { from: trip.status, to }));
  trip.status = to;
  trip.stateChangedAt = at;
  if (to === 'in_progress') {
    trip.startedAt = trip.startedAt || at;
    trip.completedAt = null;
    const open = trip.resourceSegments.find((g) => !g.endedAt);
    if (open) open.startedAt = open.startedAt || at;
    else trip.resourceSegments.push({ id: nextId('rseg'), schemaVersion: 1, driverId: trip.driverId, vehicleId: trip.vehicleId,
      assignedAt: at, startedAt: at, endedAt: null, endedReason: null, issueId: null, source: 'initial_start' });
  }
  if (to === 'completed') {
    trip.completedAt = at;
    const open = trip.resourceSegments.find((g) => !g.endedAt);
    if (open) { open.endedAt = at; open.endedReason = 'completed'; }
  }
}

function settleCompletion(trip, at, actorUserId, events, blocking = false) {
  if (firstPending(trip) < trip.steps.length) return;
  if (proofSatisfied(trip) && !blocking) { transition(trip, 'completed', at, actorUserId, events); trip.completionPending = null; }
  else trip.completionPending = { at, reasons: ['尚缺服務證明或有未結案異常'] };
}

function finalize(trip, command, expectedRevision, key, events, extra = {}) {
  trip.revision = expectedRevision + 1;
  trip.mutationReceipts = [...(trip.mutationReceipts || []), { key, action: command, resultRevision: trip.revision }];
  return {
    trip,
    request: { tripId: trip.id, command, expectedRevision, idempotencyKey: key, trip: snapshotOf(trip), events, ...extra }
  };
}

/** Trip.completeCurrentStep 的結果。blocking = 伺服器上有未結案重大異常（裝置端會看到而不完成）。 */
function completeStep(source, actorUserId, at, { blocking = false } = {}) {
  const trip = clone(source);
  const expectedRevision = trip.revision;
  const idx = firstPending(trip);
  const s = trip.steps[idx];
  const events = [];
  if (s.type === 'depart') s.departedAt = s.departedAt || at;
  else {
    s.arrivedAt = s.arrivedAt || at;
    s.serviceStartedAt = s.serviceStartedAt || at;
    if (s.type === 'pickup') s.passengerBoardedAt = s.passengerBoardedAt || at;
    if (s.type === 'dropoff') s.passengerDroppedOffAt = s.passengerDroppedOffAt || at;
    s.departedAt = s.departedAt || at;
  }
  s.completedAt = at; s.actualAt = at; s.status = 'completed';
  rebuildPassengers(trip, at, actorUserId, events);
  events.push(tripEvent(trip, 'trip_step_completed', at, actorUserId, s.id, { expectedRevision }));
  trip.currentStepIndex = firstPending(trip);
  if (trip.status === 'scheduled') transition(trip, 'in_progress', at, actorUserId, events);
  settleCompletion(trip, at, actorUserId, events, blocking);
  trip.updatedAt = at;
  return finalize(trip, 'complete_step', expectedRevision, `complete_step:${trip.id}:${s.id}:r${expectedRevision}`, events, { expectedStepId: s.id });
}

/** Trip.undoLastStep（司機限時修正）的結果。 */
function undoStep(source, actorUserId, at) {
  const trip = clone(source);
  const expectedRevision = trip.revision;
  const idx = (trip.status === 'completed' ? trip.steps.length : firstPending(trip)) - 1;
  const s = trip.steps[idx];
  const events = [];
  for (const k of ['arrivedAt', 'serviceStartedAt', 'passengerBoardedAt', 'passengerDroppedOffAt', 'departedAt', 'completedAt', 'actualAt']) s[k] = null;
  s.status = 'pending';
  const superseded = trip.serviceProofs.filter((p) => p.stepId === s.id && p.status !== 'superseded');
  const correction = tripEvent(trip, 'trip_event_corrected', at, actorUserId, s.id, { action: 'undo_step_completion' });
  for (const p of superseded) {
    p.status = 'superseded'; p.supersededAt = at; p.supersededByUserId = actorUserId;
    p.supersededReason = 'undo_last_stop'; p.supersededByCorrectionEventId = correction.id;
  }
  trip.currentStepIndex = idx;
  trip.completionPending = null;
  trip.updatedAt = at;
  rebuildPassengers(trip, at, actorUserId, events);
  const target = idx === 0 ? 'scheduled' : 'in_progress';
  if (trip.status !== target) {
    events.push(tripEvent(trip, 'trip_state_transitioned', at, actorUserId, null, { from: trip.status, to: target, correction: true }));
    trip.status = target; trip.stateChangedAt = at; trip.completedAt = null;
    if (target === 'scheduled') trip.startedAt = null;
  }
  events.push(correction);
  if (superseded.length) events.push(tripEvent(trip, 'trip_proof_of_service_superseded', at, actorUserId, s.id, { proofIds: superseded.map((p) => p.id) }));
  return finalize(trip, 'undo_step', expectedRevision, `undo_step:${trip.id}:${s.id}:r${expectedRevision}`, events, { expectedStepId: s.id });
}

/** Trip.captureProof 的結果。 */
function addProof(source, actorUserId, at, { stepId = null, receiverName = '合成收受人', photo = null, gps = null, blocking = false } = {}) {
  const trip = clone(source);
  const expectedRevision = trip.revision;
  const step = stepId ? trip.steps.find((s) => s.id === stepId) : [...trip.steps].reverse().find((s) => s.type === 'dropoff');
  const events = [];
  const proof = {
    id: nextId('proof'), schemaVersion: 4, sequence: trip.serviceProofs.length + 1, status: 'active',
    supersededAt: null, supersededByUserId: null, supersededReason: '', supersededByCorrectionEventId: null,
    tripId: trip.id, stepId: step.id, bookingId: step.bookingId, bookingLegId: step.bookingLegId, passengerId: step.passengerId,
    receiverName, receiverRole: 'family', note: '', driverConfirmed: true, capturedAt: at, actorUserId, gps, photo
  };
  trip.serviceProofs.push(proof);
  events.push(tripEvent(trip, 'trip_proof_of_service_captured', at, actorUserId, step.id, { proofId: proof.id }));
  if (trip.status === 'in_progress') settleCompletion(trip, at, actorUserId, events, blocking);
  trip.updatedAt = at;
  return finalize(trip, 'proof_service', expectedRevision, `proof_service:${trip.id}:${step.id}:${receiverName}:r${expectedRevision}`, events);
}

/** Trip.reportIssue 的結果。 */
function reportIssue(trip, actorUserId, at, type, note = '') {
  const severity = classifyIssueSeverity(type);
  const idx = firstPending(trip);
  const minutes = { emergency: 5, critical: 10, warning: 30, info: 60 }[severity];
  const issue = {
    id: nextId('iss'), schemaVersion: 3, organizationId: trip.organizationId, tripId: trip.id,
    stepId: trip.steps[idx] ? trip.steps[idx].id : null, driverId: trip.driverId, type, note, severity,
    requiresDispatch: ['critical', 'emergency'].includes(severity) || /車輛|交通事故|突發送醫/.test(type),
    status: 'open', createdAt: at, updatedAt: at, ackSlaMinutes: minutes, ackDueAt: addMinutes(at, minutes),
    acknowledgedAt: null, acknowledgedBy: null, handlingAt: null, handlingBy: null,
    resolvedAt: null, resolvedBy: null, resolutionCode: null, resolutionNote: ''
  };
  const events = [tripEvent(trip, 'trip_issue_reported', at, actorUserId, issue.stepId, { issueId: issue.id, severity })];
  return { issue, request: { tripId: trip.id, command: 'report_issue', idempotencyKey: issue.id, issue, events } };
}

/** Trip.recordLocationSample 的結果。 */
function locationSample(trip, actorUserId, at, lat = 25.0418, lng = 121.5654) {
  const sample = { id: nextId('gps'), schemaVersion: 2, at, lat, lng, deviceId: 'dev_synthetic', sessionId: 'ses_synthetic',
    serverRecordedAt: null, accuracyMeters: 12, speedMps: null, heading: null, actorUserId };
  const liveNavigation = { schemaVersion: 2, source: 'schedule', updatedAt: at, stepId: null, etaAt: null, etaMinutes: null,
    scheduledAt: null, projectedDelayMinutes: null, distanceToTargetKm: null, deviationKm: null, deviationLevel: 'unavailable', accuracyMeters: 12 };
  return { sample, request: { tripId: trip.id, command: 'location_sample', idempotencyKey: sample.id, samples: [sample], liveNavigation, events: [] } };
}

module.exports = { clone, addMinutes, outboundLeg, legRefsFor, makeTrip, snapshotOf, completeStep, undoStep, addProof, reportIssue, locationSample, firstPending };
