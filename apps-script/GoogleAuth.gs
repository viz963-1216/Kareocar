/** GoogleAuth.gs — V12.25.79 */
var GOOGLE_REQUESTER_ORG_ID_="ORG-REQ-001";
function verifyGoogleIdToken_(idToken){
  if(!idToken)throw authError_("GOOGLE_TOKEN_MISSING","缺少 Google ID Token");
  var clientId=authConfig_("GOOGLE_CLIENT_ID"),response=UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(idToken),{method:"get",muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw authError_("GOOGLE_VERIFY_FAILED","Google 登入驗證失敗");
  var p=JSON.parse(response.getContentText());if(String(p.aud||"")!==clientId)throw authError_("GOOGLE_AUDIENCE_MISMATCH","Google Client ID 不符合");
  if(p.iss!=="accounts.google.com"&&p.iss!=="https://accounts.google.com")throw authError_("GOOGLE_ISSUER_INVALID","Google Token 發行者不正確");
  if(!p.sub)throw authError_("GOOGLE_SUB_MISSING","Google Token 缺少使用者識別碼");
  if(!(p.email_verified===true||p.email_verified==="true")||!p.email)throw authError_("GOOGLE_EMAIL_UNVERIFIED","Google 電子郵件尚未完成驗證");
  if(p.exp&&Number(p.exp)<=Math.floor(Date.now()/1000))throw authError_("GOOGLE_TOKEN_EXPIRED","Google 登入憑證已過期");
  return {sub:String(p.sub),email:String(p.email).trim().toLowerCase(),name:String(p.name||"").trim(),picture:String(p.picture||"")};
}
function googleLogin_(body,req){
  body=body||{};var identity=verifyGoogleIdToken_(body.id_token||body.credential),lock=LockService.getScriptLock();lock.waitLock(15000);
  try{
    assertRequesterOrgForIdentity_();var users=readTable_("使用者"),user=users.find(function(u){return String(u["驗證提供者"]||"").toLowerCase()==="google"&&String(u["驗證主體ID"]||"")===identity.sub;});
    if(!user)user=users.find(function(u){return String(u["電子郵件"]||"").trim().toLowerCase()===identity.email;});
    var createdUser=false,createdMembership=false,now=new Date().toISOString();
    if(!user){
      var userId=identityNewId_("USR-G");user={"使用者ID":userId,"顯示名稱":identity.name||identity.email.split("@")[0],"手機號碼(E.164)":"","電子郵件":identity.email,"驗證提供者":"google","驗證主體ID":identity.sub,"啟用狀態":true,"建立時間":now,"更新時間":now,"平台角色":"none"};identityAppendObjectRow_("使用者",user);createdUser=true;
    }else{
      if(!authIsEnabled_(user["啟用狀態"]))throw authError_("ACCOUNT_DISABLED","此使用者帳號目前未啟用");
      if(String(user["平台角色"]||"").trim().toLowerCase()==="super_admin")throw authError_("SUPER_ADMIN_GOOGLE_DISABLED","平台超級管理者請使用平台密碼帳號登入");
      var provider=String(user["驗證提供者"]||"").trim().toLowerCase(),subject=String(user["驗證主體ID"]||"").trim();
      if(provider==="password")throw authError_("ACCOUNT_LOGIN_METHOD_MISMATCH","此電子信箱已有密碼帳號，請使用手機密碼登入");
      if(provider&&provider!=="google")throw authError_("ACCOUNT_LOGIN_METHOD_MISMATCH","此電子信箱已綁定其他登入方式");
      if(provider==="google"&&subject&&subject!==identity.sub)throw authError_("GOOGLE_IDENTITY_CONFLICT","此帳號已綁定其他 Google 身分");
      if(!provider&&!subject)authUpdateObjectRowByKey_("使用者","使用者ID",user["使用者ID"],{"驗證提供者":"google","驗證主體ID":identity.sub,"更新時間":now});
    }
    var userId2=String(user["使用者ID"]),allMemberships=readTable_("成員資格"),requester=allMemberships.find(function(m){return String(m["使用者ID"])===userId2&&String(m["組織ID"])===GOOGLE_REQUESTER_ORG_ID_&&String(m["角色"])==="requester"&&String(m["狀態"]||"").toLowerCase()==="active";});
    if(!requester){var mid=identityNewId_("MEM-G");identityAppendObjectRow_("成員資格",{"成員資格ID":mid,"使用者ID":userId2,"組織ID":GOOGLE_REQUESTER_ORG_ID_,"角色":"requester","狀態":"active","建立時間":now,"更新時間":now,"撤銷時間":"","撤銷者使用者ID":""});createdMembership=true;}
    var memberships=authMembershipsForUser_(userId2);try{writeAudit_({eventType:"auth.google.login",actorUserId:userId2,organizationId:memberships.length?memberships[0]["組織ID"]:"",entityType:"user",entityId:userId2,reasonCode:createdUser?"GOOGLE_FIRST_LOGIN":"GOOGLE_LOGIN",details:{requestId:req&&req.requestId?req.requestId:"",googleSub:identity.sub,createdUser:createdUser,createdRequesterMembership:createdMembership}});}catch(auditError){authRecordAuditFailure_("auth.google.login",auditError);}
    return {identity:identity,user:authPublicUser_(user),memberships:memberships.map(authPublicMembership_),sessionToken:authIssueSessionToken_(userId2),onboarding:{createdUser:createdUser,needsPhone:!normalizeTaiwanPhoneForIdentity_(user["手機號碼(E.164)"])}};
  }finally{lock.releaseLock();}
}
