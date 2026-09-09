/**
 * AppStateApi.gs — V12.25.79
 * P0-B server-authoritative operational state journal in Google Sheet.
 * Existing normalized sheets remain the import/reporting model; mutations are durably stored here and overlaid on read.
 */
var APP_STATE_SHEET_="應用狀態";
var APP_STATE_HEADERS_=Object.freeze(["實體類型","實體ID","組織ID","擁有者使用者ID","關聯行程ID","關聯預約ID","資料JSON","已刪除","版本","更新時間","更新者使用者ID"]);
var APP_STATE_COLLECTIONS_=Object.freeze([
  "organizations","users","memberships","membershipEvents","drivers","vehicles","careRecipients","careRecipientRelations","careRecipientEvents","careRecipientMergeEvents",
  "bookings","bookingEvents","bookingRevisions","dispatchPlans","trips","tripEvents","issues","systemReports","notifications",
  "benefitRulesets","benefitRulesetEvents","benefitAssessments","benefitAssessmentEvents","benefitLatestEstimateRuns",
  "serviceProofs","quoteSnapshots","cancellations","telemetryEvents"
]);
function ensureAppStateSheet_(){
  var ss=getSpreadsheet_(),sheet=ss.getSheetByName(APP_STATE_SHEET_);
  if(!sheet){
    if(typeof ss.insertSheet!=="function")throw new Error("Spreadsheet 不支援建立應用狀態工作表");
    sheet=ss.insertSheet(APP_STATE_SHEET_);
    sheet.getRange(1,1,1,APP_STATE_HEADERS_.length).setValues([APP_STATE_HEADERS_.slice()]);
    try{sheet.setFrozenRows(1);}catch(_){}
  }else if(sheet.getLastColumn()<APP_STATE_HEADERS_.length){
    sheet.getRange(1,1,1,APP_STATE_HEADERS_.length).setValues([APP_STATE_HEADERS_.slice()]);
  }
  return sheet;
}
function appStateText_(v){return String(v===undefined||v===null?"":v).trim();}
function appStateBackendOrg_(id){return authBackendOrganizationId_(appStateText_(id));}
function appStateRecordId_(record){return appStateText_(record&&(record.id||record.ID||record.entityId));}
function appStateParseJson_(text){try{return JSON.parse(String(text||"{}"));}catch(_){return {};}}
function appStateSanitizeRecord_(collection,record){
  var out={};Object.keys(record&&typeof record==="object"?record:{}).forEach(function(k){out[k]=record[k];});
  if(collection==="users"){
    ["password","passwordHash","passwordUpdatedAt","credential","credentialHash","salt","sessionToken","accessToken","refreshToken","idToken"].forEach(function(k){if(Object.prototype.hasOwnProperty.call(out,k))delete out[k];});
  }
  return out;
}
/* ================================================================
 * 每次執行的快取與批次寫回
 *
 * 一次 /state/mutate 最多帶 200 筆變更。原本每一筆變更都會重讀整張
 * 「應用狀態」工作表（授權時一次、寫入時再一次），授權過程還會各自重讀
 * 「預約」「行程」「司機」「成員資格」等表。實測每張表 2000 列時，50 筆
 * 變更會產生 132 次全表讀取、掃過 8 萬多列——而這整段期間都抓著全域鎖，
 * 平台上其他人的登入會一起卡住。
 *
 * 這裡改成：整個請求只讀一次，所有變更套用在記憶體快照上，最後一次寫回。
 * 因為全程持有 script lock，快照在請求期間不會被其他執行緒改動。
 * ================================================================ */

var APP_STATE_SNAPSHOT_ = null;
var APP_STATE_TABLE_CACHE_ = null;

/** 清掉快取。取得鎖之後呼叫，確保快照讀到的是最新資料。 */
function appStateBeginRequest_() {
  APP_STATE_SNAPSHOT_ = null;
  APP_STATE_TABLE_CACHE_ = {};
}

/** 正規化工作表的每次執行快取。 */
function appStateTable_(name) {
  if (!APP_STATE_TABLE_CACHE_) APP_STATE_TABLE_CACHE_ = {};
  if (!APP_STATE_TABLE_CACHE_[name]) APP_STATE_TABLE_CACHE_[name] = readTable_(name);
  return APP_STATE_TABLE_CACHE_[name];
}

/** 走快取的有效成員資格查詢，避免每筆變更都重讀「成員資格」。 */
function appStateMembershipsForUser_(userId) {
  var target = appStateText_(userId);
  return appStateTable_("成員資格").filter(function (m) {
    return appStateText_(m["使用者ID"]) === target &&
      String(m["狀態"] || "").toLowerCase() === "active";
  });
}

function appStateSnapshotKey_(collection, id) {
  return appStateText_(collection) + "|" + appStateText_(id);
}

/** 整張「應用狀態」讀進記憶體，並建立 (實體類型|實體ID) -> 列索引 對照。 */
function appStateSnapshot_() {
  if (APP_STATE_SNAPSHOT_) return APP_STATE_SNAPSHOT_;
  var sheet = ensureAppStateSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(appStateText_);
  var typeIx = headers.indexOf("實體類型"), idIx = headers.indexOf("實體ID");
  var index = {};
  for (var r = 1; r < values.length; r++) {
    index[appStateSnapshotKey_(values[r][typeIx], values[r][idIx])] = r;
  }
  APP_STATE_SNAPSHOT_ = {
    sheet: sheet,
    headers: headers,
    values: values,
    index: index,
    originalRowCount: values.length,
    dirtyMin: -1,
    dirtyMax: -1
  };
  return APP_STATE_SNAPSHOT_;
}

function appStateRowObject_(snap, r) {
  var o = {};
  for (var i = 0; i < snap.headers.length; i++) o[snap.headers[i]] = snap.values[r][i];
  return o;
}

function appStateExistingRows_() {
  var snap = appStateSnapshot_(), out = [];
  for (var r = 1; r < snap.values.length; r++) out.push(appStateRowObject_(snap, r));
  return out;
}

function appStateFindRow_(collection, id) {
  var snap = appStateSnapshot_();
  var r = snap.index[appStateSnapshotKey_(collection, id)];
  return r === undefined ? null : appStateRowObject_(snap, r);
}

function appStateFindEntity_(collection, id) {
  var row = appStateFindRow_(collection, id);
  if (row && String(row["已刪除"]).toLowerCase() !== "true") return appStateParseJson_(row["資料JSON"]);
  return null;
}

/**
 * 把整批變更寫回工作表：已存在的列以一次 setValues 覆寫其涵蓋範圍，
 * 新增的列以一次 setValues 接在尾端。無論批次多大都只有兩次寫入呼叫。
 */
function appStateFlush_() {
  var snap = APP_STATE_SNAPSHOT_;
  if (!snap) return { updatedRows: 0, appendedRows: 0, writeCalls: 0 };
  var cols = snap.headers.length, writeCalls = 0, updatedRows = 0;

  var appendedRows = snap.values.length - snap.originalRowCount;
  if (appendedRows > 0) {
    var newRows = [];
    for (var a = snap.originalRowCount; a < snap.values.length; a++) {
      newRows.push(snap.values[a].slice(0, cols));
    }
    snap.sheet.getRange(snap.originalRowCount + 1, 1, appendedRows, cols).setValues(newRows);
    writeCalls++;
  }

  if (snap.dirtyMin >= 0) {
    updatedRows = snap.dirtyMax - snap.dirtyMin + 1;
    var block = [];
    for (var r = snap.dirtyMin; r <= snap.dirtyMax; r++) block.push(snap.values[r].slice(0, cols));
    snap.sheet.getRange(snap.dirtyMin + 1, 1, updatedRows, cols).setValues(block);
    writeCalls++;
  }

  snap.dirtyMin = -1;
  snap.dirtyMax = -1;
  snap.originalRowCount = snap.values.length;
  return { updatedRows: updatedRows, appendedRows: appendedRows, writeCalls: writeCalls };
}

function appStateNormalizedTrip_(tripId){
  var t=appStateTable_("行程").find(function(r){return appStateText_(r["行程ID"])===appStateText_(tripId);});if(!t)return null;
  return {id:appStateText_(t["行程ID"]),organizationId:appStateText_(t["組織ID"]),driverId:appStateText_(t["司機ID"])};
}
function appStateNormalizedBooking_(bookingId){
  var b=appStateTable_("預約").find(function(r){return appStateText_(r["預約ID"])===appStateText_(bookingId);});if(!b)return null;
  return {id:appStateText_(b["預約ID"]),organizationId:appStateText_(b["組織ID"]),requestedByUserId:appStateText_(b["預約者使用者ID"]),recipientId:appStateText_(b["服務對象ID"])};
}
function appStateTripForRecord_(record){var tid=appStateText_(record&&(record.tripId||record.relatedTripId));return tid?(appStateFindEntity_("trips",tid)||appStateNormalizedTrip_(tid)):null;}
function appStateBookingForRecord_(record){var bid=appStateText_(record&&(record.bookingId||record.relatedBookingId));return bid?(appStateFindEntity_("bookings",bid)||appStateNormalizedBooking_(bid)):null;}
/* ==================================================================
 * P0-A(2) — Server-authoritative mutation authorization.
 *
 * The previous implementation derived "who owns this record" from fields in
 * the caller's own payload (record.requestedByUserId, record.userId,
 * record.governance.createdByUserId, …) and only fell back to stored state.
 * Because the authorization test was `owner === ctx.userId`, any signed-in
 * account could claim ownership of any record simply by putting its own user
 * id in the payload, and overwrite another user's booking.
 *
 * Ownership is now resolved exclusively from server state, in this order:
 *   1. the existing 應用狀態 row
 *   2. the corresponding normalized sheet row
 *   3. genuinely new record — the owner is forced to the acting user
 *
 * Payload fields are treated as pointers ("this event belongs to booking X"),
 * never as proof of entitlement.
 * ================================================================== */

var APP_STATE_NORMALIZED_SOURCE_ = Object.freeze({
  bookings:       { sheet: "預約",     idHeader: "預約ID",     ownerHeader: "預約者使用者ID", orgHeader: "組織ID" },
  trips:          { sheet: "行程",     idHeader: "行程ID",     ownerHeader: "",              orgHeader: "組織ID" },
  users:          { sheet: "使用者",   idHeader: "使用者ID",   ownerHeader: "使用者ID",      orgHeader: "" },
  organizations:  { sheet: "組織",     idHeader: "組織ID",     ownerHeader: "",              orgHeader: "組織ID" },
  memberships:    { sheet: "成員資格", idHeader: "成員資格ID", ownerHeader: "使用者ID",      orgHeader: "組織ID" },
  drivers:        { sheet: "司機",     idHeader: "司機ID",     ownerHeader: "使用者ID",      orgHeader: "組織ID" },
  vehicles:       { sheet: "車輛",     idHeader: "車輛ID",     ownerHeader: "",              orgHeader: "組織ID" },
  careRecipients: { sheet: "服務對象", idHeader: "服務對象ID", ownerHeader: "",              orgHeader: "" }
});

/** Owner/organization for an id as recorded in the normalized sheets. */
function appStateNormalizedScope_(collection, id) {
  var meta = APP_STATE_NORMALIZED_SOURCE_[collection];
  if (!meta || !id) return null;
  if (!getSpreadsheet_().getSheetByName(meta.sheet)) return null;
  var row = appStateTable_(meta.sheet).find(function (r) {
    return appStateText_(r[meta.idHeader]) === id;
  });
  if (!row) return null;
  return {
    organizationId: meta.orgHeader ? appStateBackendOrg_(row[meta.orgHeader]) : "",
    ownerUserId: meta.ownerHeader ? appStateText_(row[meta.ownerHeader]) : "",
    source: "normalized:" + meta.sheet
  };
}

/** Booking lifecycle state according to the server, ignoring the payload. */
function appStateCurrentBookingState_(id, existing) {
  if (existing && String(existing["已刪除"]).toLowerCase() !== "true") {
    var current = appStateParseJson_(existing["資料JSON"]);
    if (current && current.state) return String(current.state).toLowerCase();
  }
  var normalized = appStateNormalizedBookingRow_(id);
  return String(normalized && normalized["預約狀態"] || "").toLowerCase();
}

/**
 * The single source of truth for a mutation's owner and organization.
 * `isNew` marks a record that exists in neither 應用狀態 nor the normalized
 * sheets — the only case where the caller has any influence, and even then the
 * owner is set to the acting user rather than taken from the payload.
 */
function appStateAuthoritativeScope_(ctx, collection, id, record, existing) {
  record = record || {};

  if (existing) {
    return {
      isNew: false,
      organizationId: appStateBackendOrg_(existing["組織ID"]),
      ownerUserId: appStateText_(existing["擁有者使用者ID"]),
      tripId: appStateText_(existing["關聯行程ID"]),
      bookingId: appStateText_(existing["關聯預約ID"]),
      source: "app_state"
    };
  }

  var normalized = appStateNormalizedScope_(collection, id);
  if (normalized) {
    return {
      isNew: false,
      organizationId: normalized.organizationId,
      ownerUserId: normalized.ownerUserId,
      tripId: collection === "trips" ? id : "",
      bookingId: collection === "bookings" ? id : "",
      source: normalized.source
    };
  }

  /* New record. Parent links are still resolved against server state. */
  var tripId = appStateText_(record.tripId || record.relatedTripId);
  var bookingId = appStateText_(record.bookingId || record.relatedBookingId);
  var trip = tripId ? (appStateFindEntity_("trips", tripId) || appStateNormalizedTrip_(tripId)) : null;
  var booking = bookingId ? (appStateFindEntity_("bookings", bookingId) || appStateNormalizedBooking_(bookingId)) : null;

  var org = appStateBackendOrg_(record.organizationId || record.orgId || "");
  if (trip && trip.organizationId) org = appStateBackendOrg_(trip.organizationId);
  else if (booking && booking.organizationId) org = appStateBackendOrg_(booking.organizationId);
  if (collection === "organizations") org = appStateBackendOrg_(id);

  return {
    isNew: true,
    organizationId: org,
    ownerUserId: collection === "users" ? appStateText_(id) : ctx.userId,
    tripId: tripId,
    bookingId: bookingId,
    trip: trip,
    booking: booking,
    source: "new"
  };
}

function appStateRoleInOrg_(ctx, orgId, roles) {
  orgId = appStateBackendOrg_(orgId);
  roles = roles || [];
  if (!orgId) return false;
  return ctx.memberships.some(function (m) {
    return appStateText_(m["組織ID"]) === orgId &&
      roles.indexOf(String(m["角色"] || "").toLowerCase()) >= 0;
  });
}

function appStateDriverOwnsTrip_(ctx, scope) {
  var trip = scope.trip || null;
  if (!trip && scope.tripId) trip = appStateFindEntity_("trips", scope.tripId) || appStateNormalizedTrip_(scope.tripId);
  if (!trip) return false;
  var ownDriverIds = {};
  appStateTable_("司機").forEach(function (d) {
    if (appStateText_(d["使用者ID"]) === ctx.userId) ownDriverIds[appStateText_(d["司機ID"])] = true;
  });
  return !!ownDriverIds[appStateText_(trip.driverId)];
}

/**
 * Care recipients carry no organization or owner column, so entitlement comes
 * from the 服務對象聯絡人 relation table — never from record.governance,
 * which the caller controls.
 */
function appStateRequesterOwnsRecipient_(ctx, recipientId) {
  var rid = appStateText_(recipientId);
  if (!rid) return false;
  var relation = appStateTable_("服務對象聯絡人").find(function (r) {
    return appStateText_(r["使用者ID"]) === ctx.userId &&
      appStateText_(r["服務對象ID"]) === rid &&
      String(r["狀態"] || "active").toLowerCase() !== "revoked";
  });
  if (relation) return true;
  return !!appStateFindEntity_("careRecipientRelations", rid + "|" + ctx.userId);
}

/** Booking referenced by an event/revision row, resolved from server state. */
function appStateParentBookingScope_(record, scope) {
  var bookingId = appStateText_(scope.bookingId || (record && (record.bookingId || record.relatedBookingId)));
  if (!bookingId) return null;
  var booking = appStateFindEntity_("bookings", bookingId) || appStateNormalizedBooking_(bookingId);
  if (booking) {
    return {
      ownerUserId: appStateText_(booking.requestedByUserId),
      organizationId: appStateBackendOrg_(booking.organizationId)
    };
  }
  var row = appStateFindRow_("bookings", bookingId);
  if (!row) return null;
  return {
    ownerUserId: appStateText_(row["擁有者使用者ID"]),
    organizationId: appStateBackendOrg_(row["組織ID"])
  };
}

/**
 * Authorizes one mutation and returns the authoritative scope that must be
 * written to the sheet. Throws FORBIDDEN instead of returning false so a
 * caller can never accidentally treat a rejection as permission.
 */
function appStateAuthorizeMutation_(ctx, collection, id, record, existing, deleted) {
  record = record || {};
  var scope = appStateAuthoritativeScope_(ctx, collection, id, record, existing);
  if (ctx.isSuperAdmin) return scope;

  var owner = scope.ownerUserId;
  var org = scope.organizationId;
  var ownerInOrg = appStateRoleInOrg_(ctx, org, ["owner"]);
  var dispatcherInOrg = appStateRoleInOrg_(ctx, org, ["dispatcher"]);
  var operatorInOrg = ownerInOrg || dispatcherInOrg;
  var ok = false;

  if (collection === "users") {
    var targetUserId = appStateText_(id);
    if (targetUserId === ctx.userId) ok = !deleted;
    else ok = appStateMembershipsForUser_(targetUserId).some(function (m) {
      return appStateText_(m["組織ID"]) && appStateRoleInOrg_(ctx, m["組織ID"], ["owner"]);
    });

  } else if (collection === "memberships") {
    /* For a new membership the target organization necessarily comes from the
     * payload; it is validated against the actor's own owner role, so naming a
     * foreign organization grants nothing. */
    var membershipOrg = scope.isNew ? appStateBackendOrg_(record.organizationId) : org;
    var targetRole = String(record.role || "").toLowerCase();
    ok = !!membershipOrg && appStateRoleInOrg_(ctx, membershipOrg, ["owner"]) && targetRole !== "owner";
    if (ok) scope.organizationId = membershipOrg;

  } else if (collection === "membershipEvents") {
    ok = owner === ctx.userId || ownerInOrg;

  } else if (collection === "organizations") {
    ok = ownerInOrg && !deleted;

  } else if (collection === "vehicles" || collection === "drivers") {
    ok = ownerInOrg;

  } else if (collection === "dispatchPlans" || collection === "trips" || collection === "notifications") {
    ok = operatorInOrg;

  } else if (collection === "tripEvents" || collection === "issues" ||
             collection === "serviceProofs" || collection === "telemetryEvents") {
    ok = operatorInOrg || appStateDriverOwnsTrip_(ctx, scope);

  } else if (collection === "bookings") {
    ok = (!!owner && owner === ctx.userId) || operatorInOrg;
    if (!ok && !org && (ctx.roleSet.owner || ctx.roleSet.dispatcher)) {
      /* Public pool claim: an unclaimed booking may be taken by an active
       * operator, but only into an organization they actually belong to, and
       * only while the server still considers the booking open. */
      var claimOrg = appStateBackendOrg_(record.organizationId || "");
      if (claimOrg &&
          appStateCurrentBookingState_(id, existing) === "open" &&
          appStateRoleInOrg_(ctx, claimOrg, ["owner", "dispatcher"])) {
        ok = true;
        scope.organizationId = claimOrg;
      }
    }

  } else if (collection === "bookingEvents" || collection === "bookingRevisions" ||
             collection === "quoteSnapshots" || collection === "cancellations") {
    var parent = appStateParentBookingScope_(record, scope);
    ok = !!parent && (parent.ownerUserId === ctx.userId ||
      appStateRoleInOrg_(ctx, parent.organizationId, ["owner", "dispatcher"]));
    if (ok && parent.organizationId && !scope.organizationId) scope.organizationId = parent.organizationId;

  } else if (collection === "careRecipients") {
    ok = appStateRequesterOwnsRecipient_(ctx, id) || operatorInOrg;

  } else if (collection === "careRecipientRelations" || collection === "careRecipientEvents" ||
             collection === "careRecipientMergeEvents") {
    ok = (!!owner && owner === ctx.userId) || operatorInOrg;

  } else if (collection === "benefitAssessments" || collection === "benefitAssessmentEvents" ||
             collection === "benefitLatestEstimateRuns") {
    ok = (!!owner && owner === ctx.userId) || operatorInOrg;

  } else if (collection === "benefitRulesets" || collection === "benefitRulesetEvents") {
    ok = false; /* platform-managed */

  } else if (collection === "systemReports") {
    ok = !!owner && owner === ctx.userId;
  }

  if (!ok) throw authError_("FORBIDDEN", "目前身分無權修改 " + collection + " / " + id);
  return scope;
}

/**
 * Owner/organization actually written to the sheet. For an existing record the
 * authorized scope is authoritative and immutable. For a new record whose
 * authorization was organization-role based, the payload may name the target
 * user — the actor has already proved authority over that organization.
 */
function appStateResolveWriteScope_(collection,id,record,ctx,authorizedScope){
  var scope=authorizedScope||appStateAuthoritativeScope_(ctx,collection,id,record||{},null);
  var out={organizationId:scope.organizationId,ownerUserId:scope.ownerUserId,tripId:scope.tripId,bookingId:scope.bookingId};
  if(scope.isNew&&["memberships","membershipEvents","drivers","users"].indexOf(collection)>=0){
    var target=appStateText_(record&&(record.userId||record.id));
    if(target)out.ownerUserId=target;
  }
  return out;
}

function appStateNormalizedBookingRow_(bookingId){return appStateTable_("預約").find(function(r){return appStateText_(r["預約ID"])===appStateText_(bookingId);})||null;}
function appStateValidateBookingVersion_(id,record,existing){
  if(!record||typeof record!=="object")return;
  var current=null;
  if(existing&&String(existing["已刪除"]).toLowerCase()!=="true")current=appStateParseJson_(existing["資料JSON"]);
  var normalized=appStateNormalizedBookingRow_(id);
  var currentState=String(current&&current.state||normalized&&normalized["預約狀態"]||"").toLowerCase();
  var currentOrg=appStateBackendOrg_(current&&current.organizationId||normalized&&normalized["組織ID"]||"");
  var currentVersion=Math.max(1,Number(current&&current.version||1)||1),nextState=String(record.state||"").toLowerCase(),nextOrg=appStateBackendOrg_(record.organizationId||"");
  var nextVersion=Math.max(1,Number(record.version||1)||1);
  if(currentState==="open"&&nextState==="claimed"){
    if(nextVersion!==currentVersion+1)throw authError_("BOOKING_CONFLICT","案件版本已變更，請重新整理公開需求池");
  }else if(currentState==="claimed"&&nextState==="claimed"&&currentOrg&&nextOrg&&currentOrg!==nextOrg){
    throw authError_("BOOKING_CONFLICT","此需求已被其他服務單位接走");
  }else if(current&&nextVersion<currentVersion){
    throw authError_("BOOKING_CONFLICT","案件版本已過期，請重新整理後再操作");
  }
}
function appStateValidateTripRevision_(id,record,existing,expectedRevision){
  if(!record||typeof record!=="object")return {duplicate:false};
  var current=null;if(existing&&String(existing["已刪除"]).toLowerCase()!=="true")current=appStateParseJson_(existing["資料JSON"]);
  if(!current){
    if(expectedRevision!==null&&expectedRevision!==undefined&&Number(expectedRevision)!==0)throw authError_("TRIP_CONFLICT","行程基準版本不存在，請重新同步後再操作");
    return {duplicate:false};
  }
  var currentRevision=Math.max(0,Number(current.revision)||0),incomingRevision=Math.max(0,Number(record.revision)||0);
  if(expectedRevision===null||expectedRevision===undefined)throw authError_("TRIP_CONFLICT","缺少行程基準版本，請重新整理後再操作");
  if(Number(expectedRevision)!==currentRevision){
    if(incomingRevision===currentRevision&&JSON.stringify(current)===JSON.stringify(record))return {duplicate:true,currentRevision:currentRevision};
    throw authError_("TRIP_CONFLICT","此行程已在其他裝置更新，請重新整理後再操作");
  }
  if(incomingRevision<=currentRevision)throw authError_("TRIP_CONFLICT","行程版本未遞增，已阻擋舊畫面覆寫");
  return {duplicate:false,currentRevision:currentRevision};
}
function appStateUpsertRow_(collection,id,record,deleted,ctx,authorizedScope){
  var snap=appStateSnapshot_(),headers=snap.headers;
  var key=appStateSnapshotKey_(collection,id),rowIndex=snap.index[key];
  var existing=rowIndex===undefined?null:appStateRowObject_(snap,rowIndex);
  var scope=appStateResolveWriteScope_(collection,id,record,ctx,authorizedScope),version=Math.max(1,Number(existing&&existing["版本"]||0)+1),now=new Date().toISOString(),payloadRecord=appStateSanitizeRecord_(collection,record||{});
  if(collection==="bookings"&&record&&record.publicSanitized&&existing&&String(existing["已刪除"]).toLowerCase()!=="true"){
    var prior=appStateParseJson_(existing["資料JSON"]),safeKeys=["state","version","revisionNo","stateChangedAt","updatedAt","organizationId","claimStatus","claimedByUserId","claimedAt","status","tripId","marketExpiresAt","activeLegId","legs","cancellation","commercialSnapshots","activeCommercialSnapshotId"];
    payloadRecord={};Object.keys(prior||{}).forEach(function(k){payloadRecord[k]=prior[k];});safeKeys.forEach(function(k){if(record[k]!==undefined)payloadRecord[k]=record[k];});payloadRecord.publicSanitized=false;
  }
  payloadRecord=appStateSanitizeRecord_(collection,payloadRecord);
  var obj={"實體類型":collection,"實體ID":id,"組織ID":scope.organizationId,"擁有者使用者ID":scope.ownerUserId,"關聯行程ID":scope.tripId,"關聯預約ID":scope.bookingId,"資料JSON":deleted?"":JSON.stringify(payloadRecord),"已刪除":!!deleted,"版本":version,"更新時間":now,"更新者使用者ID":ctx.userId};
  var row=headers.map(function(h){return obj[h]!==undefined?obj[h]:"";});
  if(rowIndex===undefined){
    // 新列先放進快照尾端，flush 時整批一次接到工作表後面。
    snap.values.push(row);snap.index[key]=snap.values.length-1;
  }else{
    snap.values[rowIndex]=row;
    if(rowIndex<snap.originalRowCount){
      if(snap.dirtyMin<0||rowIndex<snap.dirtyMin)snap.dirtyMin=rowIndex;
      if(rowIndex>snap.dirtyMax)snap.dirtyMax=rowIndex;
    }
  }
  return obj;
}
function mutateAppState_(body,req){
  body=body||{};var ctx=databaseAuthContextFromToken_(body.sessionToken),changes=Array.isArray(body.changes)?body.changes:[];
  if(!changes.length)throw authError_("VALIDATION_ERROR","沒有可儲存的資料異動");if(changes.length>200)throw authError_("VALIDATION_ERROR","單次異動最多 200 筆");
  var lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    // 取得鎖之後才建立快照，確保讀到的是最新資料。
    appStateBeginRequest_();
    var results=[];
    // 驗證、授權與套用在同一個迴圈完成：同一批次中對同一筆資料的第二次變更
    // 因此看得到第一次的結果（舊版分兩段跑，版本檢查會被同批次的前一筆繞過）。
    // 所有變更只寫進記憶體快照，全部成功後才一次寫回工作表——任何一筆丟出
    // 例外就整批不落地，不會留下寫到一半的資料。
    changes.forEach(function(change){
      var collection=appStateText_(change.collection),rawRecord=change.record&&typeof change.record==="object"?change.record:{},record=appStateSanitizeRecord_(collection,rawRecord),id=appStateText_(change.id||appStateRecordId_(record)),deleted=change.deleted===true;
      if(APP_STATE_COLLECTIONS_.indexOf(collection)<0)throw authError_("COLLECTION_FORBIDDEN","不允許寫入此資料集合："+collection);
      if(!id||id.length>180)throw authError_("VALIDATION_ERROR","資料 ID 無效");
      var existing=appStateFindRow_(collection,id),tripGuard={duplicate:false};
      if(collection==="bookings"&&!deleted)appStateValidateBookingVersion_(id,record,existing);
      if(collection==="trips"&&!deleted)tripGuard=appStateValidateTripRevision_(id,record,existing,change.expectedRevision);
      var scope=appStateAuthorizeMutation_(ctx,collection,id,record,existing,deleted);
      if(tripGuard.duplicate===true){
        results.push({collection:collection,id:id,deleted:false,duplicate:true,version:Number(existing&&existing["版本"]||0),updatedAt:existing&&existing["更新時間"]||""});
        return;
      }
      var saved=appStateUpsertRow_(collection,id,record,deleted,ctx,scope);
      results.push({collection:collection,id:id,deleted:deleted,version:saved["版本"],updatedAt:saved["更新時間"]});
    });
    var flushed=appStateFlush_();
    try{writeAudit_({eventType:"state.batch_mutated",actorUserId:ctx.userId,organizationId:"",entityType:"app_state",entityId:"batch",reasonCode:"AUTHORITATIVE_WRITE",details:{requestId:req&&req.requestId||"",count:results.length,writeCalls:flushed.writeCalls}});}catch(auditError){authRecordAuditFailure_("state.batch_mutated",auditError);}
    return {ok:true,results:results,count:results.length};
  }finally{
    lock.releaseLock();
    appStateBeginRequest_();
  }
}
