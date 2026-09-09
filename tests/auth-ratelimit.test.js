require('./shim.js'); require('./sheets.js');
const fs=require('fs');
eval(fs.readFileSync(require('path').join(__dirname,'..','apps-script','AuthCore.gs'),'utf8'));
const P=global.__props;
P.set('AUTH_PASSWORD_PEPPER','pepper-abc'); P.set('AUTH_SESSION_SECRET','sess-xyz'); P.set('AUTH_PBKDF2_ITERATIONS','1000');
let clock=1800000000000; const realNow=Date.now; Date.now=()=>clock;
const advance=s=>{clock+=s*1000;};
let pass=0,fail=0;
const t=(n,c)=>{try{if(c()){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n);}}catch(e){fail++;console.log('  FAIL',n,'->',e.message);}};
const throws=(fn,code)=>{try{fn();return false;}catch(e){return e.code===code;}};

console.log('--- #06 登入鎖定：必須是「軟鎖」，不能永久 ---');
const PH='0912345678';
t('前 4 次失敗不鎖', ()=>{for(let i=0;i<4;i++){authAssertLoginAllowed_(PH,'1.1.1.1');authRecordLoginFailure_(PH,'1.1.1.1');}return true;});
t('第 5 次失敗後進入鎖定', ()=>{authRecordLoginFailure_(PH,'1.1.1.1');return throws(()=>authAssertLoginAllowed_(PH,'1.1.1.1'),'LOGIN_RATE_LIMITED');});
t('3 分鐘後自動解鎖', ()=>{advance(181);authAssertLoginAllowed_(PH,'1.1.1.1');return true;});
t('攻擊者打滿 20 次也只是長鎖，不是永久', ()=>{for(let i=0;i<20;i++){try{authAssertLoginAllowed_(PH,'1.1.1.1');}catch(_){}authRecordLoginFailure_(PH,'1.1.1.1');}return throws(()=>authAssertLoginAllowed_(PH,'1.1.1.1'),'LOGIN_RATE_LIMITED');});
t('等 1 小時後受害者可自行恢復登入（舊版需簡訊重設）', ()=>{advance(3601);authAssertLoginAllowed_(PH,'1.1.1.1');return true;});
t('不再產生 PASSWORD_RESET_REQUIRED 永久狀態', ()=>{const src=fs.readFileSync(require('path').join(__dirname,'..','apps-script','AuthCore.gs'),'utf8').split('\n').filter(l=>!l.trim().startsWith('*')&&!l.trim().startsWith('//')&&!l.trim().startsWith('/*')).join('\n');return !src.includes('resetRequired')&&!src.includes('PASSWORD_RESET_REQUIRED');});
t('成功登入清除計數', ()=>{authRecordLoginFailure_(PH,'1.1.1.1');authClearLoginRate_(PH);authAssertLoginAllowed_(PH,'1.1.1.1');return true;});

console.log('--- #06 IP 維度：擋跨帳號撞庫 ---');
t('同一 IP 對 30 個不同帳號失敗後被擋', ()=>{
  for(let i=0;i<30;i++){const p='09'+String(20000000+i);try{authAssertLoginAllowed_(p,'9.9.9.9');}catch(_){}authRecordLoginFailure_(p,'9.9.9.9');}
  return throws(()=>authAssertLoginAllowed_('0988888888','9.9.9.9'),'LOGIN_RATE_LIMITED');});
t('乾淨 IP 不受影響', ()=>{authAssertLoginAllowed_('0988888888','2.2.2.2');return true;});

console.log('--- #04 忘記密碼節流 ---');
let sent=0; global.UrlFetchApp={fetch:()=>{sent++;return {getResponseCode:()=>200};}};
P.set('PASSWORD_RESET_SMS_WEBHOOK_URL','https://sms.example.com/send');
P.set('PASSWORD_RESET_SMS_WEBHOOK_SECRET','sms-secret');
const RP='0955000111';
t('第一次索取會發簡訊', ()=>{sent=0;authCreatePasswordResetChallenge_('USR-9',RP);return sent===1;});
t('60 秒內重複索取不再發簡訊、也不報錯', ()=>{sent=0;const r=authCreatePasswordResetChallenge_('USR-9',RP);return sent===0&&r.resent===false&&r.expiresInSeconds>0;});
t('未過期時重送直接沿用原驗證碼', ()=>{advance(61);sent=0;const r=authCreatePasswordResetChallenge_('USR-9',RP);return sent===0&&r.resent===false;});
t('一小時內超過 5 次被擋', ()=>{
  advance(400); // 原 challenge 過期
  let blocked=false;
  for(let i=0;i<10;i++){advance(61);try{authCreatePasswordResetChallenge_('USR-9',RP);advance(400);}catch(e){if(e.code==='RESET_RATE_LIMITED'){blocked=true;break;}}}
  return blocked;});

console.log('--- OTP 驗證 ---');
P.delete&&P.delete('x');
t('錯誤驗證碼 3 次後作廢', ()=>{
  advance(7200); sent=0; authCreatePasswordResetChallenge_('USR-9','0966000222');
  let n=0; for(let i=0;i<5;i++){try{authVerifyPasswordResetChallenge_('0966000222','000000');}catch(e){n++;}}
  return n===5 && !P.get(authResetChallengeKey_('0966000222'));});

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
Date.now=realNow; process.exit(fail?1:0);
