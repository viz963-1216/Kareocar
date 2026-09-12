'use strict';
// Offline transaction-boundary regression: no database, secrets or network.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../netlify/functions');
function load(name, deps) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,name),'utf8'), {
    module, exports:module.exports, require:n => {if (!(n in deps)) throw Error(n); return deps[n];}, Date, String
  }, {filename:name});
  return module.exports;
}
async function run(kind) {
  let state={attempts:0,password:'old',version:1,challengeCleared:false}, snapshot;
  const client={release(){},async query(sql){
    if(sql==='BEGIN') snapshot={...state};
    if(sql==='ROLLBACK') state={...snapshot};
    return {rows:sql.includes('find_user')?[{id:'synthetic',active:true}]:[]};
  }};
  class Pool {on(){} async connect(){return client;}}
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'_db.js'),'utf8'),{
    // URL 不是 ECMAScript 內建，新的 vm context 不會自帶，要明確傳進去。
    module:mod,exports:mod.exports,require:()=>({Pool}),URL,
    process:{env:{DATABASE_URL:'postgres://care_ride_app@localhost/offline'}},console
  });
  const auth={normalizeTaiwanPhone:p=>p,toE164:p=>p,authError:(code,msg)=>Object.assign(Error(msg),{code}),
    async setPasswordCredential(){state.password='new';},async bumpSessionVersion(){state.version++; if(kind==='write-error')throw Error('database failure');},
    async clearLoginRate(){},randomHex:()=> 'test'};
  const reset={async verifyChallenge(){
      state.attempts++;
      if(kind==='invalid')throw auth.authError('RESET_CODE_INVALID','invalid');
      if(kind==='unexpected')throw Error('unexpected');
      // 驗證成功但挑戰綁的是別的使用者
      return {userId:kind==='mismatch'?'someone-else':'synthetic'};
    },async clearChallenge(){state.challengeCleared=true;}};
  const helpers={'./_db':mod.exports,'./_auth-pg':auth,'./_auth-reset':reset,'./_apps-script':{
    json:(statusCode,body)=>({statusCode,body}),parseBody:e=>JSON.parse(e.body),handleError:e=>({error:e.code||e.message})}};
  const h=load('v2-confirm-password-reset.js',helpers).handler;
  const out=await h({httpMethod:'POST',body:JSON.stringify({phone:'0900000099',otp:'111111',newPassword:'synthetic-password'})});
  if(kind==='invalid'){assert.equal(out.error,'RESET_CODE_INVALID');
    assert.deepEqual(state,{attempts:1,password:'old',version:1,challengeCleared:false});}
  else if(kind==='mismatch'){
    // 一般的 RESET_CODE_INVALID，挑戰已作廢並提交，密碼與 session 版本都沒動
    assert.equal(out.error,'RESET_CODE_INVALID');
    assert.deepEqual(state,{attempts:1,password:'old',version:1,challengeCleared:true});}
  else if(kind==='success'){assert.equal(out.body.ok,true);
    assert.deepEqual(state,{attempts:1,password:'new',version:2,challengeCleared:true});}
  else {assert.ok(out.error);
    assert.deepEqual(state,{attempts:0,password:'old',version:1,challengeCleared:false});}
  console.log('PASS reset transaction:',kind);
}
(async()=>{for(const kind of ['invalid','mismatch','unexpected','write-error','success'])await run(kind);})().catch(e=>{console.error(e);process.exitCode=1;});
