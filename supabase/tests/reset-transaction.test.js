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
// 假的 Supabase Auth（密碼存在記憶體）；必須在載入任何 function 之前
const fx = require('./_auth-fixture');
const admin = new Pool({host,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:'postgres'});
const db = require('../../netlify/functions/_db');
const reset = require('../../netlify/functions/_auth-reset');
const auth = require('../../netlify/functions/_auth-pg');
const confirm = require('../../netlify/functions/v2-confirm-password-reset');
const phone='0912000001', user='USR-VICTIM';
const other='USR-ATTACK', otherPhone='+886912000002';
const newPassword='synthetic-new-password';
fx.addUser(user, phone, 'synthetic-old-password');
const supabaseAuth = require('../../netlify/functions/_supabase-auth');
const canLogin = async (p, pw) => { try { await supabaseAuth.signInWithPassword(fx.toE164(p), pw); return true; } catch (_) { return false; } };
const validAfter = async (id) => Number((await admin.query(
  'select floor(extract(epoch from sessions_valid_after))::bigint v from users where id=$1',[id])).rows[0].v);
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
    const before=await validAfter(user);
    const updatesBefore=fx.calls.filter(c=>c[0]==='updateUser').length;
    const results=await Promise.all([post(otp),post(otp)]);
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal(results.filter(r=>r.error?.code==='RESET_CODE_INVALID').length,1);
    // 舊 session 全部失效：生效起點推到現在之後
    assert.ok(await validAfter(user) > Math.max(before, Math.floor(Date.now()/1000) - 5));
    // Supabase Auth 的密碼只被更新一次，而且是新密碼
    assert.equal(fx.calls.filter(c=>c[0]==='updateUser').length-updatesBefore,1);
    assert.equal(await canLogin(phone,newPassword),true);
    // 提交後撤銷了這個帳號全部的 refresh token
    assert.ok(fx.calls.some(c=>c[0]==='signOut'&&c[1]==='global'));
  });
  await check('challenge bound to another user is invalidated, no account changes, reuse rejected',async()=>{
    // 挑戰綁 USR-VICTIM，然後把號碼移到 USR-ATTACK：此時挑戰的 userId 與這支
    // 手機現在對應的使用者不符。正確碼也必須被拒，挑戰必須失效，兩個帳號都
    // 不能被改動。
    const otp=await challenge();
    const e164=auth.toE164(phone), parked='+886912099999';
    const snap=async()=>(await admin.query(
      `select u.id, u.sessions_valid_after, u.updated_at
         from users u where u.id in ($1,$2) order by u.id`,[user,other])).rows;
    await admin.query('update users set phone_e164=$1 where id=$2',[parked,user]);
    await admin.query('update users set phone_e164=$1 where id=$2',[e164,other]);
    try {
      const before=await snap();
      const updatesBefore=fx.calls.filter(c=>c[0]==='updateUser').length;
      const first=await post(otp);
      assert.equal(first.error.code,'RESET_CODE_INVALID');
      assert.equal(first.ok,false);   // handleError 會回 { ok:false, error:{...} }

      // 挑戰已作廢（提交後生效），不是只被回滾
      assert.equal((await admin.query('select count(*)::int n from auth_rate_limits where key=$1',
        [auth.opaqueKey('reset',phone)])).rows[0].n,0);

      // 兩個帳號的 sessions_valid_after、updated_at 都沒變
      assert.deepEqual(await snap(),before);

      // Supabase Auth 那端沒有任何一方的密碼被改
      assert.equal(fx.calls.filter(c=>c[0]==='updateUser').length,updatesBefore);

      // 同一組碼再送一次仍然被拒（挑戰真的不見了，不是還留著可重試）
      assert.equal((await post(otp)).error.code,'RESET_CODE_INVALID');
      assert.deepEqual(await snap(),before);
    } finally {
      await admin.query('update users set phone_e164=null where id=$1',[other]);
      await admin.query('update users set phone_e164=$1 where id=$2',[e164,user]);
      await admin.query('update users set phone_e164=$1 where id=$2',[otherPhone,other]);
    }
  });
  await check('failed SMS callback rolls back challenge and rate state',async()=>{
    await admin.query('delete from auth_rate_limits');
    await assert.rejects(db.withoutUser(c=>reset.createChallenge(c,user,phone,async()=>{throw Object.assign(Error('synthetic provider failure'),{code:'RESET_PROVIDER_UNAVAILABLE'});})),{code:'RESET_PROVIDER_UNAVAILABLE'});
    assert.equal((await admin.query('select count(*)::int n from auth_rate_limits')).rows[0].n,0);
  });
  console.log(`${count} real Postgres transaction scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await db.getPool().end();await admin.end();});
