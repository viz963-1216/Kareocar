/** Router.gs — V12.25.79 */
function routeRequest_(method,req){
  method=String(method||"").toUpperCase();var path=String(req&&req.path?req.path:"").trim();
  if(method==="GET"&&path==="/health")return healthCheck_();
  if(method==="POST"&&path==="/auth/google")return googleLogin_(req.body||{},req);
  if(method==="POST"&&path==="/identity/register-requester")return registerRequesterFromWeb_(req.body||{},req);
  if(method==="POST"&&path==="/identity/password-login")return passwordLogin_(req.body||{},req);
  if(method==="POST"&&path==="/identity/complete-social-profile")return completeSocialProfileFromWeb_(req.body||{},req);
  if(method==="POST"&&path==="/identity/session")return resumeIdentitySession_(req.body||{},req);
  if(method==="POST"&&path==="/identity/create-staff")return createStaffFromWeb_(req.body||{},req);
  if(method==="POST"&&path==="/identity/request-password-reset")return requestPasswordResetFromWeb_(req.body||{},req);
  if(method==="POST"&&path==="/identity/confirm-password-reset")return confirmPasswordResetFromWeb_(req.body||{},req);
  if(method==="POST"&&path==="/identity/update-account")return updateCurrentIdentityAccountFromWeb_(req.body||{},req);
  if(method==="GET"&&path==="/database/table")return readDatabaseTable_(req);
  if(method==="POST"&&path==="/state/mutate")return mutateAppState_(req.body||{},req);
  // Legacy reads are retained only behind the same session-scoped row authorization.
  var legacyMap={"/organizations":"組織","/users":"使用者","/memberships":"成員資格","/care-recipients":"服務對象","/care-recipient-contacts":"服務對象聯絡人","/drivers":"司機","/vehicles":"車輛","/trips":"行程","/trip-bookings":"行程預約關聯","/service-proofs":"服務證明","/audit":"稽核紀錄"};
  if(method==="GET"&&legacyMap[path]){req.body=req.body||{};req.body.sheet=legacyMap[path];return readDatabaseTable_(req);}
  if(method==="GET"&&path==="/bookings"){req.body=req.body||{};req.body.sheet="預約";return readDatabaseTable_(req);}
  // Existing normalized booking write handlers remain available for compatibility; AppState is the operational authority for UI mutations.
  if(method==="POST"&&path==="/bookings")return createBooking_(req.body||{},req);
  if(method==="POST"&&path==="/bookings/update")return updateBooking_(req.body||{},req);
  throw authError_("ROUTE_NOT_FOUND","找不到 API 路由："+method+" "+path);
}
function healthCheck_(){
  var ss=getSpreadsheet_(),appStateReady=false;try{appStateReady=!!ensureAppStateSheet_();}catch(_){}
  return {status:"ok",time:new Date().toISOString(),spreadsheetReady:!!ss,appStateReady:appStateReady,rowAuthorizationVersion:"12.25.79",passwordResetProviderConfigured:!!PropertiesService.getScriptProperties().getProperty("PASSWORD_RESET_SMS_WEBHOOK_URL")&&!!PropertiesService.getScriptProperties().getProperty("PASSWORD_RESET_SMS_WEBHOOK_SECRET"),authConfigured:!!PropertiesService.getScriptProperties().getProperty("AUTH_SESSION_SECRET")&&!!PropertiesService.getScriptProperties().getProperty("AUTH_PASSWORD_PEPPER")};
}
