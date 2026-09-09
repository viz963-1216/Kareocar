/**
 * IdentityApi.gs — V12.25.79
 * Google Sheet authoritative identity writes + server-side password auth.
 * Depends on AuthCore.gs and existing getSpreadsheet_/readTable_/writeAudit_.
 */
var REQUESTER_ORGANIZATION_ID_="ORG-REQ-001";

/** Source IP forwarded by the Netlify gateway; "" when unavailable. */
function identityRequestSourceIp_(req){
  var ip=req&&req.clientIp?String(req.clientIp):"";
  return ip.trim().substring(0,64);
}

function registerRequesterFromWeb_(body,req){
  body=body||{};
  var name=String(body.name||"").trim(),email=String(body.email||"").trim().toLowerCase(),phoneLocal=String(body.phone||"").replace(/\D/g,""),password=String(body.password||"");
  if(!name||name.length>80)throw authError_("VALIDATION_ERROR","請輸入正確姓名");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw authError_("VALIDATION_ERROR","請輸入正確電子信箱");
  if(!/^09\d{8}$/.test(phoneLocal))throw authError_("VALIDATION_ERROR","請輸入 09 開頭的 10 位手機號碼");
  if(password.length<8)throw authError_("WEAK_PASSWORD","密碼至少需要 8 碼");
  var phoneE164="+886"+phoneLocal.substring(1),lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    assertRequesterOrgForIdentity_();
    var users=readTable_("使用者"),emailMatch=users.find(function(u){return String(u["電子郵件"]||"").trim().toLowerCase()===email;}),phoneMatch=users.find(function(u){return normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phoneLocal;});
    if(emailMatch||phoneMatch){if(emailMatch&&phoneMatch&&String(emailMatch["使用者ID"])!==String(phoneMatch["使用者ID"]))throw authError_("IDENTITY_CONFLICT","電子信箱與手機已分別屬於不同帳號，請聯絡平台管理者");throw authError_("ACCOUNT_EXISTS","此電子信箱或手機已存在，請使用原本登入方式");}
    var now=new Date().toISOString(),userId=identityNewId_("USR-PW"),membershipId=identityNewId_("MEM-REQ"),userCreated=false,credentialCreated=false;
    try{
      identityAppendObjectRow_("使用者",{"使用者ID":userId,"顯示名稱":name,"手機號碼(E.164)":phoneE164,"電子郵件":email,"驗證提供者":"password","驗證主體ID":"password:"+userId,"啟用狀態":true,"建立時間":now,"更新時間":now,"平台角色":"none"});userCreated=true;
      authSetPasswordCredential_(userId,password);credentialCreated=true;
      identityAppendObjectRow_("成員資格",{"成員資格ID":membershipId,"使用者ID":userId,"組織ID":REQUESTER_ORGANIZATION_ID_,"角色":"requester","狀態":"active","建立時間":now,"更新時間":now,"撤銷時間":"","撤銷者使用者ID":""});
    }catch(e){if(credentialCreated)authDeletePasswordCredential_(userId);if(userCreated)identityDeleteRowByKey_("使用者","使用者ID",userId);throw e;}
    try{writeAudit_({eventType:"identity.requester_registered",actorUserId:userId,organizationId:REQUESTER_ORGANIZATION_ID_,entityType:"user",entityId:userId,reasonCode:"SELF_REGISTRATION",details:{requestId:req&&req.requestId?req.requestId:"",membershipId:membershipId,email:email}});}catch(_){}
    var user={"使用者ID":userId,"顯示名稱":name,"手機號碼(E.164)":phoneE164,"電子郵件":email,"平台角色":"none"};
    var membership={"成員資格ID":membershipId,"使用者ID":userId,"組織ID":REQUESTER_ORGANIZATION_ID_,"角色":"requester","狀態":"active"};
    return {user:authPublicUser_(user),membership:authPublicMembership_(membership),memberships:[authPublicMembership_(membership)],sessionToken:authIssueSessionToken_(userId)};
  }finally{lock.releaseLock();}
}

function passwordLogin_(body,req){
  body=body||{};var phone=String(body.phone||"").replace(/\D/g,""),password=String(body.password||"");
  if(!/^09\d{8}$/.test(phone)||!password)throw authError_("INVALID_CREDENTIALS","帳號或密碼錯誤");
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    var sourceIp=identityRequestSourceIp_(req);
    authAssertLoginAllowed_(phone,sourceIp);
    var user=readTable_("使用者").find(function(u){return normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone;});
    var valid=!!user&&authIsEnabled_(user["啟用狀態"])&&authVerifyPasswordCredential_(String(user["使用者ID"]),password);
    if(!valid){
      var rate=authRecordLoginFailure_(phone,sourceIp);
      var nowSec=Math.floor(Date.now()/1000),lockedUntil=Number(rate.lockedUntil||0);
      if(lockedUntil>nowSec){var locked=authError_("LOGIN_RATE_LIMITED","登入失敗次數過多，請稍後再試");locked.retryAfterSeconds=lockedUntil-nowSec;throw locked;}
      throw authError_("INVALID_CREDENTIALS","帳號或密碼錯誤");
    }
    authClearLoginRate_(phone);
    var userId=String(user["使用者ID"]),memberships=authMembershipsForUser_(userId);
    if(String(user["平台角色"]||"").trim().toLowerCase()!=="super_admin"&&!memberships.length)throw authError_("NO_ACTIVE_IDENTITY","此帳號目前沒有有效身分，請聯絡平台管理者");
    try{writeAudit_({eventType:"auth.password.login",actorUserId:userId,organizationId:memberships.length?memberships[0]["組織ID"]:"",entityType:"user",entityId:userId,reasonCode:"PASSWORD_LOGIN",details:{requestId:req&&req.requestId?req.requestId:""}});}catch(_){}
    return {user:authPublicUser_(user),memberships:memberships.map(authPublicMembership_),sessionToken:authIssueSessionToken_(userId)};
  }finally{lock.releaseLock();}
}

function completeSocialProfileFromWeb_(body,req){
  body=body||{};var token=String(body.sessionToken||""),payload=authVerifySessionToken_(token),userId=payload.userId;
  var phone=String(body.phone||"").replace(/\D/g,""),name=String(body.name||"").trim();
  if(!/^09\d{8}$/.test(phone))throw authError_("VALIDATION_ERROR","請輸入 09 開頭共 10 位手機號碼");
  var users=readTable_("使用者"),user=users.find(function(u){return String(u["使用者ID"])===userId;});if(!user)throw authError_("USER_NOT_FOUND","找不到登入使用者");
  var collision=users.find(function(u){return String(u["使用者ID"])!==userId&&normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone;});if(collision)throw authError_("PHONE_EXISTS","此手機號碼已被其他帳號使用");
  var updates={"手機號碼(E.164)":"+886"+phone.substring(1),"更新時間":new Date().toISOString()};if(name)updates["顯示名稱"]=name;
  authUpdateObjectRowByKey_("使用者","使用者ID",userId,updates);user["手機號碼(E.164)"]=updates["手機號碼(E.164)"];if(name)user["顯示名稱"]=name;
  var memberships=authMembershipsForUser_(userId);return {user:authPublicUser_(user),memberships:memberships.map(authPublicMembership_),sessionToken:authIssueSessionToken_(userId)};
}

function createStaffFromWeb_(body,req){
  body=body||{};var organizationId=authBackendOrganizationId_(body.organizationId),role=String(body.role||"").trim().toLowerCase(),name=String(body.name||"").trim(),phone=String(body.phone||"").replace(/\D/g,""),password=String(body.password||""),alsoRequester=body.alsoRequester===true;
  if(!organizationId||organizationId===REQUESTER_ORGANIZATION_ID_)throw authError_("VALIDATION_ERROR","請選擇一般公司／機構組織");
  if(["owner","driver","dispatcher"].indexOf(role)<0)throw authError_("VALIDATION_ERROR","不支援的人員角色");
  if(!name||name.length>80)throw authError_("VALIDATION_ERROR","請輸入姓名");if(!/^09\d{8}$/.test(phone))throw authError_("VALIDATION_ERROR","請輸入 09 開頭共 10 位手機號碼");
  var auth=authAuthorizeStaffCreate_(body.sessionToken,organizationId,role),lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    var org=readTable_("組織").find(function(o){return String(o["組織ID"])===organizationId&&authIsEnabled_(o["啟用狀態"]);});if(!org)throw authError_("ORG_NOT_FOUND","找不到有效組織");
    var memberships=readTable_("成員資格");if(role==="owner"&&memberships.some(function(m){return String(m["組織ID"])===organizationId&&String(m["角色"])==="owner"&&String(m["狀態"]||"").toLowerCase()==="active";}))throw authError_("OWNER_EXISTS","此組織已經有有效負責人");
    var users=readTable_("使用者"),user=users.find(function(u){return normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone;}),createdUser=false;
    if(user&&String(user["平台角色"]||"").trim().toLowerCase()==="super_admin")throw authError_("FORBIDDEN","平台超級管理者不可加入公司 Membership");
    if(user&&memberships.some(function(m){return String(m["使用者ID"])===String(user["使用者ID"])&&String(m["組織ID"])===organizationId&&String(m["狀態"]||"").toLowerCase()==="active";}))throw authError_("MEMBERSHIP_EXISTS","此使用者在目前組織已有有效身分");
    var now=new Date().toISOString(),userId=user?String(user["使用者ID"]):identityNewId_("USR-PW"),membershipId=identityNewId_("MEM-STAFF"),credentialCreated=false;
    if(!user){
      if(password.length<8)throw authError_("WEAK_PASSWORD","新帳號初始密碼至少需要 8 碼");
      user={"使用者ID":userId,"顯示名稱":name,"手機號碼(E.164)":"+886"+phone.substring(1),"電子郵件":"","驗證提供者":"password","驗證主體ID":"password:"+userId,"啟用狀態":true,"建立時間":now,"更新時間":now,"平台角色":"none"};
      identityAppendObjectRow_("使用者",user);createdUser=true;try{authSetPasswordCredential_(userId,password);credentialCreated=true;}catch(e){identityDeleteRowByKey_("使用者","使用者ID",userId);throw e;}
    }
    try{
      identityAppendObjectRow_("成員資格",{"成員資格ID":membershipId,"使用者ID":userId,"組織ID":organizationId,"角色":role,"狀態":"active","建立時間":now,"更新時間":now,"撤銷時間":"","撤銷者使用者ID":""});
      if(role==="driver"){
        identityAppendObjectRow_("司機",{"司機ID":identityNewId_("DRV"),"使用者ID":userId,"組織ID":organizationId,"車隊ID":"","值勤狀態":"off_duty","服務區域":"","啟用狀態":true,"更新時間":now});
      }
      if(alsoRequester&&!memberships.some(function(m){return String(m["使用者ID"])===userId&&String(m["組織ID"])===REQUESTER_ORGANIZATION_ID_&&String(m["角色"])==="requester"&&String(m["狀態"]||"").toLowerCase()==="active";})){
        identityAppendObjectRow_("成員資格",{"成員資格ID":identityNewId_("MEM-REQ"),"使用者ID":userId,"組織ID":REQUESTER_ORGANIZATION_ID_,"角色":"requester","狀態":"active","建立時間":now,"更新時間":now,"撤銷時間":"","撤銷者使用者ID":""});
      }
    }catch(e){identityDeleteRowByKey_("成員資格","成員資格ID",membershipId);if(createdUser){if(credentialCreated)authDeletePasswordCredential_(userId);identityDeleteRowByKey_("使用者","使用者ID",userId);}throw e;}
    try{writeAudit_({eventType:"identity.staff_created",actorUserId:auth.actorId,organizationId:organizationId,entityType:"membership",entityId:membershipId,reasonCode:"STAFF_CREATE",details:{requestId:req&&req.requestId?req.requestId:"",targetUserId:userId,role:role,createdUser:createdUser,alsoRequester:alsoRequester}});}catch(_){}
    var membership={"成員資格ID":membershipId,"使用者ID":userId,"組織ID":organizationId,"角色":role,"狀態":"active"};
    return {user:authPublicUser_(user),membership:authPublicMembership_(membership),createdUser:createdUser,reusedUser:!createdUser};
  }finally{lock.releaseLock();}
}


function requestPasswordResetFromWeb_(body,req){
  body=body||{};var phone=String(body.phone||"").replace(/\D/g,"");if(!/^09\d{8}$/.test(phone))throw authError_("VALIDATION_ERROR","請輸入 09 開頭共 10 位手機號碼");
  var user=readTable_("使用者").find(function(u){return normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone&&authIsEnabled_(u["啟用狀態"]);});
  // Avoid account enumeration: unknown phones receive the same generic response without creating a challenge.
  if(!user)return {requested:true,expiresInSeconds:AUTH_RESET_TTL_SECONDS_};
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    var challenge=authCreatePasswordResetChallenge_(String(user["使用者ID"]),phone);
    try{writeAudit_({eventType:"auth.password.reset_requested",actorUserId:String(user["使用者ID"]),organizationId:"",entityType:"user",entityId:String(user["使用者ID"]),reasonCode:"PASSWORD_RESET_REQUEST",details:{requestId:req&&req.requestId?req.requestId:""}});}catch(_){}
    return {requested:true,expiresInSeconds:challenge.expiresInSeconds};
  }finally{lock.releaseLock();}
}

function confirmPasswordResetFromWeb_(body,req){
  body=body||{};var phone=String(body.phone||"").replace(/\D/g,""),code=String(body.otp||body.code||"").replace(/\D/g,""),newPassword=String(body.newPassword||"");
  if(!/^09\d{8}$/.test(phone)||!/^\d{6}$/.test(code))throw authError_("RESET_CODE_INVALID","手機號碼或驗證碼格式錯誤");
  if(newPassword.length<8||newPassword.length>128)throw authError_("WEAK_PASSWORD","新密碼至少需要 8 碼，最多 128 碼");
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    var user=readTable_("使用者").find(function(u){return normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone&&authIsEnabled_(u["啟用狀態"]);});if(!user)throw authError_("RESET_CODE_INVALID","驗證碼無效或已失效");
    var verified=authVerifyPasswordResetChallenge_(phone,code);if(String(verified.state.userId)!==String(user["使用者ID"]))throw authError_("RESET_CODE_INVALID","驗證碼無效或已失效");
    var userId=String(user["使用者ID"]);authSetPasswordCredential_(userId,newPassword);authBumpSessionVersion_(userId);authClearLoginRate_(phone);PropertiesService.getScriptProperties().deleteProperty(verified.key);
    authUpdateObjectRowByKey_("使用者","使用者ID",userId,{"更新時間":new Date().toISOString()});
    try{writeAudit_({eventType:"auth.password.reset_completed",actorUserId:userId,organizationId:"",entityType:"user",entityId:userId,reasonCode:"PASSWORD_RESET_OTP",details:{requestId:req&&req.requestId?req.requestId:""}});}catch(_){}
    return {reset:true,user:authPublicUser_(user)};
  }finally{lock.releaseLock();}
}

function updateCurrentIdentityAccountFromWeb_(body,req){
  body=body||{};var payload=authVerifySessionToken_(body.sessionToken),userId=String(payload.userId),name=String(body.name||"").trim(),phone=String(body.phone||"").replace(/\D/g,""),newPassword=String(body.newPassword||"");
  if(!name||name.length>80)throw authError_("VALIDATION_ERROR","請輸入正確顯示名稱");if(!/^09\d{8}$/.test(phone))throw authError_("VALIDATION_ERROR","請輸入 09 開頭共 10 位手機號碼");if(newPassword&&(newPassword.length<8||newPassword.length>128))throw authError_("WEAK_PASSWORD","新密碼至少需要 8 碼，最多 128 碼");
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    var users=readTable_("使用者"),user=users.find(function(u){return String(u["使用者ID"])===userId;});if(!user||!authIsEnabled_(user["啟用狀態"]))throw authError_("SESSION_INVALID","使用者已停用或不存在");
    var collision=users.find(function(u){return String(u["使用者ID"])!==userId&&normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"])===phone;});if(collision)throw authError_("PHONE_EXISTS","此手機號碼已被其他帳號使用");
    var oldPhone=normalizeTaiwanPhoneForIdentity_(user["手機號碼(E.164)"]),phoneChanged=oldPhone!==phone;
    // A stolen session token must not be enough to take an account over: both the
    // password and the phone number (which is the login identifier) require the
    // current password. Social-login accounts have no password credential, so for
    // them the session token remains the only available proof.
    if((newPassword||phoneChanged)&&authHasPasswordCredential_(userId)){
      var currentPassword=String(body.currentPassword||"");
      if(!currentPassword)throw authError_("CURRENT_PASSWORD_REQUIRED","變更密碼或手機號碼前，請先輸入目前的密碼");
      if(!authVerifyPasswordCredential_(userId,currentPassword))throw authError_("INVALID_CREDENTIALS","目前密碼不正確");
    }
    var updates={"顯示名稱":name,"手機號碼(E.164)":"+886"+phone.substring(1),"更新時間":new Date().toISOString()};authUpdateObjectRowByKey_("使用者","使用者ID",userId,updates);user["顯示名稱"]=name;user["手機號碼(E.164)"]=updates["手機號碼(E.164)"];
    if(newPassword)authSetPasswordCredential_(userId,newPassword);
    if(newPassword||phoneChanged)authBumpSessionVersion_(userId);
    authClearLoginRate_(oldPhone);authClearLoginRate_(phone);
    try{writeAudit_({eventType:"identity.account_updated",actorUserId:userId,organizationId:"",entityType:"user",entityId:userId,reasonCode:newPassword?"PROFILE_AND_PASSWORD_UPDATE":"PROFILE_UPDATE",details:{requestId:req&&req.requestId?req.requestId:"",phoneChanged:oldPhone!==phone,passwordChanged:!!newPassword}});}catch(_){}
    return {user:authPublicUser_(user),memberships:authMembershipsForUser_(userId).map(authPublicMembership_),sessionToken:authIssueSessionToken_(userId),passwordChanged:!!newPassword};
  }finally{lock.releaseLock();}
}

function assertRequesterOrgForIdentity_(){
  var org=readTable_("組織").find(function(o){return String(o["組織ID"]||"")===REQUESTER_ORGANIZATION_ID_;});if(!org)throw new Error("找不到需求者組織 ORG-REQ-001");if(!authIsEnabled_(org["啟用狀態"]))throw new Error("需求者組織目前未啟用");
}
function normalizeTaiwanPhoneForIdentity_(value){var raw=String(value||"").replace(/[^\d+]/g,"");if(/^09\d{8}$/.test(raw))return raw;if(/^\+8869\d{8}$/.test(raw))return "0"+raw.substring(4);if(/^8869\d{8}$/.test(raw))return "0"+raw.substring(3);return raw.replace(/\D/g,"");}
function identityAppendObjectRow_(sheetName,obj){var sheet=getSpreadsheet_().getSheetByName(sheetName);if(!sheet)throw new Error("找不到工作表："+sheetName);var lastColumn=sheet.getLastColumn();if(lastColumn<1)throw new Error("工作表沒有欄位："+sheetName);var headers=sheet.getRange(1,1,1,lastColumn).getValues()[0].map(function(v){return String(v||"").trim();});sheet.appendRow(headers.map(function(h){return Object.prototype.hasOwnProperty.call(obj,h)?obj[h]:"";}));}
function identityDeleteRowByKey_(sheetName,keyHeader,keyValue){var sheet=getSpreadsheet_().getSheetByName(sheetName);if(!sheet)return;var values=sheet.getDataRange().getValues();if(!values.length)return;var headers=values[0].map(function(v){return String(v||"").trim();}),keyIndex=headers.indexOf(keyHeader);if(keyIndex<0)return;for(var r=values.length-1;r>=1;r--){if(String(values[r][keyIndex])===String(keyValue)){sheet.deleteRow(r+1);return;}}}
function identityNewId_(prefix){return prefix+"-"+Utilities.getUuid().replace(/-/g,"").slice(0,16).toUpperCase();}

function resumeIdentitySession_(body,req){
  body=body||{};var payload=authVerifySessionToken_(body.sessionToken),userId=payload.userId;
  var user=readTable_("使用者").find(function(u){return String(u["使用者ID"])===userId;});
  if(!user||!authIsEnabled_(user["啟用狀態"]))throw authError_("SESSION_INVALID","使用者已停用或不存在，請重新登入");
  var memberships=authMembershipsForUser_(userId);
  if(String(user["平台角色"]||"").trim().toLowerCase()!=="super_admin"&&!memberships.length)throw authError_("NO_ACTIVE_IDENTITY","此帳號目前沒有有效身分");
  return {user:authPublicUser_(user),memberships:memberships.map(authPublicMembership_),sessionToken:authIssueSessionToken_(userId)};
}
