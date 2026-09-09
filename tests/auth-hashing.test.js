require('./shim.js');
const fs=require('fs');
eval(fs.readFileSync(require('path').join(__dirname,'..','apps-script','AuthCore.gs'),'utf8'));
const P=global.__props;
P.set('AUTH_PASSWORD_PEPPER','pepper-secret-value-abc123');
P.set('AUTH_SESSION_SECRET','session-secret-value-xyz789');
P.set('AUTH_PBKDF2_ITERATIONS','3000');
let pass=0,fail=0;
const t=(n,c)=>{try{if(c()){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n);}}catch(e){fail++;console.log('  FAIL',n,'->',e.message);}};

console.log('--- 密碼雜湊 ---');
authSetPasswordCredential_('USR-1','CorrectHorse99');
t('正確密碼通過', ()=>authVerifyPasswordCredential_('USR-1','CorrectHorse99')===true);
t('錯誤密碼拒絕', ()=>authVerifyPasswordCredential_('USR-1','WrongHorse99')===false);
t('不存在帳號拒絕', ()=>authVerifyPasswordCredential_('USR-NOPE','anything123')===false);
t('儲存的是 v2 + 迭代數', ()=>{const c=JSON.parse(P.get('AUTH_CRED_USR-1'));return c.v===2&&c.iterations===3000&&c.hash.length===64;});
t('相同密碼不同 salt 產生不同 hash', ()=>{const a=P.get('AUTH_CRED_USR-1');authSetPasswordCredential_('USR-1','CorrectHorse99');return a!==P.get('AUTH_CRED_USR-1');});
t('明文不落地', ()=>!P.get('AUTH_CRED_USR-1').includes('CorrectHorse99'));
t('太短密碼被擋', ()=>{try{authSetPasswordCredential_('USR-X','short');return false;}catch(e){return e.code==='WEAK_PASSWORD';}});

console.log('--- 舊 v1 憑證自動升級 ---');
const legacySalt=authRandomHex_(16);
P.set('AUTH_CRED_USR-OLD',JSON.stringify({v:1,salt:legacySalt,hash:authHmacHex_(legacySalt+'|LegacyPass88','pepper-secret-value-abc123')}));
t('舊密碼仍可登入', ()=>authVerifyPasswordCredential_('USR-OLD','LegacyPass88')===true);
t('登入後已升級為 v2', ()=>JSON.parse(P.get('AUTH_CRED_USR-OLD')).v===2);
t('升級後仍可登入', ()=>authVerifyPasswordCredential_('USR-OLD','LegacyPass88')===true);
t('升級後錯誤密碼仍拒絕', ()=>authVerifyPasswordCredential_('USR-OLD','LegacyPass99')===false);

console.log('--- OTP 亂數 ---');
const codes=new Set();for(let i=0;i<400;i++)codes.add(authSecureOtpCode_());
t('400 次產生近乎全不重複', ()=>codes.size>395);
t('皆為 6 位數字', ()=>[...codes].every(c=>/^\d{6}$/.test(c)));
t('程式碼中無 Math.random（排除註解）', ()=>{const src=fs.readFileSync(require('path').join(__dirname,'..','apps-script','AuthCore.gs'),'utf8').split('\n').filter(l=>!l.trim().startsWith('*')&&!l.trim().startsWith('//')).join('\n');return !src.includes('Math.random');});

console.log('--- session token ---');
const tok=authIssueSessionToken_('USR-1');
t('簽發可驗證', ()=>authVerifySessionToken_(tok).userId==='USR-1');
t('竄改 payload 被拒', ()=>{try{authVerifySessionToken_('x'+tok);return false;}catch(e){return e.code==='SESSION_INVALID';}});
t('bump 版本後舊 token 失效', ()=>{authBumpSessionVersion_('USR-1');try{authVerifySessionToken_(tok);return false;}catch(e){return e.code==='SESSION_INVALID';}});

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail?1:0);
