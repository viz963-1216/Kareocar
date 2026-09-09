/**
 * AuthCore.gs — V12.25.79
 * Server-side password hashing + signed short-lived session tokens.
 * Secrets live only in Apps Script Properties.
 */
var AUTH_CREDENTIAL_PREFIX_="AUTH_CRED_";
var AUTH_SESSION_VERSION_PREFIX_="AUTH_SESSION_VERSION_";
var AUTH_LOGIN_RATE_PREFIX_="AUTH_LOGIN_RATE_";
var AUTH_RESET_CHALLENGE_PREFIX_="AUTH_RESET_CHALLENGE_";
var AUTH_SESSION_TTL_SECONDS_=12*60*60;
var AUTH_LOGIN_WINDOW_SECONDS_=30*60;
var AUTH_LOGIN_LOCK_SECONDS_=3*60;
var AUTH_RESET_TTL_SECONDS_=5*60;
var AUTH_RESET_MAX_ATTEMPTS_=5;

function authError_(code,message){
  var e=new Error(String(message||"驗證失敗"));
  e.code=String(code||"AUTH_ERROR");
  return e;
}

function authConfig_(name){
  var value="";
  if(typeof requireConfig_==="function"){
    try{value=String(requireConfig_(name)||"").trim();}catch(_){value="";}
  }
  if(!value)value=String(PropertiesService.getScriptProperties().getProperty(name)||"").trim();
  if(!value)throw authError_("CONFIG_MISSING","Apps Script 尚未設定 "+name);
  return value;
}

function authRandomHex_(bytes){
  var raw=Utilities.getUuid().replace(/-/g,"")+Utilities.getUuid().replace(/-/g,"");
  return raw.substring(0,Math.max(16,Number(bytes||16)*2));
}

function authBytesHex_(bytes){
  return bytes.map(function(b){var n=(b<0?b+256:b);return ("0"+n.toString(16)).slice(-2);}).join("");
}

function authHmacHex_(message,secret){
  return authBytesHex_(Utilities.computeHmacSha256Signature(String(message),String(secret)));
}

function authConstantTimeEqual_(a,b){
  a=String(a||"");b=String(b||"");
  if(a.length!==b.length)return false;
  var diff=0;for(var i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

function authCredentialKey_(userId){return AUTH_CREDENTIAL_PREFIX_+String(userId||"");}

function authSetPasswordCredential_(userId,password){
  password=String(password||"");
  if(password.length<8)throw authError_("WEAK_PASSWORD","密碼至少需要 8 碼");
  if(password.length>128)throw authError_("WEAK_PASSWORD","密碼長度不可超過 128 碼");
  var salt=authRandomHex_(16);
  var hash=authHmacHex_(salt+"|"+password,authConfig_("AUTH_PASSWORD_PEPPER"));
  PropertiesService.getScriptProperties().setProperty(authCredentialKey_(userId),JSON.stringify({v:1,salt:salt,hash:hash,updatedAt:new Date().toISOString()}));
}

function authDeletePasswordCredential_(userId){
  PropertiesService.getScriptProperties().deleteProperty(authCredentialKey_(userId));
}

function authVerifyPasswordCredential_(userId,password){
  var raw=PropertiesService.getScriptProperties().getProperty(authCredentialKey_(userId));
  if(!raw)return false;
  try{
    var c=JSON.parse(raw),hash=authHmacHex_(String(c.salt||"")+"|"+String(password||""),authConfig_("AUTH_PASSWORD_PEPPER"));
    return authConstantTimeEqual_(hash,c.hash);
  }catch(_){return false;}
}

function authBase64UrlEncode_(text){
  return Utilities.base64EncodeWebSafe(String(text),Utilities.Charset.UTF_8).replace(/=+$/g,"");
}

function authBase64UrlDecode_(value){
  var s=String(value||"");while(s.length%4)s+="=";
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString("UTF-8");
}

function authSessionVersion_(userId){
  var raw=PropertiesService.getScriptProperties().getProperty(AUTH_SESSION_VERSION_PREFIX_+String(userId||""));
  return Math.max(1,Number(raw||1)||1);
}

function authBumpSessionVersion_(userId){
  var next=authSessionVersion_(userId)+1;
  PropertiesService.getScriptProperties().setProperty(AUTH_SESSION_VERSION_PREFIX_+String(userId||""),String(next));
  return next;
}

function authIssueSessionToken_(userId){
  var now=Math.floor(Date.now()/1000);
  var payload={v:2,userId:String(userId),sv:authSessionVersion_(userId),iat:now,exp:now+AUTH_SESSION_TTL_SECONDS_,nonce:authRandomHex_(12)};
  var body=authBase64UrlEncode_(JSON.stringify(payload));
  var sig=authHmacHex_(body,authConfig_("AUTH_SESSION_SECRET"));
  return body+"."+sig;
}

function authVerifySessionToken_(token){
  var parts=String(token||"").split(".");
  if(parts.length!==2)throw authError_("SESSION_INVALID","登入工作階段無效，請重新登入");
  var expected=authHmacHex_(parts[0],authConfig_("AUTH_SESSION_SECRET"));
  if(!authConstantTimeEqual_(expected,parts[1]))throw authError_("SESSION_INVALID","登入工作階段簽章無效，請重新登入");
  var payload;
  try{payload=JSON.parse(authBase64UrlDecode_(parts[0]));}catch(_){throw authError_("SESSION_INVALID","登入工作階段格式錯誤");}
  var now=Math.floor(Date.now()/1000);
  if(!payload.userId||Number(payload.exp||0)<=now)throw authError_("SESSION_EXPIRED","登入工作階段已過期，請重新登入");
  if(Number(payload.sv||1)!==authSessionVersion_(payload.userId))throw authError_("SESSION_INVALID","登入工作階段已失效，請重新登入");
  return payload;
}

function authOpaquePhoneKey_(phone){
  return authHmacHex_(String(phone||""),authConfig_("AUTH_SESSION_SECRET")).substring(0,40);
}
function authLoginRateKey_(phone){return AUTH_LOGIN_RATE_PREFIX_+authOpaquePhoneKey_(phone);}
function authReadJsonProperty_(key){var raw=PropertiesService.getScriptProperties().getProperty(key);if(!raw)return null;try{return JSON.parse(raw);}catch(_){return null;}}
function authWriteJsonProperty_(key,value){PropertiesService.getScriptProperties().setProperty(key,JSON.stringify(value));}
function authLoginRateState_(phone){
  var now=Math.floor(Date.now()/1000),key=authLoginRateKey_(phone),state=authReadJsonProperty_(key)||{failures:0,windowStartedAt:now,lockedUntil:0,resetRequired:false};
  if(now-Number(state.windowStartedAt||0)>AUTH_LOGIN_WINDOW_SECONDS_&&!state.resetRequired)state={failures:0,windowStartedAt:now,lockedUntil:0,resetRequired:false};
  return {key:key,state:state,now:now};
}
function authAssertLoginAllowed_(phone){
  var x=authLoginRateState_(phone),state=x.state;
  if(state.resetRequired)throw authError_("PASSWORD_RESET_REQUIRED","此帳號登入失敗次數過多，請先使用忘記密碼重設密碼");
  if(Number(state.lockedUntil||0)>x.now){var retry=Math.max(1,Number(state.lockedUntil)-x.now);var e=authError_("LOGIN_RATE_LIMITED","登入嘗試過於頻繁，請稍後再試");e.retryAfterSeconds=retry;throw e;}
  authWriteJsonProperty_(x.key,state);return state;
}
function authRecordLoginFailure_(phone){
  var x=authLoginRateState_(phone),state=x.state;state.failures=Math.max(0,Number(state.failures)||0)+1;state.lastFailureAt=x.now;
  if(state.failures>=10){state.resetRequired=true;state.lockedUntil=0;}
  else if(state.failures>=5)state.lockedUntil=x.now+AUTH_LOGIN_LOCK_SECONDS_;
  authWriteJsonProperty_(x.key,state);return state;
}
function authClearLoginRate_(phone){PropertiesService.getScriptProperties().deleteProperty(authLoginRateKey_(phone));}

function authResetChallengeKey_(phone){return AUTH_RESET_CHALLENGE_PREFIX_+authOpaquePhoneKey_(phone);}
function authSendPasswordResetSms_(phone,code){
  var props=PropertiesService.getScriptProperties(),url=String(props.getProperty("PASSWORD_RESET_SMS_WEBHOOK_URL")||"").trim(),secret=String(props.getProperty("PASSWORD_RESET_SMS_WEBHOOK_SECRET")||"").trim();
  if(!url||!/^https:\/\//i.test(url)||!secret)throw authError_("RESET_PROVIDER_UNAVAILABLE","正式簡訊密碼重設服務尚未設定");
  var payload={phone:String(phone),message:"安心接送密碼重設驗證碼："+String(code)+"（5 分鐘內有效）"};
  var response=UrlFetchApp.fetch(url,{method:"post",contentType:"application/json",headers:{"X-Care-Ride-Secret":secret},payload:JSON.stringify(payload),muteHttpExceptions:true});
  var status=Number(response.getResponseCode());if(status<200||status>=300)throw authError_("RESET_PROVIDER_UNAVAILABLE","簡訊服務暫時無法使用，請稍後再試");
}
function authCreatePasswordResetChallenge_(userId,phone){
  var code=String(Math.floor(100000+Math.random()*900000)),now=Math.floor(Date.now()/1000),salt=authRandomHex_(12),hash=authHmacHex_(salt+"|"+code,authConfig_("AUTH_PASSWORD_PEPPER"));
  var state={v:1,userId:String(userId),phone:String(phone),salt:salt,hash:hash,expiresAt:now+AUTH_RESET_TTL_SECONDS_,attempts:0,createdAt:now};
  authWriteJsonProperty_(authResetChallengeKey_(phone),state);
  try{authSendPasswordResetSms_(phone,code);}catch(e){PropertiesService.getScriptProperties().deleteProperty(authResetChallengeKey_(phone));throw e;}
  return {expiresInSeconds:AUTH_RESET_TTL_SECONDS_};
}
function authVerifyPasswordResetChallenge_(phone,code){
  var key=authResetChallengeKey_(phone),state=authReadJsonProperty_(key),now=Math.floor(Date.now()/1000);if(!state)throw authError_("RESET_CODE_INVALID","驗證碼無效或已失效");
  if(Number(state.expiresAt||0)<=now){PropertiesService.getScriptProperties().deleteProperty(key);throw authError_("RESET_CODE_INVALID","驗證碼已過期，請重新取得");}
  state.attempts=Math.max(0,Number(state.attempts)||0)+1;if(state.attempts>AUTH_RESET_MAX_ATTEMPTS_){PropertiesService.getScriptProperties().deleteProperty(key);throw authError_("RESET_CODE_INVALID","驗證碼錯誤次數過多，請重新取得");}
  var expected=authHmacHex_(String(state.salt||"")+"|"+String(code||""),authConfig_("AUTH_PASSWORD_PEPPER"));
  if(!authConstantTimeEqual_(expected,String(state.hash||""))){authWriteJsonProperty_(key,state);throw authError_("RESET_CODE_INVALID","驗證碼錯誤");}
  return {key:key,state:state};
}

function authIsEnabled_(value){
  return value===true||String(value||"").trim().toLowerCase()==="true"||String(value||"").trim()==="1"||String(value||"").trim()==="是";
}

function authMembershipsForUser_(userId){
  return readTable_("成員資格").filter(function(m){return String(m["使用者ID"])===String(userId)&&String(m["狀態"]||"").toLowerCase()==="active";});
}

function authPublicMembership_(m){
  return {membershipId:String(m["成員資格ID"]||""),organizationId:String(m["組織ID"]||""),role:String(m["角色"]||""),status:String(m["狀態"]||"")};
}

function authPublicUser_(u){
  return {
    userId:String(u["使用者ID"]||""),
    displayName:String(u["顯示名稱"]||""),
    phone:normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"]),
    email:String(u["電子郵件"]||"").trim().toLowerCase(),
    platformRole:String(u["平台角色"]||"none").trim().toLowerCase()||"none"
  };
}

function authUpdateObjectRowByKey_(sheetName,keyHeader,keyValue,updates){
  var sheet=getSpreadsheet_().getSheetByName(sheetName);if(!sheet)throw new Error("找不到工作表："+sheetName);
  var values=sheet.getDataRange().getValues();if(!values.length)throw new Error("工作表沒有資料："+sheetName);
  var headers=values[0].map(function(v){return String(v||"").trim();});
  var keyIndex=headers.indexOf(keyHeader);if(keyIndex<0)throw new Error("缺少欄位："+keyHeader);
  var rowIndex=-1;for(var r=1;r<values.length;r++){if(String(values[r][keyIndex])===String(keyValue)){rowIndex=r+1;break;}}
  if(rowIndex<0)throw new Error("找不到要更新的資料");
  Object.keys(updates||{}).forEach(function(h){var c=headers.indexOf(h);if(c>=0)sheet.getRange(rowIndex,c+1).setValue(updates[h]);});
}

function authBackendOrganizationId_(id){
  id=String(id||"").trim();
  return id==="org_requesters"?"ORG-REQ-001":id;
}

function authAuthorizeStaffCreate_(sessionToken,organizationId,role){
  var sessionPayload=authVerifySessionToken_(sessionToken),actorId=sessionPayload.userId;
  var actor=readTable_("使用者").find(function(u){return String(u["使用者ID"])===actorId;});
  if(!actor||!authIsEnabled_(actor["啟用狀態"]))throw authError_("FORBIDDEN","目前帳號無法執行此操作");
  var platformRole=String(actor["平台角色"]||"").trim().toLowerCase();
  if(platformRole==="super_admin")return {actor:actor,actorId:actorId,isSuperAdmin:true};
  var membership=authMembershipsForUser_(actorId).find(function(m){return String(m["組織ID"])===organizationId&&String(m["角色"])==="owner";});
  if(!membership)throw authError_("FORBIDDEN","只有平台超級管理者或該公司負責人可以新增公司人員");
  if(role==="owner")throw authError_("FORBIDDEN","公司負責人只能新增司機或調度人員");
  return {actor:actor,actorId:actorId,isSuperAdmin:false,membership:membership};
}

/**
 * Run once manually in Apps Script editor before production launch.
 * Do not keep the password in source code; type it only into the Run invocation/testing console.
 */
function bootstrapSuperAdminPassword_v12_25_77(phone,password){
  phone=String(phone||"").replace(/\D/g,"");
  if(!/^09\d{8}$/.test(phone))throw new Error("手機格式錯誤");
  if(String(password||"").length<12)throw new Error("超級管理者正式密碼至少 12 碼");
  var user=readTable_("使用者").find(function(u){return String(u["平台角色"]||"").trim().toLowerCase()==="super_admin";});
  if(!user)throw new Error("找不到 super_admin 使用者");
  var userId=String(user["使用者ID"]);
  authUpdateObjectRowByKey_("使用者","使用者ID",userId,{"手機號碼(E.164)":"+886"+phone.substring(1),"驗證提供者":"password","驗證主體ID":"password:"+userId,"更新時間":new Date().toISOString()});
  authSetPasswordCredential_(userId,password);authBumpSessionVersion_(userId);authClearLoginRate_(phone);
  return {ok:true,userId:userId,phone:phone};
}
