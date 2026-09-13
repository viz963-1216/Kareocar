require('./shim.js'); require('./sheets.js');
const fs=require('fs');
const U=require('path').join(__dirname,'..','apps-script');
for(const f of ['AuthCore.gs','DatabaseApi.gs','AppStateApi.gs']) eval(fs.readFileSync(U+'/'+f,'utf8'));
const P=global.__props;
P.set('AUTH_PASSWORD_PEPPER','pep'); P.set('AUTH_SESSION_SECRET','sec'); P.set('AUTH_PBKDF2_ITERATIONS','1000');

__makeSheet('組織',['組織ID','組織名稱','啟用狀態'],[
  {'組織ID':'ORG-REQ-001','組織名稱':'需求者組織','啟用狀態':true},
  {'組織ID':'ORG-TP-001','組織名稱':'安馨福祉','啟用狀態':true},
  {'組織ID':'ORG-TP-002','組織名稱':'樂行車隊','啟用狀態':true}]);
__makeSheet('使用者',['使用者ID','顯示名稱','手機號碼(E.164)','電子郵件','啟用狀態','平台角色'],[
  {'使用者ID':'USR-VICTIM','顯示名稱':'受害需求者','啟用狀態':true,'平台角色':'none'},
  {'使用者ID':'USR-ATTACK','顯示名稱':'攻擊者','啟用狀態':true,'平台角色':'none'},
  {'使用者ID':'USR-DISP1','顯示名稱':'A隊調度','啟用狀態':true,'平台角色':'none'}]);
__makeSheet('成員資格',['成員資格ID','使用者ID','組織ID','角色','狀態'],[
  {'成員資格ID':'M1','使用者ID':'USR-VICTIM','組織ID':'ORG-REQ-001','角色':'requester','狀態':'active'},
  {'成員資格ID':'M2','使用者ID':'USR-ATTACK','組織ID':'ORG-REQ-001','角色':'requester','狀態':'active'},
  {'成員資格ID':'M3','使用者ID':'USR-DISP1','組織ID':'ORG-TP-001','角色':'dispatcher','狀態':'active'}]);
__makeSheet('預約',['預約ID','服務對象ID','預約者使用者ID','組織ID','預約狀態','上車地址','目的地'],[
  {'預約ID':'BKG-VICTIM','預約者使用者ID':'USR-VICTIM','組織ID':'ORG-TP-001','預約狀態':'claimed','上車地址':'台北市大安區某路1號'},
  {'預約ID':'BKG-OPEN','預約者使用者ID':'USR-VICTIM','組織ID':'','預約狀態':'open','上車地址':'台北市中山區某路2號'}]);
__makeSheet('行程',['行程ID','組織ID','司機ID','行程狀態'],[{'行程ID':'TRIP-1','組織ID':'ORG-TP-001','司機ID':'DRV-1'}]);
__makeSheet('司機',['司機ID','使用者ID','組織ID'],[]);
__makeSheet('服務對象',['服務對象ID','顯示名稱'],[{'服務對象ID':'CR-1','顯示名稱':'王阿嬤'}]);
__makeSheet('服務對象聯絡人',['聯絡人ID','服務對象ID','使用者ID','狀態'],[{'聯絡人ID':'C1','服務對象ID':'CR-1','使用者ID':'USR-VICTIM','狀態':'active'}]);
__makeSheet('行程預約關聯',['行程ID','預約ID'],[]);
__makeSheet('應用狀態',APP_STATE_HEADERS_.slice(),[]);

const tokenFor=u=>authIssueSessionToken_(u);
let pass=0,fail=0;
const t=(n,c)=>{try{if(c()){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n);}}catch(e){fail++;console.log('  FAIL',n,'->',e.message);}};
const forbidden=fn=>{try{fn();return false;}catch(e){return e.code==='FORBIDDEN'||e.code==='BOOKING_CONFLICT';}};

console.log('=== #01 攻擊模擬：攻擊者宣稱自己是他人預約的擁有者 ===');
t('攻擊者無法覆寫他人已承接的預約', ()=>forbidden(()=>mutateAppState_({
  sessionToken:tokenFor('USR-ATTACK'),
  changes:[{collection:'bookings',id:'BKG-VICTIM',record:{
    id:'BKG-VICTIM', requestedByUserId:'USR-ATTACK',   // <- 舊版就是被這行騙過
    state:'cancelled', version:9999}}]},{})));

t('攻擊者無法覆寫他人的公開待媒合預約', ()=>forbidden(()=>mutateAppState_({
  sessionToken:tokenFor('USR-ATTACK'),
  changes:[{collection:'bookings',id:'BKG-OPEN',record:{
    id:'BKG-OPEN', requestedByUserId:'USR-ATTACK', state:'cancelled', version:9999}}]},{})));

t('攻擊者無法冒充成為他人服務對象的關係人', ()=>forbidden(()=>mutateAppState_({
  sessionToken:tokenFor('USR-ATTACK'),
  changes:[{collection:'careRecipients',id:'CR-1',record:{
    id:'CR-1', governance:{createdByUserId:'USR-ATTACK'}, name:'已竄改'}}]},{})));

t('攻擊者無法竄改他人的系統回報', ()=>{
  mutateAppState_({sessionToken:tokenFor('USR-VICTIM'),changes:[{collection:'systemReports',id:'SR-1',record:{id:'SR-1',text:'原始內容'}}]},{});
  return forbidden(()=>mutateAppState_({sessionToken:tokenFor('USR-ATTACK'),
    changes:[{collection:'systemReports',id:'SR-1',record:{id:'SR-1',reporterUserId:'USR-ATTACK',text:'竄改'}}]},{}));});

t('攻擊者無法把自己加進別家公司當負責人', ()=>forbidden(()=>mutateAppState_({
  sessionToken:tokenFor('USR-ATTACK'),
  changes:[{collection:'memberships',id:'M-EVIL',record:{
    id:'M-EVIL',userId:'USR-ATTACK',organizationId:'ORG-TP-001',role:'owner'}}]},{})));

console.log('\n=== 正常功能必須維持可用 ===');
t('本人可以修改自己的預約', ()=>{
  const r=mutateAppState_({sessionToken:tokenFor('USR-VICTIM'),
    changes:[{collection:'bookings',id:'BKG-VICTIM',record:{id:'BKG-VICTIM',state:'claimed',version:2,note:'本人更新'}}]},{});
  return r.ok&&r.results[0].version>=1;});

t('需求者可以建立自己的新預約', ()=>{
  const r=mutateAppState_({sessionToken:tokenFor('USR-VICTIM'),
    changes:[{collection:'bookings',id:'BKG-NEW',record:{id:'BKG-NEW',state:'open',version:1}}]},{});
  const row=appStateFindRow_('bookings','BKG-NEW');
  return r.ok && row['擁有者使用者ID']==='USR-VICTIM';});

t('新預約的擁有者由伺服器指派，忽略偽造欄位', ()=>{
  mutateAppState_({sessionToken:tokenFor('USR-ATTACK'),
    changes:[{collection:'bookings',id:'BKG-NEW2',record:{id:'BKG-NEW2',requestedByUserId:'USR-VICTIM',state:'open',version:1}}]},{});
  return appStateFindRow_('bookings','BKG-NEW2')['擁有者使用者ID']==='USR-ATTACK';});

t('調度員可以承接公開需求池的案件', ()=>{
  const r=mutateAppState_({sessionToken:tokenFor('USR-DISP1'),
    changes:[{collection:'bookings',id:'BKG-OPEN',record:{id:'BKG-OPEN',state:'claimed',organizationId:'ORG-TP-001',version:2}}]},{});
  return r.ok&&appStateFindRow_('bookings','BKG-OPEN')['組織ID']==='ORG-TP-001';});

t('調度員不能把案件承接到自己沒加入的公司', ()=>{
  __SHEETS['應用狀態'].rows=__SHEETS['應用狀態'].rows.filter(r=>r[1]!=='BKG-OPEN');
  return forbidden(()=>mutateAppState_({sessionToken:tokenFor('USR-DISP1'),
    changes:[{collection:'bookings',id:'BKG-OPEN',record:{id:'BKG-OPEN',state:'claimed',organizationId:'ORG-TP-002',version:2}}]},{}));});

t('調度員可以管理自家組織的行程', ()=>{
  const r=mutateAppState_({sessionToken:tokenFor('USR-DISP1'),
    changes:[{collection:'trips',id:'TRIP-1',record:{id:'TRIP-1',revision:1,status:'scheduled'},expectedRevision:0}]},{});
  return r.ok;});

t('需求者不能碰車隊的行程', ()=>forbidden(()=>mutateAppState_({
  sessionToken:tokenFor('USR-VICTIM'),
  changes:[{collection:'trips',id:'TRIP-1',record:{id:'TRIP-1',revision:9,status:'completed'},expectedRevision:1}]},{})));

t('密碼欄位仍會被後端清除', ()=>{
  mutateAppState_({sessionToken:tokenFor('USR-VICTIM'),
    changes:[{collection:'users',id:'USR-VICTIM',record:{id:'USR-VICTIM',name:'改名',password:'plain123',passwordHash:'x',sessionToken:'y'}}]},{});
  const j=appStateFindRow_('users','USR-VICTIM')['資料JSON'];
  return !j.includes('plain123')&&!j.includes('passwordHash')&&!j.includes('sessionToken');});

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
// 不用 process.exit()：強制退出路徑曾重現卡住，機制未證實，見 tests/_exit-watchdog.js
require('./_exit-watchdog').finishTest(fail ? 1 : 0, 'appstate-authz');
