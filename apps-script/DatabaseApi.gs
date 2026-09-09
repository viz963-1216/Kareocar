/**
 * DatabaseApi.gs — V12.25.79
 * Session-authenticated + row-level-authorized Google Sheet read API.
 * P0-A: least-privilege rows are enforced on the server, not by front-end hiding.
 */
var DATABASE_READABLE_SHEETS_=Object.freeze([
  "組織","使用者","成員資格","服務對象","服務對象聯絡人","預約","司機","車輛","行程","行程預約關聯","服務證明","稽核紀錄",
  "預約異動歷史","調度最佳化","異常回報","通知紀錄","補助試算","系統回報","KPI每日","預約報價快照","取消退單","行程遙測事件","應用狀態"
]);
function databaseRequestValue_(req,key){
  if(!req)return "";
  if(req[key]!==undefined&&req[key]!==null)return req[key];
  if(req.query&&req.query[key]!==undefined)return req.query[key];
  if(req.params&&req.params[key]!==undefined)return req.params[key];
  if(req.body&&req.body[key]!==undefined)return req.body[key];
  return "";
}
function dbText_(v){return String(v===undefined||v===null?"":v).trim();}
function dbLower_(v){return dbText_(v).toLowerCase();}
function dbField_(row,names){for(var i=0;i<names.length;i++){var n=names[i];if(row&&row[n]!==undefined&&row[n]!==null&&dbText_(row[n])!=="")return row[n];}return "";}
function dbIn_(value,set){return set.has(dbText_(value));}
function dbActiveMembership_(m){return dbLower_(m["狀態"])==="active";}
function dbSet_(values){var s={};(values||[]).forEach(function(v){v=dbText_(v);if(v)s[v]=true;});return s;}
function dbHas_(setObj,value){return !!setObj[dbText_(value)];}
function dbKeys_(setObj){return Object.keys(setObj||{});}
function dbMergeSet_(target,values){(values||[]).forEach(function(v){v=dbText_(v);if(v)target[v]=true;});return target;}
function dbUserById_(userId){return readTable_("使用者").find(function(u){return dbText_(u["使用者ID"])===dbText_(userId);})||null;}
function databaseAuthContextFromToken_(sessionToken){
  var payload=authVerifySessionToken_(String(sessionToken||""));
  var userId=dbText_(payload.userId),user=dbUserById_(userId);
  if(!user||!authIsEnabled_(user["啟用狀態"]))throw authError_("FORBIDDEN","目前帳號已停用或不存在");
  var memberships=authMembershipsForUser_(userId),platformRole=dbLower_(user["平台角色"]||"none"),orgSet={},roleSet={},opsOrgSet={};
  memberships.forEach(function(m){
    var oid=dbText_(m["組織ID"]),role=dbLower_(m["角色"]);if(oid)orgSet[oid]=true;if(role)roleSet[role]=true;
    if((role==="owner"||role==="dispatcher"||role==="driver")&&oid&&oid!=="ORG-REQ-001")opsOrgSet[oid]=true;
  });
  return {userId:userId,user:user,platformRole:platformRole,isSuperAdmin:platformRole==="super_admin",memberships:memberships,orgSet:orgSet,opsOrgSet:opsOrgSet,roleSet:roleSet};
}
function databaseAuthContext_(req){return databaseAuthContextFromToken_(databaseRequestValue_(req,"sessionToken"));}
function databaseDriverIdsForUser_(ctx){
  var s={};readTable_("司機").forEach(function(d){if(dbText_(d["使用者ID"])===ctx.userId)s[dbText_(d["司機ID"])]=true;});return s;
}
function databaseScope_(ctx){
  if(ctx._dbScope)return ctx._dbScope;
  var bookings=readTable_("預約"),trips=readTable_("行程"),links=readTable_("行程預約關聯"),relations=readTable_("服務對象聯絡人"),drivers=readTable_("司機");
  var bookingIds={},tripIds={},recipientIds={},driverIds=databaseDriverIdsForUser_(ctx),staffUserIds={};
  staffUserIds[ctx.userId]=true;
  if(ctx.isSuperAdmin){
    bookings.forEach(function(b){bookingIds[dbText_(b["預約ID"])]=true;dbMergeSet_(recipientIds,[b["服務對象ID"]]);});
    trips.forEach(function(t){tripIds[dbText_(t["行程ID"])]=true;});
    relations.forEach(function(r){dbMergeSet_(recipientIds,[r["服務對象ID"]]);});
    drivers.forEach(function(d){dbMergeSet_(driverIds,[d["司機ID"]]);dbMergeSet_(staffUserIds,[d["使用者ID"]]);});
  }else{
    // Requester ownership.
    bookings.forEach(function(b){if(dbText_(b["預約者使用者ID"])===ctx.userId){bookingIds[dbText_(b["預約ID"])]=true;dbMergeSet_(recipientIds,[b["服務對象ID"]]);}});
    relations.forEach(function(r){if(dbText_(r["使用者ID"])===ctx.userId&&dbLower_(r["狀態"]||"active")!=="revoked")dbMergeSet_(recipientIds,[r["服務對象ID"]]);});

    // Owner / dispatcher sees rows for operational organizations. Driver does not receive the public pool here.
    var canOperate=!!ctx.roleSet.owner||!!ctx.roleSet.dispatcher;
    if(canOperate){
      bookings.forEach(function(b){if(dbHas_(ctx.opsOrgSet,b["組織ID"])){bookingIds[dbText_(b["預約ID"])]=true;dbMergeSet_(recipientIds,[b["服務對象ID"]]);}});
      trips.forEach(function(t){if(dbHas_(ctx.opsOrgSet,t["組織ID"])){tripIds[dbText_(t["行程ID"])]=true;}});
      readTable_("成員資格").forEach(function(m){if(dbActiveMembership_(m)&&dbHas_(ctx.opsOrgSet,m["組織ID"]))dbMergeSet_(staffUserIds,[m["使用者ID"]]);});
      drivers.forEach(function(d){if(dbHas_(ctx.opsOrgSet,d["組織ID"])){dbMergeSet_(driverIds,[d["司機ID"]]);dbMergeSet_(staffUserIds,[d["使用者ID"]]);}});
    }

    // A securely claimed public booking may exist first in 應用狀態 while the normalized 預約 row still has empty 組織ID.
    if(canOperate&&getSpreadsheet_().getSheetByName("應用狀態")){
      readTable_("應用狀態").forEach(function(sr){
        if(dbText_(sr["實體類型"])!=="bookings"||String(sr["已刪除"]).toLowerCase()==="true")return;
        try{var br=JSON.parse(String(sr["資料JSON"]||"{}"));if(br&&dbHas_(ctx.opsOrgSet,br.organizationId))bookingIds[dbText_(sr["實體ID"])]=true;}catch(_){}
      });
    }
    // Driver only receives own assigned trips + bookings on those trips.
    if(ctx.roleSet.driver){trips.forEach(function(t){if(dbHas_(driverIds,t["司機ID"]))tripIds[dbText_(t["行程ID"])]=true;});}

    // Requester trip visibility is derived through authorized bookings.
    links.forEach(function(l){var tid=dbText_(l["行程ID"]),bid=dbText_(l["預約ID"]);if(dbHas_(bookingIds,bid))tripIds[tid]=true;});
    // Driver / staff trip visibility grants only linked booking rows necessary to execute those trips.
    links.forEach(function(l){var tid=dbText_(l["行程ID"]),bid=dbText_(l["預約ID"]);if(dbHas_(tripIds,tid))bookingIds[bid]=true;});
    bookings.forEach(function(b){if(dbHas_(bookingIds,b["預約ID"]))dbMergeSet_(recipientIds,[b["服務對象ID"]]);});
  }
  ctx._dbScope={bookingIds:bookingIds,tripIds:tripIds,recipientIds:recipientIds,driverIds:driverIds,staffUserIds:staffUserIds};return ctx._dbScope;
}
function databaseRelatedBookingId_(row){return dbText_(dbField_(row,["預約ID","bookingId","BookingID"]));}
function databaseRelatedTripId_(row){return dbText_(dbField_(row,["行程ID","tripId","TripID"]));}
function databaseRelatedRecipientId_(row){return dbText_(dbField_(row,["服務對象ID","recipientId"]));}
function databaseRowOrganizationId_(row){return dbText_(dbField_(row,["組織ID","organizationId","來源組織ID"]));}
function databaseSanitizePublicAppStateBooking_(row){
  var out={};Object.keys(row||{}).forEach(function(k){out[k]=row[k];});
  var record={};try{record=JSON.parse(String(row["資料JSON"]||"{}"));}catch(_){return null;}
  if(!record||String(record.state||"").toLowerCase()!=="open"||dbText_(record.organizationId))return null;
  record.requestedByUserId=null;record.recipientId=null;record.name="匿名需求";record.phone="";record.note="";record.pickupAccessNote="";record.destinationAccessNote="";
  record.pickupAddress=databaseApproxArea_(record.pickupAddress);record.destination=databaseApproxArea_(record.destination);record.publicSanitized=true;
  if(record.locations&&typeof record.locations==="object"){
    record.locations=JSON.parse(JSON.stringify(record.locations));
    if(record.locations.pickup){record.locations.pickup.addressText=databaseApproxArea_(record.locations.pickup.addressText);record.locations.pickup.normalizedAddress=record.locations.pickup.addressText;record.locations.pickup.accessNote="";record.locations.pickup.lat=null;record.locations.pickup.lng=null;record.locations.pickup.placeId=null;}
    if(record.locations.dropoff){record.locations.dropoff.addressText=databaseApproxArea_(record.locations.dropoff.addressText);record.locations.dropoff.normalizedAddress=record.locations.dropoff.addressText;record.locations.dropoff.accessNote="";record.locations.dropoff.lat=null;record.locations.dropoff.lng=null;record.locations.dropoff.placeId=null;}
  }
  out["擁有者使用者ID"]="";out["資料JSON"]=JSON.stringify(record);return out;
}
function databaseAppStateVisible_(row,ctx){
  if(ctx.isSuperAdmin)return true;
  var owner=dbText_(row["擁有者使用者ID"]),org=dbText_(row["組織ID"]),type=dbText_(row["實體類型"]);
  if(owner&&owner===ctx.userId)return true;
  if(org&&dbHas_(ctx.opsOrgSet,org))return true;
  // Driver may read only state records explicitly assigned to own trip/driver. Scope JSON is authoritative only after mutation authorization.
  if(type==="drivers"&&dbText_(row["實體ID"])&&dbHas_(databaseScope_(ctx).driverIds,row["實體ID"]))return true;
  if((type==="trips"||type==="tripEvents"||type==="issues"||type==="serviceProofs"||type==="telemetryEvents")&&dbHas_(databaseScope_(ctx).tripIds,dbText_(row["關聯行程ID"])))return true;
  return false;
}
function databasePublicBooking_(row){return !dbText_(row["組織ID"])&&dbLower_(row["預約狀態"])==="open";}
function databaseApproxArea_(address){
  var t=dbText_(address).replace(/臺/g,"台"),m=t.match(/(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)([^市縣]{1,8}(?:區|鄉|鎮|市))?/);
  return m?(m[1]+(m[2]||"")):"區域未公開";
}
function databaseSanitizePublicBooking_(row){
  var out={};Object.keys(row||{}).forEach(function(k){out[k]=row[k];});
  out["預約者使用者ID"]="";out["服務對象ID"]="";
  Object.keys(out).forEach(function(k){if(/姓名|電話|手機|聯絡/.test(k))out[k]="";});
  if(out["上車地址"]!==undefined)out["上車地址"]=databaseApproxArea_(out["上車地址"]);
  if(out["目的地"]!==undefined)out["目的地"]=databaseApproxArea_(out["目的地"]);
  out["__PUBLIC_SANITIZED__"]=true;return out;
}
function databaseFilterRows_(sheetName,rows,ctx){
  rows=Array.isArray(rows)?rows:[];if(ctx.isSuperAdmin)return rows;
  var scope=databaseScope_(ctx);
  if(sheetName==="組織")return rows.filter(function(r){return dbHas_(ctx.orgSet,r["組織ID"]);});
  if(sheetName==="使用者")return rows.filter(function(r){return dbHas_(scope.staffUserIds,r["使用者ID"]);});
  if(sheetName==="成員資格")return rows.filter(function(r){return dbText_(r["使用者ID"])===ctx.userId||((ctx.roleSet.owner||ctx.roleSet.dispatcher)&&dbHas_(ctx.opsOrgSet,r["組織ID"]));});
  if(sheetName==="司機")return rows.filter(function(r){return dbHas_(scope.driverIds,r["司機ID"]);});
  if(sheetName==="車輛")return rows.filter(function(r){return dbHas_(ctx.opsOrgSet,r["組織ID"]);});
  if(sheetName==="服務對象")return rows.filter(function(r){return dbHas_(scope.recipientIds,r["服務對象ID"]);});
  if(sheetName==="服務對象聯絡人")return rows.filter(function(r){return dbHas_(scope.recipientIds,r["服務對象ID"]);});
  if(sheetName==="預約"){
    var canMarket=!!ctx.roleSet.owner||!!ctx.roleSet.dispatcher;
    var out=[];rows.forEach(function(r){if(dbHas_(scope.bookingIds,r["預約ID"]))out.push(r);else if(canMarket&&databasePublicBooking_(r))out.push(databaseSanitizePublicBooking_(r));});return out;
  }
  if(sheetName==="行程")return rows.filter(function(r){return dbHas_(scope.tripIds,r["行程ID"]);});
  if(sheetName==="行程預約關聯")return rows.filter(function(r){return dbHas_(scope.tripIds,r["行程ID"])&&dbHas_(scope.bookingIds,r["預約ID"]);});
  if(sheetName==="服務證明"||sheetName==="異常回報"||sheetName==="行程遙測事件")return rows.filter(function(r){return dbHas_(scope.tripIds,databaseRelatedTripId_(r));});
  if(sheetName==="預約異動歷史"||sheetName==="預約報價快照"||sheetName==="取消退單")return rows.filter(function(r){return dbHas_(scope.bookingIds,databaseRelatedBookingId_(r));});
  if(sheetName==="調度最佳化")return rows.filter(function(r){return dbHas_(ctx.opsOrgSet,databaseRowOrganizationId_(r));});
  if(sheetName==="補助試算")return rows.filter(function(r){var rid=databaseRelatedRecipientId_(r);return rid?dbHas_(scope.recipientIds,rid):dbText_(dbField_(r,["使用者ID","建立者使用者ID"]))===ctx.userId;});
  if(sheetName==="系統回報")return rows.filter(function(r){return dbText_(dbField_(r,["回報者使用者ID","使用者ID","actorUserId"]))===ctx.userId||dbHas_(ctx.opsOrgSet,databaseRowOrganizationId_(r));});
  if(sheetName==="通知紀錄")return rows.filter(function(r){var uid=dbText_(dbField_(r,["接收者使用者ID","使用者ID","recipientUserId"]));var bid=databaseRelatedBookingId_(r),tid=databaseRelatedTripId_(r);return uid===ctx.userId||dbHas_(scope.bookingIds,bid)||dbHas_(scope.tripIds,tid);});
  if(sheetName==="KPI每日")return rows.filter(function(r){var oid=databaseRowOrganizationId_(r),did=dbText_(dbField_(r,["司機ID","driverId"]));return dbHas_(ctx.opsOrgSet,oid)||dbHas_(scope.driverIds,did);});
  if(sheetName==="稽核紀錄")return rows.filter(function(r){return !!ctx.roleSet.owner&&dbHas_(ctx.opsOrgSet,databaseRowOrganizationId_(r));});
  if(sheetName==="應用狀態"){
    var canMarketState=!!ctx.roleSet.owner||!!ctx.roleSet.dispatcher,outState=[];
    rows.forEach(function(r){if(databaseAppStateVisible_(r,ctx))outState.push(r);else if(canMarketState&&dbText_(r["實體類型"])==="bookings"){var safe=databaseSanitizePublicAppStateBooking_(r);if(safe)outState.push(safe);}});return outState;
  }
  return [];
}
function readDatabaseTable_(req){
  var ctx=databaseAuthContext_(req),sheetName=dbText_(databaseRequestValue_(req,"sheet"));
  if(DATABASE_READABLE_SHEETS_.indexOf(sheetName)<0)throw authError_("TABLE_FORBIDDEN","不允許讀取此資料表");
  if(sheetName==="應用狀態"&&typeof ensureAppStateSheet_==="function")ensureAppStateSheet_();
  var sheet=getSpreadsheet_().getSheetByName(sheetName);if(!sheet)return [];
  return databaseFilterRows_(sheetName,readTable_(sheetName),ctx);
}
