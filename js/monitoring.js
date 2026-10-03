/*
 * 前端未處理錯誤回報（#17）。在 app.js 之前載入，錯誤送到本站的 /api/v2/client-error，
 * 由伺服器清掉個資後轉給 Sentry（瀏覽器不直接連 Sentry，CSP 的 connect-src 只允許本站）。
 * 每個頁面最多回報 5 筆，同樣的訊息只回報一次；只送路徑，不送查詢字串與畫面內容。
 */
(function(){
  'use strict';
  var MAX_REPORTS=5,sent=0,seen={};
  var release=(document.querySelector('meta[name="care-ride-ui-release"]')||{}).content||'';
  function sameOrigin(src){
    if(!src)return true;
    try{return new URL(src,location.href).origin===location.origin;}catch(e){return false;}
  }
  function report(kind,message,stack,source,line,col){
    try{
      if(sent>=MAX_REPORTS)return;
      if(!sameOrigin(source))return; // 瀏覽器外掛等第三方腳本的錯誤不回報
      var key=kind+'|'+String(message).slice(0,200);
      if(seen[key])return;
      seen[key]=true;sent++;
      var body=JSON.stringify({kind:kind,message:String(message||'').slice(0,500),stack:String(stack||'').slice(0,4000),
        path:location.pathname,line:line||null,col:col||null,release:release});
      fetch('/api/v2/client-error',{method:'POST',headers:{'content-type':'application/json'},body:body,
        credentials:'same-origin',keepalive:true}).catch(function(){});
    }catch(e){}
  }
  window.addEventListener('error',function(e){
    if(!e||(!e.error&&!e.message))return; // 資源載入失敗（img、script 404）沒有訊息，不回報
    report('error',(e.error&&e.error.message)||e.message,e.error&&e.error.stack,e.filename,e.lineno,e.colno);
  });
  window.addEventListener('unhandledrejection',function(e){
    var r=e&&e.reason;
    report('unhandledrejection',(r&&r.message)||String(r||'Unhandled rejection'),r&&r.stack,null,null,null);
  });
  window.careRideReportError=function(error){report('error',error&&error.message||String(error),error&&error.stack,null,null,null);};
})();
