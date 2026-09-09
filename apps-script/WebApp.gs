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
    var req={path:String(envelope.path||""),body:envelope.body||{},query:envelope.query||{},params:envelope.params||{},clientIp:String(envelope.clientIp||""),requestId:String(envelope.requestId||requestId)};
    var data=routeRequest_(String(envelope.method||"POST"),req);
    return webJson_({ok:true,data:data,requestId:req.requestId});
  }catch(error){
    // 只有帶 code 的預期錯誤（authError_）才把訊息回給前端；其餘一律回通用訊息，
    // 避免把工作表名稱、欄位名稱之類的內部結構洩漏出去。內容仍完整寫入 Logger。
    var code=String(error&&error.code||"");
    if(!code){
      try{Logger.log("[%s] unexpected: %s", requestId, String(error&&error.stack||error));}catch(_){}
      return webJson_({ok:false,error:{code:"SERVER_ERROR",message:"伺服器暫時無法處理這個請求，請稍後再試"},requestId:requestId});
    }
    return webJson_({ok:false,error:{code:code,message:String(error&&error.message||"請求失敗")},requestId:requestId});
  }
}
function doGet(){return webJson_({ok:false,error:{code:"METHOD_NOT_ALLOWED",message:"請透過正式 API Gateway 呼叫"}});}
function webJson_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
