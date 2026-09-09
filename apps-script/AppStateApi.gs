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
function appStateExistingRows_(){ensureAppStateSheet_();return readTable_(APP_STATE_SHEET_);}
function appStateFindRow_(collection,id){return appStateExistingRows_().find(function(r){return appStateText_(r["實體類型"])===collection&&appStateText_(r["實體ID"])===id;})||null;}
function appStateFindEntity_(collection,id){var row=appStateFindRow_(collection,id);if(row&&String(row["已刪除"]).toLowerCase()!=="true")return appStateParseJson_(row["資料JSON"]);return null;}
function appStateNormalizedTrip_(tripId){
  var t=readTable_("行程").find(function(r){return appStateText_(r["行程ID"])===appStateText_(tripId);});if(!t)return null;
  return {id:appStateText_(t["行程ID"]),organizationId:appStateText_(t["組織ID"]),driverId:appStateText_(t["司機ID"])};
}
function appStateNormalizedBooking_(bookingId){
  var b=readTable_("預約").find(function(r){return appStateText_(r["預約ID"])===appStateText_(bookingId);});if(!b)return null;
  return {id:appStateText_(b["預約ID"]),organizationId:appStateText_(b["組織ID"]),requestedByUserId:appStateText_(b["預約者使用者ID"]),recipientId:appStateText_(b["服務對象ID"])};
}
function appStateTripForRecord_(record){var tid=appStateText_(record&&(record.tripId||record.relatedTripId));return tid?(appStateFindEntity_("trips",tid)||appStateNormalizedTrip_(tid)):null;}
function appStateBookingForRecord_(record){var bid=appStateText_(record&&(record.bookingId||record.relatedBookingId));return bid?(appStateFindEntity_("bookings",bid)||appStateNormalizedBooking_(bid)):null;}
function appStateInferScope_(collection,record,existing){
  record=record||{};existing=existing||{};
  var org=appStateText_(record.organizationId||record.orgId||record.sourceOrganizationId||record.governance&&record.governance.sourceOrganizationId||existing["組織ID"]),
      owner=appStateText_(record.requestedByUserId||record.userId||record.createdByUserId||record.governance&&record.governance.createdByUserId||existing["擁有者使用者ID"]),
      tripId=appStateText_(record.tripId||record.relatedTripId||existing["關聯行程ID"]),bookingId=appStateText_(record.bookingId||record.relatedBookingId||existing["關聯預約ID"]);
  if(collection==="users"){
    owner=appStateText_(record.id||owner);
    if(!org&&owner){var userMemberships=authMembershipsForUser_(owner).filter(function(m){return appStateText_(m["組織ID"])!=="ORG-REQ-001";});if(userMemberships.length===1)org=appStateText_(userMemberships[0]["組織ID"]);}
  }
  if(collection==="memberships"||collection==="membershipEvents"){owner=appStateText_(record.userId||owner);org=appStateText_(record.organizationId||org);}
  if(collection==="organizations")org=appStateText_(record.id||org);
  if(collection==="drivers")org=appStateText_(record.organizationId||org);
  if(collection==="careRecipientRelations")owner=appStateText_(record.userId||owner);
  if(collection==="bookings")owner=appStateText_(record.requestedByUserId||owner);
  var trip=tripId?(appStateFindEntity_("trips",tripId)||appStateNormalizedTrip_(tripId)):null;
  if(trip&&!org)org=appStateText_(trip.organizationId);
  var booking=bookingId?(appStateFindEntity_("bookings",bookingId)||appStateNormalizedBooking_(bookingId)):null;
  if(booking){if(!org)org=appStateText_(booking.organizationId);if(!owner)owner=appStateText_(booking.requestedByUserId);}
  return {organizationId:appStateBackendOrg_(org),ownerUserId:owner,tripId:tripId,bookingId:bookingId,trip:trip,booking:booking};
}
function appStateRoleInOrg_(ctx,orgId,roles){
  orgId=appStateBackendOrg_(orgId);roles=roles||[];
  return ctx.memberships.some(function(m){return appStateText_(m["組織ID"])===orgId&&roles.indexOf(String(m["角色"]||"").toLowerCase())>=0;});
}
function appStateDriverOwnsTrip_(ctx,scope){
  var trip=scope.trip||null;if(!trip&&scope.tripId)trip=appStateFindEntity_("trips",scope.tripId)||appStateNormalizedTrip_(scope.tripId);if(!trip)return false;
  var ownDriverIds={};readTable_("司機").forEach(function(d){if(appStateText_(d["使用者ID"])===ctx.userId)ownDriverIds[appStateText_(d["司機ID"])]=true;});
  return !!ownDriverIds[appStateText_(trip.driverId)];
}
function appStateRequesterOwnsRecipient_(ctx,record){
  var rid=appStateText_(record&&record.id||record&&record.recipientId);if(!rid)return false;
  if(appStateText_(record&&record.governance&&record.governance.createdByUserId)===ctx.userId)return true;
  var relation=readTable_("服務對象聯絡人").find(function(r){return appStateText_(r["使用者ID"])===ctx.userId&&appStateText_(r["服務對象ID"])===rid&&String(r["狀態"]||"active").toLowerCase()!=="revoked";});
  if(relation)return true;
  return !!appStateFindEntity_("careRecipientRelations",rid+"|"+ctx.userId);
}
function appStateAuthorizeMutation_(ctx,collection,record,existing,deleted){
  if(ctx.isSuperAdmin)return true;
  var scope=appStateInferScope_(collection,record,existing),owner=scope.ownerUserId,org=scope.organizationId;
  var ownerInOrg=appStateRoleInOrg_(ctx,org,["owner"]),dispatcherInOrg=appStateRoleInOrg_(ctx,org,["dispatcher"]);
  if(collection==="users"){
    var targetUserId=appStateText_(record.id||existing&&existing["實體ID"]);if(targetUserId===ctx.userId)return !deleted;
    return authMembershipsForUser_(targetUserId).some(function(m){return appStateText_(m["組織ID"])&&appStateRoleInOrg_(ctx,m["組織ID"],["owner"]);});
  }
  if(collection==="memberships"){
    var membershipOrg=appStateBackendOrg_(record.organizationId||org),targetRole=String(record.role||"").toLowerCase();
    if(!membershipOrg)return false;if(!appStateRoleInOrg_(ctx,membershipOrg,["owner"]))return false;
    return targetRole!=="owner";
  }
  if(collection==="membershipEvents")return owner===ctx.userId||ownerInOrg;
  if(collection==="organizations")return ownerInOrg&&!deleted;
  if(collection==="vehicles")return ownerInOrg;
  if(collection==="drivers")return ownerInOrg;
  if(collection==="dispatchPlans")return ownerInOrg||dispatcherInOrg;
  if(collection==="trips"||collection==="notifications")return ownerInOrg||dispatcherInOrg;
  if(collection==="tripEvents"||collection==="issues"||collection==="serviceProofs"||collection==="telemetryEvents")return ownerInOrg||dispatcherInOrg||appStateDriverOwnsTrip_(ctx,scope);
  if(collection==="bookings")return owner===ctx.userId||ownerInOrg||dispatcherInOrg;
  if(collection==="bookingEvents"||collection==="bookingRevisions"||collection==="quoteSnapshots"||collection==="cancellations"){
    var b=scope.booking||appStateBookingForRecord_(record);return !!b&&(appStateText_(b.requestedByUserId)===ctx.userId||appStateRoleInOrg_(ctx,b.organizationId,["owner","dispatcher"]));
  }
  if(collection==="careRecipients")return appStateRequesterOwnsRecipient_(ctx,record)||ownerInOrg||dispatcherInOrg;
  if(collection==="careRecipientRelations"||collection==="careRecipientEvents"||collection==="careRecipientMergeEvents")return owner===ctx.userId||ownerInOrg||dispatcherInOrg;
  if(collection==="benefitAssessments"||collection==="benefitAssessmentEvents"||collection==="benefitLatestEstimateRuns")return owner===ctx.userId||ownerInOrg||dispatcherInOrg;
  if(collection==="benefitRulesets"||collection==="benefitRulesetEvents")return false;
  if(collection==="systemReports")return owner===ctx.userId||appStateText_(record.reporterUserId||record.userId||record.actorUserId)===ctx.userId;
  return false;
}
function appStateNormalizedBookingRow_(bookingId){return readTable_("預約").find(function(r){return appStateText_(r["預約ID"])===appStateText_(bookingId);})||null;}
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
function appStateUpsertRow_(collection,id,record,deleted,ctx){
  var sheet=ensureAppStateSheet_(),values=sheet.getDataRange().getValues(),headers=values[0].map(function(v){return appStateText_(v);}),typeIx=headers.indexOf("實體類型"),idIx=headers.indexOf("實體ID"),rowIndex=-1,existing=null;
  for(var r=1;r<values.length;r++){if(appStateText_(values[r][typeIx])===collection&&appStateText_(values[r][idIx])===id){rowIndex=r+1;existing={};headers.forEach(function(h,i){existing[h]=values[r][i];});break;}}
  var scope=appStateInferScope_(collection,record,existing||{}),version=Math.max(1,Number(existing&&existing["版本"]||0)+1),now=new Date().toISOString(),payloadRecord=appStateSanitizeRecord_(collection,record||{});
  if(collection==="bookings"&&record&&record.publicSanitized&&existing&&String(existing["已刪除"]).toLowerCase()!=="true"){
    var prior=appStateParseJson_(existing["資料JSON"]),safeKeys=["state","version","revisionNo","stateChangedAt","updatedAt","organizationId","claimStatus","claimedByUserId","claimedAt","status","tripId","marketExpiresAt","activeLegId","legs","cancellation","commercialSnapshots","activeCommercialSnapshotId"];
    payloadRecord={};Object.keys(prior||{}).forEach(function(k){payloadRecord[k]=prior[k];});safeKeys.forEach(function(k){if(record[k]!==undefined)payloadRecord[k]=record[k];});payloadRecord.publicSanitized=false;
  }
  payloadRecord=appStateSanitizeRecord_(collection,payloadRecord);
  var obj={"實體類型":collection,"實體ID":id,"組織ID":scope.organizationId,"擁有者使用者ID":scope.ownerUserId,"關聯行程ID":scope.tripId,"關聯預約ID":scope.bookingId,"資料JSON":deleted?"":JSON.stringify(payloadRecord),"已刪除":!!deleted,"版本":version,"更新時間":now,"更新者使用者ID":ctx.userId};
  var row=headers.map(function(h){return obj[h]!==undefined?obj[h]:"";});
  if(rowIndex>0)sheet.getRange(rowIndex,1,1,headers.length).setValues([row]);else sheet.appendRow(row);
  return obj;
}
function mutateAppState_(body,req){
  body=body||{};var ctx=databaseAuthContextFromToken_(body.sessionToken),changes=Array.isArray(body.changes)?body.changes:[];
  if(!changes.length)throw authError_("VALIDATION_ERROR","沒有可儲存的資料異動");if(changes.length>200)throw authError_("VALIDATION_ERROR","單次異動最多 200 筆");
  var lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    var results=[],prepared=[];
    changes.forEach(function(change){
      var collection=appStateText_(change.collection),rawRecord=change.record&&typeof change.record==="object"?change.record:{},record=appStateSanitizeRecord_(collection,rawRecord),id=appStateText_(change.id||appStateRecordId_(record)),deleted=change.deleted===true;
      if(APP_STATE_COLLECTIONS_.indexOf(collection)<0)throw authError_("COLLECTION_FORBIDDEN","不允許寫入此資料集合："+collection);
      if(!id||id.length>180)throw authError_("VALIDATION_ERROR","資料 ID 無效");
      var existing=appStateFindRow_(collection,id),tripGuard={duplicate:false};
      if(collection==="bookings"&&!deleted)appStateValidateBookingVersion_(id,record,existing);
      if(collection==="trips"&&!deleted)tripGuard=appStateValidateTripRevision_(id,record,existing,change.expectedRevision);
      if(!appStateAuthorizeMutation_(ctx,collection,record,existing,deleted))throw authError_("FORBIDDEN","目前身分無權修改 "+collection+" / "+id);
      prepared.push({collection:collection,id:id,record:record,deleted:deleted,duplicate:tripGuard.duplicate===true,existing:existing});
    });
    prepared.forEach(function(change){
      if(change.duplicate){results.push({collection:change.collection,id:change.id,deleted:false,duplicate:true,version:Number(change.existing&&change.existing["版本"]||0),updatedAt:change.existing&&change.existing["更新時間"]||""});return;}
      var saved=appStateUpsertRow_(change.collection,change.id,change.record,change.deleted,ctx);results.push({collection:change.collection,id:change.id,deleted:change.deleted,version:saved["版本"],updatedAt:saved["更新時間"]});
    });
    try{writeAudit_({eventType:"state.batch_mutated",actorUserId:ctx.userId,organizationId:"",entityType:"app_state",entityId:"batch",reasonCode:"AUTHORITATIVE_WRITE",details:{requestId:req&&req.requestId||"",count:results.length}});}catch(_){}
    return {ok:true,results:results,count:results.length};
  }finally{lock.releaseLock();}
}
