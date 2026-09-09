/**
 * WebApp.gs — V12.25.79
 * Only Netlify should call this Apps Script Web App.
 */
function doPost(e){
  var requestId="REQ-"+Utilities.getUuid().replace(/-/g,"").slice(0,16).toUpperCase();
  try{
    var envelope=JSON.parse(e&&e.postData&&e.postData.contents?e.postData.contents:"{}");
    var expected=authConfig_("NETLIFY_GATEWAY_SECRET");
    if(!envelope.gatewaySecret||!authConstantTimeEqual_(String(envelope.gatewaySecret),expected))throw authError_("GATEWAY_UNAUTHORIZED","未授權的 API Gateway");
    var req={path:String(envelope.path||""),body:envelope.body||{},query:envelope.query||{},params:envelope.params||{},requestId:String(envelope.requestId||requestId)};
    var data=routeRequest_(String(envelope.method||"POST"),req);
    return webJson_({ok:true,data:data,requestId:req.requestId});
  }catch(error){
    return webJson_({ok:false,error:{code:String(error&&error.code||"SERVER_ERROR"),message:String(error&&error.message||error||"伺服器錯誤")},requestId:requestId});
  }
}
function doGet(){return webJson_({ok:false,error:{code:"METHOD_NOT_ALLOWED",message:"請透過正式 API Gateway 呼叫"}});}
function webJson_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
