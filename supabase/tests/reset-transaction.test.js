'use strict';
// Real pg driver + isolated Postgres. Never run against production.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
// 只允許本機隔離端點：Unix socket（/tmp/care-ride-*）或 localhost TCP。
// 真正的保護是固定的測試庫名稱 careride_reset_test。
const host = process.env.PGHOST;
const isSocket = Boolean(host) && host.startsWith('/tmp/care-ride-');
const isLocalTcp = host === 'localhost' || host === '127.0.0.1';
if ((!isSocket && !isLocalTcp) || process.env.PGDATABASE !== 'careride_reset_test') {
  throw Error('Requires dedicated local endpoint and careride_reset_test database');
}
// Unix socket 要把路徑塞進 host 欄位並做百分比編碼；TCP 直接用主機名。
// 隔離測試用的 Postgres 沒有啟用 SSL，明確關掉；_db.js 只認這個參數。
process.env.DATABASE_URL = isSocket
  ? `postgresql://care_ride_app@${encodeURIComponent(host)}:${process.env.PGPORT}/careride_reset_test?sslmode=disable`
  : `postgresql://care_ride_app@${host}:${process.env.PGPORT}/careride_reset_test?sslmode=disable`;
process.env.AUTH_SESSION_SECRET = 'synthetic-session-secret-0123456789';
process.env.AUTH_PASSWORD_PEPPER = 'synthetic-password-pepper-0123456789';
process.env.AUTH_PBKDF2_ITERATIONS = '1000';
const admin = new Pool({host,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:'postgres'});
const db = require('../../netlify/functions/_db');
const reset = require('../../netlify/functions/_auth-reset');
const auth = require('../../netlify/functions/_auth-pg');
const confirm = require('../../netlify/functions/v2-confirm-password-reset');
const phone='0912000001', user='USR-VICTIM';
const newPassword='synthetic-new-password';
const post = async otp => JSON.parse((await confirm.handler({httpMethod:'POST',body:JSON.stringify({phone,otp,newPassword})})).body);
let count=0;
async function check(name, fn){await fn(); count++; console.log('PASS',name);}
async function challenge(){
  await admin.query('delete from auth_rate_limits');
  let otp;
  await db.withoutUser(c=>reset.createChallenge(c,user,phone,async code=>{otp=code;}));
  return otp;
}
(async()=>{
  await check('failed OTP count persists and three guesses block even the correct OTP',async()=>{
    const otp=await challenge(); const wrong=String((Number(otp)+1)%1000000).padStart(6,'0');
    for(let i=1;i<=3;i++){
      assert.equal((await post(wrong)).error.code,'RESET_CODE_INVALID');
      const {rows}=await admin.query('select state from auth_rate_limits where key=$1',[auth.opaqueKey('reset',phone)]);
      assert.equal(rows[0].state.attempts,i);
    }
    assert.equal((await post(otp)).error.code,'RESET_CODE_INVALID');
    assert.equal((await admin.query('select count(*)::int n from auth_rate_limits where key=$1',[auth.opaqueKey('reset',phone)])).rows[0].n,0);
  });
  await check('concurrent wrong guesses do not lose attempt increments',async()=>{
    const otp=await challenge(); const wrong=String((Number(otp)+1)%1000000).padStart(6,'0');
    const results=await Promise.all([post(wrong),post(wrong),post(wrong)]);
    assert.ok(results.every(r=>r.error.code==='RESET_CODE_INVALID'));
    assert.equal((await admin.query('select state from auth_rate_limits where key=$1',[auth.opaqueKey('reset',phone)])).rows[0].state.attempts,3);
  });
  await check('concurrent correct OTP requests commit exactly once',async()=>{
    const otp=await challenge();
    const before=(await admin.query('select session_version from users where id=$1',[user])).rows[0].session_version;
    const results=await Promise.all([post(otp),post(otp)]);
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal(results.filter(r=>r.error?.code==='RESET_CODE_INVALID').length,1);
    assert.equal((await admin.query('select session_version from users where id=$1',[user])).rows[0].session_version,before+1);
    assert.equal(await db.withoutUser(c=>auth.verifyPasswordCredential(c,user,newPassword)),true);
  });
  await check('failed SMS callback rolls back challenge and rate state',async()=>{
    await admin.query('delete from auth_rate_limits');
    await assert.rejects(db.withoutUser(c=>reset.createChallenge(c,user,phone,async()=>{throw Object.assign(Error('synthetic provider failure'),{code:'RESET_PROVIDER_UNAVAILABLE'});})),{code:'RESET_PROVIDER_UNAVAILABLE'});
    assert.equal((await admin.query('select count(*)::int n from auth_rate_limits')).rows[0].n,0);
  });
  console.log(`${count} real Postgres transaction scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await db.getPool().end();await admin.end();});
