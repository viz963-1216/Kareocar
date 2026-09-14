'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const loader=html.slice(html.indexOf('const AppStateDatabase={'),html.indexOf('window.AppStateDatabase=AppStateDatabase;'));
const queueMethod=html.slice(html.indexOf('  async syncOfflineQueue(){'),html.indexOf('  captureProof(tripId'));
const badgeFunction=html.match(/function updateSyncUI\(\)\{[^\n]+/)[0];
let checks=0;
function check(fn){fn();checks++;}
async function main(){
 const state={integration:{},bookings:[]};const mutations=[];
 let response={ok:true,status:200,json:async()=>({ok:true,data:{collections:{bookings:[{id:'B'}]},counts:{bookings:1},loadedAt:'2026-09-14T00:00:00Z'}})};
 const context=vm.createContext({window:{backendAuthToken:()=> 'synthetic'},navigator:{onLine:true},store:{mutate:(f,o)=>{mutations.push(o);f(state);}},normalizeLoadedIds_:x=>x,AUTHORITATIVE_STATE_COLLECTIONS:['bookings'],nowISO:()=> 'now',fetch:async()=>response,showToast:()=>{},console});
 vm.runInContext(loader+';globalThis.loader=AppStateDatabase',context);
 await context.loader.loadAll();
 check(()=>assert.equal(state.integration.lastSyncAt,'2026-09-14T00:00:00Z'));
 check(()=>assert.equal(state.integration.lastSyncStatus,'同步完成'));
 check(()=>assert.equal(state.integration.lastSyncDetails.length,0));
 check(()=>assert.equal(state.integration.lastSyncCounts.bookings,1));
 check(()=>assert.equal(state.bookings[0].id,'B'));
 response={ok:false,status:503,json:async()=>({ok:false,error:{message:'合成失敗'}})};
 check(()=>assert.equal((state.integration.lastSyncAt),'2026-09-14T00:00:00Z'));
 await context.loader.loadAll({silent:true});
 check(()=>assert.equal(state.integration.lastSyncStatus,'載入失敗'));
 check(()=>assert.equal(state.integration.lastSyncDetails[0],'合成失敗'));
 check(()=>assert.equal(state.integration.lastSyncAt,'2026-09-14T00:00:00Z'));
 response={ok:true,status:200,json:async()=>({ok:true,data:{collections:{},counts:{},truncated:true}})};
 await context.loader.loadAll();
 check(()=>assert.equal(state.integration.lastSyncStatus,'部分資料已載入'));
 check(()=>assert.equal(state.integration.lastSyncDetails.length,1));
 context.navigator.onLine=false; await context.loader.loadAll();
 check(()=>assert.match(state.integration.lastSyncDetails[0],/離線/));
 check(()=>assert.ok(mutations.every(o=>o.remote===false)));
 for(const success of [true,false]){
  const row={id:'Q',requestId:'RQ',status:'pending',attempts:0};const badge={className:'',textContent:'線上・1待同步'};
  const ctx=vm.createContext({navigator:{onLine:true},$:()=>badge,store:{state:{tripOfflineQueue:[row],tripEvents:[]},mutate:f=>f({tripOfflineQueue:[row],tripEvents:[]})},hydrateTripOutboxFromIdb:async()=>{},tripAppOffline:()=>false,TripSyncAdapter:{mode:'test',syncBatch:async()=>({ok:success,results:success?[{id:'Q',ok:true}]:[],error:success?null:'offline'})},persistTripQueueRowP2:async()=>{},cleanupTripP2Storage:async()=>{},TRIP_DEVICE_ID:'D',TRIP_SESSION_ID:'S',nowISO:()=> 'now',deepClone:x=>({...x})});
  vm.runInContext('let tripOutboxSyncPromise=null;const Trip={offlineQueue(){return store.state.tripOfflineQueue.filter(x=>x.status!=="synced"&&x.status!=="rejected");},'+queueMethod+'};'+badgeFunction+';globalThis.run=()=>Trip.syncOfflineQueue();',ctx);
  await ctx.run();
  check(()=>assert.equal(badge.textContent,success?'線上':'線上・1待同步'));
  check(()=>assert.equal(row.status,success?'synced':'pending'));
 }
 console.log(`sync-status: ${checks} passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
