(() => {
'use strict';

const APP_CONFIG = Object.freeze({
  appName: '安心接送',
  version: '12.26.1',
  schemaVersion: 44,
  storageKey: 'careRideV122579ReportDemoDB',
  sessionKey: 'careRideV122579ReportDemoSession',
  loginSecurityKey: 'careRideV122579ReportDemoLoginSecurity',
  defaultOrganizationId: 'org_demo_1',
  requesterOrganizationId: 'org_requesters',
  identityRegisterUrl: '/api/v2/register-requester',
  identityPasswordLoginUrl: '/api/v2/password-login',
  identityCreateStaffUrl: '/api/v2/create-staff',
  identitySessionUrl: '/api/v2/session',
  backendHealthUrl: '/api/health',
  authSessionTokenKey: 'careRideV122579ReportDemoAuthSessionToken',
  stateMutateUrl: '/api/v2/state-mutate',
  identityWriteUrl: '/api/v2/identity-write',
  claimBookingUrl: '/api/v2/claim-booking',
  cancelBookingUrl: '/api/v2/cancel-booking',
  tripExecuteUrl: '/api/v2/trip-execute',
  identityRequestPasswordResetUrl: '/api/v2/request-password-reset',
  identityConfirmPasswordResetUrl: '/api/v2/confirm-password-reset',
  identityUpdateAccountUrl: '/api/v2/update-account',
});

window.CARE_RIDE_RUNTIME = Object.freeze({
  version: APP_CONFIG.version,
  releaseChannel: 'production'
});

const ROLE_LABELS = Object.freeze({
  super_admin: '超級管理者',
  driver: '司機',
  dispatcher: '調度人員',
  owner: '負責人',
  requester: '需求者'
});

const MEMBERSHIP_STATUS_LABELS = Object.freeze({
  active:'有效',
  suspended:'舊版暫停',
  revoked:'已撤銷'
});

const STATUS_LABELS = Object.freeze({
  scheduled: '待執行',
  in_progress: '進行中',
  interrupted: '已中斷',
  completed: '已完成',
  cancelled: '已取消',
  aborted: '已終止'
});

const PHASE_LABELS = Object.freeze({depart:'出發', pickup:'接送', dropoff:'送達'});
const isTripTerminalStatus = (status) => ['completed','cancelled','aborted'].includes(status);
const makeTripMutationKey = (action,tripId,stepId,revision) => `${action}:${tripId}:${stepId||'-'}:r${Math.max(0,Number(revision)||0)}`;
const tripPassengerStatusLabelGlobal = (status) => ({waiting:'等待上車',onboard:'已上車',dropped_off:'已送達',cancelled:'已取消',no_show:'未到／未上車',emergency_exit:'中途緊急離車'})[status]||status||'未知';


const $ = (id) => document.getElementById(id);

function setButtonBusy(button,busy,label='處理中…'){
  if(!button)return;
  if(busy){
    if(!button.dataset.busyOriginalText){
      button.dataset.busyOriginalText=button.textContent||'';
    }
    button.disabled=true;
    button.setAttribute('aria-busy','true');
    button.textContent=label;
    return;
  }
  button.disabled=false;
  button.removeAttribute('aria-busy');
  if(button.dataset.busyOriginalText!==undefined){
    button.textContent=button.dataset.busyOriginalText;
    delete button.dataset.busyOriginalText;
  }
}

let careRideBootCompleted=false;

function runtimeErrorMessage_(error){
  const raw=String(error?.message||error||'未知錯誤').replace(/\s+/g,' ').trim();
  return raw.length>220?raw.slice(0,220)+'…':raw;
}
function showPreviewRuntimeError(error,{phase='runtime',fatal=true}={}){
  try{
    if(!fatal&&careRideBootCompleted){
      console.warn(`[Runtime:${phase}] non-fatal`,error);
      return;
    }
    const el=document.getElementById('previewRuntimeError');if(!el)return;
    const runtime=window.CARE_RIDE_RUNTIME||{};
    const message=runtimeErrorMessage_(error);
    el.textContent=`安心接送 V${runtime.version||APP_CONFIG.version}｜${phase==='bootstrap'?'初始化':'執行'}錯誤：${message}`;
    el.dataset.phase=phase;
    el.classList.remove('hidden');
  }catch{}
}
function clearRuntimeErrorBanner_(){
  try{
    const el=document.getElementById('previewRuntimeError');
    if(el){el.classList.add('hidden');el.textContent='';delete el.dataset.phase;}
  }catch{}
}

window.addEventListener('error',e=>{
  const error=e?.error||e?.message||'未知瀏覽器錯誤';
  if(careRideBootCompleted){
    console.warn('[Runtime] background error ignored after successful boot',error);
    return;
  }
  showPreviewRuntimeError(error,{phase:'bootstrap',fatal:true});
});
window.addEventListener('unhandledrejection',e=>{
  const error=e?.reason||'Unhandled Promise Rejection';
  if(careRideBootCompleted){
    console.warn('[Runtime] background rejection ignored after successful boot',error);
    return;
  }
  showPreviewRuntimeError(error,{phase:'bootstrap',fatal:true});
});
const uid = (prefix='id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
const nowISO = () => new Date().toISOString();
const dateKey = (d=new Date()) => d.toLocaleDateString('sv-SE');
const addMinutes = (date,minutes) => new Date(date.getTime()+minutes*60000);
const tripStartAt = (trip) => new Date(trip?.steps?.[0]?.scheduledAt || trip?.createdAt || 0);
const tripEndAt = (trip) => new Date(trip?.steps?.[trip?.steps?.length-1]?.scheduledAt || trip?.createdAt || 0);
const tripWindow = (trip) => ({start:tripStartAt(trip),end:tripEndAt(trip)});
const toLocalInput = (date) => {
  const offset=date.getTimezoneOffset();
  return new Date(date.getTime()-offset*60000).toISOString().slice(0,16);
};
const formatTime = (iso) => new Date(iso).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
const formatDateTime = (iso) => new Date(iso).toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const formatPhone = (phone='') => String(phone).replace(/(\d{4})(\d{3})(\d{3})/,'$1-$2-$3');
const escapeHTML = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
// tel: 連結只保留數字與開頭的 +。電話號碼來自使用者輸入，直接插進 href 的話，
// 引號或 javascript: 之類的內容會變成屬性注入。
const telHref = (phone='') => { const raw=String(phone??'').trim(); const digits=raw.replace(/[^\d]/g,''); return digits?`tel:${raw.startsWith('+')?'+':''}${digits}`:''; };
const digitsOnly = (value='') => String(value ?? '').replace(/\D/g,'');
const formatDuration = (ms) => {
  const sec=Math.max(0,Math.floor(Math.abs(ms)/1000));
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return [h,m,s].map(v=>String(v).padStart(2,'0')).join(':');
};
const durationText = (ms) => {
  const sec=Math.max(0,Math.floor(Math.abs(ms)/1000));
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  if(h) return `${h} 小時 ${m} 分`;
  if(m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
};

const deepClone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const BOOKING_EXPIRY_POLICY=Object.freeze({schemaVersion:1,policyVersion:'market_v1',leadMinutes:30});
function sharedBookingPickupDateTime(dateText='',timeText=''){
  const dm=String(dateText||'').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/),tm=String(timeText||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!dm||!tm)return null;
  const y=Number(dm[1]),mo=Number(dm[2]),d=Number(dm[3]),h=Number(tm[1]),min=Number(tm[2]);
  if(h<0||h>23||min<0||min>59)return null;
  const dt=new Date(y,mo-1,d,h,min,0,0);
  if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d||dt.getHours()!==h||dt.getMinutes()!==min)return null;
  return dt;
}
function sharedBookingMarketExpiryISO(bookingLike={},createdAt=null){
  const pickup=sharedBookingPickupDateTime(bookingLike?.pickupDate,bookingLike?.pickupTime);if(!pickup)return null;
  const created=createdAt?new Date(createdAt):new Date(),createdMs=Number.isNaN(created.getTime())?Date.now():created.getTime(),pickupMs=pickup.getTime();
  const normal=pickupMs-BOOKING_EXPIRY_POLICY.leadMinutes*60000;
  return new Date(normal>createdMs?normal:pickupMs).toISOString();
}


const BOOKING_LOCATION_SCHEMA_VERSION=1;
const BOOKING_LEG_SCHEMA_VERSION=1;
const BOOKING_LEG_STATUS=Object.freeze({PENDING:'pending',SCHEDULED:'scheduled',CANCELLED:'cancelled'});
function canonicalLocationText(value=''){ return String(value||'').replace(/臺/g,'台').replace(/\s+/g,'').replace(/[，,。．]/g,'').trim(); }
function locationCity(address=''){
  return canonicalLocationText(address).match(/(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)/)?.[1]||'';
}
const BOOKING_SERVICE_JURISDICTIONS=Object.freeze(['taipei','new_taipei','other']);
function serviceJurisdictionFromResidenceAddress(address=''){
  const city=locationCity(address);
  if(city==='台北市')return 'taipei';
  if(city==='新北市')return 'new_taipei';
  return 'other';
}
function serviceJurisdictionSnapshot({explicit=null,recipient=null,source='booking'}={}){
  const normalized=BOOKING_SERVICE_JURISDICTIONS.includes(String(explicit||''))?String(explicit):null;
  const residenceAddress=recipient?String(CareRecipient?.primaryAddress?.(recipient)||'').trim():'';
  const jurisdiction=normalized||serviceJurisdictionFromResidenceAddress(residenceAddress);
  return {jurisdiction,source:normalized?'explicit_context':(residenceAddress?'care_recipient_residence':source),residenceCity:locationCity(residenceAddress)||null,capturedAt:nowISO()};
}
function applyServiceJurisdictionSnapshot(booking,recipient,{explicit=null,source='booking'}={}){
  if(!booking)return booking;
  const snap=serviceJurisdictionSnapshot({explicit:explicit??booking.serviceJurisdiction,recipient,source});
  booking.serviceJurisdiction=snap.jurisdiction;
  booking.serviceJurisdictionSource=snap.source;
  booking.serviceJurisdictionResidenceCity=snap.residenceCity;
  booking.serviceJurisdictionCapturedAt=booking.serviceJurisdictionCapturedAt||snap.capturedAt;
  return booking;
}
function locationDistrict(address=''){
  const compact=canonicalLocationText(address),city=locationCity(compact),rest=city&&compact.startsWith(city)?compact.slice(city.length):compact;
  return rest.match(/([^市縣]{1,6}(?:區|鄉|鎮|市))/)?.[1]||'';
}
function locationRoad(address=''){
  return canonicalLocationText(address).match(/([^區鄉鎮市]{1,18}(?:路|街|大道))/)?.[1]||'';
}
function makeLocationSnapshot(addressText='',accessNote='',existing=null){
  const text=String(addressText||'').trim(),canonical=canonicalLocationText(text);
  return {
    schemaVersion:BOOKING_LOCATION_SCHEMA_VERSION,
    addressText:text,
    normalizedAddress:canonical,
    city:locationCity(text),
    district:locationDistrict(text),
    road:locationRoad(text),
    lat:Number.isFinite(Number(existing?.lat))?Number(existing.lat):null,
    lng:Number.isFinite(Number(existing?.lng))?Number(existing.lng):null,
    placeId:String(existing?.placeId||'').trim()||null,
    accessNote:String(accessNote??existing?.accessNote??'').trim().slice(0,300)
  };
}
function locationSnapshotAddress(location,fallback=''){ return String(location?.addressText||fallback||'').trim(); }
function localDateTimeParts(date){
  const d=date instanceof Date?date:new Date(date); if(Number.isNaN(d.getTime()))return {date:'',time:''};
  return {date:d.toLocaleDateString('sv-SE'),time:d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false})};
}
function bookingLocationsFromLegacy(value={},existing=null){
  return {
    schemaVersion:BOOKING_LOCATION_SCHEMA_VERSION,
    pickup:makeLocationSnapshot(value.pickupAddress||existing?.pickup?.addressText||'',value.pickupAccessNote||existing?.pickup?.accessNote||'',existing?.pickup),
    dropoff:makeLocationSnapshot(value.destination||existing?.dropoff?.addressText||'',value.destinationAccessNote||existing?.dropoff?.accessNote||'',existing?.dropoff)
  };
}
function bookingLegsFromLegacy(bookingId,value={},locations=null,existingLegs=null){
  const loc=locations||bookingLocationsFromLegacy(value),old=Array.isArray(existingLegs)?existingLegs:[];
  const oldByDirection=new Map(old.map(l=>[l.direction,l]));
  const outboundAt=(value.pickupDate&&value.pickupTime)?new Date(`${value.pickupDate}T${value.pickupTime}:00`):null;
  const returnAt=(value.returnDate&&value.returnTime)?new Date(`${value.returnDate}T${value.returnTime}:00`):null;
  const makeLeg=(direction,sequence,label,at,pickup,dropoff)=>{
    const prev=oldByDirection.get(direction)||{};
    return {
      id:prev.id||`${bookingId}_${direction}`,
      schemaVersion:BOOKING_LEG_SCHEMA_VERSION,
      sequence,direction,label,
      status:prev.status||BOOKING_LEG_STATUS.PENDING,
      requestedPickupAt:at&&!Number.isNaN(at.getTime())?at.toISOString():null,
      pickup:deepClone(pickup),dropoff:deepClone(dropoff),
      tripId:prev.tripId||null,
      scheduledOrganizationId:prev.scheduledOrganizationId||null,
      scheduledAt:prev.scheduledAt||null
    };
  };
  const legs=[makeLeg('outbound',1,'去程',outboundAt,loc.pickup,loc.dropoff)];
  if(String(value.tripType||'單程')==='來回') legs.push(makeLeg('return',2,'回程',returnAt,loc.dropoff,loc.pickup));
  return legs;
}
function scheduledBookingLegs(booking){ return (booking?.legs||[]).filter(l=>l.status===BOOKING_LEG_STATUS.SCHEDULED&&l.tripId); }
function pendingBookingLegs(booking){ return (booking?.legs||[]).filter(l=>l.status===BOOKING_LEG_STATUS.PENDING); }


function createSafeStorage(kind){
  const memory=new Map();
  let nativeStore=null;
  let persistent=true;
  let lastError=null;
  let writeFailures=0;
  const fail=(error)=>{persistent=false;lastError=String(error?.name||error?.message||error||'StorageError');nativeStore=null;};
  try{
    nativeStore=window[kind];
    const probe=`__care_ride_probe_${kind}__`;
    nativeStore.setItem(probe,'1');
    nativeStore.removeItem(probe);
  }catch(error){
    fail(error);
    console.warn(`[Storage] ${kind} unavailable; using in-memory fallback.`, error?.name||error);
  }
  return Object.freeze({
    get persistent(){ return persistent; },
    get lastError(){ return lastError; },
    get writeFailures(){ return writeFailures; },
    get mode(){ return persistent?'persistent':'memory_fallback'; },
    getItem(key){
      if(nativeStore){
        try{return nativeStore.getItem(key);}catch(error){fail(error);}
      }
      return memory.has(String(key))?memory.get(String(key)):null;
    },
    setItem(key,value){
      const k=String(key),v=String(value);
      memory.set(k,v);
      if(nativeStore){
        try{nativeStore.setItem(k,v);lastError=null;return true;}catch(error){writeFailures++;fail(error);}
      }
      return false;
    },
    removeItem(key){
      const k=String(key);memory.delete(k);
      if(nativeStore){try{nativeStore.removeItem(k);return true;}catch(error){writeFailures++;fail(error);}}
      return false;
    },
    clear(){
      memory.clear();
      if(nativeStore){try{nativeStore.clear();return true;}catch(error){writeFailures++;fail(error);}}
      return false;
    }
  });
}
const LocalStore=createSafeStorage('localStorage');
const SessionStore=createSafeStorage('sessionStorage');


function isValidCompanyPhone(value=''){ const digits=digitsOnly(value); return /^02\d{8}$/.test(digits)||/^09\d{8}$/.test(digits); }
function canonicalCompanyPhone(value=''){ const digits=digitsOnly(value); if(/^02\d{8}$/.test(digits)) return `02-${digits.slice(2)}`; if(/^09\d{8}$/.test(digits)) return digits; return String(value||'').trim(); }

function seedDB(){
  const createdAt=nowISO();
  return {
    schemaVersion: APP_CONFIG.schemaVersion,
    version: APP_CONFIG.version,
    updatedAt: createdAt,
    organizations:[{id:APP_CONFIG.requesterOrganizationId,type:'requester_hub',name:'需求者組織',taxId:'',contactPhone:'',active:true,systemManaged:true,createdAt}],
    memberships:[],
    users:[],
    fleets:[],drivers:[],externalIdentities:[],membershipEvents:[],
    vehicleAssignments:[],vehicles:[],careRecipients:[],careRecipientRelations:[],careRecipientEvents:[],careRecipientMergeEvents:[],bookings:[],bookingEvents:[],bookingRevisions:[],dispatchPlans:[],trips:[],tripEvents:[],tripOfflineQueue:[],issues:[],systemReports:[],events:[],notifications:[],serviceProofs:[],kpiDaily:[],quoteSnapshots:[],cancellations:[],telemetryEvents:[],benefitRulesets:[],benefitRulesetEvents:[],benefitAssessments:[],benefitAssessmentEvents:[],benefitLatestInfo:null,benefitLatestEstimateRuns:[],
    integration:{googleDatabaseLastSyncAt:null,lastSyncAt:null,lastSyncStatus:'尚未完成正式資料同步',lastSyncDetails:[]}
  };
}

function repairCareRecipientReferencesInDb(db,{source='load'}={}){
  db.users=Array.isArray(db.users)?db.users:[];
  db.careRecipients=Array.isArray(db.careRecipients)?db.careRecipients:[];
  db.careRecipientRelations=Array.isArray(db.careRecipientRelations)?db.careRecipientRelations:[];
  db.bookings=Array.isArray(db.bookings)?db.bookings:[];
  db.notifications=Array.isArray(db.notifications)?db.notifications:[];
  db.benefitAssessments=Array.isArray(db.benefitAssessments)?db.benefitAssessments:[];

  const stats={relationsUserRepaired:0,relationsRecipientRepaired:0,duplicateRelationsRevoked:0,primaryContactsNormalized:0,bookingRecipientRepaired:0,notificationRecipientRepaired:0,benefitRecipientRepaired:0,orphanRelationsRemoved:0,unresolved:[]};
  const userById=()=>new Map(db.users.map(u=>[u.id,u]));
  const recipientById=()=>new Map(db.careRecipients.map(r=>[r.id,r]));
  let users=userById(),recipients=recipientById();
  const usersByPhone=new Map();
  db.users.forEach(u=>{const p=digitsOnly(u.phone||'');if(!p)return;const rows=usersByPhone.get(p)||[];rows.push(u);usersByPhone.set(p,rows);});
  const uniqueUserByPhone=(phone)=>{const rows=usersByPhone.get(digitsOnly(phone||''))||[];return rows.length===1?rows[0]:null;};
  const mergedTarget=(recipientId)=>{
    const seen=new Set();let current=recipients.get(recipientId);
    while(current?.status==='merged'&&current.governance?.mergedIntoRecipientId&&!seen.has(current.id)){
      seen.add(current.id);current=recipients.get(current.governance.mergedIntoRecipientId);
    }
    return current?.id||null;
  };
  const selfRecipientForUser=(userId)=>db.careRecipientRelations.find(r=>r.userId===userId&&r.status!=='revoked'&&r.relationship==='self'&&recipients.has(r.recipientId))?.recipientId||null;
  const recipientCandidateFromBooking=(b)=>{
    const requestedUserId=b?.requestedByUserId||b?.userId||null;
    if(requestedUserId){const selfId=selfRecipientForUser(requestedUserId);if(selfId)return selfId;}
    const phone=digitsOnly(b?.phone||b?.contactPhone||'');
    if(phone){const matches=db.careRecipients.filter(r=>r.status!=='merged'&&digitsOnly(r.contacts?.primaryPhone||'')===phone);if(matches.length===1)return matches[0].id;}
    return null;
  };

  db.careRecipientRelations.forEach(rel=>{
    if(recipients.has(rel.recipientId)){
      const target=mergedTarget(rel.recipientId);
      if(target&&target!==rel.recipientId){rel.recipientId=target;rel.updatedAt=nowISO();rel.repairNote='V12.25.14 merged recipient target repair';stats.relationsRecipientRepaired++;}
      return;
    }
    const m=String(rel.id||'').match(/^crrel_demo_expanded_(\d{2})$/);
    const inferred=m?`rec_demo_expanded_${m[1]}`:null;
    if(inferred&&recipients.has(inferred)){rel.recipientId=inferred;rel.updatedAt=nowISO();rel.repairNote='V12.25.14 demo recipient id repair';stats.relationsRecipientRepaired++;}
  });

  db.careRecipientRelations.forEach(rel=>{
    if(users.has(rel.userId))return;
    const recipient=recipients.get(rel.recipientId),candidate=recipient?uniqueUserByPhone(recipient.contacts?.primaryPhone):null;
    if(candidate){rel.userId=candidate.id;rel.updatedAt=nowISO();rel.repairNote='V12.25.14 userId repaired by unique primary phone';stats.relationsUserRepaired++;}
  });

  recipients=recipientById();users=userById();
  db.careRecipientRelations=db.careRecipientRelations.filter(rel=>{
    if(!recipients.has(rel.recipientId)){
      stats.orphanRelationsRemoved++;stats.unresolved.push(`移除孤兒 Relation ${rel.id}：recipient ${rel.recipientId} 不存在`);return false;
    }
    if(!users.has(rel.userId)) stats.unresolved.push(`Relation ${rel.id}：user ${rel.userId} 仍不存在`);
    return true;
  });

  const activePair=new Map();
  db.careRecipientRelations.filter(r=>r.status!=='revoked').sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0)).forEach(rel=>{
    const key=`${rel.userId}:${rel.recipientId}`,kept=activePair.get(key);
    if(!kept){activePair.set(key,rel);return;}
    kept.canBook=!!(kept.canBook||rel.canBook);kept.canManageProfile=!!(kept.canManageProfile||rel.canManageProfile);kept.isPrimaryContact=!!(kept.isPrimaryContact||rel.isPrimaryContact);
    if(kept.relationship!=='self'&&rel.relationship==='self')kept.relationship='self';
    rel.status='revoked';rel.revokedAt=rel.revokedAt||nowISO();rel.updatedAt=nowISO();rel.repairNote='V12.25.14 duplicate active relation auto-revoked';stats.duplicateRelationsRevoked++;
  });

  const selfByUser=new Map(),selfByRecipient=new Map();
  db.careRecipientRelations.filter(r=>r.status!=='revoked'&&r.relationship==='self').sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0)).forEach(rel=>{
    const userConflict=selfByUser.has(rel.userId)&&selfByUser.get(rel.userId)!==rel.recipientId;
    const recipientConflict=selfByRecipient.has(rel.recipientId)&&selfByRecipient.get(rel.recipientId)!==rel.userId;
    if(userConflict||recipientConflict){rel.relationship='other';rel.canBook=false;rel.canManageProfile=false;rel.isPrimaryContact=false;rel.updatedAt=nowISO();rel.repairNote='V12.25.14 self 1:1 conflict downgraded';return;}
    selfByUser.set(rel.userId,rel.recipientId);selfByRecipient.set(rel.recipientId,rel.userId);rel.canBook=true;rel.canManageProfile=true;
  });

  const groups=new Map();
  db.careRecipientRelations.filter(r=>r.status!=='revoked').forEach(rel=>{const rows=groups.get(rel.recipientId)||[];rows.push(rel);groups.set(rel.recipientId,rows);});
  groups.forEach(rows=>{
    if(!rows.length)return;
    const before=rows.filter(r=>r.isPrimaryContact).map(r=>r.id).join('|');
    const chosen=rows.find(r=>r.relationship==='self')||rows.find(r=>r.isPrimaryContact&&r.canManageProfile)||rows.find(r=>r.canManageProfile)||rows[0];
    rows.forEach(r=>r.isPrimaryContact=r.id===chosen.id);chosen.canManageProfile=true;
    const after=rows.filter(r=>r.isPrimaryContact).map(r=>r.id).join('|');if(before!==after)stats.primaryContactsNormalized++;
  });

  db.bookings.forEach(b=>{
    if(!b.recipientId)return;
    if(recipients.has(b.recipientId)){const target=mergedTarget(b.recipientId);if(target&&target!==b.recipientId){b.recipientId=target;b.updatedAt=nowISO();stats.bookingRecipientRepaired++;}return;}
    const candidate=recipientCandidateFromBooking(b);if(candidate){b.recipientId=candidate;b.updatedAt=nowISO();stats.bookingRecipientRepaired++;}else stats.unresolved.push(`預約 ${b.id}：服務對象 ${b.recipientId} 不存在`);
  });
  const bookingById=new Map(db.bookings.map(b=>[b.id,b]));
  db.notifications.forEach(n=>{
    if(!n.recipientId)return;
    if(recipients.has(n.recipientId)){const target=mergedTarget(n.recipientId);if(target&&target!==n.recipientId){n.recipientId=target;stats.notificationRecipientRepaired++;}return;}
    const b=bookingById.get(n.payload?.bookingId||n.bookingId||'');if(b?.recipientId&&recipients.has(b.recipientId)){n.recipientId=b.recipientId;stats.notificationRecipientRepaired++;}else stats.unresolved.push(`Notification ${n.id}：recipient ${n.recipientId} 不存在`);
  });
  db.benefitAssessments.forEach(x=>{
    if(!x.recipientId)return;
    if(recipients.has(x.recipientId)){const target=mergedTarget(x.recipientId);if(target&&target!==x.recipientId){x.recipientId=target;stats.benefitRecipientRepaired++;}return;}
    stats.unresolved.push(`BenefitAssessment ${x.id}：recipient ${x.recipientId} 不存在`);
  });

  db.dataRepairLog=Array.isArray(db.dataRepairLog)?db.dataRepairLog:[];
  const changed=Object.entries(stats).some(([k,v])=>k!=='unresolved'&&Number(v)>0);
  if(changed||stats.unresolved.length){
    db.dataRepairLog.unshift({id:uid('repair'),module:'care_recipient',version:'12.26.1',source,stats:deepClone(stats),createdAt:nowISO()});
    if(db.dataRepairLog.length>30)db.dataRepairLog.length=30;
  }
  return stats;
}


const AUTHORITATIVE_STATE_COLLECTIONS=Object.freeze([
  'organizations','users','memberships','membershipEvents','drivers','vehicles','careRecipients','careRecipientRelations','careRecipientEvents','careRecipientMergeEvents',
  'bookings','bookingEvents','bookingRevisions','dispatchPlans','trips','tripEvents','issues','systemReports','notifications',
  'benefitRulesets','benefitRulesetEvents','benefitAssessments','benefitAssessmentEvents','benefitLatestEstimateRuns',
  'serviceProofs','quoteSnapshots','cancellations','telemetryEvents'
]);
// 這三個集合有自己的 typed 資料表，寫入走 identity-write 而不是 state-mutate。
// users 不在裡面：建立帳號只能透過註冊或建立員工的端點。
const IDENTITY_WRITE_COLLECTIONS=new Set(['organizations','memberships','drivers']);
const AUTHORITATIVE_QUEUE_KEY=`${APP_CONFIG.storageKey}:authoritativeQueue:v1`;
const authoritativeQueue=new Map();
let authoritativeFlushTimer=null,authoritativeFlushInFlight=false,authoritativeLastError='',authoritativeLastAckAt=null;
function authoritativeRecordId_(record){return String(record?.id||'').trim();}
function authoritativeSanitizeRecord_(collection,record){
  const out=deepClone(record||{});
  if(collection==='users')for(const key of ['password','passwordHash','passwordUpdatedAt','credential','credentialHash','salt','sessionToken','accessToken','refreshToken','idToken'])delete out[key];
  return out;
}
function authoritativeCollectionMap_(state,collection){const map=new Map();(Array.isArray(state?.[collection])?state[collection]:[]).forEach(r=>{const id=authoritativeRecordId_(r);if(id)map.set(id,r);});return map;}
function authoritativeDiff_(before,after){
  const changes=[];AUTHORITATIVE_STATE_COLLECTIONS.forEach(collection=>{
    const a=authoritativeCollectionMap_(before,collection),b=authoritativeCollectionMap_(after,collection);
    b.forEach((record,id)=>{const old=a.get(id),safeOld=old?authoritativeSanitizeRecord_(collection,old):null,safeRecord=authoritativeSanitizeRecord_(collection,record);if(!old||JSON.stringify(safeOld)!==JSON.stringify(safeRecord))changes.push({collection,id,record:safeRecord,previousRecord:safeOld,deleted:false,expectedRevision:collection==='trips'?(old?Math.max(0,Number(old.revision)||0):0):undefined});});
    a.forEach((record,id)=>{if(!b.has(id))changes.push({collection,id,record:authoritativeSanitizeRecord_(collection,record),previousRecord:authoritativeSanitizeRecord_(collection,record),deleted:true,expectedRevision:collection==='trips'?Math.max(0,Number(record.revision)||0):undefined});});
  });return changes;
}
function authoritativeProduction_(){return true;}
function authoritativeCurrentActor_(){try{return Identity?.currentUser?.()?.id||null;}catch{return null;}}
function authoritativePersistQueue_(){
  try{LocalStore.setItem(AUTHORITATIVE_QUEUE_KEY,JSON.stringify([...authoritativeQueue.values()]));}catch{}
  updateAuthoritativeWriteUI_();
}
function authoritativeLoadQueue_(){
  try{const rows=JSON.parse(LocalStore.getItem(AUTHORITATIVE_QUEUE_KEY)||'[]');if(Array.isArray(rows))rows.forEach(x=>{if(x?.collection&&x?.id)authoritativeQueue.set(`${x.actorUserId||''}|${x.collection}|${x.id}`,x);});}catch{}
}
function authoritativePendingForCurrentActor_(){const actor=authoritativeCurrentActor_();return [...authoritativeQueue.values()].filter(x=>x.actorUserId===actor);}
function authoritativeRollbackRows_(rows){
  if(!rows?.length||!store?.state)return;
  store.mutate(db=>{for(const row of rows){const list=Array.isArray(db[row.collection])?db[row.collection]:null;if(!list)continue;const idx=list.findIndex(x=>authoritativeRecordId_(x)===row.id);if(row.previousRecord){const restored=deepClone(row.previousRecord);if(idx>=0)list[idx]=restored;else list.push(restored);}else if(idx>=0)list.splice(idx,1);}}, {remote:false,reason:'authoritative_rollback'});
  try{render?.();}catch{}
}
function authoritativeSuccessToast_(message){const text=String(message||'');return /已|成功|完成|建立|新增|儲存|更新|送出|指派|接手|撤銷|退役|刪除|停用|啟用|標記|改派/.test(text)&&!/失敗|錯誤|無法|不能|找不到|沒有權限|阻擋|衝突|取消操作/.test(text);}
function updateAuthoritativeWriteUI_(){
  const el=document.getElementById('backendWriteHealthBanner');if(!el)return;
  if(!authoritativeProduction_()){el.classList.add('hidden');return;}
  if(authoritativeLastError){el.classList.remove('hidden');el.style.background='#fff0f0';el.style.borderColor='#efb7bc';el.style.color='#9c2430';el.textContent=`正式資料尚未完成後端確認：${authoritativeLastError}。畫面變更已保存在待同步佇列，請保持網路連線；重新整理後會以伺服器已確認的資料為準。`;return;}
  const actor=authoritativeCurrentActor_(),pending=[...authoritativeQueue.values()].filter(x=>!x.actorUserId||x.actorUserId===actor).length;
  if(pending){el.classList.remove('hidden');el.style.background='#fff7e8';el.style.borderColor='#efc27d';el.style.color='#7b520d';el.textContent=`正在將 ${pending} 筆操作寫入正式資料庫；完成前請不要關閉頁面。`;return;}
  el.classList.add('hidden');el.textContent='';
}
async function authoritativeFlush_(){
  if(authoritativeFlushInFlight){
    const started=Date.now();while(authoritativeFlushInFlight&&Date.now()-started<12000)await new Promise(resolve=>setTimeout(resolve,25));
    if(authoritativeFlushInFlight)return {ok:false,error:'正式資料庫寫入仍在處理中'};
    if(authoritativeLastError)return {ok:false,error:authoritativeLastError};
  }
  if(!authoritativeProduction_())return {ok:true,skipped:true};
  if(typeof navigator!=='undefined'&&navigator.onLine===false){updateAuthoritativeWriteUI_();return {ok:false,offline:true,pending:true,error:'目前離線，尚未寫入正式資料庫'};}
  const token=typeof backendAuthToken==='function'?backendAuthToken():'';const actor=authoritativeCurrentActor_();if(!token||!actor)return {ok:false,skipped:true};
  const rows=[...authoritativeQueue.values()].filter(x=>x.actorUserId===actor).slice(0,100);if(!rows.length){updateAuthoritativeWriteUI_();return {ok:true,count:0};}
  authoritativeFlushInFlight=true;updateAuthoritativeWriteUI_();
  try{
    // 身分資料（組織／成員資格／司機）走專屬端點：它們有 typed 資料表，登入與
    // RLS 都依賴，不能從通用的 app_state 管道寫入。兩邊分開送，任一邊失敗就整批
    // 視為失敗、留在佇列裡重試。
    const payload=rows.map(({collection,id,record,deleted,expectedRevision})=>({collection,id,record,deleted,expectedRevision}));
    const identityRows=payload.filter(x=>IDENTITY_WRITE_COLLECTIONS.has(x.collection));
    const stateRows=payload.filter(x=>!IDENTITY_WRITE_COLLECTIONS.has(x.collection));
    const post=async(url,changes)=>{
      if(!changes.length)return;
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},credentials:'same-origin',cache:'no-store',body:JSON.stringify({changes})});
      const result=await response.json().catch(()=>null);
      if(!response.ok||!result?.ok)throw new Error(result?.error?.message||`正式資料寫入失敗（HTTP ${response.status}）`);
    };
    await post(APP_CONFIG.identityWriteUrl,identityRows);
    await post(APP_CONFIG.stateMutateUrl,stateRows);
    rows.forEach(x=>authoritativeQueue.delete(`${x.actorUserId}|${x.collection}|${x.id}`));authoritativeLastError='';authoritativeLastAckAt=nowISO();authoritativePersistQueue_();
    if(authoritativeQueue.size)setTimeout(()=>authoritativeFlush_(),20);return {ok:true,count:rows.length};
  }catch(error){
    authoritativeLastError=String(error?.message||error||'未知錯誤');
    authoritativeRollbackRows_(rows);
    rows.forEach(x=>authoritativeQueue.delete(`${x.actorUserId}|${x.collection}|${x.id}`));
    authoritativePersistQueue_();return {ok:false,error:authoritativeLastError,rolledBack:true};
  }
  finally{authoritativeFlushInFlight=false;updateAuthoritativeWriteUI_();}
}
function authoritativeDiscardActorQueue_(actorUserId){
  if(!actorUserId)return 0;let removed=0;[...authoritativeQueue.entries()].forEach(([key,row])=>{if(row?.actorUserId===actorUserId){authoritativeQueue.delete(key);removed++;}});authoritativePersistQueue_();authoritativeLastError='';updateAuthoritativeWriteUI_();return removed;
}
// 司機執行自己的行程時，行程、行程事件與異常改由 trip-execute 端點逐一驗證寫入
// （見 TripSyncAdapter）。這些變更照舊整筆送 state-mutate 只會被 RLS 拒絕後回滾，
// 所以在排入一般寫入佇列之前就排除。調度／負責人的變更不受影響。
function tripDriverExecutionOwned_(trip,actorUserId=authoritativeCurrentActor_()){
  try{
    if(!trip||!actorUserId)return false;
    const driver=Organization?.driver?.(trip.driverId);
    if(!driver||driver.userId!==actorUserId)return false;
    return !Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId);
  }catch{return false;}
}
function authoritativeDriverExecutionChange_(change){
  if(!change||!['trips','tripEvents','issues'].includes(change.collection))return false;
  const tripId=change.collection==='trips'?change.id:change.record?.tripId;
  const trip=(store?.state?.trips||[]).find(t=>t.id===tripId)||(change.collection==='trips'?change.record:null);
  return tripDriverExecutionOwned_(trip);
}
function authoritativeQueueChanges_(changes){
  if(!authoritativeProduction_()||!changes?.length)return;
  changes=changes.filter(c=>!authoritativeDriverExecutionChange_(c));if(!changes.length)return;
  const actor=authoritativeCurrentActor_();const token=typeof backendAuthToken==='function'?backendAuthToken():'';if(!actor||!token)return;
  changes.forEach(c=>{const key=`${actor}|${c.collection}|${c.id}`,prior=authoritativeQueue.get(key),next={...c,record:authoritativeSanitizeRecord_(c.collection,c.record),previousRecord:prior?.previousRecord!==undefined?prior.previousRecord:c.previousRecord,expectedRevision:prior?.expectedRevision!==undefined?prior.expectedRevision:c.expectedRevision,actorUserId:actor,queuedAt:prior?.queuedAt||nowISO()};authoritativeQueue.set(key,next);});authoritativePersistQueue_();
  clearTimeout(authoritativeFlushTimer);authoritativeFlushTimer=setTimeout(()=>authoritativeFlush_(),25);
}
function clearProductionSensitiveCache_(){
  if(!authoritativeProduction_())return;
  const clear=['organizations','users','memberships','externalIdentities','membershipEvents','drivers','vehicles','careRecipients','careRecipientRelations','careRecipientEvents','careRecipientMergeEvents','bookings','bookingEvents','bookingRevisions','dispatchPlans','trips','tripEvents','issues','systemReports','notifications','benefitAssessments','benefitAssessmentEvents','serviceProofs','quoteSnapshots','cancellations','telemetryEvents','kpiDaily'];
  clear.forEach(k=>{if(Array.isArray(store.state[k]))store.state[k]=[];});store.save();
}
authoritativeLoadQueue_();
window.addEventListener('online',()=>{authoritativeLastError='';authoritativeFlush_();});
window.addEventListener('beforeunload',()=>{try{authoritativePersistQueue_();}catch{}});

class Store {
  #state;
  #listeners=new Set();
  #recoveryInfo=null;
  #lastSavePersistent=true;
  #saveTimer=null;
  #dirty=false;

  constructor(){ this.#state=this.load(); }
  load(){
    // 不再從 localStorage 還原整份資料庫。權威資料在 Postgres：開啟頁面時先給
    // 一個空結構，登入之後由 AppStateDatabase.loadAll() 拉回這個身分看得到的
    // 資料。這樣做順便解掉三個舊問題：整包鏡像撐爆 localStorage、本機留著一份
    // 會過期的資料、以及舊版 schema 遷移那一長串永遠要維護的相容程式碼。
    this.#recoveryInfo=null;
    return seedDB();
  }
  get state(){ return this.#state; }
  get recoveryInfo(){ return this.#recoveryInfo?deepClone(this.#recoveryInfo):null; }
  get storageHealth(){ return {persistent:LocalStore.persistent,lastSavePersistent:this.#lastSavePersistent,lastError:LocalStore.lastError,writeFailures:LocalStore.writeFailures,recovery:!!this.#recoveryInfo?.active}; }
  save({immediate=false}={}){
    this.#state.updatedAt=nowISO();
    if(this.#recoveryInfo?.active){
      this.#lastSavePersistent=false;
      this.#listeners.forEach(fn=>fn(this.#state));
      try{updateStorageHealthUI();}catch{}
      return false;
    }
    this.#dirty=true;
    const persist=()=>{
      this.#saveTimer=null;
      if(!this.#dirty)return this.#lastSavePersistent;
      // 整份資料庫不再寫進 localStorage。權威資料在 Postgres，本機只留
      // 「還沒送出的佇列」；把整包鏡像存在瀏覽器正是 QuotaExceededError 的
      // 來源，而且離線時那份鏡像也只會是過期資料。
      this.#lastSavePersistent=true;
      this.#dirty=false;
      try{updateStorageHealthUI();}catch{}
      return this.#lastSavePersistent;
    };
    if(immediate){
      if(this.#saveTimer){clearTimeout(this.#saveTimer);this.#saveTimer=null;}
      persist();
    }else{
      if(this.#saveTimer)clearTimeout(this.#saveTimer);
      this.#saveTimer=setTimeout(persist,80);
    }
    this.#listeners.forEach(fn=>fn(this.#state));
    return LocalStore.persistent;
  }
  flushLocal(){ return this.save({immediate:true}); }
  mutate(mutator,options={}){ const capture=options?.remote!==false&&authoritativeProduction_()&&typeof backendAuthToken==='function'&&!!backendAuthToken()&&!!authoritativeCurrentActor_(); const before=capture?deepClone(this.#state):null; mutator(this.#state); this.save(); if(capture)authoritativeQueueChanges_(authoritativeDiff_(before,this.#state)); return this.#state; }
  async flushAuthoritative(){ return authoritativeFlush_(); }
  refreshFromStorage(){
    // 本機不再保存整份資料庫，所以沒有東西可以重新讀取。
    // 要拿到最新資料請呼叫 AppStateDatabase.loadAll()。
    return this.#state;
  }
  reset(emit=true){
    this.#recoveryInfo=null;
    this.#state=seedDB();
    this.#lastSavePersistent=true;
    if(emit) this.#listeners.forEach(fn=>fn(this.#state));
    try{updateStorageHealthUI();}catch{}
    return this.#state;
  }
  subscribe(fn){ this.#listeners.add(fn); return ()=>this.#listeners.delete(fn); }
}

const store = new Store();
window.addEventListener('pagehide',()=>{try{store.flushLocal();}catch{}},{capture:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){try{store.flushLocal();}catch{}}},{passive:true});

function updateStorageHealthUI(){
  const el=document.getElementById('storageHealthBanner');if(!el)return;
  const recovery=store?.recoveryInfo||null,health=store?.storageHealth||{};
  if(recovery?.active){
    el.classList.remove('hidden');el.style.background='#fff0f0';el.style.borderColor='#efb7bc';el.style.color='#9c2430';
    el.textContent=`資料修復模式：原始資料沒有被覆寫。${recovery.backupKey?` 已建立 Recovery Backup：${recovery.backupKey}。`:''}目前修改只存在記憶體，請先匯出／修復資料後再繼續正式操作。原因：${recovery.reason}`;return;
  }
  if(!health.persistent||health.lastSavePersistent===false){
    el.classList.remove('hidden');el.style.background='#fff7e8';el.style.borderColor='#efc27d';el.style.color='#7b520d';
    el.textContent=`本機儲存目前不可用（${health.lastError||'Storage unavailable'}）。系統仍可操作，但尚未同步到伺服器的本機快取可能在重新整理或關閉頁面後消失。`;return;
  }
  el.classList.add('hidden');el.textContent='';
}
setTimeout(updateStorageHealthUI,0);

let Audit, SystemReport, Identity, CloudIdentity, LoginSecurity, Organization, CareRecipient, Booking, Dispatch, Trip, Notification, Benefit, Analytics;


function sharedBookingEffectiveNeeds(booking){
  try{return Booking?.effectiveServiceNeeds?.(booking)||{};}catch{return {};}
}
function bookingCompanionUnits(booking){return Math.max(0,Number(sharedBookingEffectiveNeeds(booking).companions||0)||0);}
function bookingPassengerUnits(booking){return 1+bookingCompanionUnits(booking);}
function bookingWheelchairUnits(booking){const n=sharedBookingEffectiveNeeds(booking);return /輪椅/.test(`${n.aidNeed||''} ${n.specialNeed||''}`)?1:0;}

function sharedTripStopAddress(stop){return stop?.address||stop?.destination||'';}
function sharedTripOperationalStops(trip){
  const dispatchStops=Array.isArray(trip?.dispatchStops)?trip.dispatchStops.filter(s=>['pickup','dropoff'].includes(s?.type)):[];
  if(dispatchStops.length)return dispatchStops;
  return (trip?.steps||[]).filter(s=>['pickup','dropoff'].includes(s?.type)).map(s=>({type:s.type,address:s.destination,destination:s.destination,at:s.scheduledAt}));
}
function tripFirstPickupAddress(trip){return sharedTripStopAddress(sharedTripOperationalStops(trip).find(s=>s.type==='pickup'))||trip?.pickupAddress||'';}
function tripLastDropoffAddress(trip){return sharedTripStopAddress([...sharedTripOperationalStops(trip)].reverse().find(s=>s.type==='dropoff'))||trip?.dropoffAddress||'';}


{
Audit = {
  log(action, detail, context={}){
    const event={id:uid('evt'),at:nowISO(),action,detail,...context};
    store.mutate(db=>{
      db.events.unshift(event);
      if(db.events.length>500) db.events.length=500;
    });
    return event;
  }
};
}


{
SystemReport = {
  create({organizationId,userId,role,category,title,detail}){
    if(!userId||!Identity?.canUser?.(userId,'system_report.create',organizationId||APP_CONFIG.requesterOrganizationId)) return {ok:false,error:'你沒有系統問題回報權限'};
    if(!title?.trim()||!detail?.trim()) return {ok:false,error:'請填寫問題標題與說明'};
    const report={id:uid('sysr'),organizationId:organizationId||null,userId:userId||null,role:role||null,category:category||'其他',title:title.trim(),detail:detail.trim(),status:'open',createdAt:nowISO(),resolvedAt:null,resolvedBy:null};
    store.mutate(db=>{db.systemReports=db.systemReports||[];db.systemReports.unshift(report);});
    Audit.log('system_report_created',`系統問題回報：${report.title}`,{organizationId:report.organizationId,actorUserId:userId,systemReportId:report.id});
    return {ok:true,report};
  },
  listAll(){ return [...(store.state.systemReports||[])]; },
  resolve(id,userId){
    const target=(store.state.systemReports||[]).find(r=>r.id===id); if(!target) return {ok:false,error:'找不到問題回報'};
    if(!userId||!Identity?.canUser?.(userId,'platform.report.manage',null)) return {ok:false,error:'只有平台超級管理者可以處理系統問題回報'};
    store.mutate(db=>{const r=(db.systemReports||[]).find(x=>x.id===id);r.status='resolved';r.resolvedAt=nowISO();r.resolvedBy=userId||null;});
    Audit.log('system_report_resolved',`系統問題已處理：${target.title}`,{organizationId:target.organizationId,actorUserId:userId,systemReportId:id});
    return {ok:true};
  }
};
}


{
const CARE_RECIPIENT_SCHEMA_VERSION=4;
const CARE_RECIPIENT_INTERNAL_TOKEN=Symbol('careRecipientInternal');
const CARE_RECIPIENT_STATUS_VALUES=Object.freeze(['active','archived','merged']);
const CARE_RECIPIENT_WALKING_VALUES=Object.freeze(['unknown','independent','assisted','walker','wheelchair']);
const CARE_RECIPIENT_WHEELCHAIR_VALUES=Object.freeze(['none','manual','electric']);
const CARE_RECIPIENT_TRANSFER_VALUES=Object.freeze(['unknown','none','independent','partial','full']);
function normalizePrimaryContactInDb(db,recipientId,preferredUserId=null){
  const active=(db.careRecipientRelations||[]).filter(x=>x.recipientId===recipientId&&x.status!=='revoked');
  if(!active.length)return null;
  const chosen=active.find(x=>preferredUserId&&x.userId===preferredUserId)||active.find(x=>x.relationship==='self')||active.find(x=>x.isPrimaryContact&&x.canManageProfile)||active.find(x=>x.isPrimaryContact)||active.find(x=>x.canManageProfile)||active[0];
  active.forEach(x=>x.isPrimaryContact=x.id===chosen.id);
  chosen.canManageProfile=true;
  return chosen;
}
function normalizeRecipientPhone(v=''){ return String(v||'').replace(/\D/g,''); }
function canonicalRecipientText(v=''){ return String(v||'').replace(/臺/g,'台').replace(/[\s，,。．-]/g,'').trim().toLowerCase(); }
function recipientEmptyMobility(){ return {walkingAbility:'unknown',wheelchairType:'none',requiresAccessibleVehicle:false,requiresEscort:false,transferAssistance:'unknown',defaultAidNeed:'',defaultSpecialNeeds:''}; }
function recipientDisplayName(recipient){ return recipient?.identity?.displayName||'未命名服務對象'; }
function normalizedAddressEntries(recipientId,addresses={},legacyDefaultPickup=''){
  const entries=[];
  const add=(row,index=0)=>{
    const address=String(typeof row==='string'?row:row?.address||'').trim();if(!address)return null;
    const same=entries.find(x=>canonicalRecipientText(x.address)===canonicalRecipientText(address));if(same)return same.id;
    const id=(typeof row==='object'&&row?.id)||`addr_${recipientId}_${index+1}`;
    entries.push({id,type:(typeof row==='object'&&row?.type)||'other',label:(typeof row==='object'&&row?.label)||'地址',address});return id;
  };
  (Array.isArray(addresses?.entries)?addresses.entries:[]).forEach((x,i)=>add(x,i));
  const legacyPrimary=String(addresses?.primary||'').trim();
  const primaryId=addresses?.primaryAddressId&&entries.some(x=>x.id===addresses.primaryAddressId)?addresses.primaryAddressId:(legacyPrimary?add({id:`addr_${recipientId}_primary`,type:'home',label:'主要地址',address:legacyPrimary},entries.length):entries[0]?.id||null);
  const pickupText=String(legacyDefaultPickup||addresses?.commonPickup||'').trim();
  const defaultPickupId=addresses?.defaultPickupAddressId&&entries.some(x=>x.id===addresses.defaultPickupAddressId)?addresses.defaultPickupAddressId:(pickupText?add({id:`addr_${recipientId}_pickup`,type:'pickup',label:'預設上車地址',address:pickupText},entries.length):primaryId);
  return {entries,primaryAddressId:primaryId,defaultPickupAddressId:defaultPickupId};
}
function addressValue(addresses,id){ return addresses?.entries?.find(x=>x.id===id)?.address||''; }
function recipientPrimaryAddress(recipient){ const a=normalizedAddressEntries(recipient?.id||'unknown',recipient?.addresses||{},recipient?.servicePreferences?.defaultPickupAddress||'');return addressValue(a,a.primaryAddressId); }
function recipientDefaultPickupAddress(recipient){ const a=normalizedAddressEntries(recipient?.id||'unknown',recipient?.addresses||{},recipient?.servicePreferences?.defaultPickupAddress||'');return addressValue(a,a.defaultPickupAddressId)||addressValue(a,a.primaryAddressId); }
function normalizeEmergencyContacts(recipientId,rows=[]){ return (Array.isArray(rows)?rows:[]).map((c,i)=>({id:c?.id||`ec_${recipientId}_${i+1}`,name:String(c?.name||'').trim(),relationship:c?.relationship||'other',phone:normalizeRecipientPhone(c?.phone||''),priority:Number.isFinite(Number(c?.priority))?Math.max(1,Number(c.priority)):i+1})).filter(c=>c.name||c.phone).sort((a,b)=>a.priority-b.priority); }
function recipientPrimaryPhone(recipient){ return recipient?.contacts?.primaryPhone||''; }
function recipientDescriptor(value={}){ const isRecipient=!!value?.identity;return {id:value?.id||null,name:String(isRecipient?recipientDisplayName(value):(value.name||value.displayName||'')).trim(),phone:normalizeRecipientPhone(isRecipient?recipientPrimaryPhone(value):(value.phone||value.primaryPhone||'')),address:String(isRecipient?recipientPrimaryAddress(value):(value.pickupAddress||value.primaryAddress||value.address||'')).trim(),birthDate:String(isRecipient?(value.identity?.birthDate||''):(value.birthDate||'')).trim()}; }
function uniqueTextArray(values=[]){ return [...new Set(values.map(v=>String(v||'').trim()).filter(Boolean))]; }
function mergeText(primary='',secondary=''){ return String(primary||'').trim()||String(secondary||'').trim(); }
function mergeNotes(primary='',secondary=''){ const a=String(primary||'').trim(),b=String(secondary||'').trim();if(!a)return b;if(!b||a===b)return a;return `${a}\n${b}`; }
function actorIsSuperAdmin(userId){ return !!(store.state.users||[]).find(u=>u.id===userId&&u.active!==false&&u.platformRole==='super_admin'); }
function activeOrganizationMembership(actorUserId,organizationId,roles=[]){ return (store.state.memberships||[]).find(m=>m.userId===actorUserId&&m.organizationId===organizationId&&(m.status||'active')==='active'&&(!roles.length||roles.includes(m.role))); }
function recipientServedByOrganization(recipientId,organizationId){ return !!organizationId&&!!Booking?.hasRecipientForOrganization?.(recipientId,organizationId); }
function driverTripAccess(recipientId,actorUserId,organizationId){
  const membership=activeOrganizationMembership(actorUserId,organizationId,['driver']);if(!membership)return false;
  const driver=(store.state.drivers||[]).find(d=>d.userId===actorUserId&&d.organizationId===organizationId&&d.active!==false);if(!driver)return false;
  return !!Trip?.hasActiveRecipientForDriver?.(recipientId,organizationId,driver.id);
}
function recipientAccessMode(recipientId,{actorUserId=null,organizationId=null,purpose='profile'}={}){
  if(!recipientId||!actorUserId)return 'none';
  if(actorIsSuperAdmin(actorUserId))return 'platform_admin';
  const rel=(store.state.careRecipientRelations||[]).find(x=>x.userId===actorUserId&&x.recipientId===recipientId&&x.status!=='revoked');
  if(rel)return rel.relationship==='self'?'self':'related';
  if(organizationId){
    const staff=activeOrganizationMembership(actorUserId,organizationId,['owner','dispatcher']);
    if(staff&&(recipientServedByOrganization(recipientId,organizationId)||CareRecipient?.get?.(recipientId)?.governance?.sourceOrganizationId===organizationId))return 'organization_served';
    if(purpose==='trip'&&driverTripAccess(recipientId,actorUserId,organizationId))return 'driver_trip';
  }
  return 'none';
}
function transportReadModel(recipient,access){
  const r=deepClone(recipient);if(access==='platform_admin'||access==='self'||access==='related')return r;
  const view={id:r.id,schemaVersion:r.schemaVersion,scope:r.scope,status:r.status,identity:r.identity,contacts:r.contacts,addresses:r.addresses,mobility:r.mobility,servicePreferences:r.servicePreferences};
  if(access==='driver_trip')return {id:view.id,schemaVersion:view.schemaVersion,status:view.status,identity:{displayName:view.identity?.displayName||''},contacts:{primaryPhone:view.contacts?.primaryPhone||'',emergencyContacts:[]},addresses:view.addresses,mobility:view.mobility,servicePreferences:{defaultCompanions:view.servicePreferences?.defaultCompanions??0,notes:''}};
  return view;
}
function recipientEvent(recipientId,eventType,{actorUserId=null,detail='',changes=null,organizationId=null,relationId=null}={}){ const event={id:uid('crevt'),recipientId,eventType,actorUserId,organizationId,relationId,detail,changes,createdAt:nowISO()};store.mutate(db=>{db.careRecipientEvents=db.careRecipientEvents||[];db.careRecipientEvents.unshift(event);});return event; }
function recipientPatchSummary(before,after){
  const fields=[['姓名',before?.identity?.displayName,after?.identity?.displayName],['生日',before?.identity?.birthDate,after?.identity?.birthDate],['性別',before?.identity?.gender,after?.identity?.gender],['手機',before?.contacts?.primaryPhone,after?.contacts?.primaryPhone],['緊急聯絡人',JSON.stringify(normalizeEmergencyContacts(before?.id||'before',before?.contacts?.emergencyContacts||[]).map(({name,relationship,phone,priority})=>({name,relationship,phone,priority}))),JSON.stringify(normalizeEmergencyContacts(after?.id||'after',after?.contacts?.emergencyContacts||[]).map(({name,relationship,phone,priority})=>({name,relationship,phone,priority})))],['主要地址',recipientPrimaryAddress(before),recipientPrimaryAddress(after)],['預設上車地址',recipientDefaultPickupAddress(before),recipientDefaultPickupAddress(after)],['行動能力',before?.mobility?.walkingAbility,after?.mobility?.walkingAbility],['輪椅類型',before?.mobility?.wheelchairType,after?.mobility?.wheelchairType],['無障礙車',before?.mobility?.requiresAccessibleVehicle,after?.mobility?.requiresAccessibleVehicle],['陪同需求',before?.mobility?.requiresEscort,after?.mobility?.requiresEscort],['上下車協助',before?.mobility?.transferAssistance,after?.mobility?.transferAssistance],['固定輔具',before?.mobility?.defaultAidNeed,after?.mobility?.defaultAidNeed],['固定特殊需求',before?.mobility?.defaultSpecialNeeds,after?.mobility?.defaultSpecialNeeds],['預設陪同人數',before?.servicePreferences?.defaultCompanions,after?.servicePreferences?.defaultCompanions],['主檔備註',before?.servicePreferences?.notes,after?.servicePreferences?.notes]];
  return fields.filter(([,a,b])=>String(a??'')!==String(b??'')).map(([label,a,b])=>({field:label,from:a??'',to:b??''}));
}
function normalizeAddressPatch(recipient,patchAddresses={},patchServicePreferences={}){
  const current=normalizedAddressEntries(recipient.id,recipient.addresses||{},recipient.servicePreferences?.defaultPickupAddress||'');
  if(Array.isArray(patchAddresses?.entries))return normalizedAddressEntries(recipient.id,patchAddresses,patchServicePreferences?.defaultPickupAddress||'');
  const primaryPatch=Object.prototype.hasOwnProperty.call(patchAddresses,'primary')?String(patchAddresses.primary||'').trim():recipientPrimaryAddress(recipient);
  const pickupPatch=Object.prototype.hasOwnProperty.call(patchAddresses,'commonPickup')?String(patchAddresses.commonPickup||'').trim():(Object.prototype.hasOwnProperty.call(patchServicePreferences,'defaultPickupAddress')?String(patchServicePreferences.defaultPickupAddress||'').trim():recipientDefaultPickupAddress(recipient));
  const entries=deepClone(current.entries||[]);
  const upsert=(id,type,label,address)=>{const value=String(address||'').trim();if(!value)return null;let row=entries.find(x=>x.id===id);if(!row){const same=entries.find(x=>canonicalRecipientText(x.address)===canonicalRecipientText(value));if(same)return same.id;row={id,type,label,address:value};entries.push(row);}else Object.assign(row,{type,label,address:value});return row.id;};
  const primaryId=upsert(current.primaryAddressId||`addr_${recipient.id}_primary`,'home','主要地址',primaryPatch)||current.primaryAddressId||null;
  let pickupId=current.defaultPickupAddressId||primaryId;
  if(pickupPatch&&canonicalRecipientText(pickupPatch)===canonicalRecipientText(primaryPatch))pickupId=primaryId;
  else if(pickupPatch)pickupId=upsert(current.defaultPickupAddressId&&current.defaultPickupAddressId!==primaryId?current.defaultPickupAddressId:`addr_${recipient.id}_pickup`,'pickup','預設上車地址',pickupPatch)||primaryId;
  return {entries,primaryAddressId:primaryId,defaultPickupAddressId:pickupId};
}
function selfRelationsForUser(userId){ return (store.state.careRecipientRelations||[]).filter(x=>x.userId===userId&&x.relationship==='self'&&x.status!=='revoked'); }
function selfRelationsForRecipient(recipientId){ return (store.state.careRecipientRelations||[]).filter(x=>x.recipientId===recipientId&&x.relationship==='self'&&x.status!=='revoked'); }
function canCreateSelfRelation(userId,recipientId,ignoreRelationId=null){ const userConflict=selfRelationsForUser(userId).find(x=>x.id!==ignoreRelationId&&x.recipientId!==recipientId);if(userConflict)return {ok:false,error:'此需求者已經有另一筆本人服務主檔'};const recipientConflict=selfRelationsForRecipient(recipientId).find(x=>x.id!==ignoreRelationId&&x.userId!==userId);if(recipientConflict)return {ok:false,error:'此服務對象已經綁定另一個需求者本人 Identity'};return {ok:true}; }

CareRecipient = {
  schemaVersion:CARE_RECIPIENT_SCHEMA_VERSION,
  list({includeArchived=false}={}){ const rows=[...(store.state.careRecipients||[])];return includeArchived?rows.filter(r=>r.status!=='merged'):rows.filter(r=>r.status==='active'); },
  get(id){ return (store.state.careRecipients||[]).find(r=>r.id===id); },
  read(id,context={}){ const recipient=this.get(id);if(!recipient||recipient.status==='merged')return {ok:false,error:'找不到可查看的服務對象'};const access=recipientAccessMode(id,context);if(access==='none')return {ok:false,error:'你沒有查看此服務對象資料的權限'};return {ok:true,recipient:transportReadModel(recipient,access),access}; },
  displayName:recipientDisplayName,primaryPhone:recipientPrimaryPhone,primaryAddress:recipientPrimaryAddress,defaultPickupAddress:recipientDefaultPickupAddress,
  defaultServiceNeeds(recipientOrId){ const r=typeof recipientOrId==='string'?this.get(recipientOrId):recipientOrId;const m=r?.mobility||recipientEmptyMobility(),sp=r?.servicePreferences||{};let aidNeed=String(m.defaultAidNeed||'').trim();if(!aidNeed){if(m.wheelchairType==='electric')aidNeed='電動輪椅';else if(m.wheelchairType==='manual')aidNeed='手動輪椅';else if(m.walkingAbility==='walker')aidNeed='助行器';}return {aidNeed,companions:Math.max(0,Number(sp.defaultCompanions??0)||0),specialNeed:String(m.defaultSpecialNeeds||'').trim(),requiresAccessibleVehicle:!!m.requiresAccessibleVehicle,requiresEscort:!!m.requiresEscort,transferAssistance:m.transferAssistance||'unknown'}; },
  bookingProfile(recipientOrId){
    const r=typeof recipientOrId==='string'?this.get(recipientOrId):recipientOrId;
    if(!r||r.status!=='active')return null;
    return Object.freeze({id:r.id,status:r.status,displayName:recipientDisplayName(r),primaryPhone:recipientPrimaryPhone(r),defaultServiceNeeds:Object.freeze({...this.defaultServiceNeeds(r)})});
  },
  resolveForBooking(input,context={}){
    const explicit=input?.recipientId?this.bookingProfile(input.recipientId):null;
    if(explicit)return this.get(explicit.id);
    return this.upsertFromBooking(input,context);
  },
  syncRequesterIdentityForBooking(userId,{name='',phone=''}={}){
    const recipient=this.selfForUser(userId); if(!recipient)return {ok:true,recipient:null};
    const patch={identity:{displayName:String(name||recipientDisplayName(recipient)||'需求者').trim()},contacts:{primaryPhone:normalizeRecipientPhone(phone||recipientPrimaryPhone(recipient))}};
    const result=this.update(recipient.id,patch,{actorUserId:userId});
    return result?.ok?{ok:true,recipient:result.recipient}:{ok:false,error:result?.error||'無法同步需求者服務主檔'};
  },
  relationsForRecipient(recipientId,{includeRevoked=false}={}){ return (store.state.careRecipientRelations||[]).filter(x=>x.recipientId===recipientId&&(includeRevoked||x.status!=='revoked')); },
  relationForUser(userId,recipientId){ return (store.state.careRecipientRelations||[]).find(x=>x.userId===userId&&x.recipientId===recipientId&&x.status!=='revoked')||null; },
  selfForUser(userId){ const rel=selfRelationsForUser(userId)[0],recipient=rel?this.get(rel.recipientId):null;return recipient?.status==='active'?recipient:null; },
  listForUser(userId,{includeArchived=false,bookableOnly=false}={}){ const relations=(store.state.careRecipientRelations||[]).filter(x=>x.userId===userId&&x.status!=='revoked'&&(!bookableOnly||x.canBook!==false)),ids=new Set(relations.map(x=>x.recipientId));return this.list({includeArchived}).filter(r=>ids.has(r.id)); },
  listServedByOrganization(organizationId,{includeArchived=false,actorUserId=null,_internalToken=null}={}){ const internal=_internalToken===CARE_RECIPIENT_INTERNAL_TOKEN;if(!internal&&!activeOrganizationMembership(actorUserId,organizationId,['owner','dispatcher']))return [];const ids=new Set(Booking?.recipientIdsForOrganization?.(organizationId)||[]);return this.list({includeArchived}).filter(r=>ids.has(r.id)||r.governance?.sourceOrganizationId===organizationId); },
  canRead(recipientId,context={}){ return recipientAccessMode(recipientId,context)!=='none'; },
  canManage(recipientId,{actorUserId=null}={}){ if(!recipientId||!actorUserId)return false;if(actorIsSuperAdmin(actorUserId))return true;const recipient=this.get(recipientId),sourceOrgId=recipient?.governance?.sourceOrganizationId;if(sourceOrgId&&activeOrganizationMembership(actorUserId,sourceOrgId,['owner']))return true;const rel=this.relationForUser(actorUserId,recipientId);return !!(rel&&rel.canManageProfile!==false&&(rel.isPrimaryContact||rel.canManageProfile)); },
  canManageRelations(recipientId,{actorUserId=null}={}){ return !!recipientId&&!!actorUserId&&actorIsSuperAdmin(actorUserId); },
  history(recipientId){ const normal=(store.state.careRecipientEvents||[]).filter(e=>e.recipientId===recipientId&&e.eventType!=='merged'),merges=(store.state.careRecipientMergeEvents||[]).filter(e=>e.primaryRecipientId===recipientId||e.duplicateRecipientId===recipientId).map(e=>({...e,eventType:'merged',recipientId:e.primaryRecipientId,detail:`合併 ${e.duplicateRecipientId} → ${e.primaryRecipientId}`,createdAt:e.createdAt}));return [...normal,...merges].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); },
  linkUser(userId,recipientId,{relationship='family',isPrimaryContact=false,canBook=true,canManageProfile=false,actorUserId=null,_internalToken=null}={}){
    const recipient=this.get(recipientId);if(!userId||!recipientId||!recipient)return null;const internal=_internalToken===CARE_RECIPIENT_INTERNAL_TOKEN;if(!internal&&!this.canManageRelations(recipientId,{actorUserId}))return null;if(relationship==='self'&&!canCreateSelfRelation(userId,recipientId).ok)return null;
    const existing=(store.state.careRecipientRelations||[]).find(x=>x.userId===userId&&x.recipientId===recipientId&&x.status!=='revoked');
    if(existing){if(relationship==='self'&&!canCreateSelfRelation(userId,recipientId,existing.id).ok)return null;store.mutate(db=>{const rel=db.careRecipientRelations.find(x=>x.id===existing.id);if(!rel)return;if(relationship)rel.relationship=relationship;if(canBook!==undefined)rel.canBook=!!canBook;if(canManageProfile!==undefined)rel.canManageProfile=!!canManageProfile;if(relationship==='self'){rel.canBook=true;rel.canManageProfile=true;}rel.updatedAt=nowISO();normalizePrimaryContactInDb(db,recipientId,(isPrimaryContact||relationship==='self')?userId:null);});return (store.state.careRecipientRelations||[]).find(x=>x.id===existing.id);}
    const relation={id:uid('crrel'),userId,recipientId,relationship,isPrimaryContact:!!isPrimaryContact||relationship==='self',canBook:relationship==='self'?true:canBook!==false,canManageProfile:relationship==='self'?true:!!canManageProfile,status:'active',createdAt:nowISO(),updatedAt:nowISO()};store.mutate(db=>{db.careRecipientRelations=db.careRecipientRelations||[];db.careRecipientRelations.push(relation);normalizePrimaryContactInDb(db,recipientId,relation.isPrimaryContact?userId:null);});recipientEvent(recipientId,'relation_linked',{actorUserId:actorUserId||userId,relationId:relation.id,detail:`建立關係：${relationship}`});Audit.log('care_recipient_relation_linked',`建立 User ${userId} ↔ CareRecipient ${recipientId} 關係`,{actorUserId:actorUserId||userId,recipientId,relationId:relation.id});return (store.state.careRecipientRelations||[]).find(x=>x.id===relation.id);
  },
  updateRelation(relationId,patch={},actorUserId=null){ const rel=(store.state.careRecipientRelations||[]).find(x=>x.id===relationId&&x.status!=='revoked');if(!rel)return {ok:false,error:'找不到有效關係'};if(!this.canManageRelations(rel.recipientId,{actorUserId}))return {ok:false,error:'你沒有管理此服務對象關係人的權限'};const nextRelationship=patch.relationship||rel.relationship;if(nextRelationship==='self'){const check=canCreateSelfRelation(rel.userId,rel.recipientId,rel.id);if(!check.ok)return check;}const active=this.relationsForRecipient(rel.recipientId);if(nextRelationship==='self'&&patch.canManageProfile===false)return {ok:false,error:'本人關係必須保留主檔管理權'};if(patch.canManageProfile===false&&rel.canManageProfile&&!active.some(x=>x.id!==relationId&&x.canManageProfile))return {ok:false,error:'至少要保留一位可管理主檔的關係人'};if(patch.isPrimaryContact===false&&rel.isPrimaryContact)return {ok:false,error:'主要聯絡人不能直接取消，請先將另一位關係人設為主要聯絡人'};store.mutate(db=>{const r=db.careRecipientRelations.find(x=>x.id===relationId);if(!r)return;r.relationship=nextRelationship;if(patch.canBook!==undefined)r.canBook=!!patch.canBook;if(patch.canManageProfile!==undefined)r.canManageProfile=!!patch.canManageProfile;if(nextRelationship==='self'){r.canBook=true;r.canManageProfile=true;}r.updatedAt=nowISO();normalizePrimaryContactInDb(db,rel.recipientId,(patch.isPrimaryContact===true||nextRelationship==='self')?r.userId:null);});recipientEvent(rel.recipientId,'relation_updated',{actorUserId,relationId,detail:'更新關係人權限',changes:patch});Audit.log('care_recipient_relation_updated',`更新 CareRecipient 關係 ${relationId}`,{actorUserId,recipientId:rel.recipientId,relationId});return {ok:true,relation:(store.state.careRecipientRelations||[]).find(x=>x.id===relationId)}; },
  revokeRelation(relationId,actorUserId=null){ const rel=(store.state.careRecipientRelations||[]).find(x=>x.id===relationId&&x.status!=='revoked');if(!rel)return {ok:false,error:'找不到有效關係'};if(!this.canManageRelations(rel.recipientId,{actorUserId}))return {ok:false,error:'你沒有管理此服務對象關係人的權限'};const active=this.relationsForRecipient(rel.recipientId);if(active.length<=1)return {ok:false,error:'至少要保留一位有效關係人，避免服務對象失去主要聯絡人'};if(rel.canManageProfile&&!active.some(x=>x.id!==relationId&&x.canManageProfile))return {ok:false,error:'這是最後一位可管理主檔的關係人，請先授權其他人再撤銷'};store.mutate(db=>{const r=db.careRecipientRelations.find(x=>x.id===relationId);r.status='revoked';r.revokedAt=nowISO();r.updatedAt=nowISO();normalizePrimaryContactInDb(db,rel.recipientId,null);});recipientEvent(rel.recipientId,'relation_revoked',{actorUserId,relationId,detail:'撤銷服務對象關係'});Audit.log('care_recipient_relation_revoked',`撤銷 CareRecipient 關係 ${relationId}`,{actorUserId,recipientId:rel.recipientId,relationId});return {ok:true}; },
  findPotentialMatches(subject,{excludeId=null,highConfidenceOnly=false}={}){ const target=recipientDescriptor(subject);return this.list().filter(r=>r.id!==excludeId).map(r=>{const c=recipientDescriptor(r),reasons=[];let score=0;const sameName=!!target.name&&canonicalRecipientText(target.name)===canonicalRecipientText(c.name),sameAddress=!!target.address&&canonicalRecipientText(target.address)===canonicalRecipientText(c.address),samePhone=!!target.phone&&target.phone===c.phone,sameBirth=!!target.birthDate&&!!c.birthDate&&target.birthDate===c.birthDate;if(sameName){score+=40;reasons.push('姓名相同');}if(sameAddress){score+=40;reasons.push('主要地址相同');}if(samePhone){score+=30;reasons.push('聯絡手機相同');}if(sameBirth){score+=50;reasons.push('生日相同');}const highConfidence=!!(sameName&&(sameAddress||samePhone||sameBirth));return {recipient:r,score,highConfidence,reasons};}).filter(x=>x.score>0&&(!highConfidenceOnly||x.highConfidence)).sort((a,b)=>Number(b.highConfidence)-Number(a.highConfidence)||b.score-a.score); },
  findDuplicateCandidates(){ const rows=this.list(),pairs=[];for(let i=0;i<rows.length;i++)this.findPotentialMatches(rows[i],{excludeId:rows[i].id,highConfidenceOnly:true}).forEach(m=>{if(rows[i].id<m.recipient.id)pairs.push({primaryCandidate:rows[i],duplicateCandidate:m.recipient,score:m.score,reasons:m.reasons});});return pairs.sort((a,b)=>b.score-a.score); },
  validate(){
    const errors=[],warnings=[],activeIds=new Set(this.list().map(r=>r.id)),allRows=store.state.careRecipients||[],allIds=new Set(allRows.map(r=>r.id));
    allRows.forEach(r=>{if(r.schemaVersion!==CARE_RECIPIENT_SCHEMA_VERSION)errors.push(`CareRecipient ${r.id} schemaVersion 應為 ${CARE_RECIPIENT_SCHEMA_VERSION}`);if(!CARE_RECIPIENT_STATUS_VALUES.includes(r.status))errors.push(`CareRecipient ${r.id} status 不合法：${r.status}`);if(r.scope!=='platform')errors.push(`CareRecipient ${r.id} scope 必須為 platform`);const a=normalizedAddressEntries(r.id,r.addresses||{},r.servicePreferences?.defaultPickupAddress||''),addrIds=new Set(a.entries.map(x=>x.id));if(a.primaryAddressId&&!addrIds.has(a.primaryAddressId))errors.push(`CareRecipient ${r.id} primaryAddressId 無對應地址`);if(a.defaultPickupAddressId&&!addrIds.has(a.defaultPickupAddressId))errors.push(`CareRecipient ${r.id} defaultPickupAddressId 無對應地址`);const m=r.mobility||{};if(!CARE_RECIPIENT_WALKING_VALUES.includes(m.walkingAbility||'unknown'))errors.push(`CareRecipient ${r.id} walkingAbility 不合法`);if(!CARE_RECIPIENT_WHEELCHAIR_VALUES.includes(m.wheelchairType||'none'))errors.push(`CareRecipient ${r.id} wheelchairType 不合法`);if(!CARE_RECIPIENT_TRANSFER_VALUES.includes(m.transferAssistance||'unknown'))errors.push(`CareRecipient ${r.id} transferAssistance 不合法`);const companions=Number(r.servicePreferences?.defaultCompanions??0);if(!Number.isInteger(companions)||companions<0)errors.push(`CareRecipient ${r.id} defaultCompanions 必須為非負整數`);const ecIds=new Set();normalizeEmergencyContacts(r.id,r.contacts?.emergencyContacts||[]).forEach(c=>{if(ecIds.has(c.id))errors.push(`CareRecipient ${r.id} 緊急聯絡人 id 重複：${c.id}`);ecIds.add(c.id);});if(r.status==='active'&&r.governance?.archivedAt)errors.push(`CareRecipient ${r.id} active 不應有 archivedAt`);if(r.status==='archived'&&!r.governance?.archivedAt)errors.push(`CareRecipient ${r.id} archived 必須有 archivedAt`);if(r.status==='merged'){if(!r.governance?.mergedIntoRecipientId||!r.governance?.mergedAt)errors.push(`CareRecipient ${r.id} merged 缺少 mergedIntoRecipientId / mergedAt`);if(!r.governance?.archivedAt)errors.push(`CareRecipient ${r.id} merged 必須保留 archivedAt`);if(r.governance?.mergedIntoRecipientId&&!allIds.has(r.governance.mergedIntoRecipientId))errors.push(`CareRecipient ${r.id} mergedIntoRecipientId 不存在`);}});
    const relationActiveKeys=new Set(),selfUser=new Map(),selfRecipient=new Map();(store.state.careRecipientRelations||[]).forEach(rel=>{if(!allIds.has(rel.recipientId))errors.push(`CareRecipientRelation ${rel.id} 找不到服務對象 ${rel.recipientId}`);if(!(store.state.users||[]).some(u=>u.id===rel.userId))errors.push(`CareRecipientRelation ${rel.id} 找不到 User ${rel.userId}`);if(rel.status!=='revoked'){const key=`${rel.userId}:${rel.recipientId}`;if(relationActiveKeys.has(key))errors.push(`重複 active CareRecipientRelation：${key}`);relationActiveKeys.add(key);const target=this.get(rel.recipientId);if(target?.status==='merged')errors.push(`CareRecipientRelation ${rel.id} 不可指向 merged Recipient`);if(rel.relationship==='self'){if(selfUser.has(rel.userId)&&selfUser.get(rel.userId)!==rel.recipientId)errors.push(`User ${rel.userId} 有多個 active self CareRecipient`);else selfUser.set(rel.userId,rel.recipientId);if(selfRecipient.has(rel.recipientId)&&selfRecipient.get(rel.recipientId)!==rel.userId)errors.push(`CareRecipient ${rel.recipientId} 綁定多個 self User`);else selfRecipient.set(rel.recipientId,rel.userId);if(!rel.canBook||!rel.canManageProfile)errors.push(`Self relation ${rel.id} 必須 canBook 且 canManageProfile`);}}});
    this.list().forEach(r=>{const active=this.relationsForRecipient(r.id);if(active.length){const primaryCount=active.filter(x=>x.isPrimaryContact).length;if(primaryCount!==1)errors.push(`CareRecipient ${r.id} 主要聯絡人數量應為 1，目前為 ${primaryCount}`);if(!active.some(x=>x.canManageProfile))errors.push(`CareRecipient ${r.id} 沒有可管理主檔的關係人`);}});
    (Booking?.recipientReferences?.()||[]).forEach(ref=>{if(ref.recipientId&&!allIds.has(ref.recipientId))errors.push(`Booking ${ref.bookingId} 找不到 CareRecipient ${ref.recipientId}`);const target=ref.recipientId?this.get(ref.recipientId):null;if(target?.status==='merged')errors.push(`Booking ${ref.bookingId} 不可指向 merged CareRecipient ${ref.recipientId}`);});
    (store.state.notifications||[]).forEach(n=>{if(n.recipientId&&!allIds.has(n.recipientId))errors.push(`Notification ${n.id} 找不到服務對象 ${n.recipientId}`);});(store.state.benefitAssessments||[]).forEach(x=>{if(x.recipientId&&!allIds.has(x.recipientId))errors.push(`BenefitAssessment ${x.id} 找不到服務對象 ${x.recipientId}`);});
    const duplicates=this.findDuplicateCandidates();duplicates.forEach(x=>warnings.push(`疑似重複：${recipientDisplayName(x.primaryCandidate)} ↔ ${recipientDisplayName(x.duplicateCandidate)}（${x.reasons.join('、')}）`));return {ok:errors.length===0,errors,warnings,duplicateCandidates:duplicates,activeCount:activeIds.size,mergeHistoryCount:(store.state.careRecipientMergeEvents||[]).length,eventCount:(store.state.careRecipientEvents||[]).length,checkedAt:nowISO()};
  },
  create(input={},context={}){
    const actorUserId=context.actorUserId||null,internal=context._internalToken===CARE_RECIPIENT_INTERNAL_TOKEN,name=String(input.name||input.displayName||'').trim(),phone=normalizeRecipientPhone(input.phone||input.primaryPhone),address=String(input.address||input.primaryAddress||'').trim(),birthDate=String(input.birthDate||'').trim()||null;
    const ownerOrganizationId=context.organizationId||null,ownerCanCreate=!!ownerOrganizationId&&!!activeOrganizationMembership(actorUserId,ownerOrganizationId,['owner']);if(!internal&&!actorIsSuperAdmin(actorUserId)&&!ownerCanCreate)return {ok:false,error:'只有平台超級管理者或目前組織負責人可以手動建立服務對象'};if(!name)return {ok:false,error:'請輸入服務對象姓名'};if(phone&&phone.length<9)return {ok:false,error:'請輸入正確聯絡手機'};
    const matches=this.findPotentialMatches({name,phone,address,birthDate},{highConfidenceOnly:true});if(matches.length&&!context.allowPotentialMatch)return {ok:false,error:`系統找到疑似同一服務對象「${recipientDisplayName(matches[0].recipient)}」，請先查看既有主檔，避免重複建檔`,matches};
    const createdAt=nowISO(),recipientId=uid('rec'),addresses=normalizedAddressEntries(recipientId,{primary:address,commonPickup:address},address),emergencyContacts=normalizeEmergencyContacts(recipientId,input.emergencyContacts||[]),sp={defaultCompanions:0,commonDestinations:[],notes:'',...(input.servicePreferences||{})};delete sp.defaultPickupAddress;
    const recipient={id:recipientId,schemaVersion:CARE_RECIPIENT_SCHEMA_VERSION,scope:'platform',status:'active',identity:{displayName:name,birthDate,gender:input.gender||'unspecified'},contacts:{primaryPhone:phone,emergencyContacts},addresses,mobility:{...recipientEmptyMobility(),...(input.mobility||{})},servicePreferences:{...sp,defaultCompanions:Math.max(0,Number(sp.defaultCompanions??0)||0)},governance:{createdByUserId:actorUserId,source:context.source||'manual',sourceOrganizationId:context.organizationId||null,potentialDuplicateRecipientIds:matches.map(x=>x.recipient.id),createdAt,updatedAt:createdAt,archivedAt:null,mergedIntoRecipientId:null,mergedAt:null}};
    const hasExplicitLink=Object.prototype.hasOwnProperty.call(context,'linkUserId'),linkUserId=hasExplicitLink?context.linkUserId:null;if(linkUserId&&context.relationship==='self'){const check=canCreateSelfRelation(linkUserId,recipientId);if(!check.ok)return check;}
    store.mutate(db=>db.careRecipients.push(recipient));recipientEvent(recipient.id,'created',{actorUserId,organizationId:context.organizationId||null,detail:'建立服務對象主檔'});Audit.log('care_recipient_created',`建立服務對象 ${name}`,{actorUserId,recipientId:recipient.id,potentialDuplicateRecipientIds:recipient.governance.potentialDuplicateRecipientIds});
    if(linkUserId){const relation=this.linkUser(linkUserId,recipient.id,{relationship:context.relationship||'family',isPrimaryContact:true,canBook:true,canManageProfile:true,actorUserId,_internalToken:CARE_RECIPIENT_INTERNAL_TOKEN});if(!relation){store.mutate(db=>{db.careRecipients=db.careRecipients.filter(x=>x.id!==recipient.id);db.careRecipientEvents=(db.careRecipientEvents||[]).filter(x=>x.recipientId!==recipient.id);});return {ok:false,error:'無法建立服務對象與 User 的唯一關係'};}}
    return {ok:true,recipient:this.get(recipient.id),matches};
  },
  upsertFromBooking(input,context={}){
    const ctx=typeof context==='string'?{organizationId:context}:context||{},userId=input.requestedByUserId||ctx.userId||null,requesterSelf=input.source==='requester_app';
    if(input.recipientId){const explicit=this.get(input.recipientId);if(explicit?.status==='active')return explicit;}
    if(requesterSelf&&userId){const existingSelf=this.selfForUser(userId);if(existingSelf)return existingSelf;}
    const name=String(input.name||'').trim(),phone=normalizeRecipientPhone(input.phone),address=String(input.pickupAddress||'').trim();
    const result=this.create({name,phone,address,birthDate:input.birthDate||null},{actorUserId:userId,linkUserId:requesterSelf?userId:null,relationship:requesterSelf?'self':'family',organizationId:ctx.organizationId||null,source:input.source||'booking',allowPotentialMatch:true,_internalToken:CARE_RECIPIENT_INTERNAL_TOKEN});
    if(!result?.ok)return null;return result.recipient;
  },
  update(id,patch={},context={}){
    const actorUserId=context.actorUserId||null,internal=context._internalToken===CARE_RECIPIENT_INTERNAL_TOKEN;if(!internal&&!actorUserId)return {ok:false,error:'修改服務對象必須提供操作人身分'};if(!internal&&!this.canManage(id,{actorUserId}))return {ok:false,error:'你沒有修改此服務對象主檔的權限'};
    const current=this.get(id);if(!current||current.status==='merged')return {ok:false,error:'找不到可修改的服務對象'};const before=deepClone(current);
    store.mutate(db=>{const r=db.careRecipients.find(x=>x.id===id);if(!r)return;if(patch.identity)Object.assign(r.identity,patch.identity);if(patch.contacts){const contacts={...patch.contacts};if(Object.prototype.hasOwnProperty.call(contacts,'emergencyContacts'))contacts.emergencyContacts=normalizeEmergencyContacts(id,contacts.emergencyContacts);Object.assign(r.contacts,contacts);}if(patch.addresses||patch.servicePreferences?.defaultPickupAddress!==undefined)r.addresses=normalizeAddressPatch(r,patch.addresses||{},patch.servicePreferences||{});if(patch.mobility)Object.assign(r.mobility,patch.mobility);if(patch.servicePreferences){const sp={...patch.servicePreferences};delete sp.defaultPickupAddress;Object.assign(r.servicePreferences,sp);r.servicePreferences.defaultCompanions=Math.max(0,Number(r.servicePreferences.defaultCompanions??0)||0);}r.schemaVersion=CARE_RECIPIENT_SCHEMA_VERSION;r.governance={...r.governance,updatedAt:nowISO(),...(internal?(patch.governance||{}):{})};});
    const after=this.get(id),changes=recipientPatchSummary(before,after);if(changes.length){recipientEvent(id,'updated',{actorUserId,detail:'更新服務對象主檔',changes});Audit.log('care_recipient_updated',`更新服務對象 ${recipientDisplayName(after)}`,{actorUserId,recipientId:id,changedFields:changes.map(x=>x.field)});}return {ok:true,recipient:after,changes};
  },
  archive(id,{actorUserId=null}={}){ if(!this.canManage(id,{actorUserId}))return {ok:false,error:'你沒有封存此服務對象的權限'};const r=this.get(id);if(!r||r.status!=='active')return {ok:false,error:'此服務對象目前無法封存'};const future=Booking?.futureActiveForRecipient?.(id,new Date())||[];if(future.length)return {ok:false,error:`仍有 ${future.length} 筆待處理／已安排預約，請先處理後再封存`};const at=nowISO();store.mutate(db=>{const row=db.careRecipients.find(x=>x.id===id);row.status='archived';row.governance={...row.governance,archivedAt:at,updatedAt:at};});recipientEvent(id,'archived',{actorUserId,detail:'封存服務對象主檔'});Audit.log('care_recipient_archived',`封存服務對象 ${recipientDisplayName(r)}`,{actorUserId,recipientId:id});return {ok:true}; },
  restore(id,{actorUserId=null}={}){ if(!this.canManage(id,{actorUserId}))return {ok:false,error:'你沒有恢復此服務對象的權限'};const r=this.get(id);if(!r||r.status!=='archived')return {ok:false,error:'此服務對象不是封存狀態'};const at=nowISO();store.mutate(db=>{const row=db.careRecipients.find(x=>x.id===id);row.status='active';row.governance={...row.governance,archivedAt:null,updatedAt:at};});recipientEvent(id,'restored',{actorUserId,detail:'恢復服務對象主檔'});Audit.log('care_recipient_restored',`恢復服務對象 ${recipientDisplayName(r)}`,{actorUserId,recipientId:id});return {ok:true}; },
  merge(primaryRecipientId,duplicateRecipientId,{actorUserId=null,reason='人工確認為同一服務對象'}={}){
    if(!actorIsSuperAdmin(actorUserId))return {ok:false,error:'只有平台超級管理者可以合併服務對象'};if(!primaryRecipientId||!duplicateRecipientId||primaryRecipientId===duplicateRecipientId)return {ok:false,error:'請選擇兩筆不同的服務對象'};const primary=this.get(primaryRecipientId),duplicate=this.get(duplicateRecipientId);if(!primary||!duplicate||primary.status!=='active'||duplicate.status!=='active')return {ok:false,error:'找不到可合併的有效服務對象'};
    const selfUsers=new Set([...selfRelationsForRecipient(primaryRecipientId),...selfRelationsForRecipient(duplicateRecipientId)].map(x=>x.userId));if(selfUsers.size>1)return {ok:false,error:'兩筆服務對象分別綁定不同的需求者本人 Identity，請先處理帳號／身分關係，不能直接合併'};
    const now=nowISO();let reassignedBookings=0,reassignedNotifications=0,reassignedBenefits=0;
    store.mutate(db=>{const p=db.careRecipients.find(x=>x.id===primaryRecipientId),d=db.careRecipients.find(x=>x.id===duplicateRecipientId);if(!p||!d)return;const preferredPrimaryUserId=(db.careRecipientRelations||[]).find(x=>x.recipientId===primaryRecipientId&&x.status!=='revoked'&&x.isPrimaryContact)?.userId||(db.careRecipientRelations||[]).find(x=>x.recipientId===duplicateRecipientId&&x.status!=='revoked'&&x.isPrimaryContact)?.userId||null;
      p.identity={...d.identity,...p.identity,displayName:mergeText(p.identity?.displayName,d.identity?.displayName),birthDate:mergeText(p.identity?.birthDate,d.identity?.birthDate)||null};
      const emergency=[...(p.contacts?.emergencyContacts||[]),...(d.contacts?.emergencyContacts||[])],ecSeen=new Set(),mergedEmergency=[];emergency.forEach(c=>{const key=`${canonicalRecipientText(c.name)}:${normalizeRecipientPhone(c.phone)}:${c.relationship||''}`;if(ecSeen.has(key))return;ecSeen.add(key);mergedEmergency.push(c);});p.contacts={...d.contacts,...p.contacts,primaryPhone:mergeText(p.contacts?.primaryPhone,d.contacts?.primaryPhone),emergencyContacts:normalizeEmergencyContacts(primaryRecipientId,mergedEmergency)};
      const pa=normalizedAddressEntries(primaryRecipientId,p.addresses||{},p.servicePreferences?.defaultPickupAddress||''),da=normalizedAddressEntries(duplicateRecipientId,d.addresses||{},d.servicePreferences?.defaultPickupAddress||''),entries=deepClone(pa.entries||[]);da.entries.forEach(row=>{if(!entries.some(x=>canonicalRecipientText(x.address)===canonicalRecipientText(row.address)))entries.push({...row,id:`addr_${primaryRecipientId}_${entries.length+1}`});});const primaryAddress=addressValue(pa,pa.primaryAddressId)||addressValue(da,da.primaryAddressId),pickupAddress=addressValue(pa,pa.defaultPickupAddressId)||addressValue(da,da.defaultPickupAddressId)||primaryAddress;p.addresses=normalizedAddressEntries(primaryRecipientId,{entries,primary:primaryAddress,commonPickup:pickupAddress},pickupAddress);
      const pm=p.mobility||recipientEmptyMobility(),dm=d.mobility||recipientEmptyMobility();p.mobility={...dm,...pm,walkingAbility:pm.walkingAbility&&pm.walkingAbility!=='unknown'?pm.walkingAbility:dm.walkingAbility||'unknown',wheelchairType:pm.wheelchairType&&pm.wheelchairType!=='none'?pm.wheelchairType:dm.wheelchairType||'none',requiresAccessibleVehicle:!!(pm.requiresAccessibleVehicle||dm.requiresAccessibleVehicle),requiresEscort:!!(pm.requiresEscort||dm.requiresEscort),transferAssistance:pm.transferAssistance&&pm.transferAssistance!=='unknown'?pm.transferAssistance:dm.transferAssistance||'unknown',defaultAidNeed:mergeText(pm.defaultAidNeed,dm.defaultAidNeed),defaultSpecialNeeds:mergeText(pm.defaultSpecialNeeds,dm.defaultSpecialNeeds)};
      const ps=p.servicePreferences||{},ds=d.servicePreferences||{};p.servicePreferences={...ds,...ps,defaultCompanions:Number(ps.defaultCompanions??ds.defaultCompanions??0)||0,commonDestinations:uniqueTextArray([...(ps.commonDestinations||[]),...(ds.commonDestinations||[])]),notes:mergeNotes(ps.notes,ds.notes)};delete p.servicePreferences.defaultPickupAddress;p.schemaVersion=CARE_RECIPIENT_SCHEMA_VERSION;p.governance={...d.governance,...p.governance,potentialDuplicateRecipientIds:uniqueTextArray([...(p.governance?.potentialDuplicateRecipientIds||[]),...(d.governance?.potentialDuplicateRecipientIds||[])]).filter(x=>x!==primaryRecipientId&&x!==duplicateRecipientId),updatedAt:now};
      reassignedBookings=Booking?.reassignRecipientInDb?.(db,duplicateRecipientId,primaryRecipientId)||0;(db.notifications||[]).forEach(x=>{if(x.recipientId===duplicateRecipientId){x.recipientId=primaryRecipientId;reassignedNotifications++;}});(db.benefitAssessments||[]).forEach(x=>{if(x.recipientId===duplicateRecipientId){x.recipientId=primaryRecipientId;reassignedBenefits++;}});(db.careRecipientRelations||[]).forEach(x=>{if(x.recipientId===duplicateRecipientId){x.recipientId=primaryRecipientId;x.updatedAt=now;}});const relSeen=new Map();db.careRecipientRelations=(db.careRecipientRelations||[]).filter(rel=>{const key=`${rel.userId}:${rel.recipientId}:${rel.status==='revoked'?'revoked':'active'}`;if(!relSeen.has(key)){relSeen.set(key,rel);return true;}const kept=relSeen.get(key);kept.isPrimaryContact=!!(kept.isPrimaryContact||rel.isPrimaryContact);kept.canBook=!!(kept.canBook||rel.canBook);kept.canManageProfile=!!(kept.canManageProfile||rel.canManageProfile);if(kept.relationship!=='self'&&rel.relationship==='self')kept.relationship='self';return false;});normalizePrimaryContactInDb(db,primaryRecipientId,preferredPrimaryUserId);d.status='merged';d.schemaVersion=CARE_RECIPIENT_SCHEMA_VERSION;d.governance={...d.governance,updatedAt:now,archivedAt:now,mergedIntoRecipientId:primaryRecipientId,mergedAt:now};db.careRecipientMergeEvents=db.careRecipientMergeEvents||[];db.careRecipientMergeEvents.unshift({id:uid('crmerge'),primaryRecipientId,duplicateRecipientId,actorUserId,reason,createdAt:now,reassigned:{bookings:reassignedBookings,notifications:reassignedNotifications,benefitAssessments:reassignedBenefits}});});
    Audit.log('care_recipient_merged',`合併服務對象 ${duplicateRecipientId} → ${primaryRecipientId}`,{actorUserId,recipientId:primaryRecipientId,duplicateRecipientId});return {ok:true,recipient:this.get(primaryRecipientId),reassigned:{bookings:reassignedBookings,notifications:reassignedNotifications,benefitAssessments:reassignedBenefits}};
  }
};
}


{


// ============================================================================
// 資料載入層 — 權威資料在 Postgres，由 AppStateDatabase.loadAll 取得。
// 過濾在資料庫的 RLS 完成，所以每個身分拿到的就是他看得到的那些列。
// ============================================================================
// Google 試算表讀取層已整段移除（原本約 240 行：GOOGLE_DB_SHEETS、gs* 欄位轉換、
// fetchGoogleSheetBackend、readGoogleDatabaseSheet、buildGoogleDatabaseSnapshot、
// commitGoogleDatabaseSnapshot、GoogleDatabase.syncAll）。資料改由 Postgres 經
// AppStateDatabase.loadAll 載入，app_state 存的就是前端模型，不需要任何欄位轉換。
//
// 只留下這三個識別碼對應：舊資料用的 ID 與前端本機用的 ID 不同，登入時建立
// session 仍然要靠它們把後端 ID 轉成本機 ID。
const gsText=(v)=>String(v??'').trim();
const gsUserId=(v)=>{const id=gsText(v);return id==='USR-SUPER-JERRY'?'usr_super_admin':id;};
window.gsUserId=gsUserId;
const gsOrganizationId=(v)=>{const id=gsText(v);return id==='ORG-REQ-001'?APP_CONFIG.requesterOrganizationId:id;};
window.gsOrganizationId=gsOrganizationId;

// =====================================================================
// 從 Postgres 載入這個身分看得到的資料。
//
// 取代 GoogleDatabase.syncAll：舊版要對 Google 試算表發十幾次請求、再把試算表
// 欄位一列一列轉回前端模型。app_state 存的本來就是前端模型，所以這裡不做轉換。
//
// 過濾在資料庫層（RLS）完成，不在這裡：需求者只會拿到自己的，調度員只會拿到
// 自家組織的。舊版從試算表撈的是「全部」，那正是本機儲存會爆掉的原因。
// =====================================================================
// 後端與前端用的是兩套識別碼：後端叫 ORG-REQ-001，前端本機叫 org_requesters
// （gsOrganizationId 負責換算）。startBackendSession 一直都有做這個換算，但
// loadAll 沒有——結果登入當下權限是好的，載入資料之後成員資格的組織就變成後端
// 那一套，跟 28 處寫死比對 APP_CONFIG.requesterOrganizationId 的地方全部對不上，
// 使用者會看到「你沒有建立預約權限」。帳號和資料都是好的，純粹是 ID 對不起來。
const LOADED_ORG_FIELDS_=Object.freeze(['organizationId','sourceOrganizationId','targetOrganizationId','viewOrganizationId']);
const LOADED_USER_FIELDS_=Object.freeze(['userId','actorUserId','requestedByUserId','ownerUserId','claimedByUserId','createdByUserId','resolvedByUserId','revokedByUserId','capturedByUserId','reporterUserId','recipientUserId']);
function normalizeLoadedIds_(collections){
  const mapOrg=(v)=>v?window.gsOrganizationId(v):v;
  const mapUser=(v)=>v?window.gsUserId(v):v;
  const out={};
  Object.entries(collections||{}).forEach(([name,rows])=>{
    out[name]=(Array.isArray(rows)?rows:[]).map(row=>{
      const r={...row};
      if(name==='organizations'&&r.id)r.id=mapOrg(r.id);
      if(name==='users'&&r.id)r.id=mapUser(r.id);
      LOADED_ORG_FIELDS_.forEach(f=>{if(r[f])r[f]=mapOrg(r[f]);});
      LOADED_USER_FIELDS_.forEach(f=>{if(r[f])r[f]=mapUser(r[f]);});
      return r;
    });
  });
  return out;
}

const AppStateDatabase={
  lastLoadedAt:null,
  recordLoadError_(message){
    store.mutate(db=>{db.integration={...(db.integration||{}),lastSyncStatus:'載入失敗',lastSyncDetails:[message]};},{remote:false,reason:'state_load_error'});
  },
  async loadAll({silent=false}={}){
    if(typeof navigator!=='undefined'&&navigator.onLine===false){
      const error='目前離線，無法向正式資料庫取得最新資料。';
      this.recordLoadError_(error);
      if(!silent)showToast(error);
      return {ok:false,error,details:[error]};
    }
    const token=typeof window.backendAuthToken==='function'?window.backendAuthToken():'';
    if(!token){this.recordLoadError_('尚未登入');return {ok:false,error:'尚未登入',details:['尚未登入']};}
    try{
      const response=await fetch('/api/v2/state-load',{
        method:'GET',
        headers:{'Accept':'application/json','Authorization':`Bearer ${token}`},
        credentials:'same-origin',cache:'no-store'
      });
      const result=await response.json().catch(()=>null);
      if(!response.ok||!result?.ok){
        const message=result?.error?.message||`載入失敗（HTTP ${response.status}）`;
        this.recordLoadError_(message);
        if(!silent)showToast(message);
        return {ok:false,error:message,details:[message],code:result?.error?.code};
      }
      const collections=normalizeLoadedIds_(result.data?.collections||{});
      const details=Object.entries(result.data?.counts||{}).map(([k,v])=>`${k} ${v} 筆`);
      // remote:false 很重要：這是「從伺服器拿回來的資料」，不是使用者的變更，
      // 不能再被 diff 成待送出的異動排隊送回伺服器。
      store.mutate(db=>{
        AUTHORITATIVE_STATE_COLLECTIONS.forEach(name=>{
          if(Array.isArray(collections[name]))db[name]=collections[name];
          else if(!Array.isArray(db[name]))db[name]=[];
        });
        db.demandPool=Array.isArray(result.data?.pool)?result.data.pool:[];
        db.integration={...(db.integration||{}),lastSyncStatus:result.data?.truncated?'部分資料已載入':'同步完成',
                        lastSyncDetails:result.data?.truncated?['資料量達到上限，目前僅載入部分資料。']:[],
                        lastSyncCounts:result.data?.counts||{},
                        lastSyncAt:result.data?.loadedAt||nowISO(),source:'postgres'};
      },{remote:false,reason:'state_load'});
      this.lastLoadedAt=result.data?.loadedAt||nowISO();
      if(result.data?.truncated)console.warn('[StateLoad] 資料量達到上限，只載入了一部分');
      return {ok:true,details,counts:result.data?.counts||{}};
    }catch(error){
      const message=`載入正式資料失敗：${error?.message||error}`;
      this.recordLoadError_(message);
      if(!silent)showToast(message);
      return {ok:false,error:message,details:[message]};
    }
  }
};
window.AppStateDatabase=AppStateDatabase;

const BOOKING_STATE = Object.freeze({
  OPEN:'open',
  CLAIMED:'claimed',
  PARTIALLY_SCHEDULED:'partially_scheduled',
  SCHEDULED:'scheduled',
  REJECTED:'rejected',
  CANCELLED:'cancelled',
  EXPIRED:'expired'
});
const BOOKING_STATE_VALUES = new Set(Object.values(BOOKING_STATE));
const BOOKING_TRANSITIONS = Object.freeze({
  [BOOKING_STATE.OPEN]:Object.freeze({claim:BOOKING_STATE.CLAIMED,cancel:BOOKING_STATE.CANCELLED,expire:BOOKING_STATE.EXPIRED}),
  [BOOKING_STATE.CLAIMED]:Object.freeze({release:BOOKING_STATE.OPEN,reject:BOOKING_STATE.REJECTED,cancel:BOOKING_STATE.CANCELLED}),
  [BOOKING_STATE.PARTIALLY_SCHEDULED]:Object.freeze({cancel:BOOKING_STATE.CANCELLED}),
  [BOOKING_STATE.SCHEDULED]:Object.freeze({cancel:BOOKING_STATE.CANCELLED}),
  [BOOKING_STATE.REJECTED]:Object.freeze({}),
  [BOOKING_STATE.CANCELLED]:Object.freeze({}),
  [BOOKING_STATE.EXPIRED]:Object.freeze({})
});
const BOOKING_EVENT_LABELS = Object.freeze({
  migrated:'歷史資料建立基準',created:'建立預約',claimed:'公開需求已接案',released:'承接單位退回公開池',leg_scheduled:'行程 Leg 已排車',leg_organization_assigned:'行程 Leg 承接組織已指定',scheduled:'已建立行程',rejected:'不受理',cancelled:'預約取消',source_updated:'來源資料更新',source_conflict:'來源資料衝突',amended:'預約內容已修改',commercial_snapshot_captured:'報價／補助快照已建立',duplicate_detected:'偵測到疑似重複預約',claim_invalidated_by_amendment:'重大修改解除原承接',expired:'公開接案期限已到'
});
const BOOKING_ACTION_EVENT = Object.freeze({claim:'claimed',release:'released',reject:'rejected',cancel:'cancelled',expire:'expired'});
const BOOKING_ACTION_REASON_REQUIRED = new Set(['release','reject','cancel']);
const BOOKING_REASON_LABELS = Object.freeze({
  requester_schedule_change:'需求者行程變更',requester_health:'需求者身體／就醫狀況變更',requester_no_longer_needed:'已不需要接送',requester_duplicate:'重複預約',
  provider_capacity:'承接量不足',provider_time_conflict:'時段衝突',provider_vehicle_mismatch:'車型／設備不符',provider_out_of_area:'超出服務區域',provider_staffing:'人力不足',
  invalid_information:'資料不完整或錯誤',unsupported_service:'目前無法提供此服務',duplicate_booking:'重複案件',amendment_requires_reconfirm:'需求重大修改，需重新承接確認',other:'其他'
});

const BOOKING_PERMISSION = Object.freeze({
  MARKET_READ:'booking.market.read',MARKET_CLAIM:'booking.market.claim',READ_CLAIMED:'booking.read_claimed',READ_CLAIMED_OWN:'booking.read_claimed_own',MANAGE_CLAIMED:'booking.manage_claimed',
  SCHEDULE:'booking.schedule',LEG_ASSIGN_ORG:'booking.leg.assign_organization',RELEASE:'booking.release',RELEASE_OWN:'booking.release_own',REJECT:'booking.reject',SYNC_GOOGLE:'booking.sync_google',
  AUDIT_READ:'booking.audit.read',AUDIT_READ_OWN:'booking.audit.read_own',AUDIT_READ_PARTICIPATED:'booking.audit.read_participated',
  CREATE_OWN:'booking.create_own',READ_OWN:'booking.read_own',EDIT_OWN:'booking.edit_own',CANCEL_OWN:'booking.cancel_own'
});
function bookingActorCan(userId,permission,organizationId=null){
  return !!userId&&!!Identity?.canUser?.(userId,permission,organizationId);
}
function bookingActorCanAnyOrganization(userId,permission){
  return !!userId&&!!Identity?.canUserInAnyOrganization?.(userId,permission);
}
function bookingPermissionError(permission){
  const labels={
    [BOOKING_PERMISSION.MARKET_READ]:'你沒有查看公開需求池的權限',[BOOKING_PERMISSION.MARKET_CLAIM]:'你沒有接案權限',
    [BOOKING_PERMISSION.READ_CLAIMED]:'你沒有查看承接預約的權限',[BOOKING_PERMISSION.SCHEDULE]:'你沒有建立預約行程的權限',[BOOKING_PERMISSION.LEG_ASSIGN_ORG]:'你沒有跨組織指定 Booking Leg 的權限',
    [BOOKING_PERMISSION.RELEASE]:'你沒有退回公開池的權限',[BOOKING_PERMISSION.REJECT]:'你沒有不受理預約的權限',
    [BOOKING_PERMISSION.SYNC_GOOGLE]:'你沒有資料同步權限',[BOOKING_PERMISSION.CREATE_OWN]:'你沒有建立預約權限',
    [BOOKING_PERMISSION.EDIT_OWN]:'你沒有修改自己的預約權限',[BOOKING_PERMISSION.CANCEL_OWN]:'你沒有取消自己的預約權限',[BOOKING_PERMISSION.AUDIT_READ]:'你沒有查看 Booking 異動歷史的權限'
  };
  return labels[permission]||'你沒有執行此 Booking 操作的權限';
}
const BOOKING_CREATE_INPUT_FIELDS = Object.freeze([
  'recipientId','name','phone','pickupDate','pickupTime','pickupAddress','pickupAccessNote','destination','destinationAccessNote',
  'tripType','returnDate','returnTime','aidNeed','companions','specialNeed','note','consent','poolingConsent','serviceJurisdiction'
]);

function sanitizeBookingCreateInput(input={}){
  const safe={};
  BOOKING_CREATE_INPUT_FIELDS.forEach(key=>{
    if(Object.prototype.hasOwnProperty.call(input,key)) safe[key]=input[key];
  });
  return safe;
}


const BOOKING_COMMERCIAL_SNAPSHOT_SCHEMA_VERSION=1;
const BOOKING_REVISION_SCHEMA_VERSION=1;
const BOOKING_EDITABLE_FIELDS=Object.freeze([
  'pickupDate','pickupTime','pickupAddress','pickupAccessNote','destination','destinationAccessNote',
  'tripType','returnDate','returnTime','aidNeed','companions','specialNeed','note','poolingConsent'
]);
const BOOKING_RECONFIRM_FIELDS=new Set(['pickupDate','pickupTime','pickupAddress','pickupAccessNote','destination','destinationAccessNote','tripType','returnDate','returnTime','aidNeed','companions','specialNeed','poolingConsent']);
function bookingEditablePayload(booking={}){
  const out={};
  BOOKING_EDITABLE_FIELDS.forEach(k=>out[k]=booking[k]??'');
  return out;
}
function bookingChangedFields(before={},after={}){
  return BOOKING_EDITABLE_FIELDS.filter(k=>JSON.stringify(before[k]??'')!==JSON.stringify(after[k]??''));
}
function buildBookingQuoteSnapshot(bookingLike={},context={}){
  return {
    schemaVersion:BOOKING_COMMERCIAL_SNAPSHOT_SCHEMA_VERSION,
    status:'ruleset_required',currency:'TWD',pricingRulesetVersion:null,
    estimatedFare:null,baseFare:null,distanceFare:null,timeFare:null,extraFee:null,
    explanation:'尚未載入具版本與生效日期的正式定價規則，因此不產生虛構金額。',
    source:'booking_pricing_stub',capturedAt:context.capturedAt||nowISO()
  };
}
function buildBookingBenefitSnapshot(bookingLike={},context={}){
  if(Benefit?.snapshotForBooking){
    return Benefit.snapshotForBooking({organizationId:bookingLike.organizationId||null,recipientId:bookingLike.recipientId||null,requestedService:'transportation',serviceDate:bookingLike.pickupDate||null,capturedAt:context.capturedAt||nowISO()});
  }
  return {
    schemaVersion:BOOKING_COMMERCIAL_SNAPSHOT_SCHEMA_VERSION,status:'ruleset_required',cmsLevel:null,
    requestedService:'transportation',estimatedSubsidy:null,rulesetVersion:null,sourceAssessmentId:null,
    explanation:'尚未載入具版本與生效日期的政府補助規則。',capturedAt:context.capturedAt||nowISO()
  };
}
function appendBookingCommercialSnapshotInDb(db,booking,{reason='created',actorUserId=null}={}){
  if(!booking)return null;
  booking.commercialSnapshots=Array.isArray(booking.commercialSnapshots)?booking.commercialSnapshots:[];
  const capturedAt=nowISO(),snapshot={
    id:uid('bterms'),schemaVersion:BOOKING_COMMERCIAL_SNAPSHOT_SCHEMA_VERSION,
    bookingId:booking.id,bookingVersion:Math.max(1,Number(booking.version)||1),reason,
    quote:buildBookingQuoteSnapshot(booking,{capturedAt}),
    benefit:buildBookingBenefitSnapshot(booking,{capturedAt}),
    capturedByUserId:actorUserId||null,capturedAt
  };
  booking.commercialSnapshots.push(snapshot);
  booking.activeCommercialSnapshotId=snapshot.id;
  return snapshot;
}
function currentBookingCommercialSnapshot(booking){
  const rows=Array.isArray(booking?.commercialSnapshots)?booking.commercialSnapshots:[];
  return rows.find(x=>x.id===booking.activeCommercialSnapshotId)||rows[rows.length-1]||null;
}
function bookingCommercialSummary(booking){
  const snap=currentBookingCommercialSnapshot(booking),q=snap?.quote,b=snap?.benefit;
  const quoteText=q?.estimatedFare!=null?`預估 NT$${Number(q.estimatedFare).toLocaleString('zh-TW')}`:'報價待正式定價規則';
  const benefitText=b?.estimatedSubsidy!=null?`補助估算 NT$${Number(b.estimatedSubsidy).toLocaleString('zh-TW')}`:'補助待規則／資格資料';
  return `${quoteText}・${benefitText}`;
}
function bookingRevisionSnapshot(booking){
  return {
    editable:bookingEditablePayload(booking),locations:deepClone(booking.locations||null),legs:deepClone(booking.legs||[]),
    serviceNeeds:deepClone(booking.serviceNeeds||null),commercialSnapshot:deepClone(currentBookingCommercialSnapshot(booking)),
    state:bookingStateOf(booking),organizationId:booking.organizationId||null,bookingVersion:Math.max(1,Number(booking.version)||1),updatedAt:booking.updatedAt||null
  };
}

const BOOKING_DUPLICATE_POLICY=Object.freeze({schemaVersion:1,timeWindowMinutes:60,highConfidenceScore:80,exactRouteWindowMinutes:45});
function bookingIdentityAffinity(candidate,existing){
  let score=0,reasons=[];
  if(candidate?.requestedByUserId&&existing?.requestedByUserId===candidate.requestedByUserId){score=50;reasons.push('同一需求者帳號');}
  else if(candidate?.recipientId&&existing?.recipientId===candidate.recipientId){score=50;reasons.push('同一服務對象');}
  else{
    const phone=digitsOnly(candidate?.phone||''),otherPhone=digitsOnly(existing?.phone||'');
    if(phone&&otherPhone&&phone===otherPhone){score=28;reasons.push('相同聯絡電話');}
    const name=String(candidate?.name||'').trim(),otherName=String(existing?.name||'').trim();
    if(name&&otherName&&name===otherName){score+=8;reasons.push('相同乘車人姓名');}
  }
  return {score,reasons,strong:score>=50};
}
function bookingRouteAffinity(candidate,existing){
  const aPickup=canonicalBookingPlace(candidate?.pickupAddress||candidate?.locations?.pickup?.addressText||''),bPickup=canonicalBookingPlace(existing?.pickupAddress||existing?.locations?.pickup?.addressText||'');
  const aDrop=canonicalBookingPlace(candidate?.destination||candidate?.locations?.dropoff?.addressText||''),bDrop=canonicalBookingPlace(existing?.destination||existing?.locations?.dropoff?.addressText||'');
  const exactPickup=!!aPickup&&aPickup===bPickup,exactDrop=!!aDrop&&aDrop===bDrop;
  if(exactPickup&&exactDrop)return {score:25,reasons:['相同上下車路線'],exact:true};
  const aPickupArea=bookingPublicArea(aPickup),bPickupArea=bookingPublicArea(bPickup),aDropArea=bookingPublicArea(aDrop),bDropArea=bookingPublicArea(bDrop);
  if(aPickupArea!=='區域未填'&&aDropArea!=='區域未填'&&aPickupArea===bPickupArea&&aDropArea===bDropArea)return {score:12,reasons:['上下車行政區相同'],exact:false};
  if((exactPickup&&aDropArea===bDropArea)||(exactDrop&&aPickupArea===bPickupArea))return {score:16,reasons:['其中一端地址相同且另一端同區'],exact:false};
  return {score:0,reasons:[],exact:false};
}
function bookingDuplicateEvaluation(candidate,existing){
  const candidateAt=parseBookingDateTimeStrict(candidate?.pickupDate,candidate?.pickupTime),existingAt=parseBookingDateTimeStrict(existing?.pickupDate,existing?.pickupTime);
  if(!candidateAt||!existingAt)return null;
  const gap=Math.abs(candidateAt-existingAt)/60000;
  if(gap>BOOKING_DUPLICATE_POLICY.timeWindowMinutes)return null;
  const identity=bookingIdentityAffinity(candidate,existing); if(identity.score<28)return null;
  const route=bookingRouteAffinity(candidate,existing);
  let timeScore=gap<=5?25:gap<=15?22:gap<=30?18:gap<=45?14:4;
  const score=Math.min(100,identity.score+route.score+timeScore);
  const highConfidence=(identity.strong&&route.exact&&gap<=BOOKING_DUPLICATE_POLICY.exactRouteWindowMinutes)||score>=BOOKING_DUPLICATE_POLICY.highConfidenceScore;
  return {booking:existing,bookingId:existing.id,score,highConfidence,timeGapMinutes:Math.round(gap),reasons:[...identity.reasons,...route.reasons,`接送時間相差 ${Math.round(gap)} 分鐘`]};
}
function bookingMarketExpiryISO(bookingLike={},createdAt=null){ return sharedBookingMarketExpiryISO(bookingLike,createdAt); }
function bookingMarketExpired(booking,at=Date.now()){
  if(bookingStateOf(booking)!==BOOKING_STATE.OPEN)return false;
  const expires=booking?.marketExpiresAt?new Date(booking.marketExpiresAt):null;
  const expiresMs=expires&&!Number.isNaN(expires.getTime())?expires.getTime():null;
  const pickup=parseBookingDateTimeStrict(booking?.pickupDate,booking?.pickupTime);
  const cutoff=expiresMs??pickup?.getTime()??null;
  return cutoff!==null&&cutoff<=Number(at instanceof Date?at.getTime():at);
}
const BOOKING_LIMITS=Object.freeze({name:80,phone:20,address:220,accessNote:300,aidNeed:120,specialNeed:500,note:1000,companionsMax:6});
const BOOKING_TRIP_TYPES=new Set(['單程','來回']);
function strictBookingDate(value=''){
  const m=String(value||'').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]),dt=new Date(y,mo-1,d);
  if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return null;
  return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function strictBookingTime(value=''){
  const m=String(value||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m)return null;
  const h=Number(m[1]),min=Number(m[2]);
  if(h<0||h>23||min<0||min>59)return null;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function parseBookingDateTimeStrict(dateText,timeText){
  const date=strictBookingDate(dateText),time=strictBookingTime(timeText);
  if(!date||!time)return null;
  const [y,mo,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number);
  const dt=new Date(y,mo-1,d,h,min,0,0);
  return Number.isNaN(dt.getTime())?null:dt;
}
function canonicalBookingPlace(value=''){ return String(value||'').replace(/臺/g,'台').replace(/\s+/g,'').replace(/[，,。．]/g,'').trim(); }
function normalizeBookingPayload(input={}){
  const out=sanitizeBookingCreateInput(input);
  out.recipientId=String(out.recipientId||'').trim()||null;
  out.name=String(out.name||'').trim();
  out.phone=digitsOnly(out.phone||'');
  out.pickupDate=String(out.pickupDate||'').trim();
  out.pickupTime=String(out.pickupTime||'').trim();
  out.pickupAddress=String(out.pickupAddress||'').trim();
  out.pickupAccessNote=String(out.pickupAccessNote||'').trim();
  out.destination=String(out.destination||'').trim();
  out.destinationAccessNote=String(out.destinationAccessNote||'').trim();
  out.tripType=String(out.tripType||'單程').trim()||'單程';
  out.returnDate=String(out.returnDate||'').trim();
  out.returnTime=String(out.returnTime||'').trim();
  out.aidNeed=String(out.aidNeed||'').trim();
  out.specialNeed=String(out.specialNeed||'').trim();
  out.note=String(out.note||'').trim();
  out.consent=String(out.consent||'').trim();
  out.poolingConsent=['yes','no'].includes(String(out.poolingConsent||'').trim())?String(out.poolingConsent).trim():'no';
  out.serviceJurisdiction=BOOKING_SERVICE_JURISDICTIONS.includes(String(out.serviceJurisdiction||'').trim())?String(out.serviceJurisdiction).trim():'';
  if(out.companions===undefined||out.companions===null||String(out.companions).trim()==='') out.companions='';
  else{ const rawCompanions=String(out.companions).trim(),m=rawCompanions.match(/^(\d+)\s*(?:人)?$/); out.companions=m?Number(m[1]):Number.NaN; }
  return out;
}
function validateBookingPayload(input={},options={}){
  const value=normalizeBookingPayload(input),errors=[],warnings=[];
  const requireIdentity=options.requireIdentity!==false,requireFuture=options.requireFuture!==false;
  const date=strictBookingDate(value.pickupDate),time=strictBookingTime(value.pickupTime);
  if(requireIdentity&&!value.name)errors.push('缺少乘車人姓名');
  if(value.name.length>BOOKING_LIMITS.name)errors.push(`姓名不可超過 ${BOOKING_LIMITS.name} 字`);
  if(requireIdentity&&(value.phone.length<9||value.phone.length>15))errors.push('聯絡電話格式不正確');
  if(!date)errors.push('接送日期格式無效'); else value.pickupDate=date;
  if(!time)errors.push('接送時間格式無效'); else value.pickupTime=time;
  if(!value.pickupAddress)errors.push('缺少上車地址');
  if(!value.destination)errors.push('缺少目的地');
  if(value.pickupAddress.length>BOOKING_LIMITS.address||value.destination.length>BOOKING_LIMITS.address)errors.push(`地址不可超過 ${BOOKING_LIMITS.address} 字`);
  if(value.pickupAddress&&value.destination&&canonicalBookingPlace(value.pickupAddress)===canonicalBookingPlace(value.destination))errors.push('上車地址與目的地不可相同');
  if(!BOOKING_TRIP_TYPES.has(value.tripType))errors.push('行程類型只允許單程或來回');
  if(value.pickupAccessNote.length>BOOKING_LIMITS.accessNote||value.destinationAccessNote.length>BOOKING_LIMITS.accessNote)errors.push(`上下車注意事項不可超過 ${BOOKING_LIMITS.accessNote} 字`);
  if(value.tripType==='來回'){
    const returnDate=strictBookingDate(value.returnDate),returnTime=strictBookingTime(value.returnTime);
    if(!returnDate)errors.push('來回預約必須填寫有效的回程日期'); else value.returnDate=returnDate;
    if(!returnTime)errors.push('來回預約必須填寫有效的回程時間'); else value.returnTime=returnTime;
    const outboundAt=parseBookingDateTimeStrict(value.pickupDate,value.pickupTime),returnAt=parseBookingDateTimeStrict(value.returnDate,value.returnTime);
    if(outboundAt&&returnAt&&returnAt.getTime()<=outboundAt.getTime())errors.push('回程時間必須晚於去程時間');
  }else{ value.returnDate=''; value.returnTime=''; }
  if(value.companions!==''&&(!Number.isInteger(value.companions)||value.companions<0||value.companions>BOOKING_LIMITS.companionsMax))errors.push(`陪同人數必須是 0～${BOOKING_LIMITS.companionsMax} 的整數`);
  if(value.aidNeed.length>BOOKING_LIMITS.aidNeed)errors.push(`輔具需求不可超過 ${BOOKING_LIMITS.aidNeed} 字`);
  if(value.specialNeed.length>BOOKING_LIMITS.specialNeed)errors.push(`特殊需求不可超過 ${BOOKING_LIMITS.specialNeed} 字`);
  if(value.note.length>BOOKING_LIMITS.note)errors.push(`備註不可超過 ${BOOKING_LIMITS.note} 字`);
  const dateTime=parseBookingDateTimeStrict(value.pickupDate,value.pickupTime);
  if(date&&time&&!dateTime)errors.push('接送日期時間無法解析');
  if(dateTime&&requireFuture&&dateTime.getTime()<Date.now()-60000)errors.push('接送時間不可早於現在');
  if(dateTime&&!requireFuture&&dateTime.getTime()<Date.now()-60000)warnings.push('此筆為過去日期，僅作歷史／來源同步保留');
  return {ok:errors.length===0,errors,warnings,value,dateTime};
}

// 遮蔽需求池（state-load 的 data.pool，來自 app_state_booking_pool）轉成接案畫面用的形狀。
// 只使用 view 露出的欄位：行政區、時間、行程類型、服務需求列舉值；沒有門牌、姓名、電話。
function bookingPoolProjection(row){
  if(!row||!row.id)return null;
  const wheelchairs=Math.max(0,Number(row.wheelchair_slots)||0),companions=Math.max(0,Number(row.companions)||0);
  const needs=[row.aid_need,wheelchairs?`輪椅 ${wheelchairs} 位`:'',companions?`陪同 ${companions} 人`:''].filter(Boolean).join('・')||'一般接送需求';
  return Object.freeze({id:String(row.id),version:Math.max(1,Number(row.version)||1),state:BOOKING_STATE.OPEN,marketExpiresAt:row.market_expires_at||'',
    pickupDate:String(row.pickup_at||''),pickupTime:String(row.pickup_time||''),tripType:String(row.trip_type||'單程'),returnDate:String(row.return_date||''),returnTime:String(row.return_time||''),
    pickupArea:row.pickup_area||'區域未填',destinationArea:row.destination_area||'區域未填',destinationLabel:row.destination_area||'未填',
    needsSummary:needs,serviceConstraints:Object.freeze({requiresAccessibleVehicle:wheelchairs>0,requiresEscort:false,companions}),source:'demand_pool'});
}
function bookingPublicArea(address=''){
  const text=String(address||'').replace(/臺/g,'台').replace(/\s+/g,'');
  const city=text.match(/(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)/)?.[1]||'';
  const remainder=city&&text.startsWith(city)?text.slice(city.length):text;
  const district=remainder.match(/([^市縣]{1,5}(?:區|鄉|鎮|市))/)?.[1]||'';
  return `${city}${district}`||'區域未填';
}
function bookingPublicDestinationLabel(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '未填';
  const containsDetailedAddress=/\d|(?:路|街|大道|段|巷|弄|號)/.test(raw);
  return containsDetailedAddress?bookingPublicArea(raw):raw.slice(0,40);
}
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
async function withBookingClaimLock(bookingId,task){
  const lockName=`careRide.booking.claim.${bookingId}`;
  if(globalThis.navigator?.locks?.request){
    return navigator.locks.request(lockName,{mode:'exclusive'},task);
  }
  const key=`${APP_CONFIG.storageKey}:claim-lock:${bookingId}`,token=uid('claimlock'),leaseMs=4000;
  for(let attempt=0;attempt<8;attempt++){
    const now=Date.now();
    let current=null;
    try{ current=JSON.parse(LocalStore.getItem(key)||'null'); }catch{}
    if(!current||Number(current.expiresAt||0)<=now){
      LocalStore.setItem(key,JSON.stringify({token,expiresAt:now+leaseMs}));
      let confirmed=null;
      try{ confirmed=JSON.parse(LocalStore.getItem(key)||'null'); }catch{}
      if(confirmed?.token===token){
        try{return await task();}
        finally{
          let latest=null;try{latest=JSON.parse(LocalStore.getItem(key)||'null');}catch{}
          if(latest?.token===token) LocalStore.removeItem(key);
        }
      }
    }
    await sleep(30+Math.floor(Math.random()*50));
  }
  return {ok:false,error:'此需求正在被其他人接案，請重新整理後再試'};
}
function bookingEventActorName(userId){ return (store?.state?.users||[]).find(u=>u.id===userId)?.name||(userId?'未知使用者':'系統'); }
function appendBookingEventInDb(db,{bookingId,eventType,action=null,fromState=null,toState=null,actorUserId=null,organizationId=null,tripId=null,reasonCode=null,reasonText='',source='booking',bookingVersion=null,metadata=null,createdAt=null}={}){
  db.bookingEvents=Array.isArray(db.bookingEvents)?db.bookingEvents:[];
  const event={id:uid('bevt'),bookingId,eventType,action,fromState,toState,actorUserId:actorUserId||null,organizationId:organizationId||null,tripId:tripId||null,reasonCode:reasonCode||null,reasonText:String(reasonText||'').trim().slice(0,500),source,bookingVersion:bookingVersion===null?null:Number(bookingVersion),metadata:metadata&&typeof metadata==='object'?deepClone(metadata):null,createdAt:createdAt||nowISO()};
  db.bookingEvents.unshift(event);
  return event;
}
function bookingReasonText(reasonCode,reasonText=''){
  const label=BOOKING_REASON_LABELS[reasonCode]||reasonCode||'';
  const extra=String(reasonText||'').trim();
  return [label,extra].filter(Boolean).join('：');
}
function bookingStateOf(booking){
  if(!booking) return null;
  if(BOOKING_STATE_VALUES.has(booking.state)) return booking.state;
  if(booking.status==='partially_scheduled') return BOOKING_STATE.PARTIALLY_SCHEDULED;
  if(booking.status==='scheduled') return BOOKING_STATE.SCHEDULED;
  if(booking.status==='rejected') return BOOKING_STATE.REJECTED;
  if(booking.status==='cancelled'||booking.claimStatus==='cancelled') return BOOKING_STATE.CANCELLED;
  if(booking.status==='expired'||booking.claimStatus==='expired') return BOOKING_STATE.EXPIRED;
  if(booking.organizationId||booking.claimStatus==='claimed') return BOOKING_STATE.CLAIMED;
  return BOOKING_STATE.OPEN;
}
function syncBookingLegacyLifecycleFields(booking){
  const state=bookingStateOf(booking);
  booking.state=state;
  if(state===BOOKING_STATE.OPEN){
    booking.status='pending';
    booking.claimStatus='open';
    booking.organizationId=null;
    booking.claimedByUserId=null;
    booking.claimedAt=null;
    booking.tripId=null;
  }else if(state===BOOKING_STATE.CLAIMED){
    booking.status='pending';
    booking.claimStatus='claimed';
    booking.tripId=null;
  }else if(state===BOOKING_STATE.PARTIALLY_SCHEDULED){
    booking.status='partially_scheduled';
    booking.claimStatus='claimed';
    booking.tripId=scheduledBookingLegs(booking)[0]?.tripId||null;
  }else if(state===BOOKING_STATE.SCHEDULED){
    booking.status='scheduled';
    booking.claimStatus='claimed';
    booking.tripId=scheduledBookingLegs(booking)[0]?.tripId||booking.tripId||null;
  }else if(state===BOOKING_STATE.REJECTED){
    booking.status='rejected';
    booking.claimStatus='closed';
    booking.tripId=null;
  }else if(state===BOOKING_STATE.CANCELLED){
    booking.status='cancelled';
    booking.claimStatus='cancelled';
    booking.tripId=null;
  }else if(state===BOOKING_STATE.EXPIRED){
    booking.status='expired';
    booking.claimStatus='expired';
    booking.organizationId=null;
    booking.claimedByUserId=null;
    booking.claimedAt=null;
    booking.tripId=null;
  }
  return booking;
}
function bookingTransitionCheck(booking,action,context={}){
  if(!booking) return {ok:false,error:'找不到預約'};
  const from=bookingStateOf(booking),to=BOOKING_TRANSITIONS[from]?.[action];
  if(!to) return {ok:false,error:`預約目前為 ${from}，不能執行 ${action}`};
  if(context.expectedVersion!==undefined&&context.expectedVersion!==null){
    const expected=Number(context.expectedVersion),actual=Math.max(1,Number(booking.version)||1);
    if(!Number.isInteger(expected)||expected<1) return {ok:false,error:'預約版本資訊無效，請重新整理'};
    if(actual!==expected) return {ok:false,error:'此需求資料已更新或已被其他人處理，請重新整理'};
  }
  if(action==='claim'){
    if(!context.organizationId||!context.userId) return {ok:false,error:'接案缺少組織或操作人員'};
    if(booking.organizationId) return {ok:false,error:'此需求已被其他組織接走'};
  }
  if(BOOKING_ACTION_REASON_REQUIRED.has(action)&&!String(context.reasonCode||'').trim()) return {ok:false,error:'請選擇此操作的原因'};
  if(action==='release'){
    if(scheduledBookingLegs(booking).length)return {ok:false,error:'已有 Leg 完成排車，不能再整張退回公開池；請由調度處理剩餘 Leg'};
    if(!booking.organizationId) return {ok:false,error:'此預約目前沒有承接組織，無法退回公開池'};
    if(context.organizationId&&booking.organizationId!==context.organizationId) return {ok:false,error:'只能由目前承接組織退回此需求'};
  }
  if(action==='schedule'){
    if(!context.tripId) return {ok:false,error:'建立行程時缺少 tripId'};
    if(!booking.organizationId) return {ok:false,error:'公開需求尚未接案，不能直接排車'};
    if(context.organizationId&&booking.organizationId!==context.organizationId) return {ok:false,error:'預約承接組織與行程組織不一致'};
  }
  return {ok:true,from,to};
}
function applyBookingTransitionRecord(booking,action,context={}){
  const check=bookingTransitionCheck(booking,action,context);
  if(!check.ok) return check;
  const at=context.at||nowISO();
  booking.state=check.to;
  booking.updatedAt=at;
  booking.stateChangedAt=at;
  booking.version=Math.max(1,Number(booking.version)||1)+1;
  if(action==='claim'){
    booking.organizationId=context.organizationId;
    booking.claimedByUserId=context.userId;
    booking.claimedAt=at;
  }else if(action==='release'){
    booking.lastReleasedAt=at;
    booking.lastReleasedByUserId=context.userId||null;
    booking.lastReleaseReasonCode=context.reasonCode||null;
    booking.lastReleaseReasonText=String(context.reasonText||'').trim();
  }else if(action==='schedule'){
    booking.tripId=context.tripId;
    booking.scheduledAt=at;
  }else if(action==='reject'){
    booking.rejectedAt=at;
    booking.rejectedByUserId=context.userId||null;
    booking.rejectReasonCode=context.reasonCode||null;
    booking.rejectReasonText=String(context.reasonText||'').trim();
  }else if(action==='expire'){
    booking.expiredAt=at;
    booking.expiryReason=context.reasonText||'公開接案期限已到';
  }else if(action==='cancel'){
    booking.cancelledAt=at;
    booking.cancelledByUserId=context.userId||null;
    booking.cancelReasonCode=context.reasonCode||null;
    booking.cancelReasonText=String(context.reasonText||'').trim();
    const legTripIds=scheduledBookingLegs(booking).map(l=>l.tripId).filter(Boolean);
    booking.cancelledTripIds=[...new Set([...(booking.cancelledTripIds||[]),...legTripIds])];
    booking.cancelledTripId=booking.cancelledTripIds[0]||booking.tripId||booking.cancelledTripId||null;
    (booking.legs||[]).forEach(l=>{if(l.status!==BOOKING_LEG_STATUS.CANCELLED)l.status=BOOKING_LEG_STATUS.CANCELLED;});
  }
  syncBookingLegacyLifecycleFields(booking);
  return {ok:true,from:check.from,to:check.to,booking};
}
function bookingServiceNeedsSnapshot(recipient){ return CareRecipient.bookingProfile(recipient)?.defaultServiceNeeds||{aidNeed:'',companions:0,specialNeed:'',requiresAccessibleVehicle:false,requiresEscort:false,transferAssistance:'unknown'}; }
function bookingServiceNeedsOverrides(input={}){
  const aid=String(input.aidNeed||'').trim(),special=String(input.specialNeed||'').trim();
  const hasCompanions=input.companions!==undefined&&input.companions!==null&&String(input.companions)!=='';
  return {aidNeed:aid||null,companions:hasCompanions?Math.max(0,Number(input.companions)||0):null,specialNeed:special||null};
}
function createBookingServiceNeeds(input,recipient,existing=null){
  if(existing?.recipientDefaultsSnapshot&&existing?.bookingOverrides)return existing;
  return {schemaVersion:1,recipientDefaultsSnapshot:bookingServiceNeedsSnapshot(recipient),bookingOverrides:bookingServiceNeedsOverrides(input),capturedAt:input.submittedAt||nowISO()};
}


function bookingLegById(booking,legId){ return (booking?.legs||[]).find(l=>l.id===legId)||null; }
function nextBookingLeg(booking){ return pendingBookingLegs(booking).sort((a,b)=>a.sequence-b.sequence)[0]||null; }
function bookingLegResponsibleOrganization(booking,leg){ return leg?.assignedOrganizationId||leg?.scheduledOrganizationId||booking?.organizationId||null; }
function bookingDispatchView(booking){
  if(!booking)return null;
  const now=Date.now(),futureLeg=[...(booking.legs||[])].filter(l=>l.requestedPickupAt&&!Number.isNaN(new Date(l.requestedPickupAt).getTime())&&new Date(l.requestedPickupAt).getTime()>=now).sort((a,b)=>new Date(a.requestedPickupAt)-new Date(b.requestedPickupAt))[0]||null;
  const leg=nextBookingLeg(booking)||futureLeg||booking.legs?.[0]||null;
  if(!leg)return booking;
  const parts=leg.requestedPickupAt?localDateTimeParts(leg.requestedPickupAt):{date:booking.pickupDate||'',time:booking.pickupTime||''};
  return {...booking,activeLegId:leg.id,activeLegDirection:leg.direction,activeLegLabel:leg.label,activeLegOrganizationId:bookingLegResponsibleOrganization(booking,leg),pickupDate:parts.date,pickupTime:parts.time,pickupAddress:locationSnapshotAddress(leg.pickup,booking.pickupAddress),destination:locationSnapshotAddress(leg.dropoff,booking.destination),pickupAccessNote:leg.pickup?.accessNote||'',destinationAccessNote:leg.dropoff?.accessNote||''};
}
function bookingDispatchViewForLeg(booking,legId){
  if(!booking||!legId)return null;
  const leg=bookingLegById(booking,legId);if(!leg)return null;
  const parts=leg.requestedPickupAt?localDateTimeParts(leg.requestedPickupAt):{date:booking.pickupDate||'',time:booking.pickupTime||''};
  return {...booking,activeLegId:leg.id,activeLegDirection:leg.direction,activeLegLabel:leg.label,activeLegOrganizationId:bookingLegResponsibleOrganization(booking,leg),pickupDate:parts.date,pickupTime:parts.time,pickupAddress:locationSnapshotAddress(leg.pickup,booking.pickupAddress),destination:locationSnapshotAddress(leg.dropoff,booking.destination),pickupAccessNote:leg.pickup?.accessNote||'',destinationAccessNote:leg.dropoff?.accessNote||''};
}
function canScheduleBookingLegRecord(booking,legId,context={}){
  if(!booking)return {ok:false,error:'找不到預約'};
  const state=bookingStateOf(booking);
  if(![BOOKING_STATE.CLAIMED,BOOKING_STATE.PARTIALLY_SCHEDULED].includes(state))return {ok:false,error:`預約目前為 ${state}，不能新增行程 Leg`};
  if(!booking.organizationId)return {ok:false,error:'預約尚未有主要承接組織'};
  const leg=bookingLegById(booking,legId)||nextBookingLeg(booking);
  if(!leg)return {ok:false,error:'沒有待排車的去程／回程 Leg'};
  const responsibleOrganizationId=bookingLegResponsibleOrganization(booking,leg);
  if(!responsibleOrganizationId)return {ok:false,error:'此行程段 尚未指定承接組織'};
  if(context.organizationId&&responsibleOrganizationId!==context.organizationId)return {ok:false,error:'此行程段 的承接組織與行程組織不一致'};
  if(leg.status!==BOOKING_LEG_STATUS.PENDING)return {ok:false,error:`${leg.label||'此行程段'} 已經排車或不可再排車`};
  if(!leg.requestedPickupAt||Number.isNaN(new Date(leg.requestedPickupAt).getTime()))return {ok:false,error:`${leg.label||'此行程段'} 缺少有效接送時間`};
  if(!context.tripId)return {ok:false,error:'建立行程時缺少 tripId'};
  return {ok:true,leg,state,responsibleOrganizationId};
}
function scheduleBookingLegInDb(db,bookingId,legId,context={}){
  const booking=(db.bookings||[]).find(b=>b.id===bookingId),check=canScheduleBookingLegRecord(booking,legId,context);
  if(!check.ok)return check;
  const at=context.at||nowISO(),from=check.state,leg=check.leg;
  leg.status=BOOKING_LEG_STATUS.SCHEDULED;leg.tripId=context.tripId;leg.scheduledOrganizationId=context.organizationId||check.responsibleOrganizationId||booking.organizationId;leg.scheduledAt=at;
  const allScheduled=(booking.legs||[]).length>0&&(booking.legs||[]).every(l=>l.status===BOOKING_LEG_STATUS.SCHEDULED);
  booking.state=allScheduled?BOOKING_STATE.SCHEDULED:BOOKING_STATE.PARTIALLY_SCHEDULED;
  booking.updatedAt=at;booking.stateChangedAt=at;booking.version=Math.max(1,Number(booking.version)||1)+1;
  if(allScheduled)booking.scheduledAt=at;
  syncBookingLegacyLifecycleFields(booking);
  appendBookingEventInDb(db,{bookingId,eventType:'leg_scheduled',action:'schedule',fromState:from,toState:booking.state,actorUserId:context.userId||null,organizationId:context.organizationId||check.responsibleOrganizationId||booking.organizationId||null,tripId:context.tripId,source:context.source||'booking',bookingVersion:booking.version,metadata:{legId:leg.id,direction:leg.direction,label:leg.label,allLegsScheduled:allScheduled}});
  return {ok:true,from,to:booking.state,booking,leg};
}
Booking = {
  STATE:BOOKING_STATE,
  PERMISSION:BOOKING_PERMISSION,
  eventLabel(eventType){return BOOKING_EVENT_LABELS[eventType]||String(eventType||'異動');},
  eventActorName(userId){return bookingEventActorName(userId);},
  reasonLabel(code){return BOOKING_REASON_LABELS[code]||String(code||'');},
  reasonText(code,text=''){return bookingReasonText(code,text);},
  commercialSummary(bookingOrId){return bookingCommercialSummary(typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId);},
  validate(input,options={}){ return validateBookingPayload(input,options); },
  duplicateCandidates(candidate,{excludeId=null,highConfidenceOnly=false}={}){
    return store.state.bookings.map(existing=>{
      if(existing.id===excludeId||[BOOKING_STATE.REJECTED,BOOKING_STATE.CANCELLED,BOOKING_STATE.EXPIRED].includes(this.stateOf(existing)))return null;
      return bookingDuplicateEvaluation(candidate,existing);
    }).filter(x=>x&&(!highConfidenceOnly||x.highConfidence)).sort((a,b)=>b.score-a.score||a.timeGapMinutes-b.timeGapMinutes);
  },
  get(id){ return store.state.bookings.find(b=>b.id===id); },
  isMarketExpired(bookingOrId,at=Date.now()){return bookingMarketExpired(typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId,at);},
  expireStaleOpen({at=Date.now(),source='expiry_sweep'}={}){
    const due=store.state.bookings.filter(b=>this.isMarketExpired(b,at)).map(b=>b.id);if(!due.length)return {ok:true,count:0,bookingIds:[]};
    const expired=[];store.mutate(db=>{due.forEach(id=>{const row=(db.bookings||[]).find(b=>b.id===id);if(!row||!bookingMarketExpired(row,at))return;const result=this.transitionInDb(db,id,'expire',{userId:null,organizationId:null,source,reasonText:'公開接案期限已到',at:new Date(Number(at instanceof Date?at.getTime():at)).toISOString()});if(result.ok)expired.push(id);});});
    expired.forEach(id=>Audit.log('booking_expired',`Booking ${id} 公開接案期限已到`,{bookingId:id,source}));return {ok:true,count:expired.length,bookingIds:expired};
  },
  listForOrganization(organizationId,actorUserId){
    if(!bookingActorCan(actorUserId,BOOKING_PERMISSION.READ_CLAIMED,organizationId))return [];
    return store.state.bookings.filter(b=>b.organizationId===organizationId);
  },
  listClaimedByUser(organizationId,userId){
    const allowed=bookingActorCan(userId,BOOKING_PERMISSION.READ_CLAIMED,organizationId)||bookingActorCan(userId,BOOKING_PERMISSION.READ_CLAIMED_OWN,organizationId);if(!allowed)return [];
    return store.state.bookings.filter(b=>b.organizationId===organizationId&&b.claimedByUserId===userId);
  },
  listForDispatch(organizationId,date=null,actorUserId=null){
    if(!actorUserId||!bookingActorCan(actorUserId,BOOKING_PERMISSION.READ_CLAIMED,organizationId))return [];
    return store.state.bookings.filter(b=>[BOOKING_STATE.CLAIMED,BOOKING_STATE.PARTIALLY_SCHEDULED].includes(bookingStateOf(b))).map(b=>bookingDispatchView(b)).filter(b=>b&&b.activeLegId&&b.activeLegOrganizationId===organizationId&&(!date||b.pickupDate===date));
  },
  hasRecipientForOrganization(recipientId,organizationId){ return !!organizationId&&store.state.bookings.some(b=>b.organizationId===organizationId&&b.recipientId===recipientId&&!['rejected','cancelled','expired'].includes(b.status)); },
  recipientIdsForOrganization(organizationId){ return [...new Set(store.state.bookings.filter(b=>b.organizationId===organizationId&&b.recipientId).map(b=>b.recipientId))]; },
  recipientReferences(){ return store.state.bookings.filter(b=>b.recipientId).map(b=>({bookingId:b.id,recipientId:b.recipientId,state:bookingStateOf(b)})); },
  futureActiveForRecipient(recipientId,at=new Date()){
    const cutoff=at instanceof Date?at:new Date(at);return store.state.bookings.filter(b=>b.recipientId===recipientId&&![BOOKING_STATE.REJECTED,BOOKING_STATE.CANCELLED,BOOKING_STATE.EXPIRED].includes(bookingStateOf(b))).filter(b=>{const dt=parseBookingDateTimeStrict(b.pickupDate,b.pickupTime);return !!dt&&dt>=cutoff;});
  },
  reassignRecipientInDb(db,fromRecipientId,toRecipientId){ let count=0;(db.bookings||[]).forEach(b=>{if(b.recipientId===fromRecipientId){b.recipientId=toRecipientId;b.updatedAt=nowISO();count++;}});return count; },
  stateOf(bookingOrId){ return bookingStateOf(typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId); },
  canTransition(id,action,context={}){
    const booking=this.get(id);if(!booking)return {ok:false,error:'找不到預約'};
    if(action==='schedule')return this.canScheduleLegForTrip(id,context.legId,{...context,tripId:context.tripId||'__preview__'});
    if(action==='claim'&&!bookingActorCan(context.userId,BOOKING_PERMISSION.MARKET_CLAIM,context.organizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.MARKET_CLAIM)};
    if(action==='release'&&!(bookingActorCan(context.userId,BOOKING_PERMISSION.RELEASE,booking.organizationId)||(booking.claimedByUserId===context.userId&&bookingActorCan(context.userId,BOOKING_PERMISSION.RELEASE_OWN,booking.organizationId))))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.RELEASE)};
    if(action==='reject'&&!bookingActorCan(context.userId,BOOKING_PERMISSION.REJECT,booking.organizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.REJECT)};
    if(action==='cancel'&&!(booking.requestedByUserId===context.userId&&bookingActorCan(context.userId,BOOKING_PERMISSION.CANCEL_OWN,APP_CONFIG.requesterOrganizationId)))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.CANCEL_OWN)};
    return bookingTransitionCheck(booking,action,context);
  },
  transitionInDb(db,id,action,context={}){
    const row=(db.bookings||[]).find(x=>x.id===id),beforeOrg=row?.organizationId||null,beforeTrip=row?.tripId||null;
    const result=applyBookingTransitionRecord(row,action,context);
    if(result.ok){
      appendBookingEventInDb(db,{bookingId:id,eventType:BOOKING_ACTION_EVENT[action]||'state_changed',action,fromState:result.from,toState:result.to,actorUserId:context.userId||null,organizationId:context.organizationId||beforeOrg||row?.organizationId||null,tripId:context.tripId||beforeTrip||row?.tripId||null,reasonCode:context.reasonCode||null,reasonText:context.reasonText||'',source:context.source||'booking',bookingVersion:row?.version||null,createdAt:row?.stateChangedAt||nowISO()});
    }
    return result;
  },
  transition(id,action,context={}){
    if(action==='claim')return {ok:false,error:'公開接案必須使用 Booking.claim() 以保留版本鎖與併發檢查'};
    if(action==='schedule')return {ok:false,error:'Booking 排車必須由 Trip Contract 建立，不能直接變更狀態'};
    const permissionCheck=this.canTransition(id,action,context);if(!permissionCheck.ok)return permissionCheck;
    let result={ok:false,error:'找不到預約'};
    store.mutate(db=>{ result=this.transitionInDb(db,id,action,context); });
    if(result.ok){
      Audit.log('booking_state_changed',`Booking ${id}：${result.from} → ${result.to}`,{bookingId:id,action,fromState:result.from,toState:result.to,organizationId:context.organizationId||this.get(id)?.organizationId||null,actorUserId:context.userId||null,tripId:context.tripId||null,reasonCode:context.reasonCode||null,reasonText:context.reasonText||''});
    }
    return result.ok?{...result,booking:this.get(id)}:result;
  },
  rawEvents(id){ return (store.state.bookingEvents||[]).filter(e=>e.bookingId===id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); },
  events(id,userId){ return this.canReadEvents(id,userId)?this.rawEvents(id):[]; },
  canReadEvents(id,userId){
    const b=this.get(id),u=(store.state.users||[]).find(x=>x.id===userId&&x.active!==false); if(!b||!u)return false;
    if(u.platformRole==='super_admin'&&bookingActorCan(userId,BOOKING_PERMISSION.AUDIT_READ,null))return true;
    if(b.requestedByUserId===userId&&bookingActorCan(userId,BOOKING_PERMISSION.AUDIT_READ_OWN,APP_CONFIG.requesterOrganizationId))return true;
    const history=this.rawEvents(id),historicalOrgIds=new Set(history.map(e=>e.organizationId).filter(Boolean)); if(b.organizationId)historicalOrgIds.add(b.organizationId);
    if([...historicalOrgIds].some(orgId=>bookingActorCan(userId,BOOKING_PERMISSION.AUDIT_READ,orgId)))return true;
    const participated=b.claimedByUserId===userId||history.some(e=>e.actorUserId===userId);
    return participated&&[...historicalOrgIds].some(orgId=>bookingActorCan(userId,BOOKING_PERMISSION.AUDIT_READ_PARTICIPATED,orgId));
  },
  effectiveServiceNeeds(bookingOrId){
    const b=typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId;if(!b)return {aidNeed:'',companions:0,specialNeed:'',requiresAccessibleVehicle:false,requiresEscort:false,transferAssistance:'unknown'};
    const recipientProfile=CareRecipient.bookingProfile(b.recipientId),fallbackDefaults=recipientProfile?.defaultServiceNeeds||{aidNeed:'',companions:0,specialNeed:'',requiresAccessibleVehicle:false,requiresEscort:false,transferAssistance:'unknown'},sn=b.serviceNeeds||{},defaults={...fallbackDefaults,...(sn.recipientDefaultsSnapshot||{})},overrides=sn.bookingOverrides||bookingServiceNeedsOverrides(b);
    const aidNeed=overrides.aidNeed!==null&&overrides.aidNeed!==undefined&&String(overrides.aidNeed)!==''?String(overrides.aidNeed):String(defaults.aidNeed||'');
    const specialNeed=overrides.specialNeed!==null&&overrides.specialNeed!==undefined&&String(overrides.specialNeed)!==''?String(overrides.specialNeed):String(defaults.specialNeed||'');
    const companions=overrides.companions!==null&&overrides.companions!==undefined?Math.max(0,Number(overrides.companions)||0):Math.max(0,Number(defaults.companions)||0);
    return {aidNeed,companions,specialNeed,requiresAccessibleVehicle:!!(defaults.requiresAccessibleVehicle||/輪椅|無障礙|升降/.test(`${aidNeed} ${specialNeed}`)),requiresEscort:!!(defaults.requiresEscort||companions>0||/陪同/.test(specialNeed)),transferAssistance:defaults.transferAssistance||'unknown'};
  },
  needsText(bookingOrId){ const n=this.effectiveServiceNeeds(bookingOrId),extra=[];if(n.requiresAccessibleVehicle&&!/輪椅|無障礙|升降/.test(n.aidNeed||''))extra.push('需無障礙車');if(n.requiresEscort&&!n.companions&&!/陪同|協助/.test(n.specialNeed||''))extra.push('需陪同協助');return [n.aidNeed,n.companions?`陪同 ${n.companions} 人`:null,n.specialNeed,...extra].filter(Boolean).join('・')||'一般接送需求'; },
  publicProjection(bookingOrId){
    const b=typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId;
    if(!b||this.stateOf(b)!==BOOKING_STATE.OPEN) return null;
    const needs=this.effectiveServiceNeeds(b);
    return Object.freeze({
      id:b.id,version:Math.max(1,Number(b.version)||1),state:BOOKING_STATE.OPEN,marketExpiresAt:b.marketExpiresAt||bookingMarketExpiryISO(b,b.submittedAt||b.updatedAt||null),
      pickupDate:String(b.pickupDate||''),pickupTime:String(b.pickupTime||''),tripType:String(b.tripType||'單程'),returnDate:String(b.returnDate||''),returnTime:String(b.returnTime||''),
      pickupArea:bookingPublicArea(locationSnapshotAddress(b.locations?.pickup,b.pickupAddress)),destinationArea:bookingPublicArea(locationSnapshotAddress(b.locations?.dropoff,b.destination)),destinationLabel:bookingPublicDestinationLabel(locationSnapshotAddress(b.locations?.dropoff,b.destination)),
      needsSummary:this.needsText(b),
      serviceConstraints:Object.freeze({requiresAccessibleVehicle:!!needs.requiresAccessibleVehicle,requiresEscort:!!needs.requiresEscort,companions:Math.max(0,Number(needs.companions)||0)})
    });
  },
  openDemand(date=null,userId=null){
    if(!bookingActorCanAnyOrganization(userId,BOOKING_PERMISSION.MARKET_READ)&&!bookingActorCan(userId,BOOKING_PERMISSION.MARKET_READ,null))return [];
    // 未承接的需求不會出現在 bookings：後端 RLS 只回傳呼叫者有權看的原始資料。
    // 公開需求只能讀 state-load 回傳的遮蔽需求池（app_state_booking_pool）。
    const now=Date.now(),at=b=>parseBookingDateTimeStrict(b.pickupDate,b.pickupTime);
    return (store.state.demandPool||[])
      .map(row=>bookingPoolProjection(row))
      .filter(b=>{if(!b)return false;const dt=at(b);if(!dt||dt.getTime()<now)return false;const exp=b.marketExpiresAt?new Date(b.marketExpiresAt).getTime():NaN;if(Number.isFinite(exp)&&exp<=now)return false;return !date||b.pickupDate===date;})
      .sort((a,b)=>(at(a)?.getTime()??Number.MAX_SAFE_INTEGER)-(at(b)?.getTime()??Number.MAX_SAFE_INTEGER));
  },
  async claim(id,organizationId,userId,expectedVersion){
    // 接案由後端 app.claim_app_state_booking 決定：組織權限、組織類型、FOR UPDATE 搶單。
    // 本機不先改 store——那會變成一筆 state-mutate 寫入，而一般寫入管道不允許接案。
    if(!bookingActorCan(userId,BOOKING_PERMISSION.MARKET_CLAIM,organizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.MARKET_CLAIM)};
    const token=typeof backendAuthToken==='function'?backendAuthToken():'';
    if(!token)return {ok:false,error:'請先登入後再接案'};
    try{
      const response=await fetch(APP_CONFIG.claimBookingUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},credentials:'same-origin',cache:'no-store',body:JSON.stringify({bookingId:id,organizationId,expectedVersion:Number(expectedVersion)||null})});
      const result=await response.json().catch(()=>null);
      if(!response.ok||!result?.ok)return {ok:false,code:result?.error?.code||null,error:result?.error?.message||`接案失敗（HTTP ${response.status}）`};
      return {ok:true,organization:Organization.get(organizationId)||{id:organizationId,name:'目前組織'},serverVersion:result.data?.version??null};
    }catch(error){return {ok:false,error:`接案失敗：${error?.message||error}`};}
  },
  listForUser(organizationId,userId){ return this.listForOrganization(organizationId,userId).filter(b=>b.requestedByUserId===userId).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)); },
  listForRequesterUser(userId){
    if(!bookingActorCan(userId,BOOKING_PERMISSION.READ_OWN,APP_CONFIG.requesterOrganizationId))return [];
    return store.state.bookings.filter(b=>b.requestedByUserId===userId).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  },
  nextPendingLeg(bookingOrId){ const b=typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId;return nextBookingLeg(b); },
  dispatchView(bookingOrId){ return bookingDispatchView(typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId); },
  dispatchViewForLeg(bookingOrId,legId){ return bookingDispatchViewForLeg(typeof bookingOrId==='string'?this.get(bookingOrId):bookingOrId,legId); },
  pending(organizationId,date=null,actorUserId=null){
    if(actorUserId&&!bookingActorCan(actorUserId,BOOKING_PERMISSION.READ_CLAIMED,organizationId))return [];
    return this.listForDispatch(organizationId,date,actorUserId);
  },
  dateTime(booking){ const view=booking?.activeLegId?booking:this.dispatchView(booking);return parseBookingDateTimeStrict(view?.pickupDate,view?.pickupTime); },
  reject(id,userId=null,reasonCode='unsupported_service',reasonText=''){
    const booking=this.get(id); if(!booking)return {ok:false,error:'找不到預約'};
    if(!bookingActorCan(userId,BOOKING_PERMISSION.REJECT,booking.organizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.REJECT)};
    return this.transition(id,'reject',{userId,organizationId:booking.organizationId,reasonCode,reasonText});
  },
  release(id,userId,reasonCode,reasonText=''){
    const booking=this.get(id); if(!booking)return {ok:false,error:'找不到預約'};
    if(this.stateOf(booking)!==BOOKING_STATE.CLAIMED)return {ok:false,error:'只有尚未建立任何 Leg 行程的已接案預約可以退回公開池'};
    const canRelease=bookingActorCan(userId,BOOKING_PERMISSION.RELEASE,booking.organizationId)||(booking.claimedByUserId===userId&&bookingActorCan(userId,BOOKING_PERMISSION.RELEASE_OWN,booking.organizationId));
    if(!canRelease)return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.RELEASE)};
    const released=this.transition(id,'release',{userId,organizationId:booking.organizationId,reasonCode,reasonText});
    if(released.ok&&this.isMarketExpired(released.booking)){
      let expireResult={ok:false};store.mutate(db=>{expireResult=this.transitionInDb(db,id,'expire',{userId:null,source:'release_guard',reasonText:'退回公開池時已超過接案期限'});});
      if(expireResult.ok)Audit.log('booking_expired',`Booking ${id} 退回公開池時已過期`,{bookingId:id,source:'release_guard'});
      return {ok:true,booking:this.get(id),releasedThenExpired:true};
    }
    return released;
  },
  canScheduleLegForTrip(id,legId,context={}){
    const booking=this.get(id); if(!booking)return {ok:false,error:'找不到預約'};
    const leg=bookingLegById(booking,legId)||nextBookingLeg(booking),responsibleOrganizationId=bookingLegResponsibleOrganization(booking,leg);
    if(!responsibleOrganizationId||!bookingActorCan(context.userId,BOOKING_PERMISSION.SCHEDULE,responsibleOrganizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.SCHEDULE)};
    return canScheduleBookingLegRecord(booking,legId,{...context,organizationId:context.organizationId||responsibleOrganizationId});
  },
  scheduleLegForTripInDb(db,id,legId,context={}){
    const booking=(db.bookings||[]).find(b=>b.id===id); if(!booking)return {ok:false,error:'找不到預約'};
    const leg=bookingLegById(booking,legId)||nextBookingLeg(booking),responsibleOrganizationId=bookingLegResponsibleOrganization(booking,leg);
    if(!responsibleOrganizationId||!bookingActorCan(context.userId,BOOKING_PERMISSION.SCHEDULE,responsibleOrganizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.SCHEDULE)};
    return scheduleBookingLegInDb(db,id,legId,{...context,organizationId:context.organizationId||responsibleOrganizationId});
  },
  assignPendingLegOrganization(id,legId,targetOrganizationId,actorUserId){
    if(!bookingActorCan(actorUserId,BOOKING_PERMISSION.LEG_ASSIGN_ORG,null))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.LEG_ASSIGN_ORG)};
    const target=Organization.get(targetOrganizationId);if(!target||target.active===false||!['transport_provider','care_facility'].includes(target.type))return {ok:false,error:'目標承接組織不存在或目前不可承接'};
    let result={ok:false,error:'指定失敗'};
    store.mutate(db=>{
      const row=(db.bookings||[]).find(b=>b.id===id);if(!row){result={ok:false,error:'找不到預約'};return;}
      const state=bookingStateOf(row);if(![BOOKING_STATE.CLAIMED,BOOKING_STATE.PARTIALLY_SCHEDULED].includes(state)){result={ok:false,error:'只有已接案或部分已排車的 Booking 可以跨組織指定待排 Leg'};return;}
      const leg=bookingLegById(row,legId)||nextBookingLeg(row);if(!leg||leg.status!==BOOKING_LEG_STATUS.PENDING){result={ok:false,error:'找不到可重新指定的待排 Leg'};return;}
      const fromOrganizationId=bookingLegResponsibleOrganization(row,leg),at=nowISO();
      leg.assignedOrganizationId=targetOrganizationId;leg.assignedAt=at;leg.assignedByUserId=actorUserId;row.updatedAt=at;row.version=Math.max(1,Number(row.version)||1)+1;
      appendBookingEventInDb(db,{bookingId:id,eventType:'leg_organization_assigned',fromState:state,toState:state,actorUserId,organizationId:targetOrganizationId,source:'platform_admin',bookingVersion:row.version,metadata:{legId:leg.id,label:leg.label,fromOrganizationId,toOrganizationId:targetOrganizationId}});
      result={ok:true,booking:row,leg,fromOrganizationId,toOrganizationId:targetOrganizationId};
    });
    if(result.ok)Audit.log('booking_leg_organization_assigned',`Booking ${id} ${result.leg.label||'Leg'} 指定給 ${target.name}`,{bookingId:id,actorUserId,organizationId:targetOrganizationId,fromOrganizationId:result.fromOrganizationId,legId:result.leg.id});
    return result.ok?{...result,booking:this.get(id)}:result;
  },
  markScheduled(id,tripId,organizationId=null,userId=null,legId=null){ let result={ok:false,error:'找不到預約'};store.mutate(db=>{result=this.scheduleLegForTripInDb(db,id,legId,{tripId,organizationId,userId});});return result.ok?{...result,booking:this.get(id)}:result; },
  create(input,context={}){
    const ctx=typeof context==='string'?{organizationId:context}:(context||{});
    const organizationId=ctx.organizationId||null,requestedByUserId=ctx.requestedByUserId||null,source=ctx.source||'internal';
    const validation=this.validate(input,{requireIdentity:true,requireFuture:ctx.requireFuture!==false});
    if(!validation.ok)return {ok:false,error:validation.errors[0],errors:validation.errors};
    const safeInput=validation.value;
    const recipient=CareRecipient.resolveForBooking({...safeInput,requestedByUserId,source},{organizationId,userId:requestedByUserId});
    if(!recipient)return {ok:false,error:'無法建立或解析服務對象主檔'};
    const duplicateCandidate={...safeInput,requestedByUserId,recipientId:recipient.id};
    const duplicateMatches=this.duplicateCandidates(duplicateCandidate,{highConfidenceOnly:true});
    if(duplicateMatches.length){
      const d=duplicateMatches[0];
      store.mutate(db=>appendBookingEventInDb(db,{bookingId:d.bookingId,eventType:'duplicate_detected',fromState:bookingStateOf(d.booking),toState:bookingStateOf(d.booking),actorUserId:requestedByUserId||ctx.claimedByUserId||null,organizationId:d.booking.organizationId||organizationId||null,source,bookingVersion:d.booking.version||null,metadata:{attemptedPickupDate:safeInput.pickupDate,attemptedPickupTime:safeInput.pickupTime,score:d.score,reasons:d.reasons}}));
      Audit.log('booking_duplicate_blocked',`阻擋疑似重複預約，既有 Booking ${d.bookingId}`,{bookingId:d.bookingId,actorUserId:requestedByUserId||ctx.claimedByUserId||null,score:d.score,reasons:d.reasons});
      return {ok:false,error:`偵測到高度疑似重複預約（${d.reasons.join('、')}），請先確認既有預約`,duplicateBookingId:d.bookingId,duplicateScore:d.score,duplicateReasons:d.reasons};
    }
    const submittedAt=nowISO(),serviceNeeds=createBookingServiceNeeds({...safeInput,submittedAt},recipient,null),initialState=organizationId?BOOKING_STATE.CLAIMED:BOOKING_STATE.OPEN;
    const bookingId=uid('booking'),locations=bookingLocationsFromLegacy(safeInput);
    const booking={
      ...safeInput,
      id:bookingId,recipientId:recipient.id,requestedByUserId,source,submittedAt,
      externalBookingId:ctx.externalBookingId||null,
      organizationId,claimedByUserId:ctx.claimedByUserId||null,claimedAt:organizationId?submittedAt:null,
      state:initialState,status:'pending',claimStatus:organizationId?'claimed':'open',tripId:null,
      version:1,revisionNo:0,stateChangedAt:submittedAt,updatedAt:submittedAt,serviceNeeds,locations,
      marketExpiresAt:sharedBookingMarketExpiryISO(safeInput,submittedAt),expiryPolicyVersion:BOOKING_EXPIRY_POLICY.policyVersion,expiredAt:null,expiryReason:null,
      legs:bookingLegsFromLegacy(bookingId,safeInput,locations),commercialSnapshots:[],activeCommercialSnapshotId:null
    };
    applyServiceJurisdictionSnapshot(booking,recipient,{explicit:safeInput.serviceJurisdiction||null,source:'booking_create'});
    syncBookingLegacyLifecycleFields(booking);
    store.mutate(db=>{db.bookings.push(booking);const actorUserId=requestedByUserId||ctx.claimedByUserId||null,commercialSnapshot=appendBookingCommercialSnapshotInDb(db,booking,{reason:'created',actorUserId});appendBookingEventInDb(db,{bookingId:booking.id,eventType:'created',fromState:null,toState:booking.state,actorUserId,organizationId,source:booking.source,bookingVersion:booking.version,metadata:{externalBookingId:booking.externalBookingId||null,commercialSnapshotId:commercialSnapshot?.id||null}});appendBookingEventInDb(db,{bookingId:booking.id,eventType:'commercial_snapshot_captured',fromState:booking.state,toState:booking.state,actorUserId,organizationId,source:'booking_commercial_snapshot',bookingVersion:booking.version,metadata:{revisionNo:0,commercialSnapshotId:commercialSnapshot?.id||null}});});
    Audit.log('booking_created',`建立預約 ${booking.id}`,{bookingId:booking.id,organizationId,source:booking.source,requestedByUserId:booking.requestedByUserId||null,externalBookingId:booking.externalBookingId});
    return booking;
  },
  createForRequester(input,userId){
    if(!userId)return {ok:false,error:'尚未登入'};
    if(!bookingActorCan(userId,BOOKING_PERMISSION.CREATE_OWN,APP_CONFIG.requesterOrganizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.CREATE_OWN)};
    const user=(store.state.users||[]).find(u=>u.id===userId&&u.active!==false); if(!user)return {ok:false,error:'找不到有效需求者帳號'};
    const phone=String(user.phone||'').replace(/\D/g,''); if(phone.length<9)return {ok:false,error:'請先在我的帳戶補齊正確手機號碼'};
    const profileSync=CareRecipient.syncRequesterIdentityForBooking(userId,{name:user.name||'需求者',phone}); if(!profileSync.ok)return profileSync;
    const selfRecipient=profileSync.recipient||CareRecipient.selfForUser(userId);
    const booking=this.create({...input,recipientId:selfRecipient?.id||null,name:user.name||'需求者',phone,consent:'同意'},{organizationId:null,requestedByUserId:userId,source:'requester_app'});
    return booking?.ok===false?booking:{ok:true,booking};
  },
  canEditOwn(id,userId){
    if(!bookingActorCan(userId,BOOKING_PERMISSION.EDIT_OWN,APP_CONFIG.requesterOrganizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.EDIT_OWN)};
    const booking=this.get(id);if(!booking||booking.requestedByUserId!==userId)return {ok:false,error:'找不到可修改的預約'};
    const state=this.stateOf(booking);
    if(![BOOKING_STATE.OPEN,BOOKING_STATE.CLAIMED].includes(state))return {ok:false,error:'預約已進入排車或結案階段，不能直接修改；請聯絡承接單位處理'};
    if((booking.legs||[]).some(l=>l.status!==BOOKING_LEG_STATUS.PENDING))return {ok:false,error:'已有去程／回程 Leg 進入排車，不能直接修改'};
    return {ok:true,booking,state};
  },
  amendOwn(id,userId,input,reasonText='需求者修改預約'){
    const allowed=this.canEditOwn(id,userId);if(!allowed.ok)return allowed;
    const existing=allowed.booking;
    const validation=this.validate({...input,recipientId:existing.recipientId,name:existing.name,phone:existing.phone,consent:existing.consent||'同意'},{requireIdentity:true,requireFuture:true});
    if(!validation.ok)return {ok:false,error:validation.errors[0],errors:validation.errors};
    const safe=validation.value,beforeEditable=bookingEditablePayload(existing),afterEditable=bookingEditablePayload(safe),changedFields=bookingChangedFields(beforeEditable,afterEditable);
    if(!changedFields.length)return {ok:false,error:'沒有偵測到可儲存的修改'};
    const duplicateMatches=this.duplicateCandidates({...safe,requestedByUserId:existing.requestedByUserId,recipientId:existing.recipientId,name:existing.name,phone:existing.phone},{excludeId:id,highConfidenceOnly:true});
    if(duplicateMatches.length){
      const d=duplicateMatches[0];
      store.mutate(db=>appendBookingEventInDb(db,{bookingId:d.bookingId,eventType:'duplicate_detected',fromState:bookingStateOf(d.booking),toState:bookingStateOf(d.booking),actorUserId:userId,organizationId:d.booking.organizationId||null,source:'requester_amend',bookingVersion:d.booking.version||null,metadata:{attemptedBookingId:id,attemptedPickupDate:safe.pickupDate,attemptedPickupTime:safe.pickupTime,score:d.score,reasons:d.reasons}}));
      Audit.log('booking_duplicate_amend_blocked',`阻擋修改後重複預約 ${id}`,{bookingId:id,duplicateBookingId:d.bookingId,actorUserId:userId,score:d.score,reasons:d.reasons});
      return {ok:false,error:`修改後會與高度疑似重複預約衝突（${d.reasons.join('、')}）`,duplicateBookingId:d.bookingId,duplicateScore:d.score,duplicateReasons:d.reasons};
    }
    let result={ok:false,error:'修改失敗'};
    store.mutate(db=>{
      const row=(db.bookings||[]).find(b=>b.id===id);if(!row){result={ok:false,error:'找不到預約'};return;}
      const liveCheck=this.canEditOwn(id,userId);if(!liveCheck.ok){result=liveCheck;return;}
      const at=nowISO(),revisionNo=Math.max(0,Number(row.revisionNo)||0)+1;
      const beforeState=bookingStateOf(row),beforeOrganizationId=row.organizationId||null,beforeClaimedByUserId=row.claimedByUserId||null;
      const requiresReconfirm=beforeState===BOOKING_STATE.CLAIMED&&changedFields.some(field=>BOOKING_RECONFIRM_FIELDS.has(field));
      db.bookingRevisions=Array.isArray(db.bookingRevisions)?db.bookingRevisions:[];
      db.bookingRevisions.unshift({id:uid('brev'),schemaVersion:BOOKING_REVISION_SCHEMA_VERSION,bookingId:id,revisionNo,actorUserId:userId,reasonText:String(reasonText||'需求者修改預約').trim().slice(0,500),changedFields:[...changedFields],snapshot:bookingRevisionSnapshot(row),createdAt:at});
      BOOKING_EDITABLE_FIELDS.forEach(k=>{row[k]=safe[k]??'';});
      row.locations=bookingLocationsFromLegacy(row,row.locations||null);
      row.legs=bookingLegsFromLegacy(row.id,row,row.locations,row.legs||null);
      row.serviceNeeds={schemaVersion:1,recipientDefaultsSnapshot:deepClone(row.serviceNeeds?.recipientDefaultsSnapshot||bookingServiceNeedsSnapshot(row.recipientId)),bookingOverrides:bookingServiceNeedsOverrides(row),capturedAt:row.serviceNeeds?.capturedAt||row.submittedAt||at,lastAmendedAt:at};
      row.revisionNo=revisionNo;row.version=Math.max(1,Number(row.version)||1)+1;row.updatedAt=at;row.marketExpiresAt=sharedBookingMarketExpiryISO(row,row.submittedAt||at);row.expiryPolicyVersion=BOOKING_EXPIRY_POLICY.policyVersion;row.expiredAt=null;row.expiryReason=null;
      if(requiresReconfirm){
        row.state=BOOKING_STATE.OPEN;
        row.reconfirmationRequired=true;row.reconfirmationTriggeredAt=at;row.lastClaimInvalidatedOrganizationId=beforeOrganizationId;row.lastClaimInvalidatedByUserId=beforeClaimedByUserId;
        row.lastReleasedAt=at;row.lastReleasedByUserId=userId;row.lastReleaseReasonCode='amendment_requires_reconfirm';row.lastReleaseReasonText='需求者重大修改，原承接失效並重新開放接案';
      }
      syncBookingLegacyLifecycleFields(row);
      const commercialSnapshot=appendBookingCommercialSnapshotInDb(db,row,{reason:'amended',actorUserId:userId});
      appendBookingEventInDb(db,{bookingId:id,eventType:'amended',fromState:beforeState,toState:row.state,actorUserId:userId,organizationId:beforeOrganizationId||row.organizationId||null,source:'requester_app',bookingVersion:row.version,reasonText,metadata:{revisionNo,changedFields,commercialSnapshotId:commercialSnapshot?.id||null,reconfirmationRequired:requiresReconfirm}});
      if(requiresReconfirm)appendBookingEventInDb(db,{bookingId:id,eventType:'claim_invalidated_by_amendment',fromState:beforeState,toState:BOOKING_STATE.OPEN,actorUserId:userId,organizationId:beforeOrganizationId,source:'requester_app',bookingVersion:row.version,reasonCode:'amendment_requires_reconfirm',reasonText:'需求者重大修改，原承接失效並重新開放接案',metadata:{revisionNo,changedFields,previousClaimedByUserId:beforeClaimedByUserId}});
      appendBookingEventInDb(db,{bookingId:id,eventType:'commercial_snapshot_captured',fromState:row.state,toState:row.state,actorUserId:userId,organizationId:row.organizationId||beforeOrganizationId||null,source:'booking_commercial_snapshot',bookingVersion:row.version,metadata:{revisionNo,commercialSnapshotId:commercialSnapshot?.id||null}});
      result={ok:true,revisionNo,changedFields,commercialSnapshotId:commercialSnapshot?.id||null,reconfirmationRequired:requiresReconfirm,previousOrganizationId:beforeOrganizationId};
    });
    if(result.ok){
      Audit.log('booking_amended',`需求者修改預約 ${id}`,{bookingId:id,actorUserId:userId,organizationId:result.previousOrganizationId||existing.organizationId||null,revisionNo:result.revisionNo,changedFields:result.changedFields,reconfirmationRequired:result.reconfirmationRequired});
      if(result.reconfirmationRequired)Audit.log('booking_claim_invalidated_by_amendment',`Booking ${id} 因重大修改解除原承接並重新公開`,{bookingId:id,actorUserId:userId,organizationId:result.previousOrganizationId||null,changedFields:result.changedFields});
    }
    return result.ok?{...result,booking:this.get(id)}:result;
  },
  revisions(id,userId){return this.canReadEvents(id,userId)?(store.state.bookingRevisions||[]).filter(r=>r.bookingId===id).sort((a,b)=>b.revisionNo-a.revisionNo):[];},
  commercialSnapshot(id){return currentBookingCommercialSnapshot(this.get(id));},
  canCancelOwn(id,userId){
    if(!bookingActorCan(userId,BOOKING_PERMISSION.CANCEL_OWN,APP_CONFIG.requesterOrganizationId))return {ok:false,error:bookingPermissionError(BOOKING_PERMISSION.CANCEL_OWN)};
    const booking=this.get(id); if(!booking||booking.requestedByUserId!==userId)return {ok:false,error:'找不到可取消的預約'};
    const state=this.stateOf(booking);
    if([BOOKING_STATE.OPEN,BOOKING_STATE.CLAIMED].includes(state))return {ok:true,state,trips:[]};
    // 已排車時行程由調度員建立，需求者本機拿不到行程資料（後端 RLS 不回傳），
    // 無法在本機判斷行程是否已開始。改由 cancel-booking 端點在交易內驗證。
    if([BOOKING_STATE.PARTIALLY_SCHEDULED,BOOKING_STATE.SCHEDULED].includes(state))return {ok:true,state,trips:[],serverValidated:true};
    return {ok:false,error:'此預約目前不可取消'};
  },
  async cancelOwn(id,userId,reasonCode,reasonText=''){
    const allowed=this.canCancelOwn(id,userId); if(!allowed.ok)return allowed;
    if(!String(reasonCode||'').trim())return {ok:false,error:'請選擇此操作的原因'};
    const token=typeof backendAuthToken==='function'?backendAuthToken():'';
    if(!token)return {ok:false,error:'請先登入後再取消預約'};
    // 預約與關聯行程由後端 app.cancel_app_state_booking 在同一交易內處理；
    // 本機不先改 store，避免產生需求者無權寫入的行程異動。
    // 取消通知（司機 trip_cancelled、需求者 booking_cancelled）也由後端在同一交易內
    // 排入 notifications，重新載入後出現；取消失敗不會留下通知。
    try{
      const response=await fetch(APP_CONFIG.cancelBookingUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},credentials:'same-origin',cache:'no-store',body:JSON.stringify({bookingId:id,reasonCode,reasonText})});
      const result=await response.json().catch(()=>null);
      if(!response.ok||!result?.ok)return {ok:false,code:result?.error?.code||null,error:result?.error?.message||`取消失敗（HTTP ${response.status}）`};
      const refresh=await AppStateDatabase.loadAll({silent:true});
      return {ok:true,booking:this.get(id),cancelledTripIds:result.data?.cancelledTripIds||[],repairedTripIds:[],notificationIds:result.data?.notificationIds||[],refreshError:refresh?.ok===false?(refresh.error||'重新載入失敗'):null};
    }catch(error){return {ok:false,error:`取消失敗：${error?.message||error}`};}
  },
  // syncFromPublishedSheet 已移除。
  // 它從一份「發布到網路」的 Google 試算表匯入預約——那種連結不需要登入，
  // 任何拿到網址的人都能下載全部內容，而網址就寫在這個檔案裡（等於公開）。
  // 實際內容是乘客姓名、電話、完整地址與醫療狀況，不該用這種方式流通。
  // 這個方法在移除時已經沒有任何呼叫點。預約資料現在一律走 Postgres。
};
}


{
const DRIVER_STATUS_VALUES = Object.freeze(['off_duty','on_duty','break','unavailable']);
const DRIVER_STATUS_LABELS = Object.freeze({off_duty:'未執勤',on_duty:'執勤中',break:'休息中',unavailable:'不可派車'});
const VEHICLE_STATUS_VALUES = Object.freeze(['available','maintenance','retired']);
const VEHICLE_STATUS_LABELS = Object.freeze({available:'可派車',maintenance:'維修／保養中',retired:'已退役'});

function activeRoleMembership(organizationId,actorUserId,roles=[]){
  return store.state.memberships.find(m=>m.organizationId===organizationId&&m.userId===actorUserId&&roles.includes(m.role)&&(m.status||'active')==='active');
}
function activeOwnerMembership(organizationId,actorUserId){ return activeRoleMembership(organizationId,actorUserId,['owner']); }
function activeDriverMembership(userId,organizationId){ return activeRoleMembership(organizationId,userId,['driver']); }
function isPlatformAdminActor(actorUserId){
  const user=store.state.users.find(u=>u.id===actorUserId);
  return !!(user&&user.active!==false&&user.platformRole==='super_admin');
}
function incompleteTripsForOrganization(organizationId){
  return store.state.trips.filter(t=>t.organizationId===organizationId&&!isTripTerminalStatus(t.status));
}
function incompleteTripsForDriver(driverId){
  return store.state.trips.filter(t=>t.driverId===driverId&&!isTripTerminalStatus(t.status));
}
function inProgressTripsForDriver(driverId){
  return store.state.trips.filter(t=>t.driverId===driverId&&t.status==='in_progress');
}
function tripRequirementSnapshot(trip){
  const bookings=(trip?.bookingIds||[]).map(id=>store.state.bookings.find(b=>b.id===id)).filter(Boolean);
  const passengerUnits=Number(trip?.passengerCount)||Math.max(1,bookings.reduce((sum,b)=>sum+1+Math.max(0,Number(Booking.effectiveServiceNeeds(b).companions||0)||0),0));
  const wheelchairUnits=bookings.length
    ?bookings.reduce((sum,b)=>{const n=Booking.effectiveServiceNeeds(b);return sum+(/輪椅/.test(`${n.aidNeed||''} ${n.specialNeed||''}`)?1:0);},0)
    :(/輪椅/.test(trip?.needs||'')?1:0);
  const needs=String(trip?.needs||'');
  return {passengerUnits,wheelchairUnits,needs};
}
function summarizeTripCodes(rows,limit=3){
  const codes=rows.slice(0,limit).map(t=>t.code||t.id).join('、');
  return rows.length>limit?`${codes} 等 ${rows.length} 趟`:codes;
}
function normalizeVehiclePlate(value=''){ return String(value||'').trim().toUpperCase().replace(/\s+/g,''); }
function taxIdInUse(taxId,ignoreOrganizationId=null){
  const normalized=digitsOnly(taxId); if(!normalized) return false;
  return store.state.organizations.some(o=>o.id!==ignoreOrganizationId&&digitsOnly(o.taxId)===normalized);
}
function enrichDriverProfile(raw){
  if(!raw) return undefined;
  const user=store.state.users.find(u=>u.id===raw.userId);
  return {...raw,name:user?.name||'未知司機',phone:user?.phone||''};
}
function tripsForVehicle(vehicleId){
  return store.state.trips.filter(t=>t.vehicleId===vehicleId);
}
function incompleteTripsForVehicle(vehicleId){
  return tripsForVehicle(vehicleId).filter(t=>!isTripTerminalStatus(t.status));
}
function draftDispatchPlansForVehicle(vehicleId){
  return (store.state.dispatchPlans||[]).filter(plan=>plan.status!=='applied'&&(plan.items||[]).some(item=>item.vehicleId===vehicleId));
}
function vehicleUsageSnapshot(vehicleId){
  const trips=tripsForVehicle(vehicleId);
  const incompleteTrips=trips.filter(t=>!isTripTerminalStatus(t.status));
  const draftPlans=draftDispatchPlansForVehicle(vehicleId);
  return {
    tripCount:trips.length,
    incompleteTripCount:incompleteTrips.length,
    draftPlanCount:draftPlans.length,
    canHardDelete:trips.length===0&&draftPlans.length===0,
    canRetire:incompleteTrips.length===0
  };
}
function validateVehicleInput(input,organizationId,ignoreVehicleId=null){
  const organization=store.state.organizations.find(o=>o.id===organizationId);
  if(!organization) return {ok:false,error:'找不到公司'};
  if(organization.active===false) return {ok:false,error:'公司目前已停用，不能異動車輛'};
  if(organization.systemManaged) return {ok:false,error:'系統管理組織不能管理車輛'};
  const plate=normalizeVehiclePlate(input.plate),model=String(input.model||'').trim();
  const capacity=Number(input.capacity),wheelchairSlots=Number(input.wheelchairSlots);
  const accessible=!!input.accessible,status=String(input.status||'available');
  if(!plate) return {ok:false,error:'請輸入車牌'};
  if(!model) return {ok:false,error:'請輸入車型'};
  if(store.state.vehicles.some(v=>v.id!==ignoreVehicleId&&normalizeVehiclePlate(v.plate)===plate)) return {ok:false,error:'此車牌已存在'};
  if(!Number.isInteger(capacity)||capacity<1||capacity>20) return {ok:false,error:'載客量必須為 1～20 的整數'};
  if(!Number.isInteger(wheelchairSlots)||wheelchairSlots<0||wheelchairSlots>6) return {ok:false,error:'輪椅位必須為 0～6 的整數'};
  if(wheelchairSlots>capacity) return {ok:false,error:'輪椅位不可大於載客量'};
  if(wheelchairSlots>0&&!accessible) return {ok:false,error:'有輪椅位的車輛必須設定為具無障礙設備'};
  if(!VEHICLE_STATUS_VALUES.includes(status)) return {ok:false,error:'車輛狀態不合法'};
  let fleetId=input.fleetId||null;
  if(fleetId){
    const fleet=store.state.fleets.find(f=>f.id===fleetId&&f.organizationId===organizationId&&f.active!==false);
    if(!fleet) return {ok:false,error:'指定車隊不屬於目前公司或已停用'};
  }else fleetId=store.state.fleets.find(f=>f.organizationId===organizationId&&f.active!==false)?.id||null;
  return {ok:true,value:{plate,model,capacity,wheelchairSlots,accessible,status,fleetId}};
}

Organization = {
  get(id){ return store.state.organizations.find(o=>o.id===id); },
  list({includeInactive=true}={}){ const rows=[...store.state.organizations]; return includeInactive?rows:rows.filter(o=>o.active!==false); },
  serviceOrganizations(){ return store.state.organizations.filter(o=>o.active!==false&&['transport_provider','care_facility'].includes(o.type)&&o.id!==APP_CONFIG.requesterOrganizationId); },
  incompleteTrips(organizationId){ return incompleteTripsForOrganization(organizationId); },
  drivers(organizationId){ return store.state.drivers.filter(d=>d.organizationId===organizationId&&d.active!==false&&!!activeDriverMembership(d.userId,organizationId)).map(enrichDriverProfile); },
  driver(id){ return enrichDriverProfile(store.state.drivers.find(d=>d.id===id)); },
  driverForUser(userId,organizationId=null){ return enrichDriverProfile(store.state.drivers.find(d=>d.userId===userId&&d.active!==false&&(!organizationId||d.organizationId===organizationId))); },
  vehicles(organizationId){ return store.state.vehicles.filter(v=>v.organizationId===organizationId); },
  dispatchableVehicles(organizationId){ return this.vehicles(organizationId).filter(v=>v.status==='available'); },
  vehicle(id){ return store.state.vehicles.find(v=>v.id===id); },
  vehicleUsage(vehicleId){ return vehicleUsageSnapshot(vehicleId); },
  vehicleStatusLabel(status){ return VEHICLE_STATUS_LABELS[status]||status||'未知'; },
  driverStatusLabel(status){ return DRIVER_STATUS_LABELS[status]||status||'未知'; },
  isOwnerActor(organizationId,actorUserId){ return !!activeOwnerMembership(organizationId,actorUserId); },
  canManageDriverProfiles(organizationId,actorUserId){ return isPlatformAdminActor(actorUserId)||!!activeOwnerMembership(organizationId,actorUserId); },
  canManageTripResources(organizationId,actorUserId){ return !!activeRoleMembership(organizationId,actorUserId,['owner','dispatcher']); },
  tripVehicleForDriver(driverId,date=dateKey()){
    const trips=store.state.trips.filter(t=>t.driverId===driverId&&t.date===date&&!isTripTerminalStatus(t.status)).sort((a,b)=>tripWindow(a).start-tripWindow(b).start);
    return this.vehicle(trips[0]?.vehicleId);
  },

  setDriverDuty(driverId,status,actorUserId){
    const raw=store.state.drivers.find(d=>d.id===driverId);
    if(!raw||raw.active===false) return {ok:false,error:'司機資料不存在或已停用'};
    if(!DRIVER_STATUS_VALUES.includes(status)) return {ok:false,error:'司機狀態不合法'};
    const organization=this.get(raw.organizationId);
    if(!organization||organization.active===false) return {ok:false,error:'公司目前已停用，司機不能變更執勤狀態'};
    if(!activeDriverMembership(raw.userId,raw.organizationId)) return {ok:false,error:'司機 Membership 目前不是有效狀態'};

    const actorIsSelf=actorUserId===raw.userId;
    const actorIsManager=!!activeRoleMembership(raw.organizationId,actorUserId,['owner','dispatcher']);
    if(!actorIsSelf&&!actorIsManager) return {ok:false,error:'只有司機本人、調度員或公司負責人可以調整司機狀態'};

    const current=DRIVER_STATUS_VALUES.includes(raw.status)?raw.status:'off_duty';
    if(current===status) return {ok:true,driver:this.driver(driverId),unchanged:true};
    const selfTransitions={off_duty:['on_duty'],on_duty:['break','off_duty'],break:['on_duty','off_duty'],unavailable:[]};
    const managerTransitions={off_duty:['unavailable'],on_duty:['off_duty','unavailable'],break:['off_duty','unavailable'],unavailable:['off_duty']};
    const allowed=actorIsSelf?(selfTransitions[current]||[]):(managerTransitions[current]||[]);
    if(!allowed.includes(status)){
      if(actorIsSelf&&current==='unavailable') return {ok:false,error:'目前被公司設定為不可派車，需由調度員或負責人先恢復'};
      return {ok:false,error:`不允許從「${current}」切換為「${status}」`};
    }

    const inProgress=inProgressTripsForDriver(driverId);
    if((status==='break'||status==='off_duty')&&inProgress.length) return {ok:false,error:`目前仍有進行中行程 ${summarizeTripCodes(inProgress)}，請先完成或改派`};
    if(status==='unavailable'){
      const incomplete=incompleteTripsForDriver(driverId);
      if(incomplete.length) return {ok:false,error:`此司機仍有未完成行程 ${summarizeTripCodes(incomplete)}，請先由調度完成改派再設為不可派車`};
    }

    store.mutate(db=>{ const d=db.drivers.find(x=>x.id===driverId); if(d){d.status=status;d.updatedAt=nowISO();} });
    Audit.log('driver_duty_changed',`司機 ${driverId}：${current} → ${status}`,{driverId,organizationId:raw.organizationId,actorUserId});
    return {ok:true,driver:this.driver(driverId)};
  },

  addOrganization(input,actorUserId){
    if(!isPlatformAdminActor(actorUserId)) return {ok:false,error:'只有平台超級管理者可以建立組織'};
    const name=String(input.name||'').trim(); if(!name) return {ok:false,error:'請輸入組織名稱'};
    const cleanTaxId=digitsOnly(input.taxId),cleanPhone=String(input.contactPhone||'').trim();
    if(cleanTaxId&&cleanTaxId.length!==8) return {ok:false,error:'統一編號請輸入 8 位數字'};
    if(cleanTaxId&&taxIdInUse(cleanTaxId)) return {ok:false,error:'此統一編號已被其他組織使用'};
    if(cleanPhone&&!isValidCompanyPhone(cleanPhone)) return {ok:false,error:'公司聯絡電話請輸入 02 開頭市話或 09 開頭手機'};
    const organization={id:uid('org'),type:input.type||'transport_provider',name,taxId:cleanTaxId,contactPhone:cleanPhone?canonicalCompanyPhone(cleanPhone):'',active:true,createdAt:nowISO()};
    const fleet=organization.type==='transport_provider'?{id:uid('fleet'),organizationId:organization.id,name:`${name} 車隊`,active:true}:null;
    store.mutate(db=>{db.organizations.push(organization);if(fleet)db.fleets.push(fleet);});
    Audit.log('organization_created',`新增組織 ${name}`,{organizationId:organization.id,actorUserId});
    return {ok:true,organization};
  },
  updateOrganizationDetails(id,{name,taxId,contactPhone},actorUserId){
    if(!isPlatformAdminActor(actorUserId)) return {ok:false,error:'只有平台超級管理者可以修改組織資料'};
    const target=this.get(id); if(!target) return {ok:false,error:'找不到組織'};
    if(target.systemManaged) return {ok:false,error:'系統管理組織不可編輯公司資料'};
    const cleanName=String(name||'').trim(),cleanTaxId=digitsOnly(taxId),cleanPhone=String(contactPhone||'').trim();
    if(!cleanName) return {ok:false,error:'請輸入組織名稱'};
    if(cleanTaxId&&cleanTaxId.length!==8) return {ok:false,error:'統一編號請輸入 8 位數字'};
    if(cleanTaxId&&taxIdInUse(cleanTaxId,id)) return {ok:false,error:'此統一編號已被其他組織使用'};
    if(cleanPhone&&!isValidCompanyPhone(cleanPhone)) return {ok:false,error:'公司聯絡電話請輸入 02 開頭市話或 09 開頭手機'};
    const previousName=target.name;
    store.mutate(db=>{const o=db.organizations.find(x=>x.id===id);o.name=cleanName;o.taxId=cleanTaxId;o.contactPhone=cleanPhone?canonicalCompanyPhone(cleanPhone):'';o.updatedAt=nowISO();db.fleets.filter(f=>f.organizationId===id&&f.name===`${previousName} 車隊`).forEach(f=>f.name=`${cleanName} 車隊`);});
    Audit.log('organization_details_updated',`更新組織資料 ${previousName} → ${cleanName}`,{organizationId:id,actorUserId});
    return {ok:true,organization:this.get(id)};
  },
  setOrganizationActive(id,active,actorUserId){
    if(!isPlatformAdminActor(actorUserId)) return {ok:false,error:'只有平台超級管理者可以停用或重新啟用組織'};
    const target=this.get(id); if(!target) return {ok:false,error:'找不到組織'};
    if(target.systemManaged) return {ok:false,error:'需求者組織為系統必要組織，不可移除'};
    if(!active){
      const incomplete=incompleteTripsForOrganization(id);
      if(incomplete.length) return {ok:false,error:`此組織仍有未完成行程 ${summarizeTripCodes(incomplete)}，請先完成或改派後再停用組織`};
      if(this.list({includeInactive:false}).filter(o=>!o.systemManaged).length<=1) return {ok:false,error:'至少必須保留一個有效公司組織'};
    }
    store.mutate(db=>{const o=db.organizations.find(x=>x.id===id);o.active=!!active;o.updatedAt=nowISO();});
    Audit.log(active?'organization_reactivated':'organization_removed',`${active?'重新啟用':'移除'}組織 ${target.name}`,{organizationId:id,actorUserId});
    return {ok:true,organization:this.get(id)};
  },

  addVehicle(input,organizationId,actorUserId){
    if(!this.isOwnerActor(organizationId,actorUserId)) return {ok:false,error:'只有公司負責人可以新增車輛'};
    const validated=validateVehicleInput(input,organizationId); if(!validated.ok) return validated;
    const vehicle={id:uid('veh'),organizationId,...validated.value,retiredAt:null,retiredByUserId:null,createdAt:nowISO(),updatedAt:nowISO()};
    store.mutate(db=>db.vehicles.push(vehicle));
    Audit.log('vehicle_created',`新增車輛 ${vehicle.plate}`,{vehicleId:vehicle.id,organizationId,actorUserId});
    return {ok:true,vehicle};
  },

  updateVehicle(vehicleId,input,actorUserId){
    const target=this.vehicle(vehicleId); if(!target) return {ok:false,error:'找不到可編輯車輛'};
    if(!this.isOwnerActor(target.organizationId,actorUserId)) return {ok:false,error:'只有公司負責人可以修改車輛'};
    const validated=validateVehicleInput({...target,...input},target.organizationId,vehicleId); if(!validated.ok) return validated;
    if(target.status==='retired'&&validated.value.status!=='retired') return {ok:false,error:'已退役車輛屬於歷史資料，不能恢復為可派車或維修／保養中'};

    const incompleteTrips=incompleteTripsForVehicle(vehicleId);
    if(validated.value.status!=='available'&&incompleteTrips.length){
      return {ok:false,error:`此車仍有未完成行程 ${summarizeTripCodes(incompleteTrips)}，請先改派車輛後再切換為「${this.vehicleStatusLabel(validated.value.status)}」`};
    }

    const incompatible=incompleteTrips.filter(trip=>{
      const req=tripRequirementSnapshot(trip);
      return req.passengerUnits>validated.value.capacity
        || req.wheelchairUnits>validated.value.wheelchairSlots
        || ((req.wheelchairUnits>0||/輪椅|升降|無障礙/.test(req.needs))&&!validated.value.accessible);
    });
    if(incompatible.length) return {ok:false,error:`修改後的車輛規格無法承接既有未完成行程 ${summarizeTripCodes(incompatible)}，請先改派再降低載客量、輪椅位或無障礙能力`};

    const previousStatus=target.status,previousPlate=target.plate;
    const retiring=previousStatus!=='retired'&&validated.value.status==='retired';
    store.mutate(db=>{
      const vehicle=db.vehicles.find(v=>v.id===vehicleId);
      Object.assign(vehicle,validated.value,{updatedAt:nowISO()});
      if(retiring){ vehicle.retiredAt=nowISO(); vehicle.retiredByUserId=actorUserId||null; }
    });
    Audit.log(retiring?'vehicle_retired':'vehicle_updated',retiring
      ?`車輛 ${previousPlate} 已退役`
      :`更新車輛 ${previousPlate} → ${validated.value.plate}；狀態 ${previousStatus} → ${validated.value.status}`,
      {vehicleId,organizationId:target.organizationId,actorUserId});
    return {ok:true,vehicle:this.vehicle(vehicleId)};
  },

  retireVehicle(vehicleId,actorUserId){
    const target=this.vehicle(vehicleId); if(!target) return {ok:false,error:'找不到可退役車輛'};
    if(!this.isOwnerActor(target.organizationId,actorUserId)) return {ok:false,error:'只有公司負責人可以將車輛退役'};
    if(target.status==='retired') return {ok:true,vehicle:target,unchanged:true};
    const incompleteTrips=incompleteTripsForVehicle(vehicleId);
    if(incompleteTrips.length) return {ok:false,error:`此車仍有未完成行程 ${summarizeTripCodes(incompleteTrips)}，請先完成或改派後再退役`};
    store.mutate(db=>{
      const vehicle=db.vehicles.find(v=>v.id===vehicleId);
      vehicle.status='retired'; vehicle.retiredAt=nowISO(); vehicle.retiredByUserId=actorUserId||null; vehicle.updatedAt=nowISO();
    });
    Audit.log('vehicle_retired',`車輛 ${target.plate} 已退役並永久保留歷史`,{vehicleId,organizationId:target.organizationId,actorUserId});
    return {ok:true,vehicle:this.vehicle(vehicleId)};
  },

  deleteVehicle(vehicleId,actorUserId){
    const target=this.vehicle(vehicleId); if(!target) return {ok:false,error:'找不到可刪除車輛'};
    if(!this.isOwnerActor(target.organizationId,actorUserId)) return {ok:false,error:'只有公司負責人可以刪除車輛'};
    const usage=vehicleUsageSnapshot(vehicleId);
    if(usage.tripCount>0) return {ok:false,error:`此車已有 ${usage.tripCount} 筆 Trip 歷史，為保留營運紀錄不可刪除；請改為「已退役」`};
    if(usage.draftPlanCount>0) return {ok:false,error:`此車仍被 ${usage.draftPlanCount} 筆未套用派車方案引用，請先重新最佳化或移除方案後再刪除`};

    store.mutate(db=>{
      db.vehicles=db.vehicles.filter(v=>v.id!==vehicleId);
      db.vehicleAssignments=(db.vehicleAssignments||[]).filter(a=>a.vehicleId!==vehicleId);
    });
    Audit.log('vehicle_deleted',`永久刪除未使用車輛 ${target.plate}`,{vehicleId,organizationId:target.organizationId,actorUserId});
    return {ok:true,hardDeleted:true};
  },

  validateTripResourceAssignment({organizationId,driverId,vehicleId,startAt,endAt,needs='',passengerUnits=1,wheelchairUnits=0,ignoreTripId=null,actorUserId=null,requireActor=false}){
    if(requireActor&&!this.canManageTripResources(organizationId,actorUserId)) return {ok:false,error:'只有調度員或公司負責人可以指定司機與車輛'};
    const organization=this.get(organizationId); if(!organization||organization.active===false) return {ok:false,error:'公司目前不可派車'};
    const rawDriver=store.state.drivers.find(d=>d.id===driverId);
    if(!rawDriver||rawDriver.organizationId!==organizationId||rawDriver.active===false||!activeDriverMembership(rawDriver.userId,organizationId)) return {ok:false,error:'司機不存在、已停用或不屬於目前公司'};
    if(rawDriver.status!=='on_duty') return {ok:false,error:'此司機目前不是執勤中，不能指派新行程'};
    const vehicle=this.vehicle(vehicleId);
    if(!vehicle||vehicle.organizationId!==organizationId) return {ok:false,error:'車輛不存在或不屬於目前公司'};
    if(vehicle.status!=='available') return {ok:false,error:`車輛目前為「${this.vehicleStatusLabel(vehicle.status)}」，不可派車`};
    if(Number(passengerUnits)>Number(vehicle.capacity||0)) return {ok:false,error:`乘員需求 ${passengerUnits} 人超過車輛載客量 ${vehicle.capacity}`};
    if(Number(wheelchairUnits)>Number(vehicle.wheelchairSlots||0)) return {ok:false,error:`輪椅需求 ${wheelchairUnits} 位超過車輛輪椅位 ${vehicle.wheelchairSlots||0}`};
    if(/輪椅|升降|無障礙/.test(needs||'')&&!(vehicle.accessible||vehicle.wheelchairSlots>0)) return {ok:false,error:'此行程需要無障礙／輪椅設備，但所選車輛不符合'};
    const start=new Date(startAt),end=new Date(endAt||addMinutes(start,55));
    if(isNaN(start)||isNaN(end)||end<=start) return {ok:false,error:'行程時間不合法'};
    const relevant=store.state.trips.filter(t=>t.id!==ignoreTripId&&t.organizationId===organizationId&&!['cancelled'].includes(t.status));
    const driverConflict=relevant.find(t=>t.driverId===driverId&&tripWindow(t).start<end&&tripWindow(t).end>start);
    if(driverConflict) return {ok:false,error:`司機與既有行程 ${driverConflict.code} 時段重疊`};
    const vehicleConflict=relevant.find(t=>t.vehicleId===vehicleId&&tripWindow(t).start<end&&tripWindow(t).end>start);
    if(vehicleConflict) return {ok:false,error:`車輛 ${vehicle.plate} 與既有行程 ${vehicleConflict.code} 時段重疊`};
    return {ok:true,driver:this.driver(driverId),vehicle};
  },

  ensureDriverProfileForUser(userId,organizationId,actorUserId){
    if(!this.canManageDriverProfiles(organizationId,actorUserId)) return {ok:false,error:'只有平台超級管理者或公司負責人可以建立／恢復 Driver Profile'};
    let raw=store.state.drivers.find(d=>d.userId===userId&&d.organizationId===organizationId);
    const user=store.state.users.find(u=>u.id===userId); if(!user) return null;
    if(raw){
      store.mutate(db=>{const d=db.drivers.find(x=>x.id===raw.id);d.active=true;d.status='off_duty';delete d.name;delete d.phone;d.updatedAt=nowISO();});
      return this.driver(raw.id);
    }
    raw={id:uid('drv'),userId,organizationId,fleetId:store.state.fleets.find(f=>f.organizationId===organizationId&&f.active)?.id||null,status:'off_duty',serviceArea:'',active:true,createdAt:nowISO(),updatedAt:nowISO()};
    store.mutate(db=>db.drivers.push(raw)); return this.driver(raw.id);
  },
  incompleteTripsForDriverUser(userId,organizationId){
    const raw=store.state.drivers.find(d=>d.userId===userId&&d.organizationId===organizationId);
    return raw?incompleteTripsForDriver(raw.id):[];
  },
  canDeactivateDriverProfile(userId,organizationId){
    const raw=store.state.drivers.find(d=>d.userId===userId&&d.organizationId===organizationId);
    if(!raw) return {ok:true,trips:[]};
    const trips=incompleteTripsForDriver(raw.id);
    if(trips.length) return {ok:false,error:`此司機仍有未完成行程 ${summarizeTripCodes(trips)}，請先由調度員或負責人完成改派`,trips};
    return {ok:true,trips:[]};
  },
  deactivateDriverProfile(userId,organizationId,actorUserId){
    if(!this.canManageDriverProfiles(organizationId,actorUserId)) return {ok:false,error:'只有平台超級管理者或公司負責人可以停用 Driver Profile'};
    const check=this.canDeactivateDriverProfile(userId,organizationId); if(!check.ok) return check;
    store.mutate(db=>{const d=db.drivers.find(x=>x.userId===userId&&x.organizationId===organizationId);if(!d)return;d.active=false;d.status='off_duty';d.updatedAt=nowISO();});
    return {ok:true};
  }
};
}

{
const DISPATCH_BOOKING_PERMISSION=Object.freeze({READ_CLAIMED:'booking.read_claimed',SCHEDULE:'booking.schedule',MARKET_READ:'booking.market.read'});
const DISPATCH_POLICY=Object.freeze({
  routingServiceBufferMin:4,
  departureBufferMin:20,
  pooling:Object.freeze({maxPickupDriveMin:15,maxPickupDelayMin:10,maxTimeGapMin:45,maxDetourMin:15,maxRideTimeRatio:1.35,rideRatioMinDirectMin:15,ownDropoffServiceGraceMin:4,maxGroupSize:3}),
  recommendation:Object.freeze({deadhead:30,schedule:20,continuity:15,vehicleFit:10,balance:10,pooling:10,area:5}),
  objectiveProfiles:Object.freeze({
    balanced:Object.freeze({label:'平衡最佳化',deadhead:1.0,lateRisk:1.0,pooling:1.0,balance:1.0,scarcity:1.0}),
    on_time:Object.freeze({label:'準時優先',deadhead:.75,lateRisk:1.65,pooling:.65,balance:.75,scarcity:1.25}),
    low_deadhead:Object.freeze({label:'低空車優先',deadhead:1.65,lateRisk:1.0,pooling:.75,balance:.8,scarcity:1.1}),
    pooling:Object.freeze({label:'共乘優先',deadhead:.8,lateRisk:1.0,pooling:1.75,balance:.75,scarcity:1.0})
  })
});

const POOLING_POLICY_VERSION='pool-law-tpe-ntpc-2026-08-26-v2-service-jurisdiction';
const DISPATCH_OPTIMIZER_VERSION='dispatch-stop-sequence-scarcity-regret-v6-short-trip-ratio-grace';
const POOLING_FARE_MULTIPLIER=.66;
const POOLING_POLICIES=Object.freeze({
  taipei:Object.freeze({jurisdiction:'taipei',label:'臺北市長照交通',requireExplicitConsent:true,routeMode:'safety_constraints',fareMultiplier:POOLING_FARE_MULTIPLIER,sourceLabel:'臺北市長照交通接送服務使用者須知'}),
  new_taipei:Object.freeze({jurisdiction:'new_taipei',label:'新北市長照交通',requireExplicitConsent:true,routeMode:'same_od_or_same_destination_enroute',fareMultiplier:POOLING_FARE_MULTIPLIER,sourceLabel:'新北市長照交通接送平台服務條款'}),
  other:Object.freeze({jurisdiction:'other',label:'其他地區',requireExplicitConsent:true,routeMode:'disabled',fareMultiplier:null,sourceLabel:'尚未建立地方共乘規則'})
});
function bookingJurisdiction(booking){
  const jurisdiction=String(booking?.serviceJurisdiction||'').trim();
  return BOOKING_SERVICE_JURISDICTIONS.includes(jurisdiction)?jurisdiction:'other';
}
function poolingPolicyForBooking(booking){ return POOLING_POLICIES[bookingJurisdiction(booking)]||POOLING_POLICIES.other; }
function bookingPoolingConsented(booking){
  if(booking?.poolingConsent==='yes')return true;
  if(booking?.poolingConsent==='no')return false;
  return String(booking?.source||'').includes('demo');
}
function sameOD(a,b){return canonicalAddress(a.pickupAddress)===canonicalAddress(b.pickupAddress)&&canonicalAddress(a.destination)===canonicalAddress(b.destination);}
function sameDestination(a,b){return !!canonicalAddress(a.destination)&&canonicalAddress(a.destination)===canonicalAddress(b.destination);}
function newTaipeiEnrouteCheck(bookings){
  if(bookings.every(b=>sameOD(bookings[0],b)))return {ok:true,mode:'same_od',detail:'同一地點上下車'};
  if(!bookings.every(b=>sameDestination(bookings[0],b)))return {ok:false,mode:'different_destination',detail:'新北共乘須同一地點上下車，或目的地相同且於行駛途中上車'};
  const ordered=[...bookings].sort((a,b)=>dispatchBookingTimeMs(a)-dispatchBookingTimeMs(b));
  const destination=ordered[0].destination;
  for(let i=0;i<ordered.length-1;i++){
    const from=ordered[i].pickupAddress,next=ordered[i+1].pickupAddress;
    const direct=estimateDriveMinutes(from,destination,{departureAt:Booking.dateTime(ordered[i])});
    const via=estimateDriveMinutes(from,next,{departureAt:Booking.dateTime(ordered[i])})+estimateDriveMinutes(next,destination,{departureAt:Booking.dateTime(ordered[i+1])});
    const extra=Math.max(0,via-direct);
    if(extra>DISPATCH_POLICY.pooling.maxDetourMin)return {ok:false,mode:'not_enroute',detail:`順路接人額外繞行約 ${extra} 分，超過 ${DISPATCH_POLICY.pooling.maxDetourMin} 分鐘限制`};
  }
  return {ok:true,mode:'same_destination_enroute',detail:'目的地相同，且後續上車點符合順路限制'};
}
function evaluatePoolingPolicy(bookings){
  const rows=(bookings||[]).filter(Boolean),reasons=[];
  if(rows.length<2)return {ok:true,reasons,policy:null,jurisdiction:null,mode:'single'};
  const jurisdictions=[...new Set(rows.map(bookingJurisdiction))];
  if(jurisdictions.length!==1)return {ok:false,reasons:['不同地方規則的 Booking 不自動組成同一共乘群組'],policy:null,jurisdiction:'mixed',mode:'blocked'};
  const policy=POOLING_POLICIES[jurisdictions[0]]||POOLING_POLICIES.other;
  if(policy.routeMode==='disabled')reasons.push('此所在地尚未建立可驗證的地方共乘規則，禁止自動共乘');
  if(policy.requireExplicitConsent){
    const noConsent=rows.filter(b=>!bookingPoolingConsented(b));
    if(noConsent.length)reasons.push(`${noConsent.map(b=>b.name||'乘客').join('、')} 尚未明確同意共乘`);
  }
  let routeRule={ok:true,mode:'safety_constraints',detail:'依既有安全與服務品質限制'};
  if(policy.jurisdiction==='new_taipei')routeRule=newTaipeiEnrouteCheck(rows);
  if(!routeRule.ok)reasons.push(routeRule.detail);
  return {ok:reasons.length===0,reasons,policy,jurisdiction:policy.jurisdiction,mode:routeRule.mode,detail:routeRule.detail,snapshot:{schemaVersion:1,policyVersion:POOLING_POLICY_VERSION,jurisdiction:policy.jurisdiction,policyLabel:policy.label,routeMode:routeRule.mode,fareMultiplier:policy.fareMultiplier,consentRequired:policy.requireExplicitConsent,sourceLabel:policy.sourceLabel,capturedAt:nowISO()}};
}

function dispatchActorCan(userId,permission,organizationId){
  return !!userId&&!!Identity?.canUser?.(userId,permission,organizationId);
}
const canonicalAddress=(value='')=>String(value||'').replace(/臺/g,'台').replace(/\s+/g,'').replace(/[，,。．]/g,'').trim();
const extractCity=(address='')=>canonicalAddress(address).match(/(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)/)?.[1]||'';
const extractDistrict=(address='')=>{const s=canonicalAddress(address).replace(/^(台北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|台中市|彰化縣|南投縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣)/,'');return s.match(/([^市縣]{1,5}(?:區|鄉|鎮|市))/)?.[1]||'';};
const extractRoad=(address='')=>canonicalAddress(address).match(/([^區鄉鎮市]{1,12}(?:路|街|大道))/)?.[1]||'';

function addressAffinity(a,b){
  const x=canonicalAddress(a),y=canonicalAddress(b);
  if(!x||!y) return {score:0,label:''};
  if(x===y) return {score:100,label:'同一地址'};
  const dx=extractDistrict(x),dy=extractDistrict(y),cx=extractCity(x),cy=extractCity(y),rx=extractRoad(x),ry=extractRoad(y);
  if(rx&&ry&&rx===ry&&dx&&dy&&dx===dy) return {score:82,label:`同區同路（${dx}）`};
  if(dx&&dy&&dx===dy) return {score:68,label:`同一行政區（${dx}）`};
  if(cx&&cy&&cx===cy) return {score:30,label:`同城市（${cx}）`};
  if((cx==='台北市'&&cy==='新北市')||(cx==='新北市'&&cy==='台北市')) return {score:16,label:'雙北跨區'};
  return {score:3,label:'跨區'};
}
function stablePairNoise(a,b,mod=7){ const key=[canonicalAddress(a),canonicalAddress(b)].sort().join('|'); let h=2166136261; for(let i=0;i<key.length;i++){ h^=key.charCodeAt(i); h=Math.imul(h,16777619); } return Math.abs(h>>>0)%mod; }
let dispatchRoutingProvider=null;
const dispatchRoutingCache=new Map();
function routingBaseKey(from,to){return `${canonicalAddress(from)}→${canonicalAddress(to)}`;}
function routingCacheKey(from,to,departureAt=null){
  const d=departureAt?new Date(departureAt):null;
  const bucket=d&&!Number.isNaN(d.getTime())?`${dateKey(d)}T${String(d.getHours()).padStart(2,'0')}:${d.getMinutes()<30?'00':'30'}`:'any';
  return `${routingBaseKey(from,to)}@${bucket}`;
}
function normalizeRoutingResult(value,source='external'){
  if(!value)return null;
  const durationMinutes=Number(value.durationMinutes),distanceKm=Number(value.distanceKm);
  if(!Number.isFinite(durationMinutes)||durationMinutes<0)return null;
  return {durationMinutes:Math.max(1,Math.round(durationMinutes)),distanceKm:Number.isFinite(distanceKm)?Math.max(.1,Math.round(distanceKm*10)/10):null,source:value.source||source,confidence:value.confidence||'high',provider:value.provider||null};
}
const DispatchRouting={
  version:'routing-adapter-v2/cache-matrix-v1/heuristic-v2',
  setProvider(provider){
    dispatchRoutingProvider=provider&&(typeof provider.estimate==='function'||typeof provider.matrix==='function')?provider:null;
    return this.status();
  },
  status(){return {provider:dispatchRoutingProvider?.name||dispatchRoutingProvider?.id||'heuristic',external:!!dispatchRoutingProvider,cacheEntries:dispatchRoutingCache.size,version:this.version};},
  clearCache(){dispatchRoutingCache.clear();},
  _remember(from,to,departureAt,result){
    const normalized=normalizeRoutingResult(result,dispatchRoutingProvider?.name||'external');if(!normalized)return null;
    dispatchRoutingCache.set(routingCacheKey(from,to,departureAt),normalized);
    dispatchRoutingCache.set(routingBaseKey(from,to),normalized);
    return normalized;
  },
  async prime(pairs=[]){
    if(!dispatchRoutingProvider||!Array.isArray(pairs)||!pairs.length)return {ok:true,provider:this.status().provider,primed:0,fallback:true};
    const deduped=[],seen=new Set();
    for(const row of pairs){
      if(!row?.from||!row?.to)continue;
      const key=routingCacheKey(row.from,row.to,row.departureAt||null);if(seen.has(key)||dispatchRoutingCache.has(key))continue;
      seen.add(key);deduped.push({from:row.from,to:row.to,departureAt:row.departureAt||null});
      if(deduped.length>=600)break;
    }
    if(!deduped.length)return {ok:true,provider:this.status().provider,primed:0,cached:true};
    let primed=0;
    try{
      if(typeof dispatchRoutingProvider.matrix==='function'){
        const result=await dispatchRoutingProvider.matrix(deduped);
        const rows=Array.isArray(result)?result:(Array.isArray(result?.results)?result.results:[]);
        rows.forEach((r,i)=>{const pair=deduped[i];if(pair&&this._remember(pair.from,pair.to,pair.departureAt,r))primed++;});
      }else{
        const rows=await Promise.all(deduped.map(async pair=>{
          try{return await dispatchRoutingProvider.estimate(pair.from,pair.to,{departureAt:pair.departureAt});}catch(_){return null;}
        }));
        rows.forEach((r,i)=>{const pair=deduped[i];if(pair&&this._remember(pair.from,pair.to,pair.departureAt,r))primed++;});
      }
      return {ok:true,provider:this.status().provider,primed};
    }catch(error){return {ok:false,provider:this.status().provider,primed,error:String(error?.message||error)};}
  },
  estimate(from,to,{departureAt=null}={}){
    const exact=dispatchRoutingCache.get(routingCacheKey(from,to,departureAt)),base=dispatchRoutingCache.get(routingBaseKey(from,to));
    if(exact||base)return {...(exact||base),source:(exact||base).source||'external-cache'};
    if(dispatchRoutingProvider&&typeof dispatchRoutingProvider.estimate==='function'){
      try{
        const live=dispatchRoutingProvider.estimate(from,to,{departureAt});
        if(live&&typeof live.then!=='function'){
          const normalized=this._remember(from,to,departureAt,live);if(normalized)return normalized;
        }
      }catch(_){  }
    }
    const affinity=addressAffinity(from,to);
    let durationMinutes=30;
    if(canonicalAddress(from)&&canonicalAddress(to)){
      if(affinity.score>=100) durationMinutes=2+stablePairNoise(from,to,2);
      else if(affinity.score>=82) durationMinutes=4+stablePairNoise(from,to,4);
      else if(affinity.score>=68) durationMinutes=7+stablePairNoise(from,to,9);
      else if(affinity.score>=30) durationMinutes=14+stablePairNoise(from,to,12);
      else if(affinity.score>=16) durationMinutes=22+stablePairNoise(from,to,15);
      else durationMinutes=35+stablePairNoise(from,to,21);
    }
    const speed=durationMinutes<=10?.32:durationMinutes<=25?.42:.5;
    const distanceKm=Math.max(.5,Math.round(durationMinutes*speed*10)/10);
    return {durationMinutes,distanceKm,source:'heuristic',confidence:affinity.score>=68?'medium':'low',provider:'heuristic'};
  }
};
if(typeof window!=='undefined'&&window.CareRideRoutingProvider)DispatchRouting.setProvider(window.CareRideRoutingProvider);
function estimateDriveMinutes(from,to,options={}){ return DispatchRouting.estimate(from,to,options).durationMinutes; }
function estimateDriveKm(from,to,options={}){ const r=DispatchRouting.estimate(from,to,options); return r.distanceKm??Math.max(.5,Math.round(r.durationMinutes*.42*10)/10); }
function tripStopAddress(stop){ return stop?.address||stop?.destination||''; }
function tripOperationalStops(t){
  const dispatchStops=Array.isArray(t?.dispatchStops)?t.dispatchStops.filter(s=>['pickup','dropoff'].includes(s?.type)):[];
  if(dispatchStops.length)return dispatchStops;
  return (t?.steps||[]).filter(s=>['pickup','dropoff'].includes(s?.type)).map(s=>({type:s.type,address:s.destination,destination:s.destination,at:s.scheduledAt}));
}
const tripFirstPickupAddress=t=>tripStopAddress(tripOperationalStops(t).find(s=>s.type==='pickup'))||t?.pickupAddress||'';
const tripLastDropoffAddress=t=>tripStopAddress([...tripOperationalStops(t)].reverse().find(s=>s.type==='dropoff'))||t?.dropoffAddress||'';
const dispatchBookingTimeMs=b=>{const dt=Booking.dateTime(b);return dt&&!Number.isNaN(dt.getTime())?dt.getTime():Number.MAX_SAFE_INTEGER;};
const bookingCompanionUnits=b=>Math.max(0,Number(Booking.effectiveServiceNeeds(b).companions||0)||0);
const bookingPassengerUnits=b=>1+bookingCompanionUnits(b);
const bookingWheelchairUnits=b=>{const n=Booking.effectiveServiceNeeds(b);return /輪椅/.test(`${n.aidNeed||''} ${n.specialNeed||''}`)?1:0;};

function driverTimeline(driverId,date,excludeTripIds=[]){
  const excluded=new Set(excludeTripIds||[]);
  return store.state.trips.filter(t=>t.driverId===driverId&&t.date===date&&!['cancelled','aborted'].includes(t.status)&&!excluded.has(t.id)).sort((a,b)=>tripStartAt(a)-tripStartAt(b));
}
function vehicleMatchesNeeds(vehicle,{needs='',passengerUnits=1,wheelchairUnits=0}={}){
  if(!vehicle||vehicle.status!=='available') return false;
  if(passengerUnits>Number(vehicle.capacity||0)) return false;
  if(wheelchairUnits>Number(vehicle.wheelchairSlots||0)) return false;
  if(/輪椅|升降|無障礙/.test(needs||'')&&!(vehicle.accessible||vehicle.wheelchairSlots>0)) return false;
  return true;
}
function availableVehicleForWindow(organizationId,start,end,requirements={},reservedItems=[],options={}){
  const excluded=new Set(options.excludeTripIds||[]),blocked=new Set(options.blockedVehicleIds||[]);
  return Organization.dispatchableVehicles(organizationId).filter(v=>!blocked.has(v.id)&&vehicleMatchesNeeds(v,requirements)).filter(v=>{
    const conflict=store.state.trips.find(t=>!excluded.has(t.id)&&t.vehicleId===v.id&&!['cancelled','aborted'].includes(t.status)&&tripStartAt(t)<end&&tripEndAt(t)>start);
    const draftConflict=reservedItems.find(i=>i.vehicleId===v.id&&new Date(i.startAt)<end&&new Date(i.endAt)>start);
    return !conflict&&!draftConflict;
  }).sort((a,b)=>Number(a.capacity)-Number(b.capacity)||Number(a.wheelchairSlots)-Number(b.wheelchairSlots))[0]||null;
}
function feasibility(driver,booking,organizationId){
  const reasons=[];
  if(!driver||driver.active===false) reasons.push('司機 Driver Profile 已停用');
  if(driver&&driver.status!=='on_duty') reasons.push('司機目前非執勤中');
  if(driver&&!store.state.memberships.some(m=>m.userId===driver.userId&&m.organizationId===organizationId&&m.role==='driver'&&(m.status||'active')==='active')) reasons.push('司機 Membership 已失效或不屬於目前公司');
  const pickupAt=Booking.dateTime(booking);
  if(!pickupAt)return {feasible:false,reasons:[...reasons,'預約日期時間無效，請先修正 Booking'],vehicle:null,previous:null,next:null,pickupAt:null,dropoffAt:null};
  const directRoute=DispatchRouting.estimate(booking.pickupAddress,booking.destination,{departureAt:pickupAt});
  const dropoffAt=addMinutes(pickupAt,Math.max(8,directRoute.durationMinutes+DISPATCH_POLICY.routingServiceBufferMin)),trips=driverTimeline(driver.id,booking.pickupDate||dateKey(pickupAt));
  const previous=[...trips].filter(t=>tripEndAt(t)<=pickupAt).sort((a,b)=>tripEndAt(b)-tripEndAt(a))[0];
  const next=[...trips].filter(t=>tripStartAt(t)>pickupAt).sort((a,b)=>tripStartAt(a)-tripStartAt(b))[0];
  const overlap=trips.find(t=>tripStartAt(t)<dropoffAt&&tripEndAt(t)>addMinutes(pickupAt,-20));
  if(overlap) reasons.push(`與既有行程 ${overlap.code} 的執行時間重疊`);
  if(previous&&!overlap){ const gap=(pickupAt-tripEndAt(previous))/60000,min=estimateDriveMinutes(tripLastDropoffAddress(previous),booking.pickupAddress); if(gap<min) reasons.push(`前一趟後僅 ${Math.max(0,Math.floor(gap))} 分鐘，最低轉場約需 ${min} 分鐘`); }
  if(next&&!overlap){ const gap=(tripStartAt(next)-dropoffAt)/60000,min=estimateDriveMinutes(booking.destination,tripFirstPickupAddress(next)); if(gap<min) reasons.push(`送達後至 ${next.code} 僅 ${Math.max(0,Math.floor(gap))} 分鐘，最低轉場約需 ${min} 分鐘`); }
  const effectiveNeeds=Booking.effectiveServiceNeeds(booking);
  const requirements={needs:`${effectiveNeeds.aidNeed||''} ${effectiveNeeds.specialNeed||''} ${effectiveNeeds.requiresAccessibleVehicle?'無障礙':''}`,passengerUnits:bookingPassengerUnits(booking),wheelchairUnits:bookingWheelchairUnits(booking)};
  const vehicle=availableVehicleForWindow(organizationId,addMinutes(pickupAt,-20),dropoffAt,requirements);
  if(!vehicle) reasons.push('此時段沒有符合需求且可派的公司車');
  return {feasible:reasons.length===0,reasons,vehicle,previous,next,pickupAt,dropoffAt,directRoute};
}
function validatePoolPair(first,second,organizationId){
  const aAt=Booking.dateTime(first),bAt=Booking.dateTime(second);if(!aAt||!bAt)return {ok:false,reasons:['預約時間無效'],policyCheck:evaluatePoolingPolicy([first,second])};
  const group=validatePoolGroup([first,second],organizationId),route=group.route,ordered=[first,second].sort((a,b)=>dispatchBookingTimeMs(a)-dispatchBookingTimeMs(b));
  if(!route)return {ok:false,reasons:group.reasons||['無法建立共乘路線'],ordered,policyCheck:group.policyCheck};
  const pickupDrive=estimateDriveMinutes(ordered[0].pickupAddress,ordered[1].pickupAddress,{departureAt:Booking.dateTime(ordered[0])}),timeGap=Math.round(Math.abs(aAt-bAt)/60000);
  const delays=ordered.map(b=>Math.max(0,Math.round((route.pickupActual[b.id]-Booking.dateTime(b))/60000))),detours=ordered.map(b=>{const direct=estimateDriveMinutes(b.pickupAddress,b.destination,{departureAt:Booking.dateTime(b)}),ride=Math.round((route.dropoffActual[b.id]-route.pickupActual[b.id])/60000);return {direct,ride,detour:Math.max(0,ride-direct),ratio:ride/Math.max(1,direct)};});
  const best={order:route.stops.map(s=>`${s.type==='pickup'?'P':'D'}:${s.bookingId}`).join('→'),rideA:detours[0].ride,rideB:detours[1].ride,detourA:detours[0].detour,detourB:detours[1].detour,ratioA:detours[0].ratio,ratioB:detours[1].ratio,total:Math.round((new Date(route.endAt)-new Date(route.startAt))/60000)};
  return {ok:group.ok,reasons:group.reasons||[],ordered,pickupDrive,timeGap,secondPickupDelay:Math.max(...delays),best,passengerUnits:route.maxPassengers,wheelchairUnits:route.maxWheelchairs,capacityVehicle:group.capacityVehicle,policyCheck:group.policyCheck,route};
}
function poolCandidates(booking,organizationId,actorUserId){
  return Booking.listForDispatch(organizationId,booking.pickupDate,actorUserId).filter(b=>b.id!==booking.id).map(other=>{
    const check=validatePoolPair(booking,other,organizationId);
    if(!check.ok)return null;
    const destinationDrive=estimateDriveMinutes(booking.destination,other.destination),detour=Math.max(check.best.detourA,check.best.detourB);
    const score=Math.max(0,100-check.pickupDrive*2.2-check.timeGap*.45-detour*2.5-Math.min(destinationDrive,60)*.15);
    return {booking:other,pickupDrive:check.pickupDrive,destinationDrive,timeGap:check.timeGap,pickupDelay:check.secondPickupDelay,maxDetour:Math.round(detour),eligible:true,autoFit:true,score:Math.round(score),validation:check};
  }).filter(Boolean).sort((a,b)=>b.score-a.score);
}
function scheduleScore(minutes){ if(minutes<0)return 0;if(minutes<10)return Math.max(0,Math.round(minutes));if(minutes<=45)return 20;if(minutes<=90)return 17;if(minutes<=150)return 13;return 10; }
function normalizePart(value,max){ return Math.max(0,Math.min(max,Math.round(value))); }
function scoreDriver(driver,booking,organizationId,actorUserId){
  const f=feasibility(driver,booking,organizationId);
  if(!f.feasible) return {driver,vehicle:f.vehicle,feasible:false,score:0,reasons:f.reasons,breakdown:{},explanation:{hardConstraints:f.reasons,softScores:[]}};
  const weights=DISPATCH_POLICY.recommendation,vehicle=f.vehicle,pickupAt=f.pickupAt,from=f.previous?tripLastDropoffAddress(f.previous):driver.serviceArea;
  const deadheadMin=from?estimateDriveMinutes(from,booking.pickupAddress):15,deadheadKm=from?estimateDriveKm(from,booking.pickupAddress):6.3;
  const nextMin=f.next?estimateDriveMinutes(booking.destination,tripFirstPickupAddress(f.next)):0,prevBuffer=f.previous?(pickupAt-tripEndAt(f.previous))/60000:60;
  const dayLoad=driverTimeline(driver.id,booking.pickupDate).length,bestPool=poolCandidates(booking,organizationId,actorUserId)[0]||null,area=addressAffinity(driver.serviceArea||'',booking.pickupAddress);
  const breakdown={
    deadhead:normalizePart(weights.deadhead-deadheadMin*1.05,weights.deadhead),
    schedule:normalizePart(scheduleScore(prevBuffer),weights.schedule),
    continuity:normalizePart(f.next?weights.continuity-nextMin*.45:weights.continuity*.8,weights.continuity),
    vehicleFit:normalizePart(weights.vehicleFit-(Math.max(0,(vehicle?.capacity||1)-bookingPassengerUnits(booking))*1.2),weights.vehicleFit),
    balance:normalizePart(weights.balance-Math.min(weights.balance-2,dayLoad*1.6),weights.balance),
    pooling:normalizePart(bestPool?(bestPool.score/100)*weights.pooling:0,weights.pooling),
    area:normalizePart((area.score/100)*weights.area,weights.area)
  };
  const score=Math.max(0,Math.min(100,Object.values(breakdown).reduce((a,b)=>a+b,0)));
  const softScores=[
    {key:'deadhead',label:'空車距離',score:breakdown.deadhead,max:weights.deadhead,detail:`約 ${deadheadMin} 分／${deadheadKm} km`},
    {key:'schedule',label:'時間銜接',score:breakdown.schedule,max:weights.schedule,detail:f.previous?`前趟後緩衝 ${Math.round(prevBuffer)} 分`:'無前趟限制'},
    {key:'continuity',label:'下一趟銜接',score:breakdown.continuity,max:weights.continuity,detail:f.next?`下一趟轉場約 ${nextMin} 分`:'無下一趟限制'},
    {key:'vehicleFit',label:'車型適配',score:breakdown.vehicleFit,max:weights.vehicleFit,detail:`${vehicle?.plate||'可派車'}・載客 ${vehicle?.capacity||0}・輪椅位 ${vehicle?.wheelchairSlots||0}`},
    {key:'balance',label:'工作量平衡',score:breakdown.balance,max:weights.balance,detail:`當日既有 ${dayLoad} 趟`},
    {key:'pooling',label:'共乘機會',score:breakdown.pooling,max:weights.pooling,detail:bestPool?`候選 ${bestPool.booking.name}・適配 ${bestPool.score}`:'無明顯候選'},
    {key:'area',label:'服務區熟悉度',score:breakdown.area,max:weights.area,detail:area.label||'跨區'}
  ];
  const reasons=softScores.sort((a,b)=>(b.score/b.max)-(a.score/a.max)).slice(0,4).map(x=>`${x.label} ${x.score}/${x.max}：${x.detail}`);
  return {driver,vehicle,feasible:true,score,reasons,deadheadMin,deadheadKm,poolCandidate:bestPool,breakdown,explanation:{hardConstraints:[],softScores}};
}
function enumerateLegalStopSequences(bookings){
  const rows=(bookings||[]).filter(Boolean),out=[];
  function walk(sequence,picked,dropped){
    if(sequence.length===rows.length*2){out.push(sequence.map(x=>({...x})));return;}
    for(const b of rows){
      if(!picked.has(b.id)){
        const nextPicked=new Set(picked);nextPicked.add(b.id);
        walk([...sequence,{type:'pickup',bookingId:b.id}],nextPicked,dropped);
      }else if(!dropped.has(b.id)){
        const nextDropped=new Set(dropped);nextDropped.add(b.id);
        walk([...sequence,{type:'dropoff',bookingId:b.id}],picked,nextDropped);
      }
    }
  }
  walk([],new Set(),new Set());
  return out;
}
function materializeStopSequence(bookings,sequence){
  const byId=new Map(bookings.map(b=>[b.id,b])),stops=[],pickupActual={},dropoffActual={};
  let at=null,cursor='',passengers=0,careRecipients=0,companions=0,wheelchairs=0,maxPassengers=0,maxCareRecipients=0,maxWheelchairs=0,loadedKm=0,interStopEmptyKm=0;
  for(let i=0;i<sequence.length;i++){
    const token=sequence[i],b=byId.get(token.bookingId);if(!b)continue;
    const isPickup=token.type==='pickup',address=isPickup?b.pickupAddress:b.destination,requested=Booking.dateTime(b);
    if(!at){at=new Date(requested);cursor=address;}
    else{
      const route=DispatchRouting.estimate(cursor,address,{departureAt:at}),km=route.distanceKm??estimateDriveKm(cursor,address,{departureAt:at});
      if(passengers>0)loadedKm+=km;else interStopEmptyKm+=km;
      at=addMinutes(at,route.durationMinutes+DISPATCH_POLICY.routingServiceBufferMin);
      if(isPickup&&at<requested)at=new Date(requested);
      cursor=address;
    }
    const companionDelta=isPickup?bookingCompanionUnits(b):-bookingCompanionUnits(b),careDelta=isPickup?1:-1,wheelDelta=isPickup?bookingWheelchairUnits(b):-bookingWheelchairUnits(b),passengerDelta=isPickup?bookingPassengerUnits(b):-bookingPassengerUnits(b);
    passengers+=passengerDelta;careRecipients+=careDelta;companions+=companionDelta;wheelchairs+=wheelDelta;
    maxPassengers=Math.max(maxPassengers,passengers);maxCareRecipients=Math.max(maxCareRecipients,careRecipients);maxWheelchairs=Math.max(maxWheelchairs,wheelchairs);
    const stop={type:token.type,bookingId:b.id,legId:b.activeLegId||Booking.nextPendingLeg(b)?.id||null,name:b.name,address,at:at.toISOString(),passengerDelta,careRecipientDelta:careDelta,companionDelta,wheelchairDelta:wheelDelta};
    stops.push(stop);
    if(isPickup)pickupActual[b.id]=new Date(at);else dropoffActual[b.id]=new Date(at);
  }
  const loadTimeline=[];passengers=0;careRecipients=0;companions=0;wheelchairs=0;
  for(const stop of stops){
    passengers+=stop.passengerDelta;careRecipients+=stop.careRecipientDelta||0;companions+=stop.companionDelta||0;wheelchairs+=stop.wheelchairDelta;
    loadTimeline.push({at:stop.at,type:stop.type,bookingId:stop.bookingId,name:stop.name,careRecipients,companions,seatsUsed:passengers,passengers,wheelchairSlotsUsed:wheelchairs,wheelchairs});
  }
  const firstDropIndex=stops.findIndex(s=>s.type==='dropoff'),lastPickupIndex=[...stops].map((s,i)=>s.type==='pickup'?i:-1).filter(i=>i>=0).pop()??-1;
  return {ordered:[...bookings].sort((a,b)=>dispatchBookingTimeMs(a)-dispatchBookingTimeMs(b)),stops,pickupActual,dropoffActual,loadTimeline,maxPassengers,maxCareRecipients,maxWheelchairs,loadedKm:Math.round(loadedKm*10)/10,interStopEmptyKm:Math.round(interStopEmptyKm*10)/10,startAt:stops[0]?.at||null,endAt:stops[stops.length-1]?.at||null,firstPickupAddress:stops[0]?.address||'',finalDropoffAddress:stops[stops.length-1]?.address||'',sequenceMode:firstDropIndex>=0&&firstDropIndex<lastPickupIndex?'interleaved':'pickup_then_dropoff'};
}
function poolRouteQuality(route){
  const rules=DISPATCH_POLICY.pooling,violations=[];let pickupDelayTotal=0,detourTotal=0,rideRatioExcess=0;
  if(!route)return {violations:['無法建立路線'],penalty:Number.MAX_SAFE_INTEGER,cost:Number.MAX_SAFE_INTEGER};
  if(route.ordered.length>1&&route.maxCareRecipients<2)violations.push('路線沒有形成實際同車共乘');
  const sameODGroup=route.ordered.length>1&&route.ordered.every(b=>sameOD(route.ordered[0],b));
  for(const b of route.ordered){
    const requested=Booking.dateTime(b),actual=route.pickupActual[b.id],drop=route.dropoffActual[b.id];if(!requested||!actual||!drop){violations.push(`${b.name} 缺少完整上下車時間`);continue;}
    const pickupDelay=Math.max(0,Math.round((actual-requested)/60000));pickupDelayTotal+=pickupDelay;
    if(pickupDelay>rules.maxPickupDelayMin)violations.push(`${b.name} 預估晚接 ${pickupDelay} 分超過 ${rules.maxPickupDelayMin} 分`);
    const direct=estimateDriveMinutes(b.pickupAddress,b.destination,{departureAt:requested});
    const rawRide=Math.round((drop-actual)/60000);
    const ride=Math.max(1,rawRide-Math.min(rules.ownDropoffServiceGraceMin||0,DISPATCH_POLICY.routingServiceBufferMin||0));
    const detour=Math.max(0,ride-direct),ratio=ride/Math.max(1,direct);
    const enforceRatio=!sameODGroup&&direct>=(rules.rideRatioMinDirectMin||0);
    detourTotal+=detour;
    if(enforceRatio)rideRatioExcess+=Math.max(0,ratio-1);
    if(detour>rules.maxDetourMin)violations.push(`${b.name} 繞路 ${detour} 分超過 ${rules.maxDetourMin} 分`);
    if(enforceRatio&&ratio>rules.maxRideTimeRatio)violations.push(`${b.name} 乘車時間為單獨搭乘 ${ratio.toFixed(2)} 倍`);
  }
  const pickups=route.stops.filter(s=>s.type==='pickup');
  for(let i=1;i<pickups.length;i++){
    const drive=estimateDriveMinutes(pickups[i-1].address,pickups[i].address,{departureAt:new Date(pickups[i-1].at)});
    if(drive>rules.maxPickupDriveMin)violations.push(`案家 ${pickups[i-1].name} → ${pickups[i].name} 轉場 ${drive} 分超過 ${rules.maxPickupDriveMin} 分`);
  }
  const duration=Math.max(0,(new Date(route.endAt)-new Date(route.startAt))/60000),penalty=violations.length*100000+pickupDelayTotal*500+detourTotal*120+rideRatioExcess*1000;
  const cost=penalty+duration*4+route.loadedKm*8+route.interStopEmptyKm*20;
  return {violations,pickupDelayTotal,detourTotal,duration,penalty,cost:Math.round(cost*10)/10};
}
function buildPoolRoute(bookings,organizationId){
  const rows=[...bookings].filter(b=>!!Booking.dateTime(b));if(!rows.length)return null;
  const sequences=enumerateLegalStopSequences(rows),evaluated=sequences.map(sequence=>{const route=materializeStopSequence(rows,sequence),quality=poolRouteQuality(route);return {route,quality};}).sort((a,b)=>a.quality.violations.length-b.quality.violations.length||a.quality.cost-b.quality.cost);
  const best=evaluated[0];if(!best)return null;
  return {...best.route,routeQuality:best.quality,sequenceEvaluatedCount:evaluated.length};
}
function validatePoolGroup(bookings,organizationId){
  const rules=DISPATCH_POLICY.pooling,policyCheck=evaluatePoolingPolicy(bookings);
  if(bookings.length>rules.maxGroupSize)return {ok:false,reasons:[`共乘上限為 ${rules.maxGroupSize} 筆需求`],route:null,policyCheck};
  const route=buildPoolRoute(bookings,organizationId),reasons=[...policyCheck.reasons];
  if(!route)return {ok:false,reasons:['無法建立共乘路線'],route:null,policyCheck};
  if(bookings.length>1){
    const firstRequested=Booking.dateTime(route.ordered[0]),lastRequested=Booking.dateTime(route.ordered[route.ordered.length-1]),timeGap=Math.round(Math.abs(lastRequested-firstRequested)/60000);
    if(timeGap>rules.maxTimeGapMin)reasons.push(`群組預約時間差 ${timeGap} 分超過 ${rules.maxTimeGapMin} 分`);
    reasons.push(...(route.routeQuality?.violations||[]));
  }
  const needs=route.ordered.map(b=>Booking.needsText(b)).join(' '),vehicle=Organization.dispatchableVehicles(organizationId).find(v=>vehicleMatchesNeeds(v,{passengerUnits:route.maxPassengers,wheelchairUnits:route.maxWheelchairs,needs}));
  if(!vehicle)reasons.push(`車隊沒有可承載尖峰 ${route.maxPassengers} 人／${route.maxWheelchairs} 輪椅位的車輛`);
  const uniqueReasons=[...new Set(reasons)];
  return {ok:uniqueReasons.length===0,reasons:uniqueReasons,route,capacityVehicle:vehicle||null,policyCheck};
}
function makePlanItem(bookings,organizationId){
  const groupCheck=validatePoolGroup(bookings,organizationId),route=groupCheck.route;
  if(!route)return null;
  const pickups=route.stops.filter(s=>s.type==='pickup').map(s=>({bookingId:s.bookingId,legId:s.legId,name:s.name,address:s.address,at:s.at})),dropoffs=route.stops.filter(s=>s.type==='dropoff').map(s=>({bookingId:s.bookingId,legId:s.legId,name:s.name,address:s.address,at:s.at}));
  return {id:uid('plan_item'),organizationId,bookingIds:route.ordered.map(b=>b.id),bookingLegRefs:route.ordered.map(b=>({bookingId:b.id,legId:b.activeLegId||Booking.nextPendingLeg(b)?.id||null})),isPooled:route.ordered.length>1,pickups,dropoffs,stops:route.stops,loadTimeline:route.loadTimeline,startAt:route.startAt,endAt:route.endAt,firstPickupAddress:route.firstPickupAddress,finalDropoffAddress:route.finalDropoffAddress,passengerUnits:route.maxPassengers,wheelchairUnits:route.maxWheelchairs,loadedKm:route.loadedKm,driverId:null,vehicleId:null,emptyKm:0,score:0,feasible:groupCheck.ok,reason:groupCheck.reasons.join('・'),poolValidation:groupCheck,poolingPolicySnapshot:groupCheck.policyCheck?.snapshot||null};
}
function groupBookings(bookings,organizationId){
  const remaining=[...bookings].filter(b=>!!Booking.dateTime(b)).sort((a,b)=>dispatchBookingTimeMs(a)-dispatchBookingTimeMs(b)),groups=[];
  while(remaining.length){
    const group=[remaining.shift()];
    while(group.length<DISPATCH_POLICY.pooling.maxGroupSize){
      const candidates=remaining.map((other,index)=>{const check=validatePoolGroup([...group,other],organizationId);if(!check.ok)return null;const avgDelay=check.route.ordered.reduce((sum,b)=>sum+Math.max(0,(check.route.pickupActual[b.id]-Booking.dateTime(b))/60000),0)/check.route.ordered.length;return {other,index,check,cost:check.route.loadedKm*2+avgDelay*3};}).filter(Boolean).sort((a,b)=>a.cost-b.cost);
      if(!candidates.length)break;
      const best=candidates[0];group.push(best.other);remaining.splice(best.index,1);
    }
    const item=makePlanItem(group,organizationId);if(item)groups.push(item);
  }
  return groups;
}
function objectiveProfile(name='balanced'){ return DISPATCH_POLICY.objectiveProfiles[name]||DISPATCH_POLICY.objectiveProfiles.balanced; }
function planFeasibility(driver,item,otherItems,date,objectiveName='balanced',options={}){
  const reasons=[],blockedDriverIds=new Set(options.blockedDriverIds||[]);
  if(blockedDriverIds.has(driver.id)) reasons.push('此司機在本次局部重排中被標記為不可再指派');
  if(driver.status!=='on_duty') reasons.push('司機目前非執勤');
  if(driver.active===false) reasons.push('司機 Driver Profile 已停用');
  if(!store.state.memberships.some(m=>m.userId===driver.userId&&m.organizationId===item.organizationId&&m.role==='driver'&&(m.status||'active')==='active')) reasons.push('司機 Membership 已失效');
  const timeline=[...driverTimeline(driver.id,date,options.excludeTripIds||[]).map(t=>({start:tripStartAt(t),end:tripEndAt(t),from:tripFirstPickupAddress(t),to:tripLastDropoffAddress(t)})),...otherItems.filter(x=>x.driverId===driver.id).map(x=>({start:new Date(x.startAt),end:new Date(x.endAt),from:x.firstPickupAddress,to:x.finalDropoffAddress}))].sort((a,b)=>a.start-b.start);
  const start=new Date(item.startAt),windowStart=addMinutes(start,-DISPATCH_POLICY.departureBufferMin),end=new Date(item.endAt),overlap=timeline.find(x=>x.start<end&&x.end>windowStart),previous=[...timeline].filter(x=>x.end<=windowStart).sort((a,b)=>b.end-a.end)[0],next=[...timeline].filter(x=>x.start>=end).sort((a,b)=>a.start-b.start)[0];
  if(overlap) reasons.push('與既有安排時段重疊（含出發前準備窗口）');
  const from=previous?previous.to:driver.serviceArea,deadheadMin=from?estimateDriveMinutes(from,item.firstPickupAddress,{departureAt:start}):15,deadheadKm=from?estimateDriveKm(from,item.firstPickupAddress,{departureAt:start}):6.3;
  let lateRisk=0;
  if(previous&&!overlap){ const gap=(start-previous.end)/60000;if(gap<deadheadMin) reasons.push(`前一趟後僅 ${Math.floor(gap)} 分，轉場估需 ${deadheadMin} 分`);else lateRisk+=Math.max(0,15-(gap-deadheadMin)); }
  if(next&&!overlap){ const min=estimateDriveMinutes(item.finalDropoffAddress,next.from,{departureAt:end}),gap=(next.start-end)/60000;if(gap<min) reasons.push(`完成後至下一趟僅 ${Math.floor(gap)} 分，轉場估需 ${min} 分`);else lateRisk+=Math.max(0,15-(gap-min)); }
  const vehicle=availableVehicleForWindow(item.organizationId,windowStart,end,{passengerUnits:item.passengerUnits,wheelchairUnits:item.wheelchairUnits,needs:item.wheelchairUnits?'輪椅':''},otherItems,{excludeTripIds:options.excludeTripIds||[],blockedVehicleIds:options.blockedVehicleIds||[]});
  if(!vehicle) reasons.push('此時段沒有符合容量／輪椅需求的可派車輛');
  const p=objectiveProfile(objectiveName),balanceLoad=timeline.length,poolingGain=item.isPooled?Math.max(1,(item.bookingIds.length-1)*10):0;
  const penalty=deadheadKm*4*p.deadhead+lateRisk*3*p.lateRisk+balanceLoad*2.5*p.balance-poolingGain*p.pooling;
  const score=Math.max(0,Math.min(100,Math.round(100-penalty)));
  return {feasible:reasons.length===0,reasons,vehicle,deadheadMin,deadheadKm,lateRisk,balanceLoad,poolingGain,score,objective:{profile:objectiveName,label:p.label,penalty:Math.round(penalty*10)/10}};
}
function assignmentCandidates(item,assigned,date,organizationId,objectiveName,options={}){
  return Organization.drivers(organizationId).map(driver=>({driver,check:planFeasibility(driver,item,assigned,date,objectiveName,options)})).filter(x=>x.check.feasible).sort((a,b)=>b.check.score-a.check.score);
}
function scarcityRegretAssign(items,date,organizationId,objectiveName='balanced',seedAssigned=[],options={}){
  const assigned=[...(seedAssigned||[])],remaining=[...items],profile=objectiveProfile(objectiveName);
  while(remaining.length){
    const evaluated=remaining.map((item,index)=>{
      const candidates=assignmentCandidates(item,assigned,date,organizationId,objectiveName,options),best=candidates[0],second=candidates[1];
      const regret=best?(best.check.score-(second?.check.score??0)):999;
      const feasibleCount=candidates.length;
      const scarcityPressure=feasibleCount===0?10:(1/feasibleCount);
      const scarcityPriority=Math.round((scarcityPressure*100*profile.scarcity+regret)*100)/100;
      return {item,index,candidates,feasibleCount,regret,scarcityPriority,start:new Date(item.startAt).getTime()};
    }).sort((a,b)=>b.scarcityPriority-a.scarcityPriority||a.feasibleCount-b.feasibleCount||b.regret-a.regret||a.start-b.start);
    const chosen=evaluated[0],item=chosen.item,best=chosen.candidates[0];remaining.splice(chosen.index,1);
    item.scarcity={feasibleDrivers:chosen.feasibleCount,regret:chosen.regret,weight:profile.scarcity,priority:chosen.scarcityPriority};
    if(best){item.driverId=best.driver.id;item.vehicleId=best.check.vehicle?.id||null;item.feasible=true;item.score=best.check.score;item.emptyKm=best.check.deadheadKm;item.assignmentExplanation={objective:best.check.objective,feasibleDrivers:chosen.feasibleCount,regret:chosen.regret,scarcityWeight:profile.scarcity,scarcityPriority:chosen.scarcityPriority,deadheadMin:best.check.deadheadMin,deadheadKm:best.check.deadheadKm,lateRisk:best.check.lateRisk,balanceLoad:best.check.balanceLoad,poolingGain:best.check.poolingGain};item.reason=`${best.check.objective.label}｜可行司機 ${chosen.feasibleCount} 位・Scarcity ${chosen.scarcityPriority}・Regret ${chosen.regret}・空車 ${best.check.deadheadMin} 分／${best.check.deadheadKm} km`;}
    else {const fallback=Organization.drivers(organizationId).map(driver=>({driver,check:planFeasibility(driver,item,assigned,date,objectiveName,options)})).sort((a,b)=>a.check.reasons.length-b.check.reasons.length)[0];item.feasible=false;item.reason=(fallback?.check.reasons||['沒有可執行司機']).join('・');}
    assigned.push(item);
  }
  return assigned.sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));
}
function summarizeDispatchAssignments(assigned,bookingCount){
  const rows=assigned||[],feasibleRows=rows.filter(i=>i.feasible&&i.driverId&&i.vehicleId),feasibleBookingIds=new Set(feasibleRows.flatMap(i=>i.bookingIds||[])),pooledBookings=feasibleRows.filter(i=>i.isPooled).reduce((n,i)=>n+(i.bookingIds?.length||0),0);
  return {bookings:bookingCount,proposedTrips:rows.length,feasibleBookings:feasibleBookingIds.size,trips:feasibleRows.length,poolGroups:feasibleRows.filter(i=>i.isPooled).length,pooledBookings,savedTrips:Math.max(0,feasibleBookingIds.size-feasibleRows.length),emptyKm:Math.round(feasibleRows.reduce((s,i)=>s+(i.emptyKm||0),0)*10)/10,loadedKm:Math.round(feasibleRows.reduce((s,i)=>s+(i.loadedKm||0),0)*10)/10,unassigned:Math.max(0,bookingCount-feasibleBookingIds.size),poolRate:bookingCount?Math.round(pooledBookings/bookingCount*100):0};
}
function compareDispatchSummaries(before,after){
  const emptySaved=Math.round(((before.emptyKm||0)-(after.emptyKm||0))*10)/10,loadedDelta=Math.round(((after.loadedKm||0)-(before.loadedKm||0))*10)/10;
  return {before,after,tripsReduced:(before.trips||0)-(after.trips||0),emptyKmSaved:emptySaved,emptyKmSavedRate:before.emptyKm>0?Math.round(emptySaved/before.emptyKm*100):0,poolRateDelta:(after.poolRate||0)-(before.poolRate||0),loadedKmDelta:loadedDelta,unassignedDelta:(after.unassigned||0)-(before.unassigned||0)};
}
function collectOptimizationRoutingPairs(bookings,organizationId){
  const rows=(bookings||[]).map(b=>Booking.dispatchView(b)||b).filter(b=>b?.pickupAddress&&b?.destination),pairs=[],stops=[];
  rows.forEach(b=>{const departureAt=Booking.dateTime(b);pairs.push({from:b.pickupAddress,to:b.destination,departureAt});stops.push({address:b.pickupAddress,departureAt},{address:b.destination,departureAt});});
  for(let i=0;i<stops.length;i++)for(let j=0;j<stops.length;j++)if(i!==j)pairs.push({from:stops[i].address,to:stops[j].address,departureAt:stops[i].departureAt});
  for(const driver of Organization.drivers(organizationId))for(const b of rows)pairs.push({from:driver.serviceArea||'',to:b.pickupAddress,departureAt:Booking.dateTime(b)});
  const deduped=[],seen=new Set();for(const row of pairs){if(!row.from||!row.to)continue;const key=`${routingBaseKey(row.from,row.to)}@${row.departureAt?dateKey(new Date(row.departureAt)):''}`;if(seen.has(key))continue;seen.add(key);deduped.push(row);if(deduped.length>=600)break;}
  return deduped;
}
function planItemFromScheduledTrip(trip){
  const dispatchStops=(trip.dispatchStops||[]).map(s=>({...s}));
  const fallbackStops=(trip.steps||[]).filter(s=>s.type==='pickup'||s.type==='dropoff').map(s=>({type:s.type,bookingId:(trip.bookingIds||[])[0]||null,legId:null,name:s.name,address:s.destination,at:s.scheduledAt,passengerDelta:0,careRecipientDelta:0,companionDelta:0,wheelchairDelta:0}));
  const stops=dispatchStops.length?dispatchStops:fallbackStops,first=stops[0],last=stops[stops.length-1],maxSeats=Math.max(Number(trip.passengerCount||0),...(trip.passengerLoadTimeline||[]).map(x=>Number(x.seatsUsed||x.passengers||0))),maxWheelchairs=Math.max(0,...(trip.passengerLoadTimeline||[]).map(x=>Number(x.wheelchairSlotsUsed||x.wheelchairs||0)));
  return {id:`repair_${trip.id}`,sourceTripId:trip.id,organizationId:trip.organizationId,bookingIds:[...(trip.bookingIds||[])],bookingLegRefs:[...(trip.bookingLegRefs||[])],isPooled:!!trip.isPooled,pickups:stops.filter(s=>s.type==='pickup').map(s=>({bookingId:s.bookingId,legId:s.legId,name:s.name,address:s.address,at:s.at})),dropoffs:stops.filter(s=>s.type==='dropoff').map(s=>({bookingId:s.bookingId,legId:s.legId,name:s.name,address:s.address,at:s.at})),stops,loadTimeline:[...(trip.passengerLoadTimeline||[])],startAt:first?.at||trip.steps?.find(s=>s.type==='pickup')?.scheduledAt||trip.steps?.[0]?.scheduledAt,endAt:last?.at||trip.steps?.[trip.steps.length-1]?.scheduledAt,firstPickupAddress:first?.address||tripFirstPickupAddress(trip),finalDropoffAddress:last?.address||tripLastDropoffAddress(trip),passengerUnits:maxSeats||1,wheelchairUnits:maxWheelchairs,loadedKm:Number(trip.estimatedLoadedKm||0),driverId:null,vehicleId:null,emptyKm:0,score:0,feasible:true,reason:'局部重排候選',poolingPolicySnapshot:trip.poolingPolicySnapshot||null};
}
function dispatchHash(value=''){ let h=2166136261;const text=String(value);for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36); }
function dispatchResourceRepairFingerprint(trip){
  return dispatchHash(JSON.stringify({id:trip?.id,status:trip?.status,driverId:trip?.driverId,vehicleId:trip?.vehicleId,bookingIds:trip?.bookingIds||[],bookingLegRefs:trip?.bookingLegRefs||[],start:trip?.steps?.[0]?.scheduledAt||null,end:trip?.steps?.[trip?.steps?.length-1]?.scheduledAt||null,updatedAt:trip?.updatedAt||trip?.createdAt||null}));
}
function dispatchPlanInputFingerprint(plan){
  const bookingRefs=[...new Set((plan.items||[]).flatMap(i=>i.bookingIds||[]))].sort().map(id=>{const b=Booking.get(id),leg=Booking.nextPendingLeg(b);return b?{id:b.id,version:Number(b.version)||1,state:Booking.stateOf(b),updatedAt:b.updatedAt||null,serviceJurisdiction:b.serviceJurisdiction||'other',legId:leg?.id||null,legStatus:leg?.status||null}: {id,missing:true};});
  const driverIds=[...new Set((plan.items||[]).map(i=>i.driverId).filter(Boolean))].sort(),vehicleIds=[...new Set((plan.items||[]).map(i=>i.vehicleId).filter(Boolean))].sort();
  const drivers=driverIds.map(id=>{const d=Organization.driver(id);if(!d)return {id,missing:true};const m=store.state.memberships.find(m=>m.userId===d.userId&&m.organizationId===plan.organizationId&&m.role==='driver');return {id,status:d.status,active:d.active!==false,updatedAt:d.updatedAt||null,userId:d.userId,membershipId:m?.id||null,membershipStatus:m?.status||'missing',membershipUpdatedAt:m?.updatedAt||null};});
  const vehicles=vehicleIds.map(id=>{const v=Organization.vehicle(id);return v?{id,status:v.status,capacity:v.capacity,wheelchairSlots:v.wheelchairSlots,accessible:v.accessible===true,updatedAt:v.updatedAt||null}: {id,missing:true};});
  const trips=store.state.trips.filter(t=>t.organizationId===plan.organizationId&&t.date===plan.date&&t.status!=='cancelled').map(t=>({id:t.id,driverId:t.driverId,vehicleId:t.vehicleId,status:t.status,start:t.steps?.[0]?.scheduledAt||null,end:t.steps?.[t.steps.length-1]?.scheduledAt||null,updatedAt:t.updatedAt||t.createdAt||null})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return dispatchHash(JSON.stringify({bookingRefs,drivers,vehicles,trips}));
}
function dispatchPlanStaleReason(plan){
  if(!plan?.inputFingerprint)return null;
  if(plan.poolingPolicyVersion!==POOLING_POLICY_VERSION)return '共乘規則版本已更新';
  if(plan.routingVersion!==DispatchRouting.version)return 'Routing 版本已更新';
  if(plan.optimizerVersion!==DISPATCH_OPTIMIZER_VERSION)return 'Optimizer 版本已更新';
  return dispatchPlanInputFingerprint(plan)===plan.inputFingerprint?null:'Booking、司機 Membership、車輛能力或既有 Trip 已在方案產生後異動';
}
function marketFitScore(booking,organizationId,actorUserId){
  if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.MARKET_READ,organizationId))return null;
  const raw=Booking.get(booking?.id||booking);if(!raw)return null;
  const view=Booking.dispatchView(raw);if(!view?.activeLegId)return {score:0,grade:'不建議',hardBlocked:true,reasons:['目前沒有可承接的去程／回程 Leg'],breakdown:{}};
  const pickupAt=Booking.dateTime(view);if(!pickupAt)return {score:0,grade:'不建議',hardBlocked:true,reasons:['預約時間資料無效'],breakdown:{}};
  const effective=Booking.effectiveServiceNeeds(raw),requirements={needs:`${effective.aidNeed||''} ${effective.specialNeed||''} ${effective.requiresAccessibleVehicle?'無障礙':''}`,passengerUnits:bookingPassengerUnits(raw),wheelchairUnits:bookingWheelchairUnits(raw)};
  const drivers=Organization.drivers(organizationId),capableVehicles=Organization.dispatchableVehicles(organizationId).filter(v=>vehicleMatchesNeeds(v,requirements));
  if(!drivers.length)return {score:0,grade:'不建議',hardBlocked:true,reasons:['目前組織沒有有效 Driver Profile'],breakdown:{feasibility:0,deadhead:0,area:0,pooling:0,balance:0}};
  if(!capableVehicles.length)return {score:0,grade:'不建議',hardBlocked:true,reasons:['目前車隊沒有符合載客量／輪椅／無障礙需求的車輛'],breakdown:{feasibility:0,deadhead:0,area:0,pooling:0,balance:0}};
  const tripDuration=Math.max(8,DispatchRouting.estimate(view.pickupAddress,view.destination,{departureAt:pickupAt}).durationMinutes+DISPATCH_POLICY.routingServiceBufferMin),endAt=addMinutes(pickupAt,tripDuration),windowStart=addMinutes(pickupAt,-DISPATCH_POLICY.departureBufferMin);
  const candidateRows=drivers.map(driver=>{
    const route=DispatchRouting.estimate(driver.serviceArea||'',view.pickupAddress,{departureAt:pickupAt});
    const driverConflict=driverTimeline(driver.id,view.pickupDate).some(t=>tripStartAt(t)<endAt&&tripEndAt(t)>windowStart);
    const vehicle=availableVehicleForWindow(organizationId,windowStart,endAt,requirements);
    return {driver,route,vehicle,driverConflict,exactReady:driver.status==='on_duty'&&!driverConflict&&!!vehicle};
  });
  const bestExact=candidateRows.filter(x=>x.exactReady).sort((a,b)=>a.route.durationMinutes-b.route.durationMinutes)[0],best=(bestExact||candidateRows.sort((a,b)=>a.route.durationMinutes-b.route.durationMinutes)[0]);
  const area=addressAffinity(best.driver.serviceArea||'',view.pickupAddress),deadhead=Math.max(0,25-Math.round(best.route.durationMinutes*.8)),areaScore=area.score>=68?15:area.score>=30?10:area.score>=16?6:2;
  const ownPending=dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.READ_CLAIMED,organizationId)?Booking.listForDispatch(organizationId,view.pickupDate,actorUserId):[];
  const nearPool=ownPending.filter(b=>b.id!==raw.id).map(b=>{const other=Booking.dispatchView(b)||b,dt=Booking.dateTime(other);if(!dt)return null;const law=validatePoolPair(view,other,organizationId);return law.ok?{b:other,timeGap:Math.abs(dt-pickupAt)/60000,pickup:estimateDriveMinutes(other.pickupAddress,view.pickupAddress,{departureAt:pickupAt}),dest:estimateDriveMinutes(other.destination,view.destination,{departureAt:pickupAt})}:null;}).filter(x=>x&&x.timeGap<=45&&x.pickup<=15&&x.dest<=25).sort((a,b)=>(a.pickup+a.dest+a.timeGap/3)-(b.pickup+b.dest+b.timeGap/3))[0];
  const pooling=nearPool?15:0,dayLoads=drivers.map(d=>driverTimeline(d.id,view.pickupDate).length),minLoad=dayLoads.length?Math.min(...dayLoads):0,balance=Math.max(3,10-Math.min(7,minLoad)),feasibility=bestExact?35:20;
  const breakdown={feasibility,deadhead,area:areaScore,pooling,balance},score=Math.max(0,Math.min(100,Object.values(breakdown).reduce((a,b)=>a+b,0))),grade=score>=80?'非常適合':score>=65?'適合':score>=50?'可考慮':'低適配';
  const reasons=[bestExact?`目前已有可執行組合：${best.driver.name}／${best.vehicle?.plate||'可派車'}`:'資源規格可承接，但目前執勤／時段需再由調度確認',`預估空車至案家 ${best.route.durationMinutes} 分`,area.label?`待命區域：${area.label}`:'待命區域距離較遠',nearPool?'已有符合法規且相近的承接需求，可評估共乘／順路安排':'目前沒有明顯合法共乘候選'];
  return {score,grade,hardBlocked:false,reasons,breakdown,bestDriverId:best.driver.id,bestVehicleId:best.vehicle?.id||capableVehicles[0]?.id||null,activeLegId:view.activeLegId,activeLegLabel:view.activeLegLabel||null};
}

function tripLegRefsForRepair(trip){
  const explicit=Array.isArray(trip?.bookingLegRefs)?trip.bookingLegRefs.filter(r=>r?.bookingId):[];
  if(explicit.length)return explicit.map(r=>({bookingId:r.bookingId,legId:r.legId||null}));
  return (trip?.bookingIds||[]).map(bookingId=>{const b=Booking.get(bookingId),leg=(b?.legs||[]).find(l=>l.tripId===trip.id&&l.status==='scheduled');return {bookingId,legId:leg?.id||null};});
}
function prepareRouteRepairItem(trip,{excludeBookingIds=[]}={}){
  if(!trip||trip.status!=='scheduled')return {ok:false,error:'只有尚未開始的 待執行行程 可以重建路線'};
  const excluded=new Set(excludeBookingIds||[]),refs=tripLegRefsForRepair(trip).filter(r=>!excluded.has(r.bookingId));
  if(!refs.length)return {ok:true,mode:'cancel_trip',item:null,views:[],remainingRefs:[]};
  const views=[];
  for(const ref of refs){
    const raw=Booking.get(ref.bookingId);if(!raw)return {ok:false,error:`找不到剩餘 Booking ${ref.bookingId}`};
    const view=ref.legId?Booking.dispatchViewForLeg(raw,ref.legId):Booking.dispatchView(raw);
    if(!view?.activeLegId)return {ok:false,error:`Booking ${ref.bookingId} 缺少可重建的 Leg`};
    views.push(view);
  }
  const item=makePlanItem(views,trip.organizationId);
  if(!item)return {ok:false,error:'無法建立剩餘 Booking 的 Route Repair item'};
  if(!item.feasible)return {ok:false,error:`剩餘共乘路線不合法：${item.reason||'未通過共乘／容量限制'}`,item};
  item.sourceTripId=trip.id;
  item.driverId=trip.driverId||null;item.vehicleId=trip.vehicleId||null;
  return {ok:true,mode:'route_repair',item,views,remainingRefs:refs};
}
Dispatch = {
  routing:DispatchRouting, policy:DISPATCH_POLICY, optimizerVersion:DISPATCH_OPTIMIZER_VERSION, poolingPolicyVersion:POOLING_POLICY_VERSION,
  bookingPoolingConsented,
  estimateDriveMinutes, estimateDriveKm, addressAffinity,
  validatePoolPair, validatePoolGroup,
  objectiveProfiles:DISPATCH_POLICY.objectiveProfiles,
  marketFitScore,
  recommendDrivers(booking,organizationId,actorUserId){ if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.READ_CLAIMED,organizationId))return []; return Organization.drivers(organizationId).map(d=>scoreDriver(d,booking,organizationId,actorUserId)).sort((a,b)=>Number(b.feasible)-Number(a.feasible)||b.score-a.score); },
  poolCandidates(booking,organizationId,actorUserId){ if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.READ_CLAIMED,organizationId))return []; return poolCandidates(booking,organizationId,actorUserId); },
  optimize(date,organizationId,actorUserId,objectiveName='balanced'){
    if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.SCHEDULE,organizationId)||!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.READ_CLAIMED,organizationId))return null;
    const profile=objectiveProfile(objectiveName),pending=Booking.listForDispatch(organizationId,date,actorUserId);
    const baselineItems=pending.map(b=>makePlanItem([b],organizationId)).filter(Boolean),baselineAssigned=scarcityRegretAssign(baselineItems,date,organizationId,objectiveName),baseline=summarizeDispatchAssignments(baselineAssigned,pending.length);
    const items=groupBookings(pending,organizationId),assigned=scarcityRegretAssign(items,date,organizationId,objectiveName),summary=summarizeDispatchAssignments(assigned,pending.length),comparison=compareDispatchSummaries(baseline,summary);
    const plan={id:uid('dispatch'),organizationId,date,status:'draft',revision:1,optimizerVersion:DISPATCH_OPTIMIZER_VERSION,routingVersion:DispatchRouting.version,poolingPolicyVersion:POOLING_POLICY_VERSION,objectiveProfile:objectiveName,objectiveLabel:profile.label,routingStatus:DispatchRouting.status(),createdAt:nowISO(),items:assigned,summary,comparison};
    plan.inputFingerprint=dispatchPlanInputFingerprint(plan);
    store.mutate(db=>{ db.dispatchPlans=db.dispatchPlans.filter(p=>!(p.organizationId===organizationId&&p.date===date&&p.status==='draft')); db.dispatchPlans.unshift(plan); });
    Audit.log('dispatch_optimized',`產生 ${date} ${profile.label}：${pending.length} 筆預約／${assigned.length} 趟；空車 ${comparison.emptyKmSaved>=0?'減少':'增加'} ${Math.abs(comparison.emptyKmSaved)} km`,{organizationId,dispatchPlanId:plan.id,objectiveProfile:objectiveName,comparison});
    return plan;
  },
  async optimizeWithRouting(date,organizationId,actorUserId,objectiveName='balanced'){
    if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.SCHEDULE,organizationId)||!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.READ_CLAIMED,organizationId))return null;
    const pending=Booking.listForDispatch(organizationId,date,actorUserId),pairs=collectOptimizationRoutingPairs(pending,organizationId);
    const routingPrime=await DispatchRouting.prime(pairs),plan=this.optimize(date,organizationId,actorUserId,objectiveName);
    if(plan){plan.routingPrime=routingPrime;store.mutate(db=>{const p=db.dispatchPlans.find(x=>x.id===plan.id);if(p)p.routingPrime=routingPrime;});}
    return plan;
  },
  prepareRouteRepair(tripOrId,{excludeBookingIds=[]}={}){
    const trip=typeof tripOrId==='string'?store.state.trips.find(t=>t.id===tripOrId):tripOrId;
    return prepareRouteRepairItem(trip,{excludeBookingIds});
  },
  detectAffectedScheduledTrips(date,organizationId,{fromAt=null,driverId=null,vehicleId=null,bookingId=null}={}){
    const threshold=fromAt?new Date(fromAt):new Date();
    return store.state.trips.filter(t=>t.organizationId===organizationId&&(bookingId||t.date===date)&&t.status==='scheduled'&&tripStartAt(t)>=threshold).filter(t=>{
      const driver=Organization.driver(t.driverId),membership=driver&&store.state.memberships.find(m=>m.userId===driver.userId&&m.organizationId===organizationId&&m.role==='driver'),vehicle=Organization.vehicle(t.vehicleId);
      const invalidResource=!driver||driver.active===false||driver.status!=='on_duty'||(membership?.status||'missing')!=='active'||!vehicle||vehicle.status!=='available';
      const explicit=(driverId&&t.driverId===driverId)||(vehicleId&&t.vehicleId===vehicleId)||(bookingId&&(t.bookingIds||[]).includes(bookingId));
      return driverId||vehicleId||bookingId?!!explicit:invalidResource;
    });
  },
  repairResourceTrips({date,organizationId,actorUserId,fromAt=null,driverId=null,vehicleId=null,reason='資源異動局部重排',objectiveName='balanced'}={}){
    if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.SCHEDULE,organizationId))return {ok:false,error:'你沒有局部重新派車的權限'};
    const affected=this.detectAffectedScheduledTrips(date,organizationId,{fromAt,driverId,vehicleId});
    if(!affected.length)return {ok:true,repairType:'resource_change',changed:0,trips:[],message:'目前沒有需要資源重排的未開始行程'};
    const excludedIds=affected.map(t=>t.id),expectedFingerprints=new Map(affected.map(t=>[t.id,dispatchResourceRepairFingerprint(t)]));
    const items=affected.map(planItemFromScheduledTrip).filter(i=>i.startAt&&i.endAt),options={excludeTripIds:excludedIds,blockedDriverIds:driverId?[driverId]:[],blockedVehicleIds:vehicleId?[vehicleId]:[]};
    const reassigned=scarcityRegretAssign(items,date,organizationId,objectiveName,[],options),blocked=reassigned.filter(i=>!i.feasible||!i.driverId||!i.vehicleId);
    if(blocked.length)return {ok:false,error:`仍有 ${blocked.length} 趟找不到替代司機／車輛，未變更任何 Trip`,blocked};
    const changes=reassigned.map(item=>{const trip=affected.find(t=>t.id===item.sourceTripId);return {tripId:trip.id,expectedFingerprint:expectedFingerprints.get(trip.id),oldDriverId:trip.driverId,newDriverId:item.driverId,oldVehicleId:trip.vehicleId,newVehicleId:item.vehicleId,score:item.score,reason:item.reason};});
    try{
      store.mutate(db=>{
        for(const change of changes){const t=db.trips.find(x=>x.id===change.tripId);if(!t||t.status!=='scheduled'||dispatchResourceRepairFingerprint(t)!==change.expectedFingerprint)throw new Error('RESOURCE_REPAIR_STALE');}
        const at=nowISO();
        for(const change of changes){const t=db.trips.find(x=>x.id===change.tripId);t.redispatchHistory=t.redispatchHistory||[];t.redispatchHistory.push({at,actorUserId,repairType:'resource_change',reason,oldDriverId:change.oldDriverId,newDriverId:change.newDriverId,oldVehicleId:change.oldVehicleId,newVehicleId:change.newVehicleId});t.driverId=change.newDriverId;t.vehicleId=change.newVehicleId;t.optimizerScore=change.score;t.redispatchedAt=at;t.redispatchReason=reason;t.updatedAt=at;}
      });
    }catch(error){if(error?.message==='RESOURCE_REPAIR_STALE')return {ok:false,error:'Resource Repair 套用前 Trip 已開始或被其他調度異動；整批未變更，且未發送任何改派通知',stale:true};throw error;}
    if(typeof Notification!=='undefined'&&Notification?.queue){for(const change of changes){const trip=store.state.trips.find(t=>t.id===change.tripId),newDriver=Organization.driver(change.newDriverId),oldDriver=Organization.driver(change.oldDriverId);if(newDriver?.userId)Notification.queue({organizationId:trip?.organizationId||organizationId,recipientId:newDriver.userId,channel:'line',template:'trip_redispatched',eventType:'trip_redispatched',payload:{tripId:change.tripId,tripCode:trip?.code||'',reason}});if(oldDriver?.userId&&oldDriver.userId!==newDriver?.userId)Notification.queue({organizationId:trip?.organizationId||organizationId,recipientId:oldDriver.userId,channel:'line',template:'trip_unassigned',eventType:'trip_unassigned',payload:{tripId:change.tripId,tripCode:trip?.code||'',reason}});}}
    Audit.log('dispatch_resource_repaired',`Resource Repair ${changes.length} 趟未開始 Trip`,{organizationId,date,actorUserId,reason,atomic:true,changes});
    return {ok:true,repairType:'resource_change',changed:changes.length,trips:changes};
  },
  repairRouteTrips({date,organizationId,actorUserId,bookingId=null,excludeBookingIds=[],reason='Booking 異動路線重排',objectiveName='balanced',changeType='booking_changed'}={}){
    if(!dispatchActorCan(actorUserId,DISPATCH_BOOKING_PERMISSION.SCHEDULE,organizationId))return {ok:false,error:'你沒有局部路線重排的權限'};
    const affected=this.detectAffectedScheduledTrips(date,organizationId,{fromAt:new Date(0),bookingId});
    if(!affected.length)return {ok:true,repairType:changeType,changed:0,trips:[],message:'目前沒有需要 Route Repair 的未開始行程'};
    const excludedTripIds=affected.map(t=>t.id),prepared=[];
    for(const trip of affected){const r=prepareRouteRepairItem(trip,{excludeBookingIds});if(!r.ok)return {ok:false,error:`${trip.code||trip.id} Route Repair 失敗：${r.error}`,tripId:trip.id};if(r.mode==='cancel_trip'){prepared.push({trip,mode:'cancel_trip',item:null});continue;}prepared.push({trip,mode:'route_repair',item:r.item});}
    const routeItems=prepared.filter(x=>x.mode==='route_repair').map(x=>x.item),options={excludeTripIds:excludedTripIds},reassigned=[];
    const itemsByDate=new Map();for(const item of routeItems){const repairDate=dateKey(new Date(item.startAt));const list=itemsByDate.get(repairDate)||[];list.push(item);itemsByDate.set(repairDate,list);}
    for(const [repairDate,rows] of itemsByDate)reassigned.push(...scarcityRegretAssign(rows,repairDate,organizationId,objectiveName,[],options));
    const blocked=reassigned.filter(i=>!i.feasible||!i.driverId||!i.vehicleId);if(blocked.length)return {ok:false,error:`Route Repair 後仍有 ${blocked.length} 趟找不到可執行司機／車輛，未變更任何 Trip`,blocked};
    const itemByTrip=new Map(reassigned.map(i=>[i.sourceTripId,i])),changes=[];
    for(const row of prepared){if(row.mode==='cancel_trip'){changes.push({tripId:row.trip.id,mode:'cancel_trip'});continue;}const item=itemByTrip.get(row.trip.id);if(!item)return {ok:false,error:`${row.trip.code||row.trip.id} 缺少重排結果`};changes.push({tripId:row.trip.id,mode:'route_repair',item});}
    const apply=Trip?.applyPreparedRouteRepairs?.(changes,{actorUserId,reason,repairType:changeType});if(!apply?.ok)return apply||{ok:false,error:'Trip Route Repair 套用失敗'};
    Audit.log('dispatch_route_repaired',`Route Repair ${apply.changed||0} 趟未開始 Trip`,{organizationId,date,actorUserId,reason,changeType,bookingId,excludeBookingIds,tripIds:apply.tripIds||[]});
    return {ok:true,repairType:changeType,changed:apply.changed||0,trips:apply.tripIds||[]};
  },
  repairAffectedTrips({date,organizationId,actorUserId,fromAt=null,driverId=null,vehicleId=null,bookingId=null,excludeBookingIds=[],reason='局部重新最佳化',objectiveName='balanced',changeType='resource_change'}={}){
    if(['booking_cancelled','booking_changed'].includes(changeType)){const effectiveExclude=changeType==='booking_cancelled'&&bookingId?[...new Set([...(excludeBookingIds||[]),bookingId])]:excludeBookingIds;return this.repairRouteTrips({date,organizationId,actorUserId,bookingId,excludeBookingIds:effectiveExclude,reason,objectiveName,changeType});}
    return this.repairResourceTrips({date,organizationId,actorUserId,fromAt,driverId,vehicleId,reason,objectiveName});
  },
  latestDraft(date,organizationId){ return store.state.dispatchPlans.find(p=>p.organizationId===organizationId&&p.date===date&&p.status==='draft')||null; },
  validatePlanFreshness(planId){ const plan=typeof planId==='string'?store.state.dispatchPlans.find(p=>p.id===planId):planId;if(!plan)return {ok:false,error:'找不到調度方案'};const reason=dispatchPlanStaleReason(plan);return reason?{ok:false,error:`方案已過期：${reason}，請重新最佳化`,staleReason:reason}:{ok:true,plan}; },
  confirm(planId,actorUserId){
    const plan=store.state.dispatchPlans.find(p=>p.id===planId); if(!plan) return {ok:false,error:'找不到調度方案'};
    if(!actorUserId||!Identity?.canUser?.(actorUserId,DISPATCH_BOOKING_PERMISSION.SCHEDULE,plan.organizationId)) return {ok:false,error:'你沒有確認調度方案／建立 Booking 行程的權限'};
    if(plan.status!=='draft') return {ok:false,error:'此調度方案已不是待確認狀態，請重新產生最佳化方案'};
    const fresh=this.validatePlanFreshness(plan);if(!fresh.ok){store.mutate(db=>{const p=db.dispatchPlans.find(x=>x.id===planId);if(p){p.staleAt=nowISO();p.staleReason=fresh.staleReason;}});return fresh;}
    const blocked=plan.items.filter(i=>!i.feasible||!i.driverId||!i.vehicleId||Organization.driver(i.driverId)?.status!=='on_duty'||Organization.vehicle(i.vehicleId)?.status!=='available'); if(blocked.length) return {ok:false,error:`仍有 ${blocked.length} 趟的司機／車輛不可執行，請重新最佳化或改派`};
    store.mutate(db=>{ const p=db.dispatchPlans.find(x=>x.id===planId); p.status='confirmed'; p.confirmedAt=nowISO(); p.confirmedByUserId=actorUserId; });
    Audit.log('dispatch_confirmed',`確認調度方案 ${planId}`,{dispatchPlanId:planId,organizationId:plan.organizationId,actorUserId});
    return {ok:true,plan:store.state.dispatchPlans.find(p=>p.id===planId)};
  }
};
}


{
Notification = {
  queue({organizationId,recipientId,channel='line',template,eventType,payload={}}){
    const item={id:uid('ntf'),organizationId,recipientId,channel,template,eventType,payload,status:'queued',createdAt:nowISO(),sentAt:null,error:null};
    store.mutate(db=>db.notifications.unshift(item));
    return item;
  },
  list(organizationId){ return store.state.notifications.filter(n=>n.organizationId===organizationId); },
  markSent(id){ store.mutate(db=>{ const n=db.notifications.find(x=>x.id===id); if(n){ n.status='sent'; n.sentAt=nowISO(); } }); },
  simulateDelivery(id){ this.markSent(id); return store.state.notifications.find(n=>n.id===id); }
};
}


{

const TRIP_RUNTIME_SCHEMA_VERSION=8;
const TRIP_EVENT_SCHEMA_VERSION=1;
const TRIP_PASSENGER_SCHEMA_VERSION=1;
const TRIP_RESOURCE_SEGMENT_SCHEMA_VERSION=1;
const TRIP_EXECUTION_SNAPSHOT_SCHEMA_VERSION=1;
const TRIP_ACTUAL_METRICS_SCHEMA_VERSION=1;
const TRIP_PROOF_SCHEMA_VERSION=4;
const TRIP_PROOF_POLICY_VERSION=1;
const TRIP_INVARIANT_SCHEMA_VERSION=1;
const TRIP_NAVIGATION_SCHEMA_VERSION=2;
const TRIP_OFFLINE_QUEUE_SCHEMA_VERSION=2;
const TRIP_EXECUTION_POLICY=Object.freeze({startEarlyMinutes:60,completedCorrectionWindowMinutes:15});
const TRIP_P2_RETENTION_POLICY={syncedQueueDays:14,gpsDays:30,proofBlobDays:180,orphanProofBlobDays:7,eventUiPageSize:40,proofUiPageSize:10};
const TRIP_P2_IDB={name:'careRideTripP2',version:2,stores:{queue:'offlineQueue',gps:'gpsSamples',proof:'proofBlobs',meta:'meta'}};
function newStableClientId(prefix){return `${prefix}_${(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():uid(prefix)}`;}
function getOrCreateStableClientId(key,prefix){
  let value=LocalStore.getItem(key);
  if(value)return value;
  value=SessionStore.getItem(key);
  if(value)return value;
  value=newStableClientId(prefix);
  if(!LocalStore.setItem(key,value))SessionStore.setItem(key,value);
  return value;
}
function getOrCreateSessionClientId(key,prefix){
  let value=SessionStore.getItem(key);
  if(value)return value;
  value=newStableClientId(prefix);
  SessionStore.setItem(key,value);
  return value;
}
let TRIP_DEVICE_ID=getOrCreateStableClientId('careRideTripDeviceId','dev');
let TRIP_DEVICE_ID_SOURCE=LocalStore.persistent?'localStorage':SessionStore.persistent?'sessionStorage':'ephemeral';
const TRIP_SESSION_ID=getOrCreateSessionClientId('careRideTripSessionId','ses');
function tripClientEnvelope(extra={}){return {requestId:extra.requestId||`req_${(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():uid('req')}`,deviceId:TRIP_DEVICE_ID,deviceIdSource:TRIP_DEVICE_ID_SOURCE,sessionId:TRIP_SESSION_ID,clientRecordedAt:extra.clientRecordedAt||nowISO(),serverRecordedAt:extra.serverRecordedAt||null,...extra};}
let TRIP_IDB_DISABLED=false;
function tripIdbOpen(){return new Promise((resolve,reject)=>{
  if(TRIP_IDB_DISABLED||typeof indexedDB==='undefined')return reject(new Error('IndexedDB unavailable'));
  let settled=false;
  const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  const timer=setTimeout(()=>{TRIP_IDB_DISABLED=true;finish(reject,new Error('IndexedDB preview timeout'));},900);
  try{
    const req=indexedDB.open(TRIP_P2_IDB.name,TRIP_P2_IDB.version);
    req.onupgradeneeded=()=>{const db=req.result;for(const name of Object.values(TRIP_P2_IDB.stores))if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});};
    req.onsuccess=()=>finish(resolve,req.result);
    req.onerror=()=>{TRIP_IDB_DISABLED=true;finish(reject,req.error||new Error('IndexedDB open 失敗'));};
    req.onblocked=()=>{TRIP_IDB_DISABLED=true;finish(reject,new Error('IndexedDB blocked'));};
  }catch(error){TRIP_IDB_DISABLED=true;finish(reject,error);}
});}
async function tripIdbPut(storeName,row){try{const db=await tripIdbOpen();await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).put(row);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;}catch(e){return false;}}
async function tripIdbGetAll(storeName){try{const db=await tripIdbOpen();const rows=await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readonly'),req=tx.objectStore(storeName).getAll();req.onsuccess=()=>resolve(Array.isArray(req.result)?req.result:[]);req.onerror=()=>reject(req.error);});db.close();return rows;}catch(e){return [];}}
async function tripIdbGet(storeName,id){try{const db=await tripIdbOpen();const row=await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readonly'),req=tx.objectStore(storeName).get(id);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});db.close();return row;}catch(e){return null;}}
async function tripIdbDelete(storeName,id){try{const db=await tripIdbOpen();await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;}catch(e){return false;}}
async function tripIdbCleanup(storeName,olderThanIso,dateField,{predicate=null}={}){try{const db=await tripIdbOpen();await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite'),st=tx.objectStore(storeName),req=st.openCursor();req.onsuccess=()=>{const c=req.result;if(!c)return;const row=c.value,raw=row?.[dateField],dt=raw?new Date(raw):null;if((!predicate||predicate(row))&&dt&&!Number.isNaN(dt.getTime())&&dt<new Date(olderThanIso))c.delete();c.continue();};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;}catch(e){return false;}}
async function hydrateTripDeviceIdentityFromIdb(){
  try{
    const existing=await tripIdbGet(TRIP_P2_IDB.stores.meta,'device_identity');
    if(existing?.value){
      TRIP_DEVICE_ID=String(existing.value);
      TRIP_DEVICE_ID_SOURCE='indexeddb';
      LocalStore.setItem('careRideTripDeviceId',TRIP_DEVICE_ID);
      return {ok:true,deviceId:TRIP_DEVICE_ID,source:TRIP_DEVICE_ID_SOURCE,restored:true};
    }
    const row={id:'device_identity',value:TRIP_DEVICE_ID,createdAt:nowISO()};
    const ok=await tripIdbPut(TRIP_P2_IDB.stores.meta,row);
    if(ok)TRIP_DEVICE_ID_SOURCE='indexeddb';
    return {ok,deviceId:TRIP_DEVICE_ID,source:TRIP_DEVICE_ID_SOURCE,restored:false};
  }catch(error){
    return {ok:false,deviceId:TRIP_DEVICE_ID,source:TRIP_DEVICE_ID_SOURCE,error:String(error?.message||error)};
  }
}
function proofBlobRetentionDecisionP2(row,{referenced=false,nowMs=Date.now()}={}){
  const createdAt=new Date(row?.createdAt||0).getTime(),remoteBacked=!!(row?.remoteObjectKey||row?.metadata?.remoteObjectKey||row?.metadata?.remoteBacked);
  if(!createdAt||Number.isNaN(createdAt))return {purge:false,reason:'invalid_or_missing_created_at',remoteBacked};
  const ageMs=Math.max(0,nowMs-createdAt),orphanLimit=TRIP_P2_RETENTION_POLICY.orphanProofBlobDays*86400000,referencedLimit=TRIP_P2_RETENTION_POLICY.proofBlobDays*86400000;
  if(!referenced&&ageMs>orphanLimit)return {purge:true,reason:'orphan_expired',remoteBacked};
  if(referenced&&remoteBacked&&ageMs>referencedLimit)return {purge:true,reason:'remote_backed_local_cache_expired',remoteBacked};
  if(referenced&&!remoteBacked&&ageMs>referencedLimit)return {purge:false,reason:'protected_local_only_reference',remoteBacked};
  return {purge:false,reason:referenced?'active_reference':'recent_orphan',remoteBacked};
}
async function cleanupProofBlobStorageP2(){
  try{
    const db=await tripIdbOpen();
    const referenced=new Set((store.state.trips||[]).flatMap(t=>(t.serviceProofs||[]).map(p=>p?.photo?.objectKey).filter(Boolean)));
    let deleted=0,protectedLocal=0;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(TRIP_P2_IDB.stores.proof,'readwrite'),st=tx.objectStore(TRIP_P2_IDB.stores.proof),req=st.openCursor();
      req.onsuccess=()=>{
        const c=req.result;if(!c)return;
        const row=c.value||{},decision=proofBlobRetentionDecisionP2(row,{referenced:referenced.has(row.id)});
        if(decision.purge){c.delete();deleted++;}
        else if(decision.reason==='protected_local_only_reference')protectedLocal++;
        c.continue();
      };
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
    return {ok:true,deleted,protectedLocal};
  }catch(error){return {ok:false,deleted:0,protectedLocal:0,error:String(error?.message||error)};}
}
const TRIP_QUEUE_SETTLED_STATUSES=Object.freeze(['synced','rejected']);
// 行程離線佇列的同步轉接器。
//
// 司機執行自己的行程：每個指令（完成停靠點、返回上一步、服務證明、定位、異常）
// 依排入順序逐一送 trip-execute，帶上該指令當下的行程執行欄位與同一時間點產生的
// 行程事件，伺服器逐欄驗證後寫入。同一趟行程前一個指令沒成功，後面的就不送：
//   - 網路錯誤或伺服器暫時失敗 → 保留待同步，下次重試（伺服器以冪等鍵防重複寫入）
//   - 400／403／404／409 → 標記 rejected、不再自動重送，重新載入伺服器資料並提示
// 其他行程（調度／負責人的操作）維持原本走 state-mutate 的方式。
const TripSyncAdapter={mode:'trip_execute_endpoint',
  commandBody_(item,tripId,events){
    const p=item.payload||{};
    if(p.command)return {tripId,command:p.command,expectedRevision:p.expectedRevision,expectedStepId:p.expectedStepId||undefined,idempotencyKey:p.idempotencyKey||item.referenceId,trip:p.tripSnapshot,events};
    if(item.mutationType==='trip_location_sample')return {tripId,command:'location_sample',idempotencyKey:item.referenceId,samples:[p],liveNavigation:(store.state.trips||[]).find(t=>t.id===tripId)?.liveNavigation??undefined,events};
    return {tripId,command:'report_issue',idempotencyKey:item.referenceId,issue:p,events};
  },
  async syncBatch(items,context={}){
    const results=[],legacy=[],byTrip=new Map();let rejected=null;
    const isCommand=x=>!!x.payload?.command||x.mutationType==='trip_location_sample'||x.mutationType==='trip_issue_reported';
    for(const item of items){
      const trip=(store.state.trips||[]).find(t=>t.id===item.tripId)||null;
      if(!trip&&item.payload?.command){results.push({id:item.id,requestId:item.requestId,ok:false,permanent:true,error:'行程已不在目前可執行的清單中，這筆離線操作無法送出'});continue;}
      if(!tripDriverExecutionOwned_(trip)){legacy.push(item);continue;}
      if(!byTrip.has(item.tripId))byTrip.set(item.tripId,[]);byTrip.get(item.tripId).push(item);
    }
    const token=typeof backendAuthToken==='function'?backendAuthToken():'';
    for(const [tripId,rows] of byTrip){
      const claimed=new Set();let stop=null;
      for(const cmd of rows.filter(isCommand)){
        const siblings=rows.filter(x=>!isCommand(x)&&!claimed.has(x.id)&&x.queuedAt===cmd.queuedAt);
        siblings.forEach(x=>claimed.add(x.id));
        const group=[cmd,...siblings];
        if(stop){if(stop.permanent)group.forEach(x=>results.push({id:x.id,requestId:x.requestId,ok:false,permanent:true,error:`同一趟行程較早的離線操作被拒絕，此操作未送出：${stop.error}`}));continue;}
        if(!token){stop={permanent:false,error:'尚未登入'};continue;}
        const events=siblings.filter(x=>x.mutationType==='trip_event'&&x.payload).map(x=>x.payload);
        let status=0,body=null,networkError='';
        try{const response=await fetch(APP_CONFIG.tripExecuteUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},credentials:'same-origin',cache:'no-store',body:JSON.stringify(this.commandBody_(cmd,tripId,events))});status=response.status;body=await response.json().catch(()=>null);}catch(error){networkError=String(error?.message||error);}
        if(status===200&&body?.ok){const stamp=nowISO();group.forEach(x=>results.push({id:x.id,requestId:x.requestId,ok:true,serverRevision:body.data?.revision??null,serverRecordedAt:stamp}));continue;}
        const error=body?.error?.message||(status?`行程同步失敗（HTTP ${status}）`:`行程同步失敗：${networkError||'網路錯誤'}`);
        stop={permanent:[400,403,404,409].includes(status),error};
        if(stop.permanent){rejected=rejected||error;group.forEach(x=>results.push({id:x.id,requestId:x.requestId,ok:false,permanent:true,error}));}
      }
      // 沒有對應指令的事件（例如載入時補建的歷史基準事件）只留在本機，伺服器沒有對應寫入
      if(!stop||stop.permanent)for(const x of rows)if(!isCommand(x)&&!claimed.has(x.id))results.push({id:x.id,requestId:x.requestId,ok:true,localOnly:true,serverRecordedAt:null});
    }
    if(legacy.length){
      const ack=await authoritativeFlush_();const stamp=authoritativeLastAckAt||nowISO();
      legacy.forEach(x=>results.push(ack?.ok?{id:x.id,requestId:x.requestId,ok:true,serverRevision:Trip?.get?.(x.tripId)?.revision??null,serverRecordedAt:stamp}:{id:x.id,requestId:x.requestId,ok:false,error:ack?.error||'正式行程同步失敗'}));
    }
    if(rejected)setTimeout(async()=>{try{await AppStateDatabase.loadAll({silent:true});render();}catch{}try{showToast(`離線行程操作被伺服器拒絕：${rejected}。已改以伺服器資料為準。`);}catch{}},0);
    const answered=new Set(results.map(r=>r.id)),complete=items.every(x=>answered.has(x.id));
    return {ok:complete&&results.every(r=>r.ok),mode:this.mode,serverRecordedAt:nowISO(),error:rejected||(complete?null:'部分行程操作尚未送出'),results};
  }
};
const TripNavigationAdapter={routeProvider:null,trafficEtaProvider:null,configure({routeProvider=null,trafficEtaProvider=null}={}){this.routeProvider=routeProvider;this.trafficEtaProvider=trafficEtaProvider;},async enrich(ctx){const out={source:'fallback',polyline:null,deviationKm:null,etaAt:null,etaMinutes:null,provider:null,routeProvider:null,trafficProvider:null};if(this.routeProvider?.getRoute){try{const r=await this.routeProvider.getRoute(ctx);if(r){out.polyline=r.polyline||null;out.routeProvider=r.provider||'route_adapter';out.provider=out.routeProvider;out.source='route_adapter';if(Number.isFinite(Number(r.deviationKm)))out.deviationKm=Number(r.deviationKm);}}catch(e){}}if(this.trafficEtaProvider?.getEta){try{const e=await this.trafficEtaProvider.getEta(ctx);if(e){out.etaAt=e.etaAt||null;out.etaMinutes=Number.isFinite(Number(e.etaMinutes))?Number(e.etaMinutes):null;out.trafficProvider=e.provider||'traffic_adapter';out.provider=out.trafficProvider;out.source=out.routeProvider?'route+traffic_adapter':'traffic_adapter';}}catch(e){}}return out;}};
let tripOutboxFlushTimer=null,tripOutboxSyncPromise=null,tripOutboxHydrated=false,tripOutboxHydratePromise=null;
let tripInitializationPromise=null;
function scheduleTripOutboxFlush(delayMs=35){if(tripAppOffline())return;if(tripOutboxFlushTimer)clearTimeout(tripOutboxFlushTimer);tripOutboxFlushTimer=setTimeout(()=>{tripOutboxFlushTimer=null;try{Trip?.syncOfflineQueue?.();}catch(e){}},delayMs);}
async function persistTripQueueRowP2(row){return tripIdbPut(TRIP_P2_IDB.stores.queue,deepClone(row));}
async function persistTripGpsP2(sample){return tripIdbPut(TRIP_P2_IDB.stores.gps,deepClone(sample));}
async function persistTripProofBlobP2({proofId,tripId,blob,metadata}){if(!blob)return null;const row={id:proofId,tripId,blob,metadata:{remoteObjectKey:null,remoteBacked:false,...deepClone(metadata||{})},createdAt:nowISO()};const ok=await tripIdbPut(TRIP_P2_IDB.stores.proof,row);return ok?{storage:'indexeddb',objectKey:proofId,...deepClone(row.metadata)}:null;}
function tripDataUrlToBlob(dataUrl){const value=String(dataUrl||'');const comma=value.indexOf(',');if(!value.startsWith('data:')||comma<0)throw new Error('Legacy Proof 圖片格式不合法');const meta=value.slice(5,comma),body=value.slice(comma+1),mime=(meta.split(';')[0]||'application/octet-stream'),isBase64=/;base64/i.test(meta),binary=isBase64?atob(body):decodeURIComponent(body),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new Blob([bytes],{type:mime});}
function outboxStatusRank(status){return status==='synced'||status==='rejected'?3:status==='failed'?2:1;}
function mergeOutboxRows(localRow,idbRow){if(!localRow)return deepClone(idbRow);if(!idbRow)return deepClone(localRow);const winner=outboxStatusRank(idbRow.status)>outboxStatusRank(localRow.status)?idbRow:localRow,other=winner===localRow?idbRow:localRow;return {...deepClone(other),...deepClone(winner),payload:winner.payload??other.payload??null,requestId:winner.requestId||other.requestId||null,dedupeKey:winner.dedupeKey||other.dedupeKey||null};}
async function hydrateTripOutboxFromIdb(){if(tripOutboxHydrated)return {ok:true,hydrated:true,changed:0};if(tripOutboxHydratePromise)return tripOutboxHydratePromise;tripOutboxHydratePromise=(async()=>{const idbRows=await tripIdbGetAll(TRIP_P2_IDB.stores.queue);if(!idbRows.length){tripOutboxHydrated=true;return {ok:true,hydrated:true,changed:0};}let changed=0;store.mutate(db=>{const local=normalizeTripOfflineQueueInDb(db),byId=new Map(local.map(x=>[x.id,x]));for(const row of idbRows){if(!row?.id)continue;const merged=mergeOutboxRows(byId.get(row.id),row),idx=local.findIndex(x=>x.id===row.id);if(idx>=0)local[idx]=merged;else{local.push(merged);changed++;}byId.set(row.id,merged);}const seen=new Map();for(let i=local.length-1;i>=0;i--){const r=local[i],key=r.requestId||r.id;if(seen.has(key)){local.splice(i,1);changed++;}else seen.set(key,true);}});tripOutboxHydrated=true;return {ok:true,hydrated:true,changed};})().finally(()=>{tripOutboxHydratePromise=null;});return tripOutboxHydratePromise;}
async function migrateLegacyProofPhotosToIdb(){const candidates=[];for(const trip of store.state.trips||[]){for(const proof of trip.serviceProofs||[]){if(proof?.photo?.dataUrl)candidates.push({tripId:trip.id,proofId:proof.id,photo:deepClone(proof.photo)});}}let migrated=0,failed=0;for(const c of candidates){try{const blob=tripDataUrlToBlob(c.photo.dataUrl),objectKey=`legacy_${c.proofId}`,ref=await persistTripProofBlobP2({proofId:objectKey,tripId:c.tripId,blob,metadata:{name:c.photo.name||'proof.jpg',type:c.photo.type||blob.type||'image/jpeg',size:c.photo.size||blob.size,legacyMigrated:true}});if(!ref){failed++;continue;}store.mutate(db=>{const trip=(db.trips||[]).find(t=>t.id===c.tripId),proof=trip?.serviceProofs?.find(p=>p.id===c.proofId);if(!proof?.photo?.dataUrl)return;proof.photo={name:c.photo.name||'proof.jpg',type:c.photo.type||blob.type||'image/jpeg',size:c.photo.size||blob.size,storage:'indexeddb',objectKey,legacyInline:false,legacyMigratedAt:nowISO()};appendTripEventInDb(db,{tripId:c.tripId,eventType:'trip_proof_photo_migrated',actorUserId:null,reason:'legacy_inline_to_indexeddb',metadata:{proofId:c.proofId,objectKey}});});migrated++;}catch(e){failed++;}}return {ok:failed===0,migrated,failed,total:candidates.length};}
async function cleanupTripP2Storage(){const now=Date.now(),iso=d=>new Date(now-d*86400000).toISOString();const [queueOk,gpsOk,proofResult]=await Promise.all([tripIdbCleanup(TRIP_P2_IDB.stores.queue,iso(TRIP_P2_RETENTION_POLICY.syncedQueueDays),'syncedAt',{predicate:row=>row?.status==='synced'&&!!row?.syncedAt}),tripIdbCleanup(TRIP_P2_IDB.stores.gps,iso(TRIP_P2_RETENTION_POLICY.gpsDays),'at'),cleanupProofBlobStorageP2()]);return {ok:!!queueOk&&!!gpsOk&&proofResult?.ok!==false,queueOk,gpsOk,proof:proofResult};}

const TRIP_LOCATION_SAMPLE_LIMIT=240;
const TRIP_ROUTE_DEVIATION_POLICY=Object.freeze({warningKm:1.2,criticalKm:2.5,maxAccuracyMeters:250});
const TRIP_ROUTE_DEVIATION_WARN_KM=TRIP_ROUTE_DEVIATION_POLICY.warningKm;
const TRIP_ROUTE_DEVIATION_CRITICAL_KM=TRIP_ROUTE_DEVIATION_POLICY.criticalKm;
function tripRouteDeviationLevel(deviationKm){const km=Number(deviationKm);if(!Number.isFinite(km))return 'unavailable';return km>=TRIP_ROUTE_DEVIATION_POLICY.criticalKm?'critical':km>=TRIP_ROUTE_DEVIATION_POLICY.warningKm?'warning':'normal';}
const ISSUE_SCHEMA_VERSION=3;
const ISSUE_SLA_MINUTES=Object.freeze({emergency:5,critical:10,warning:30,info:60});
const TRIP_PASSENGER_STATUSES=Object.freeze(['waiting','onboard','dropped_off','cancelled','no_show','emergency_exit']);
const TRIP_MUTATION_RECEIPT_LIMIT=80;
const TRIP_LOCK_TTL_MS=4000;
const TRIP_STATUS_TRANSITIONS=Object.freeze({
  scheduled:Object.freeze(['in_progress','cancelled']),
  in_progress:Object.freeze(['interrupted','completed']),
  interrupted:Object.freeze(['in_progress','aborted']),
  completed:Object.freeze([]),
  cancelled:Object.freeze([]),
  aborted:Object.freeze([])
});
const TRIP_CORRECTION_TRANSITIONS=Object.freeze({
  in_progress:Object.freeze(['scheduled']),
  completed:Object.freeze(['in_progress'])
});
const TRIP_STOP_STATUSES=Object.freeze(['pending','arrived','servicing','completed']);
const ISSUE_STATUSES=Object.freeze(['open','acknowledged','handling','resolved']);
const ISSUE_STATUS_TRANSITIONS=Object.freeze({
  open:Object.freeze(['acknowledged']),
  acknowledged:Object.freeze(['handling']),
  handling:Object.freeze(['resolved']),
  resolved:Object.freeze([])
});
const ISSUE_STATUS_LABELS=Object.freeze({open:'待接手',acknowledged:'已接手',handling:'處理中',resolved:'已結案'});
const ISSUE_SEVERITY_LABELS=Object.freeze({info:'一般',warning:'注意',critical:'重大',emergency:'緊急'});


function issueStatusLabel(status){ return ISSUE_STATUS_LABELS[status]||status||'未知'; }
function issueSlaMinutes(severity){return ISSUE_SLA_MINUTES[severity]??60;}
function issueSlaState(issue,at=nowISO()){
  normalizeIssueRuntime(issue);const due=issue.ackDueAt?new Date(issue.ackDueAt):null,ack=issue.acknowledgedAt?new Date(issue.acknowledgedAt):null,now=new Date(at);
  if(!due||Number.isNaN(due.getTime()))return {status:'unknown',label:'SLA 未設定',breached:false};
  if(ack){const breached=ack>due;return {status:breached?'breached':'met',label:breached?'SLA 逾時接手':'SLA 達成',breached,dueAt:issue.ackDueAt};}
  const breached=now>due;return {status:breached?'breached':'pending',label:breached?'SLA 已逾時':`SLA ${Math.max(0,Math.ceil((due-now)/60000))} 分`,breached,dueAt:issue.ackDueAt};
}
function issueSeverityLabel(severity){ return ISSUE_SEVERITY_LABELS[severity]||severity||'一般'; }
function issueStatusClass(status){ return status==='resolved'?'green':status==='handling'?'purple':status==='acknowledged'?'blue':'red'; }
function issueSeverityClass(severity){ return severity==='emergency'||severity==='critical'?'red':severity==='warning'?'yellow':'gray'; }
function classifyIssueSeverity(type=''){
  const text=String(type||'');
  if(/突發送醫/.test(text))return 'emergency';
  if(/交通事故|車輛故障|車輛設備異常|病患身體不適/.test(text))return 'critical';
  if(/乘客尚未準備|無法聯絡|地址有誤|臨時取消|陪同人員未到|輪椅|交通壅塞|道路封閉|施工|無法臨停|停車/.test(text))return 'warning';
  return 'info';
}
function normalizeIssueRuntime(issue){
  if(!issue)return issue;
  issue.schemaVersion=ISSUE_SCHEMA_VERSION;
  if(!ISSUE_STATUSES.includes(issue.status))issue.status=issue.resolvedAt?'resolved':'open';
  issue.severity=issue.severity||classifyIssueSeverity(issue.type);
  issue.requiresDispatch=issue.requiresDispatch!==undefined?!!issue.requiresDispatch:['critical','emergency'].includes(issue.severity)||/車輛|交通事故|突發送醫/.test(issue.type||'');
  issue.ackSlaMinutes=Math.max(1,Number(issue.ackSlaMinutes)||issueSlaMinutes(issue.severity));
  issue.ackDueAt=issue.ackDueAt||addMinutes(new Date(issue.createdAt||nowISO()),issue.ackSlaMinutes).toISOString();
  issue.acknowledgedAt=issue.acknowledgedAt||null;issue.acknowledgedBy=issue.acknowledgedBy||null;
  issue.handlingAt=issue.handlingAt||null;issue.handlingBy=issue.handlingBy||null;
  issue.resolvedAt=issue.resolvedAt||null;issue.resolvedBy=issue.resolvedBy||null;
  issue.resolutionCode=issue.resolutionCode||null;issue.resolutionNote=issue.resolutionNote||'';
  issue.updatedAt=issue.updatedAt||issue.resolvedAt||issue.createdAt||nowISO();
  return issue;
}
function transitionIssueInDb(db,issueOrId,nextState,{actorUserId=null,at=nowISO(),reason='',resolutionCode=null,resolutionNote=''}={}){
  const issue=typeof issueOrId==='string'?(db.issues||[]).find(x=>x.id===issueOrId):issueOrId;normalizeIssueRuntime(issue);
  if(!issue)return {ok:false,error:'找不到異常'};
  const current=issue.status;
  if(current===nextState)return {ok:true,noOp:true,issue,from:current,to:nextState};
  if(!(ISSUE_STATUS_TRANSITIONS[current]||[]).includes(nextState))return {ok:false,error:`Issue 狀態不可由 ${issueStatusLabel(current)} 轉為 ${issueStatusLabel(nextState)}`};
  issue.status=nextState;issue.updatedAt=at;
  if(nextState==='acknowledged'){issue.acknowledgedAt=at;issue.acknowledgedBy=actorUserId||null;}
  if(nextState==='handling'){issue.handlingAt=at;issue.handlingBy=actorUserId||null;}
  if(nextState==='resolved'){issue.resolvedAt=at;issue.resolvedBy=actorUserId||null;issue.resolutionCode=resolutionCode||'other';issue.resolutionNote=String(resolutionNote||reason||'').trim();}
  const event=appendTripEventInDb(db,{tripId:issue.tripId,eventType:'trip_issue_state_transitioned',at,actorUserId,stepId:issue.stepId||null,reason:reason||`${current}_to_${nextState}`,metadata:{issueId:issue.id,from:current,to:nextState,severity:issue.severity,resolutionCode:issue.resolutionCode||null,resolutionNote:issue.resolutionNote||''}});
  return {ok:true,issue,from:current,to:nextState,event};
}
function normalizeTripResourceSegments(trip){
  if(!trip)return trip;
  trip.resourceSegments=Array.isArray(trip.resourceSegments)?trip.resourceSegments:[];
  if(!trip.resourceSegments.length&&trip.driverId&&trip.vehicleId){
    trip.resourceSegments.push({id:uid('rseg'),schemaVersion:TRIP_RESOURCE_SEGMENT_SCHEMA_VERSION,driverId:trip.driverId,vehicleId:trip.vehicleId,assignedAt:trip.createdAt||trip.updatedAt||nowISO(),startedAt:trip.startedAt||null,endedAt:trip.status==='completed'?(trip.completedAt||trip.updatedAt||null):trip.status==='aborted'?(trip.abortedAt||trip.updatedAt||null):trip.status==='interrupted'?(trip.interruptedAt||trip.updatedAt||null):null,endedReason:trip.status==='completed'?'completed':trip.status==='aborted'?'aborted':trip.status==='interrupted'?'interrupted':null,issueId:trip.interruptionIssueId||null,source:'migration_or_initial'});
  }
  trip.resourceSegments.forEach(seg=>{seg.schemaVersion=TRIP_RESOURCE_SEGMENT_SCHEMA_VERSION;seg.assignedAt=seg.assignedAt||trip.createdAt||nowISO();seg.startedAt=seg.startedAt||null;seg.endedAt=seg.endedAt||null;seg.endedReason=seg.endedReason||null;seg.issueId=seg.issueId||null;seg.source=seg.source||'assignment';});
  return trip;
}
function currentTripResourceSegment(trip){normalizeTripResourceSegments(trip);return [...(trip?.resourceSegments||[])].reverse().find(seg=>!seg.endedAt)||null;}
function ensureTripResourceSegment(trip,{driverId=null,vehicleId=null,assignedAt=nowISO(),source='assignment',issueId=null}={}){
  normalizeTripResourceSegments(trip);let seg=currentTripResourceSegment(trip);
  if(seg&&!seg.startedAt){seg.driverId=driverId||trip.driverId;seg.vehicleId=vehicleId||trip.vehicleId;seg.assignedAt=assignedAt;seg.source=source;seg.issueId=issueId||seg.issueId||null;return seg;}
  if(!seg){seg={id:uid('rseg'),schemaVersion:TRIP_RESOURCE_SEGMENT_SCHEMA_VERSION,driverId:driverId||trip.driverId,vehicleId:vehicleId||trip.vehicleId,assignedAt,startedAt:null,endedAt:null,endedReason:null,issueId:issueId||null,source};trip.resourceSegments.push(seg);}
  return seg;
}
function closeTripResourceSegment(trip,at,endedReason,issueId=null){const seg=currentTripResourceSegment(trip);if(seg){seg.endedAt=seg.endedAt||at;seg.endedReason=seg.endedReason||endedReason||'closed';seg.issueId=issueId||seg.issueId||null;}return seg;}
function tripRemainingResourceWindow(trip,at=nowISO()){
  const start=new Date(at),planned=new Date(trip?.steps?.[trip.steps.length-1]?.scheduledAt||0);let end=planned;
  if(Number.isNaN(end.getTime())||end<=start)end=addMinutes(start,90);else end=addMinutes(end,30);
  return {start,end};
}

function tripPassengerRuntimeId(tripId,bookingId,index=0){
  const raw=String(bookingId||`manual_${index}`).replace(/[^a-zA-Z0-9_-]/g,'_');
  return `tpax_${tripId}_${raw}`;
}
function tripPassengerStatusLabel(status){
  return ({waiting:'等待上車',onboard:'已上車',dropped_off:'已送達',cancelled:'已取消',no_show:'未到／未上車',emergency_exit:'中途緊急離車'})[status]||status||'未知';
}
function tripPassengerTerminal(status){ return ['dropped_off','cancelled','no_show','emergency_exit'].includes(status); }
function bookingLegIdForTripBooking(trip,bookingId){ return (trip?.bookingLegRefs||[]).find(r=>r?.bookingId===bookingId)?.legId||null; }
function inferTripStepBookingLinks(trip){
  const passengerSteps=(trip?.steps||[]).filter(s=>['pickup','dropoff'].includes(s.type));
  const dispatchStops=Array.isArray(trip?.dispatchStops)?trip.dispatchStops:[];
  passengerSteps.forEach((step,index)=>{
    if(!step.bookingId&&dispatchStops[index]?.bookingId)step.bookingId=dispatchStops[index].bookingId;
    if(!step.bookingLegId&&(dispatchStops[index]?.legId||dispatchStops[index]?.bookingLegId))step.bookingLegId=dispatchStops[index].legId||dispatchStops[index].bookingLegId;
  });
  const ids=[...(trip?.bookingIds||[])];
  if(ids.length===1){
    passengerSteps.forEach(step=>{step.bookingId=step.bookingId||ids[0];step.bookingLegId=step.bookingLegId||bookingLegIdForTripBooking(trip,ids[0]);});
  }
  return trip;
}
function buildTripPassengers(tripId,bookings=[],bookingLegRefs=[],manualPassenger=null){
  const refs=new Map((bookingLegRefs||[]).map(r=>[r.bookingId,r.legId||null]));
  if(bookings.length){
    return bookings.map((b,index)=>({
      id:tripPassengerRuntimeId(tripId,b.id,index),schemaVersion:TRIP_PASSENGER_SCHEMA_VERSION,bookingId:b.id,bookingLegId:refs.get(b.id)||null,
      recipientId:b.recipientId||null,name:b.name||`乘客${index+1}`,phone:b.phone||'',seatUnits:Math.max(1,Number(typeof bookingPassengerUnits==='function'?bookingPassengerUnits(b):1)||1),
      wheelchairUnits:Math.max(0,Number(typeof bookingWheelchairUnits==='function'?bookingWheelchairUnits(b):0)||0),status:'waiting',boardedAt:null,droppedOffAt:null,cancelledAt:null,
      pickupStepId:null,dropoffStepId:null,updatedAt:null
    }));
  }
  if(manualPassenger){
    return [{id:tripPassengerRuntimeId(tripId,manualPassenger.bookingId||null,0),schemaVersion:TRIP_PASSENGER_SCHEMA_VERSION,bookingId:manualPassenger.bookingId||null,bookingLegId:manualPassenger.bookingLegId||null,recipientId:manualPassenger.recipientId||null,name:manualPassenger.name||'乘客',phone:manualPassenger.phone||'',seatUnits:Math.max(1,Number(manualPassenger.seatUnits)||1),wheelchairUnits:Math.max(0,Number(manualPassenger.wheelchairUnits)||0),status:'waiting',boardedAt:null,droppedOffAt:null,cancelledAt:null,pickupStepId:null,dropoffStepId:null,updatedAt:null}];
  }
  return [];
}
function rebuildTripPassengerProjection(trip,{preserveSpecialTerminal=true}={}){
  if(!trip)return trip;
  inferTripStepBookingLinks(trip);
  for(const p of trip.passengers||[]){
    if(preserveSpecialTerminal&&['no_show','emergency_exit'].includes(p.status))continue;
    const pickup=(trip.steps||[]).find(s=>s.id===p.pickupStepId)||(trip.steps||[]).find(s=>s.type==='pickup'&&((p.bookingId&&s.bookingId===p.bookingId)||(!p.bookingId&&s.passengerId===p.id)));
    const dropoff=(trip.steps||[]).find(s=>s.id===p.dropoffStepId)||(trip.steps||[]).find(s=>s.type==='dropoff'&&((p.bookingId&&s.bookingId===p.bookingId)||(!p.bookingId&&s.passengerId===p.id)));
    if(trip.status==='cancelled'&&!pickup?.completedAt&&!pickup?.passengerBoardedAt){p.status='cancelled';p.cancelledAt=p.cancelledAt||trip.cancelledAt||trip.stateChangedAt||null;p.boardedAt=null;p.droppedOffAt=null;continue;}
    if(dropoff?.passengerDroppedOffAt||dropoff?.completedAt){p.status='dropped_off';p.boardedAt=p.boardedAt||pickup?.passengerBoardedAt||pickup?.completedAt||null;p.droppedOffAt=dropoff.passengerDroppedOffAt||dropoff.completedAt||null;p.cancelledAt=null;continue;}
    if(pickup?.passengerBoardedAt||pickup?.completedAt){p.status='onboard';p.boardedAt=pickup.passengerBoardedAt||pickup.completedAt||p.boardedAt||null;p.droppedOffAt=null;p.cancelledAt=null;continue;}
    p.status='waiting';p.boardedAt=null;p.droppedOffAt=null;p.cancelledAt=null;
  }
  return trip;
}
function normalizeTripPassengers(trip){
  if(!trip)return trip;
  inferTripStepBookingLinks(trip);
  let passengers=Array.isArray(trip.passengers)?trip.passengers:[];
  if(!passengers.length){
    const bookings=(trip.bookingIds||[]).map(id=>typeof Booking!=='undefined'&&Booking?.get?Booking.get(id):null).filter(Boolean);
    passengers=buildTripPassengers(trip.id,bookings,trip.bookingLegRefs||[],bookings.length?null:{name:trip.passengerSummary||trip.steps?.find(s=>s.type==='pickup')?.name||'乘客',phone:trip.steps?.find(s=>s.type==='pickup')?.contacts?.[0]?.phone||'',seatUnits:Math.max(1,Number(trip.passengerCount)||1),wheelchairUnits:/輪椅/.test(trip.needs||'')?1:0});
    trip.passengers=passengers;
  }
  passengers.forEach((p,index)=>{
    p.id=p.id||tripPassengerRuntimeId(trip.id,p.bookingId,index);p.schemaVersion=TRIP_PASSENGER_SCHEMA_VERSION;p.bookingId=p.bookingId||null;p.bookingLegId=p.bookingLegId||bookingLegIdForTripBooking(trip,p.bookingId);p.recipientId=p.recipientId||null;p.name=p.name||`乘客${index+1}`;p.phone=p.phone||'';p.seatUnits=Math.max(1,Number(p.seatUnits)||1);p.wheelchairUnits=Math.max(0,Number(p.wheelchairUnits)||0);p.status=TRIP_PASSENGER_STATUSES.includes(p.status)?p.status:'waiting';p.boardedAt=p.boardedAt||null;p.droppedOffAt=p.droppedOffAt||null;p.cancelledAt=p.cancelledAt||null;p.updatedAt=p.updatedAt||null;
    const pickup=(trip.steps||[]).find(s=>s.type==='pickup'&&((p.bookingId&&s.bookingId===p.bookingId)||s.passengerId===p.id));
    const dropoff=(trip.steps||[]).find(s=>s.type==='dropoff'&&((p.bookingId&&s.bookingId===p.bookingId)||s.passengerId===p.id));
    if(pickup){p.pickupStepId=pickup.id;pickup.bookingId=pickup.bookingId||p.bookingId;pickup.bookingLegId=pickup.bookingLegId||p.bookingLegId;pickup.passengerId=p.id;}
    if(dropoff){p.dropoffStepId=dropoff.id;dropoff.bookingId=dropoff.bookingId||p.bookingId;dropoff.bookingLegId=dropoff.bookingLegId||p.bookingLegId;dropoff.passengerId=p.id;}
  });
  rebuildTripPassengerProjection(trip);
  return trip;
}
function normalizeTripExecutionSnapshots(trip){
  if(!trip)return trip;
  trip.executionSnapshots=Array.isArray(trip.executionSnapshots)?trip.executionSnapshots.filter(Boolean):[];
  trip.executionSnapshots.forEach((snap,index)=>{snap.schemaVersion=TRIP_EXECUTION_SNAPSHOT_SCHEMA_VERSION;snap.sequence=Number(snap.sequence)||index+1;snap.capturedAt=snap.capturedAt||trip.createdAt||nowISO();snap.source=snap.source||'unknown';});
  if(trip.activeExecutionSnapshotId&&!trip.executionSnapshots.some(x=>x.id===trip.activeExecutionSnapshotId))trip.activeExecutionSnapshotId=null;
  if(!trip.activeExecutionSnapshotId&&trip.executionSnapshots.length)trip.activeExecutionSnapshotId=trip.executionSnapshots[trip.executionSnapshots.length-1].id;
  return trip;
}
function tripSnapshotLeg(booking,legId){
  const leg=(booking?.legs||[]).find(l=>l.id===legId)||null;
  if(!leg)return null;
  return deepClone({id:leg.id,schemaVersion:leg.schemaVersion||null,sequence:leg.sequence||null,direction:leg.direction||null,label:leg.label||'',requestedPickupAt:leg.requestedPickupAt||null,pickup:leg.pickup||null,dropoff:leg.dropoff||null,status:leg.status||null,scheduledOrganizationId:leg.scheduledOrganizationId||null,tripId:leg.tripId||null});
}
function tripSnapshotCareRecipient(db,recipientId){
  const r=(db?.careRecipients||[]).find(x=>x.id===recipientId);
  if(!r)return null;
  return deepClone({recipientId:r.id,schemaVersion:r.schemaVersion||null,status:r.status||null,displayName:r.identity?.displayName||'',primaryPhone:r.contacts?.primaryPhone||'',emergencyContacts:r.contacts?.emergencyContacts||[],mobility:r.mobility||{},servicePreferences:{defaultCompanions:r.servicePreferences?.defaultCompanions??0,notes:r.servicePreferences?.notes||''},capturedGovernanceUpdatedAt:r.governance?.updatedAt||null});
}
function tripSnapshotPassenger(db,trip,booking,index){
  const ref=(trip.bookingLegRefs||[]).find(r=>r.bookingId===booking.id)||{};
  const effective=typeof Booking!=='undefined'&&Booking?.effectiveServiceNeeds?Booking.effectiveServiceNeeds(booking):{};
  const runtime=(trip.passengers||[]).find(p=>p.bookingId===booking.id)||null;
  return {
    sequence:index+1,bookingId:booking.id,bookingVersion:Math.max(1,Number(booking.version)||1),bookingRevisionNo:Math.max(0,Number(booking.revisionNo)||0),bookingLegId:ref.legId||null,
    recipientId:booking.recipientId||null,name:booking.name||runtime?.name||`乘客${index+1}`,phone:booking.phone||runtime?.phone||'',requestedByUserId:booking.requestedByUserId||null,
    locations:deepClone(booking.locations||{pickup:makeLocationSnapshot(booking.pickupAddress||''),dropoff:makeLocationSnapshot(booking.destination||'')}),leg:tripSnapshotLeg(booking,ref.legId||null),
    serviceNeeds:deepClone(effective),serviceNeedsSource:deepClone(booking.serviceNeeds||null),commercialSnapshotId:booking.activeCommercialSnapshotId||null,
    careRecipient:tripSnapshotCareRecipient(db,booking.recipientId||null),seatUnits:runtime?.seatUnits??Math.max(1,Number(typeof bookingPassengerUnits==='function'?bookingPassengerUnits(booking):1)||1),wheelchairUnits:runtime?.wheelchairUnits??Math.max(0,Number(typeof bookingWheelchairUnits==='function'?bookingWheelchairUnits(booking):0)||0)
  };
}
function buildTripExecutionSnapshotInDb(db,trip,{source='trip_created',capturedAt=nowISO(),actorUserId=null,reason=''}={}){
  normalizeTripPassengers(trip);normalizeTripExecutionSnapshots(trip);
  const bookings=(trip.bookingIds||[]).map(id=>(db?.bookings||[]).find(b=>b.id===id)).filter(Boolean),driver=(db?.drivers||[]).find(d=>d.id===trip.driverId)||null,driverUser=driver?(db?.users||[]).find(u=>u.id===driver.userId)||null:null,vehicle=(db?.vehicles||[]).find(v=>v.id===trip.vehicleId)||null;
  const passengers=bookings.length?bookings.map((b,index)=>tripSnapshotPassenger(db,trip,b,index)):(trip.passengers||[]).map((p,index)=>({sequence:index+1,bookingId:p.bookingId||null,bookingVersion:null,bookingRevisionNo:null,bookingLegId:p.bookingLegId||null,recipientId:p.recipientId||null,name:p.name||`乘客${index+1}`,phone:p.phone||'',requestedByUserId:null,locations:{pickup:deepClone(trip.pickupLocation||makeLocationSnapshot(trip.pickupAddress||'')),dropoff:deepClone(trip.dropoffLocation||makeLocationSnapshot(trip.dropoffAddress||''))},leg:null,serviceNeeds:{summary:trip.needs||'一般乘客'},serviceNeedsSource:null,commercialSnapshotId:null,careRecipient:tripSnapshotCareRecipient(db,p.recipientId||null),seatUnits:p.seatUnits||1,wheelchairUnits:p.wheelchairUnits||0}));
  return {
    id:uid('tsnap'),schemaVersion:TRIP_EXECUTION_SNAPSHOT_SCHEMA_VERSION,tripId:trip.id,sequence:(trip.executionSnapshots||[]).length+1,tripRevision:Number(trip.revision)||0,capturedAt,source,actorUserId:actorUserId||null,reason:String(reason||''),
    dispatchPlanId:trip.dispatchPlanId||null,organizationId:trip.organizationId,date:trip.date||null,statusAtCapture:trip.status||'scheduled',bookingIds:[...(trip.bookingIds||[])],bookingLegRefs:deepClone(trip.bookingLegRefs||[]),
    route:{pickupLocation:deepClone(trip.pickupLocation||null),dropoffLocation:deepClone(trip.dropoffLocation||null),pickupAddress:trip.pickupAddress||'',dropoffAddress:trip.dropoffAddress||'',dispatchStops:deepClone(trip.dispatchStops||[]),steps:(trip.steps||[]).map(s=>({id:s.id,type:s.type,sequence:s.sequence,scheduledAt:s.scheduledAt,scheduledArrivalAt:s.scheduledArrivalAt,scheduledDepartureAt:s.scheduledDepartureAt,destination:s.destination,bookingId:s.bookingId||null,bookingLegId:s.bookingLegId||null,passengerId:s.passengerId||null,note:s.note||''}))},
    resources:{driver:driver?{id:driver.id,userId:driver.userId||null,name:driverUser?.name||'',phone:driverUser?.phone||'',status:driver.status||null}:null,vehicle:vehicle?{id:vehicle.id,plate:vehicle.plate||'',model:vehicle.model||'',capacity:Number(vehicle.capacity)||0,wheelchairSlots:Number(vehicle.wheelchairSlots)||0,accessible:!!vehicle.accessible,status:vehicle.status||null}:null},
    passengers,needsSummary:trip.needs||'一般乘客',proofPolicySnapshot:deepClone(normalizeTripProofPolicy(trip)),poolingPolicySnapshot:deepClone(trip.poolingPolicySnapshot||null),routeOptimizationSnapshot:deepClone(trip.routeOptimizationSnapshot||null),planned:{estimatedEmptyKm:Number.isFinite(Number(trip.estimatedEmptyKm))?Number(trip.estimatedEmptyKm):null,estimatedLoadedKm:Number.isFinite(Number(trip.estimatedLoadedKm))?Number(trip.estimatedLoadedKm):null,plannedStartAt:trip.steps?.[0]?.scheduledAt||null,plannedEndAt:trip.steps?.[trip.steps.length-1]?.scheduledAt||null}
  };
}
function appendTripExecutionSnapshotInDb(db,trip,options={}){
  normalizeTripExecutionSnapshots(trip);const snap=buildTripExecutionSnapshotInDb(db,trip,options);trip.executionSnapshots.push(snap);trip.activeExecutionSnapshotId=snap.id;
  if(options.emitEvent!==false&&typeof appendTripEventInDb==='function')appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_execution_snapshot_captured',at:snap.capturedAt,actorUserId:options.actorUserId||null,reason:options.reason||options.source||'snapshot',metadata:{snapshotId:snap.id,sequence:snap.sequence,source:snap.source,tripRevision:snap.tripRevision,bookingVersions:snap.passengers.map(p=>({bookingId:p.bookingId,version:p.bookingVersion,revisionNo:p.bookingRevisionNo}))}});
  return snap;
}
function activeTripExecutionSnapshot(trip){normalizeTripExecutionSnapshots(trip);return (trip.executionSnapshots||[]).find(x=>x.id===trip.activeExecutionSnapshotId)||trip.executionSnapshots?.[trip.executionSnapshots.length-1]||null;}
function minutesBetween(later,earlier){if(!later||!earlier)return null;const a=new Date(later),b=new Date(earlier);if(Number.isNaN(a.getTime())||Number.isNaN(b.getTime()))return null;return Math.round(((a-b)/60000)*10)/10;}
function normalizeTripActualDistance(trip){
  const existing=trip.actualDistance&&typeof trip.actualDistance==='object'?trip.actualDistance:{};
  const empty=existing.emptyKm??trip.actualEmptyKm,loaded=existing.loadedKm??trip.actualLoadedKm;
  trip.actualDistance={schemaVersion:1,emptyKm:Number.isFinite(Number(empty))?Math.max(0,Number(empty)):null,loadedKm:Number.isFinite(Number(loaded))?Math.max(0,Number(loaded)):null,source:existing.source||null,recordedAt:existing.recordedAt||null,recordedByUserId:existing.recordedByUserId||null};
  return trip.actualDistance;
}
function rebuildTripActualMetrics(trip){
  if(!trip)return null;normalizeTripActualDistance(trip);
  const stops=(trip.steps||[]).filter(s=>['pickup','dropoff'].includes(s.type));let timedStops=0,onTimeStops=0,passengerWaitTotal=0,passengerWaitCount=0,driverWaitTotal=0,driverWaitCount=0,serviceTotal=0,serviceCount=0;
  for(const s of stops){
    const planned=s.scheduledArrivalAt||s.scheduledAt||null,arrival=s.arrivedAt||s.serviceStartedAt||(s.type==='pickup'?s.passengerBoardedAt:s.passengerDroppedOffAt)||s.completedAt||null;
    if(planned&&arrival){const delta=minutesBetween(arrival,planned);if(delta!==null){timedStops++;if(delta<=5)onTimeStops++;}}
    if(s.type==='pickup'&&s.passengerBoardedAt&&planned){const wait=minutesBetween(s.passengerBoardedAt,planned);if(wait!==null){passengerWaitTotal+=Math.max(0,wait);passengerWaitCount++;}}
    if(s.type==='pickup'&&s.passengerBoardedAt&&s.arrivedAt){const wait=minutesBetween(s.passengerBoardedAt,s.arrivedAt);if(wait!==null){driverWaitTotal+=Math.max(0,wait);driverWaitCount++;}}
    if(s.arrivedAt&&s.departedAt){const service=minutesBetween(s.departedAt,s.arrivedAt);if(service!==null){serviceTotal+=Math.max(0,service);serviceCount++;}}
  }
  const terminalAt=trip.status==='completed'?trip.completedAt:trip.status==='aborted'?trip.abortedAt:null,duration=terminalAt&&trip.startedAt?minutesBetween(terminalAt,trip.startedAt):null,d=trip.actualDistance;
  trip.actualMetrics={schemaVersion:TRIP_ACTUAL_METRICS_SCHEMA_VERSION,calculatedAt:nowISO(),actualStartAt:trip.startedAt||null,actualEndAt:terminalAt||null,actualDurationMinutes:duration===null?null:Math.max(0,duration),timedStops,onTimeStops,onTimeRate:timedStops?Math.round(onTimeStops/timedStops*100):null,passengerWaitMinutesTotal:Math.round(passengerWaitTotal*10)/10,passengerWaitCount,avgPassengerWaitMinutes:passengerWaitCount?Math.round(passengerWaitTotal/passengerWaitCount*10)/10:null,driverWaitMinutesTotal:Math.round(driverWaitTotal*10)/10,driverWaitCount,avgDriverWaitMinutes:driverWaitCount?Math.round(driverWaitTotal/driverWaitCount*10)/10:null,serviceMinutesTotal:Math.round(serviceTotal*10)/10,serviceStopCount:serviceCount,avgServiceMinutes:serviceCount?Math.round(serviceTotal/serviceCount*10)/10:null,actualEmptyKm:d.emptyKm,actualLoadedKm:d.loadedKm,distanceSource:(d.emptyKm!==null||d.loadedKm!==null)?(d.source||'actual_recorded'):'unavailable'};
  return trip.actualMetrics;
}

function passengersForTripStep(trip,step){
  normalizeTripPassengers(trip);
  if(!step||!['pickup','dropoff'].includes(step.type))return [];
  const rows=(trip.passengers||[]).filter(p=>(step.passengerId&&p.id===step.passengerId)||(step.bookingId&&p.bookingId===step.bookingId));
  if(rows.length)return rows;
  return (trip.passengers||[]).length===1?[trip.passengers[0]]:[];
}
function validatePassengerStateForStep(trip,step,nextState){
  const rows=passengersForTripStep(trip,step);if(!rows.length)return {ok:true,rows:[]};
  for(const p of rows){
    if(nextState==='onboard'&&!['waiting','onboard'].includes(p.status))return {ok:false,error:`${p.name} 目前為「${tripPassengerStatusLabel(p.status)}」，不能再次上車`};
    if(nextState==='dropped_off'&&!['onboard','dropped_off'].includes(p.status))return {ok:false,error:`${p.name} 尚未完成上車，不能直接標記送達`};
  }
  return {ok:true,rows};
}
function applyPassengerStateForStepInDb(db,trip,step,nextState,at,actorUserId,{reason=''}={}){
  const check=validatePassengerStateForStep(trip,step,nextState);if(!check.ok)return check;
  const events=[];
  for(const p of check.rows){
    if(p.status===nextState)continue;
    const previous=p.status;p.status=nextState;p.updatedAt=at;
    if(nextState==='onboard'){p.boardedAt=p.boardedAt||at;p.droppedOffAt=null;p.cancelledAt=null;}
    if(nextState==='dropped_off'){p.droppedOffAt=p.droppedOffAt||at;p.cancelledAt=null;}
    events.push(appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_passenger_state_changed',at,actorUserId,stepId:step.id,reason:reason||`${previous}_to_${nextState}`,metadata:{passengerId:p.id,bookingId:p.bookingId,bookingLegId:p.bookingLegId,name:p.name,from:previous,to:nextState,seatUnits:p.seatUnits,wheelchairUnits:p.wheelchairUnits}}));
  }
  return {ok:true,rows:check.rows,events};
}
function normalizeTripMutationRuntime(trip){
  if(!trip)return trip;
  trip.revision=Math.max(0,Number(trip.revision)||0);
  trip.mutationReceipts=Array.isArray(trip.mutationReceipts)?trip.mutationReceipts.filter(x=>x&&x.key):[];
  if(trip.mutationReceipts.length>TRIP_MUTATION_RECEIPT_LIMIT)trip.mutationReceipts=trip.mutationReceipts.slice(-TRIP_MUTATION_RECEIPT_LIMIT);
  return trip;
}
function makeTripMutationKey(action,tripId,stepId,revision){ return `${action}:${tripId}:${stepId||'-'}:r${Math.max(0,Number(revision)||0)}`; }
function tripMutationReceipt(trip,key){ return (trip?.mutationReceipts||[]).find(x=>x.key===key)||null; }
// 司機執行自己的行程時，同步改走 trip-execute：佇列保存「這個指令做完後的行程執行
// 欄位」。離線連續操作時每個指令都帶自己當下的結果，伺服器才能一個一個驗證。
// 鍵的清單與 netlify/functions/_trip-execution-rules.js 的 TRIP_PATCH_KEYS 相同。
const TRIP_DRIVER_EXECUTION_COMMANDS=Object.freeze(['complete_step','undo_step','proof_service']);
const TRIP_EXECUTION_PATCH_KEYS=Object.freeze(['status','stateChangedAt','startedAt','completedAt','currentStepIndex','completionPending','steps','passengers','serviceProofs','resourceSegments','actualMetrics','lastInvariantCheck','invariantViolation','updatedAt']);
function tripDriverExecutionCommandPayload(trip,action,stepId,key,actorUserId){
  if(!TRIP_DRIVER_EXECUTION_COMMANDS.includes(action)||!key||!tripDriverExecutionOwned_(trip,actorUserId))return {};
  const tripSnapshot={};for(const k of TRIP_EXECUTION_PATCH_KEYS)if(k in trip)tripSnapshot[k]=deepClone(trip[k]);
  return {command:action,expectedRevision:Math.max(0,Number(trip.revision)-1),expectedStepId:stepId||null,tripSnapshot};
}
function checkTripMutationGuard(trip,{expectedRevision=null,expectedStepId=null,idempotencyKey=null}={}){
  normalizeTripMutationRuntime(trip);
  if(idempotencyKey){const receipt=tripMutationReceipt(trip,idempotencyKey);if(receipt)return {ok:true,duplicate:true,receipt};}
  if(expectedRevision!==null&&expectedRevision!==undefined&&Number(expectedRevision)!==Number(trip.revision))return {ok:false,stale:true,error:'此行程已在其他操作中更新，請重新整理後再試',currentRevision:trip.revision};
  if(expectedStepId){const current=trip.steps?.[trip.currentStepIndex];if(current?.id!==expectedStepId)return {ok:false,stale:true,error:'目前執行站點已改變，已阻擋重複點擊／舊畫面操作',currentStepId:current?.id||null};}
  return {ok:true};
}
function finalizeTripMutationInDb(trip,{key,action,at,actorUserId=null,stepId=null,db=null}={}){
  normalizeTripMutationRuntime(trip);trip.revision+=1;trip.updatedAt=at||nowISO();
  if(key){trip.mutationReceipts.push({key,action:action||'',at:at||nowISO(),actorUserId:actorUserId||null,stepId:stepId||null,resultRevision:trip.revision});if(trip.mutationReceipts.length>TRIP_MUTATION_RECEIPT_LIMIT)trip.mutationReceipts.splice(0,trip.mutationReceipts.length-TRIP_MUTATION_RECEIPT_LIMIT);}
  rebuildTripActualMetrics(trip);
  if(db){enforceTripInvariantsInDb(db,trip,action||'mutation');queueTripOfflineMutationInDb(db,{tripId:trip.id,mutationType:'trip_mutation',referenceId:key||`${action||'mutation'}:r${trip.revision}`,payload:{action:action||'mutation',stepId:stepId||null,resultRevision:trip.revision,idempotencyKey:key||null,actorUserId:actorUserId||null,...tripDriverExecutionCommandPayload(trip,action,stepId,key,actorUserId)},queuedAt:at||nowISO()});}
  return trip.revision;
}
function bumpTripRevisionInDb(trip,at=nowISO(),db=null,context='revision_bump'){normalizeTripMutationRuntime(trip);trip.revision+=1;trip.updatedAt=at;rebuildTripActualMetrics(trip);if(db){enforceTripInvariantsInDb(db,trip,context);queueTripOfflineMutationInDb(db,{tripId:trip.id,mutationType:'trip_mutation',referenceId:`${context}:r${trip.revision}`,payload:{action:context,resultRevision:trip.revision},queuedAt:at});}return trip.revision;}
function tripLockStorageKey(tripId){return `${APP_CONFIG.storageKey}:trip-lock:${tripId}`;}
function acquireTripMutationLock(tripId,actorUserId=null){
  const key=tripLockStorageKey(tripId),owner=uid('tlock'),now=Date.now();
  try{const existing=JSON.parse(LocalStore.getItem(key)||'null');if(existing?.owner&&Number(existing.expiresAt)>now)return {ok:false,error:'此行程正在處理另一個操作，請稍後再試'};}catch{}
  const candidate={owner,actorUserId:actorUserId||null,expiresAt:now+TRIP_LOCK_TTL_MS};LocalStore.setItem(key,JSON.stringify(candidate));
  try{const confirmed=JSON.parse(LocalStore.getItem(key)||'null');if(confirmed?.owner!==owner)return {ok:false,error:'此行程正在其他分頁處理，已阻擋同時操作'};}catch{return {ok:false,error:'無法取得行程操作鎖'};}
  return {ok:true,key,owner};
}
function releaseTripMutationLock(lock){if(!lock?.ok)return;try{const current=JSON.parse(LocalStore.getItem(lock.key)||'null');if(current?.owner===lock.owner)LocalStore.removeItem(lock.key);}catch{}}
async function withTripMutationExclusiveLock(tripId,task){
  const lockName=`careRide.trip.mutation.${tripId}`;
  if(globalThis.navigator?.locks?.request){
    return navigator.locks.request(lockName,{mode:'exclusive'},async()=>{store.refreshFromStorage?.();return await task();});
  }
  return await task();
}

function tripStopRuntimeSnapshot(step){
  if(!step)return null;
  return {
    stepId:step.id||null,type:step.type||null,sequence:Number(step.sequence)||0,status:step.status||'pending',
    scheduledAt:step.scheduledAt||null,arrivedAt:step.arrivedAt||null,serviceStartedAt:step.serviceStartedAt||null,
    passengerBoardedAt:step.passengerBoardedAt||null,passengerDroppedOffAt:step.passengerDroppedOffAt||null,
    departedAt:step.departedAt||null,completedAt:step.completedAt||step.actualAt||null
  };
}
function tripAppOffline(){ return typeof navigator!=='undefined'&&navigator.onLine===false; }
function normalizeTripOfflineQueueInDb(db){db.tripOfflineQueue=Array.isArray(db.tripOfflineQueue)?db.tripOfflineQueue:[];return db.tripOfflineQueue;}
function queueTripOfflineMutationInDb(db,{tripId,mutationType,referenceId=null,payload=null,queuedAt=nowISO()}={}){
  if(!tripId||!mutationType)return null;
  const q=normalizeTripOfflineQueueInDb(db),dedupe=`${tripId}:${mutationType}:${referenceId||''}`;
  const existing=q.find(x=>!TRIP_QUEUE_SETTLED_STATUSES.includes(x.status)&&x.dedupeKey===dedupe);if(existing){if(!tripAppOffline())scheduleTripOutboxFlush();return existing;}
  const env=tripClientEnvelope({clientRecordedAt:queuedAt});const item={id:uid('toff'),schemaVersion:TRIP_OFFLINE_QUEUE_SCHEMA_VERSION,tripId,mutationType,referenceId:referenceId||null,dedupeKey:dedupe,payload:payload===undefined?null:deepClone(payload),status:'pending',queuedAt,syncedAt:null,attempts:0,syncMode:null,lastError:null,requestId:env.requestId,deviceId:env.deviceId,deviceIdSource:env.deviceIdSource,sessionId:env.sessionId,clientRecordedAt:env.clientRecordedAt,serverRecordedAt:null,expectedServerRevision:null};q.push(item);persistTripQueueRowP2(item).finally(()=>{if(!tripAppOffline())scheduleTripOutboxFlush();});
  if(q.length>1200){const synced=q.filter(x=>x.status==='synced').sort((a,b)=>new Date(a.syncedAt||a.queuedAt||0)-new Date(b.syncedAt||b.queuedAt||0));for(const old of synced.slice(0,Math.max(0,q.length-1000))){const i=q.findIndex(x=>x.id===old.id);if(i>=0)q.splice(i,1);}}
  return item;
}

let tripEventIndexCache={rowsRef:null,length:-1,map:new Map()};
function tripEventRowsIndexed(db,tripId){
  const all=Array.isArray(db.tripEvents)?db.tripEvents:[];
  if(tripEventIndexCache.rowsRef!==all||tripEventIndexCache.length!==all.length){
    const map=new Map();
    for(const event of all){if(!event?.tripId)continue;if(!map.has(event.tripId))map.set(event.tripId,[]);map.get(event.tripId).push(event);}
    for(const rows of map.values())rows.sort((a,b)=>(Number(a.sequence)||0)-(Number(b.sequence)||0)||new Date(a.at||0)-new Date(b.at||0));
    tripEventIndexCache={rowsRef:all,length:all.length,map};
  }
  return tripEventIndexCache.map.get(tripId)||[];
}
function nextTripEventSequenceInDb(db,tripId){
  const trip=(db.trips||[]).find(t=>t.id===tripId),rows=tripEventRowsIndexed(db,tripId);
  const observed=rows.length?Number(rows[rows.length-1]?.sequence)||0:0;
  let current=Math.max(Number(trip?.eventSequence)||0,observed);
  const next=current+1;if(trip)trip.eventSequence=next;return next;
}
function appendTripEventInDb(db,{tripId,eventType,at=nowISO(),actorUserId=null,stepId=null,reason='',metadata=null,targetEventIds=[]}={}){
  if(!tripId||!eventType)return null;
  db.tripEvents=Array.isArray(db.tripEvents)?db.tripEvents:[];
  const sequence=nextTripEventSequenceInDb(db,tripId);
  const event={
    id:uid('tevt'),schemaVersion:TRIP_EVENT_SCHEMA_VERSION,tripId,sequence,eventType,at,actorUserId:actorUserId||null,
    clientRecordedAt:at,serverRecordedAt:null,deviceId:TRIP_DEVICE_ID,deviceIdSource:TRIP_DEVICE_ID_SOURCE,sessionId:TRIP_SESSION_ID,
    stepId:stepId||null,reason:String(reason||''),metadata:metadata===undefined?null:deepClone(metadata),
    targetEventIds:[...new Set((targetEventIds||[]).filter(Boolean))]
  };
  db.tripEvents.push(event); // append-only：禁止 splice / replace / truncate
  queueTripOfflineMutationInDb(db,{tripId,mutationType:'trip_event',referenceId:event.id,payload:event,queuedAt:at});
  return event;
}
function tripEventHistoryFromDb(db,tripId,{includeCorrected=true}={}){
  const rows=tripEventRowsIndexed(db,tripId);
  const correctedIds=new Set(rows.filter(e=>e.eventType==='trip_event_corrected').flatMap(e=>e.targetEventIds||[]));
  const decorated=rows.map(e=>({...e,isCorrected:correctedIds.has(e.id),isCorrection:e.eventType==='trip_event_corrected'}));
  return includeCorrected?decorated:decorated.filter(e=>!e.isCorrected);
}
function activeTripEventsForStepInDb(db,tripId,stepId){
  return tripEventHistoryFromDb(db,tripId,{includeCorrected:false}).filter(e=>e.stepId===stepId&&['trip_stop_milestone','trip_step_completed','trip_stop_runtime_migrated','trip_passenger_state_changed'].includes(e.eventType));
}

function makeTripStop({id,type,sequence=0,scheduledAt,title,name,destination,contacts=[],note='',bookingId=null,bookingLegId=null,passengerId=null}){
  const planned=scheduledAt||null;
  return {
    id,type,sequence:Number(sequence)||0,schemaVersion:TRIP_RUNTIME_SCHEMA_VERSION,
    scheduledAt:planned,
    scheduledArrivalAt:type==='depart'?null:planned,
    scheduledDepartureAt:type==='depart'?planned:null,
    title,name,destination,contacts,note,bookingId:bookingId||null,bookingLegId:bookingLegId||null,passengerId:passengerId||null,
    arrivedAt:null,serviceStartedAt:null,passengerBoardedAt:null,passengerDroppedOffAt:null,departedAt:null,completedAt:null,
    actualAt:null,status:'pending'
  };
}

function normalizeTripStopRuntime(step,index=0){
  if(!step)return step;
  const completed=step.completedAt||step.actualAt||null;
  step.schemaVersion=TRIP_RUNTIME_SCHEMA_VERSION;
  step.sequence=Number(step.sequence)||index+1;
  step.scheduledAt=step.scheduledAt||step.scheduledArrivalAt||step.scheduledDepartureAt||null;
  if(step.type==='depart'){
    step.scheduledDepartureAt=step.scheduledDepartureAt||step.scheduledAt||null;
    step.scheduledArrivalAt=step.scheduledArrivalAt||null;
    step.departedAt=step.departedAt||completed;
  }else{
    step.scheduledArrivalAt=step.scheduledArrivalAt||step.scheduledAt||null;
    step.scheduledDepartureAt=step.scheduledDepartureAt||null;
    if(completed){
      step.arrivedAt=step.arrivedAt||completed;
      step.serviceStartedAt=step.serviceStartedAt||completed;
      if(step.type==='pickup')step.passengerBoardedAt=step.passengerBoardedAt||completed;
      if(step.type==='dropoff')step.passengerDroppedOffAt=step.passengerDroppedOffAt||completed;
      step.departedAt=step.departedAt||completed;
    }
  }
  step.arrivedAt=step.arrivedAt||null;
  step.serviceStartedAt=step.serviceStartedAt||null;
  step.passengerBoardedAt=step.passengerBoardedAt||null;
  step.passengerDroppedOffAt=step.passengerDroppedOffAt||null;
  step.departedAt=step.departedAt||null;
  step.completedAt=completed;
  step.actualAt=completed; // backward-compatible read path
  step.status=completed?'completed':step.serviceStartedAt?'servicing':step.arrivedAt?'arrived':'pending';
  if(!TRIP_STOP_STATUSES.includes(step.status))step.status='pending';
  return step;
}

function normalizeTripProofs(trip){
  if(!trip)return trip;trip.serviceProofs=Array.isArray(trip.serviceProofs)?trip.serviceProofs.filter(Boolean):[];
  trip.serviceProofs.forEach((p,index)=>{p.schemaVersion=TRIP_PROOF_SCHEMA_VERSION;p.sequence=Number(p.sequence)||index+1;p.capturedAt=p.capturedAt||trip.completedAt||trip.updatedAt||trip.createdAt||nowISO();p.status=['active','superseded'].includes(p.status)?p.status:'active';p.supersededAt=p.supersededAt||null;p.supersededByUserId=p.supersededByUserId||null;p.supersededReason=p.supersededReason||'';p.supersededByCorrectionEventId=p.supersededByCorrectionEventId||null;p.gps=p.gps&&typeof p.gps==='object'?p.gps:null;p.photo=p.photo&&typeof p.photo==='object'?p.photo:null;if(p.photo?.dataUrl){p.photo={...p.photo,name:p.photo.name||'proof.jpg',type:p.photo.type||'image/jpeg',size:p.photo.size||null,storage:'legacy_inline',objectKey:p.photo.objectKey||null,legacyInline:true};}});return trip;
}
function normalizeTripNavigationRuntime(trip){
  if(!trip)return trip;trip.locationSamples=Array.isArray(trip.locationSamples)?trip.locationSamples.filter(Boolean):[];if(trip.locationSamples.length>TRIP_LOCATION_SAMPLE_LIMIT)trip.locationSamples=trip.locationSamples.slice(-TRIP_LOCATION_SAMPLE_LIMIT);
  const nav=trip.liveNavigation&&typeof trip.liveNavigation==='object'?trip.liveNavigation:{};trip.liveNavigation={schemaVersion:TRIP_NAVIGATION_SCHEMA_VERSION,source:nav.source||'schedule',updatedAt:nav.updatedAt||null,stepId:nav.stepId||null,etaAt:nav.etaAt||null,etaMinutes:Number.isFinite(Number(nav.etaMinutes))?Number(nav.etaMinutes):null,scheduledAt:nav.scheduledAt||null,projectedDelayMinutes:Number.isFinite(Number(nav.projectedDelayMinutes))?Number(nav.projectedDelayMinutes):null,distanceToTargetKm:Number.isFinite(Number(nav.distanceToTargetKm))?Number(nav.distanceToTargetKm):null,deviationKm:Number.isFinite(Number(nav.deviationKm))?Number(nav.deviationKm):null,deviationLevel:nav.deviationLevel||'unavailable',accuracyMeters:Number.isFinite(Number(nav.accuracyMeters))?Number(nav.accuracyMeters):null};return trip;
}
function validCoords(loc){return loc&&Number.isFinite(Number(loc.lat))&&Number.isFinite(Number(loc.lng));}
function haversineKm(a,b){if(!validCoords(a)||!validCoords(b))return null;const R=6371,toRad=x=>x*Math.PI/180,lat1=toRad(Number(a.lat)),lat2=toRad(Number(b.lat)),dLat=lat2-lat1,dLng=toRad(Number(b.lng)-Number(a.lng)),h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
function pointToSegmentKm(point,a,b){if(!validCoords(point)||!validCoords(a)||!validCoords(b))return null;const lat0=(Number(a.lat)+Number(b.lat)+Number(point.lat))/3*Math.PI/180,kx=111.32*Math.cos(lat0),ky=110.57,ax=Number(a.lng)*kx,ay=Number(a.lat)*ky,bx=Number(b.lng)*kx,by=Number(b.lat)*ky,px=Number(point.lng)*kx,py=Number(point.lat)*ky,dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy;if(len<1e-9)return Math.hypot(px-ax,py-ay);const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len)),cx=ax+t*dx,cy=ay+t*dy;return Math.hypot(px-cx,py-cy);}
function tripStepLocationSnapshot(trip,step){
  if(!trip||!step)return null;const snap=activeTripExecutionSnapshot(trip),p=step.bookingId?(snap?.passengers||[]).find(x=>x.bookingId===step.bookingId):null;
  if(step.type==='pickup')return deepClone(p?.locations?.pickup||trip.pickupLocation||null);
  if(step.type==='dropoff')return deepClone(p?.locations?.dropoff||trip.dropoffLocation||null);
  return null;
}
function previousNavigableStepLocation(trip,step){const index=(trip.steps||[]).findIndex(s=>s.id===step?.id);for(let i=index-1;i>=0;i--){const s=trip.steps[i];if(!['pickup','dropoff'].includes(s.type))continue;const loc=tripStepLocationSnapshot(trip,s);if(validCoords(loc))return loc;}return null;}
function computeTripNavigationProjection(trip,sample){
  normalizeTripRuntime(trip);const step=trip.steps?.[trip.currentStepIndex]||null,scheduledAt=step?.scheduledArrivalAt||step?.scheduledAt||null,target=tripStepLocationSnapshot(trip,step),sampleLoc={lat:sample?.lat,lng:sample?.lng};let source='schedule',etaAt=scheduledAt,etaMinutes=null,distanceToTargetKm=null,deviationKm=null,deviationLevel='unavailable';
  if(validCoords(sampleLoc)&&validCoords(target)){distanceToTargetKm=haversineKm(sampleLoc,target);const speedMps=Number(sample?.speedMps),speedKph=Number.isFinite(speedMps)&&speedMps>1.4?Math.max(12,Math.min(80,speedMps*3.6)):25,roadFactor=1.25;etaMinutes=Math.max(1,Math.round((distanceToTargetKm*roadFactor/speedKph*60)*10)/10);etaAt=addMinutes(new Date(sample.at||nowISO()),etaMinutes).toISOString();source='gps_straight_line_estimate';const previous=previousNavigableStepLocation(trip,step);if(validCoords(previous)&&Number(sample?.accuracyMeters||9999)<=TRIP_ROUTE_DEVIATION_POLICY.maxAccuracyMeters){deviationKm=pointToSegmentKm(sampleLoc,previous,target);deviationLevel=tripRouteDeviationLevel(deviationKm);}}
  if(etaMinutes===null&&scheduledAt){etaMinutes=Math.round(((new Date(scheduledAt)-new Date(sample?.at||nowISO()))/60000)*10)/10;}
  const projectedDelayMinutes=etaAt&&scheduledAt?Math.round(((new Date(etaAt)-new Date(scheduledAt))/60000)*10)/10:null;
  return {schemaVersion:TRIP_NAVIGATION_SCHEMA_VERSION,source,updatedAt:sample?.at||nowISO(),stepId:step?.id||null,etaAt:etaAt||null,etaMinutes,distanceToTargetKm:distanceToTargetKm===null?null:Math.round(distanceToTargetKm*10)/10,scheduledAt,projectedDelayMinutes,deviationKm:deviationKm===null?null:Math.round(deviationKm*10)/10,deviationLevel,accuracyMeters:Number.isFinite(Number(sample?.accuracyMeters))?Math.round(Number(sample.accuracyMeters)):null};
}

async function loadTripProofPhotoP1(photo){
  if(!photo)return {ok:false,error:'此 Proof 沒有照片'};
  if(photo.dataUrl)return {ok:true,url:photo.dataUrl,storage:'legacy_inline',metadata:{name:photo.name||'proof.jpg',type:photo.type||'image/jpeg',size:photo.size||null},revoke:false};
  if(photo.storage==='indexeddb'&&photo.objectKey){const row=await tripIdbGet(TRIP_P2_IDB.stores.proof,photo.objectKey);if(!row?.blob)return {ok:false,error:'找不到 Proof 照片 Blob，可能已依保存期限清理或尚未完成 migration'};if(typeof URL==='undefined'||typeof URL.createObjectURL!=='function')return {ok:false,error:'目前預覽環境不支援 Blob 圖片檢視，請使用一般瀏覽器開啟'};return {ok:true,url:URL.createObjectURL(row.blob),storage:'indexeddb',metadata:{...(row.metadata||{}),size:row.metadata?.size||row.blob.size,type:row.metadata?.type||row.blob.type},revoke:true};}
  return {ok:false,error:'此 Proof 照片目前只有外部物件參照，尚未設定 Object Storage 讀取 Provider'};
}
function applyNavigationAdapterResultInDb(db,trip,enriched,{actorUserId=null,at=nowISO()}={}){
  normalizeTripNavigationRuntime(trip);const oldLevel=trip.liveNavigation?.deviationLevel||'unavailable',oldDeviation=trip.liveNavigation?.deviationKm??null;
  trip.liveNavigation={...trip.liveNavigation,source:enriched.source||trip.liveNavigation.source,provider:enriched.provider||null,routeProvider:enriched.routeProvider||trip.liveNavigation.routeProvider||null,trafficProvider:enriched.trafficProvider||trip.liveNavigation.trafficProvider||null,polylineAvailable:!!enriched.polyline,updatedAt:at};
  if(enriched.etaAt)trip.liveNavigation.etaAt=enriched.etaAt;if(enriched.etaMinutes!==null&&enriched.etaMinutes!==undefined)trip.liveNavigation.etaMinutes=enriched.etaMinutes;
  let newLevel=oldLevel;if(enriched.deviationKm!==null&&enriched.deviationKm!==undefined){trip.liveNavigation.deviationKm=Math.round(Number(enriched.deviationKm)*10)/10;newLevel=tripRouteDeviationLevel(enriched.deviationKm);trip.liveNavigation.deviationLevel=newLevel;}
  let event=null;if(newLevel!==oldLevel){const metadata={previousLevel:oldLevel,level:newLevel,previousDeviationKm:oldDeviation,deviationKm:trip.liveNavigation.deviationKm,etaAt:trip.liveNavigation.etaAt,source:trip.liveNavigation.source,provider:enriched.deviationKm!==null&&enriched.deviationKm!==undefined?(enriched.routeProvider||enriched.provider||null):(enriched.provider||null),routeProvider:trip.liveNavigation.routeProvider||null,trafficProvider:trip.liveNavigation.trafficProvider||null};if(['warning','critical'].includes(newLevel))event=appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_route_deviation_detected',at,actorUserId,stepId:trip.liveNavigation.stepId,reason:newLevel,metadata});else if(['warning','critical'].includes(oldLevel)&&newLevel==='normal')event=appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_route_deviation_cleared',at,actorUserId,stepId:trip.liveNavigation.stepId,reason:'provider_back_in_corridor',metadata});}
  return event;
}
function tripExecutionWindowState(trip,at=nowISO()){
  normalizeTripRuntime(trip);const now=new Date(at),first=trip?.steps?.[0],scheduled=new Date(first?.scheduledAt||0);
  if(!trip||trip.status!=='scheduled'||!first||Number.isNaN(scheduled.getTime()))return {ok:true,canExecute:true,reason:'not_scheduled_or_missing_schedule',earliestAt:null,scheduledAt:first?.scheduledAt||null};
  const earliest=addMinutes(scheduled,-TRIP_EXECUTION_POLICY.startEarlyMinutes),canExecute=now>=earliest;
  return {ok:canExecute,canExecute,tooEarly:!canExecute,earliestAt:earliest.toISOString(),scheduledAt:scheduled.toISOString(),minutesUntilOpen:canExecute?0:Math.max(1,Math.ceil((earliest-now)/60000)),error:canExecute?null:`尚未到 Trip 可執行時間；可於 ${formatDateTime(earliest.toISOString())} 後開始`};
}
function tripCompletedCorrectionAvailability(trip,actorUserId,at=nowISO()){
  normalizeTripRuntime(trip);if(!trip||trip.status!=='completed')return {ok:false,eligible:false,error:'只有已完成 Trip 可使用完成後修正'};
  const execute=tripExecutionAccess(trip,actorUserId),canManage=!!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId);if(!execute.ok&&!canManage)return {ok:false,eligible:false,error:'你沒有修正此 Trip 的權限'};
  const completedAt=new Date(trip.completedAt||0),now=new Date(at);if(Number.isNaN(completedAt.getTime()))return {ok:false,eligible:false,error:'Trip 缺少完成時間，不能安全修正'};
  const ageMinutes=(now-completedAt)/60000;if(ageMinutes<0)return {ok:false,eligible:false,error:'Trip 完成時間晚於目前裝置時間，請先檢查裝置時間'};
  if(ageMinutes>TRIP_EXECUTION_POLICY.completedCorrectionWindowMinutes)return {ok:false,eligible:false,expired:true,error:`完成後修正期限已超過 ${TRIP_EXECUTION_POLICY.completedCorrectionWindowMinutes} 分鐘，請由調度以正式修正 流程處理`};
  const index=Math.max(0,Math.min(trip.currentStepIndex-1,trip.steps.length-1)),step=trip.steps[index];if(!step?.completedAt&&!step?.actualAt)return {ok:false,eligible:false,error:'沒有可修正的最後完成停靠點'};
  return {ok:true,eligible:true,expiresAt:addMinutes(completedAt,TRIP_EXECUTION_POLICY.completedCorrectionWindowMinutes).toISOString(),remainingMinutes:Math.max(0,Math.ceil(TRIP_EXECUTION_POLICY.completedCorrectionWindowMinutes-ageMinutes)),stepId:step.id};
}
function tripProofIsValidForStep(proof,step,policy){
  if(!proof||proof.status==='superseded'||proof.stepId!==step?.id)return false;
  const capturedAt=new Date(proof.capturedAt||0),completedAt=new Date(step?.completedAt||step?.passengerDroppedOffAt||0);if(Number.isNaN(capturedAt.getTime())||Number.isNaN(completedAt.getTime())||capturedAt<completedAt)return false;
  return (!policy.requireGps||!!proof.gps)&&(!policy.requirePhoto||!!proof.photo);
}
function normalizeTripProofPolicy(trip){
  if(!trip)return null;
  const hadPolicy=!!(trip.proofPolicy&&typeof trip.proofPolicy==='object'),current=hadPolicy?trip.proofPolicy:{},legacyCompleted=!hadPolicy&&trip.status==='completed'&&!(trip.serviceProofs||[]).length;
  trip.proofPolicy={version:TRIP_PROOF_POLICY_VERSION,requiredPerDropoff:legacyCompleted?false:current.requiredPerDropoff!==false,requireGps:!!current.requireGps,requirePhoto:!!current.requirePhoto,source:current.source||(legacyCompleted?'legacy_completed_migration':'platform_default')};
  return trip.proofPolicy;
}
function tripProofRequirementRows(trip){
  normalizeTripProofs(trip);const policy=normalizeTripProofPolicy(trip);if(!policy?.requiredPerDropoff)return [];
  return (trip?.steps||[]).filter(s=>s.type==='dropoff'&&(s.completedAt||s.passengerDroppedOffAt)).map(step=>{
    const proofs=(trip.serviceProofs||[]).filter(p=>p.stepId===step.id),valid=proofs.filter(p=>tripProofIsValidForStep(p,step,policy));
    return {stepId:step.id,step,proofs,valid,required:true,satisfied:valid.length>0,requireGps:policy.requireGps,requirePhoto:policy.requirePhoto};
  });
}
function unresolvedBlockingIssuesInDb(db,trip){
  return (db?.issues||store?.state?.issues||[]).filter(i=>i.tripId===trip?.id&&i.status!=='resolved'&&(i.requiresDispatch||['critical','emergency'].includes(i.severity)));
}
function tripCompletionReadinessInDb(db,trip){
  normalizeTripRuntime(trip);const reasons=[];
  if((trip.steps||[]).some(s=>s.status!=='completed'))reasons.push('尚有未完成停靠點');
  const unfinished=(trip.passengers||[]).filter(p=>!tripPassengerTerminal(p.status));if(unfinished.length)reasons.push(`仍有乘客未完成離車：${unfinished.map(p=>p.name).join('、')}`);
  const proofMissing=tripProofRequirementRows(trip).filter(r=>!r.satisfied);if(proofMissing.length)reasons.push(`尚缺 ${proofMissing.length} 個 Dropoff 的 服務證明`);
  const blocking=unresolvedBlockingIssuesInDb(db,trip);if(blocking.length)reasons.push(`尚有 ${blocking.length} 筆重大／需調度 Issue 未結案`);
  if(trip.status==='interrupted')reasons.push('Trip 仍在中斷狀態');
  if(trip.pendingHandover?.active)reasons.push('資源交接尚未完成 Resume 驗證');
  return {ok:reasons.length===0,reasons,proofMissing,blockingIssues:blocking};
}
function tripInvariantReportInDb(db,trip){
  normalizeTripRuntime(trip);const errors=[],warnings=[];const steps=trip.steps||[],idx=Number(trip.currentStepIndex)||0;
  if(idx<0||idx>steps.length)errors.push('currentStepIndex 超出合法範圍');
  const firstPending=steps.findIndex(s=>s.status!=='completed'),expected=trip.status==='completed'?steps.length:(firstPending<0?steps.length:firstPending);if(idx!==expected)errors.push(`currentStepIndex 與 Stop 投影不一致（${idx} != ${expected}）`);
  const onboard=(trip.passengers||[]).filter(p=>p.status==='onboard'),vehicle=Organization?.vehicle?.(trip.vehicleId),seatUsed=onboard.reduce((s,p)=>s+Math.max(1,Number(p.seatUnits)||1),0),wheelUsed=onboard.reduce((s,p)=>s+Math.max(0,Number(p.wheelchairUnits)||0),0);
  if(vehicle&&seatUsed>Math.max(1,Number(vehicle.capacity)||1))errors.push(`車上席次 ${seatUsed} 超過車輛容量 ${vehicle.capacity}`);
  if(vehicle&&wheelUsed>Math.max(0,Number(vehicle.wheelchairSlots)||0))errors.push(`車上輪椅 ${wheelUsed} 超過輪椅位 ${vehicle.wheelchairSlots||0}`);
  if(trip.status==='completed'&&onboard.length)errors.push('completed Trip 仍有 onboard 乘客');
  if(trip.status==='completed'&&tripCompletionReadinessInDb(db,trip).ok===false)errors.push('completed Trip 不符合完成條件');
  if(trip.status==='interrupted'&&trip.completedAt)errors.push('interrupted Trip 不應有 completedAt');
  if(trip.status==='aborted'&&!trip.abortedAt)errors.push('aborted Trip 缺少 abortedAt');
  const segments=trip.resourceSegments||[];for(let i=0;i<segments.length-1;i++){const a=segments[i],b=segments[i+1];if(a.endedAt&&b.assignedAt&&new Date(a.endedAt)>new Date(b.assignedAt))errors.push('resourceSegments 時間重疊');}
  if((trip.executionSnapshots||[]).length&&!activeTripExecutionSnapshot(trip))errors.push('有 executionSnapshots 但 active snapshot 不存在');
  if(!Number.isInteger(Number(trip.revision))||Number(trip.revision)<0)errors.push('revision 非合法非負整數');
  if(trip.status==='in_progress'&&idx===steps.length&&!trip.completionPending)warnings.push('所有 Stop 已完成但 Trip 尚未 completed，且沒有 completionPending 標記');
  return {ok:errors.length===0,errors,warnings,schemaVersion:TRIP_INVARIANT_SCHEMA_VERSION};
}
function enforceTripInvariantsInDb(db,trip,context='mutation'){
  const report=tripInvariantReportInDb(db,trip);trip.lastInvariantCheck={at:nowISO(),context,ok:report.ok,errors:[...report.errors],warnings:[...report.warnings],schemaVersion:TRIP_INVARIANT_SCHEMA_VERSION};trip.invariantViolation=report.ok?null:{at:trip.lastInvariantCheck.at,context,errors:[...report.errors]};if(!report.ok)console.error('[Trip invariant]',trip.id,context,report.errors);return report;
}
function inferTripReasonCode(text=''){const s=String(text||'');if(/車輛故障|車輛設備/.test(s))return 'vehicle_failure';if(/交通事故/.test(s))return 'traffic_accident';if(/突發送醫|病患身體不適/.test(s))return 'medical_emergency';if(/乘客.*取消|臨時取消/.test(s))return 'passenger_cancelled';if(/無法聯絡|未到/.test(s))return 'no_show_or_unreachable';if(/安全|無法繼續/.test(s))return 'unsafe_to_continue';return 'other';}
function handoverManifestForTrip(trip){normalizeTripPassengers(trip);return (trip.passengers||[]).filter(p=>!tripPassengerTerminal(p.status)).map(p=>({passengerId:p.id,bookingId:p.bookingId||null,name:p.name,status:p.status,seatUnits:Math.max(1,Number(p.seatUnits)||1),wheelchairUnits:Math.max(0,Number(p.wheelchairUnits)||0)}));}
function validateHandoverManifest(trip,manifest){const current=handoverManifestForTrip(trip),byId=new Map((manifest||[]).map(x=>[x.passengerId,x]));const missing=current.filter(p=>!byId.has(p.passengerId));const mismatch=current.filter(p=>{const m=byId.get(p.passengerId);return m&&(m.status!==p.status||Number(m.seatUnits)!==Number(p.seatUnits)||Number(m.wheelchairUnits)!==Number(p.wheelchairUnits));});return missing.length||mismatch.length?{ok:false,error:`交接乘客清冊已改變：${[...missing,...mismatch].map(x=>x.name).join('、')}`}:{ok:true,current};}

function normalizeTripRuntime(trip){
  if(!trip)return trip;
  trip.steps=Array.isArray(trip.steps)?trip.steps:[];
  trip.steps.forEach((step,index)=>normalizeTripStopRuntime(step,index));
  normalizeTripMutationRuntime(trip);
  trip.runtimeSchemaVersion=TRIP_RUNTIME_SCHEMA_VERSION;
  trip.eventSequence=Math.max(0,Number(trip.eventSequence)||0);
  trip.stateChangedAt=trip.stateChangedAt||trip.updatedAt||trip.createdAt||nowISO();
  if(!['scheduled','in_progress','interrupted','completed','cancelled','aborted'].includes(trip.status))trip.status='scheduled';
  const firstPending=trip.steps.findIndex(s=>s.status!=='completed');
  if(trip.status==='completed')trip.currentStepIndex=trip.steps.length;
  else trip.currentStepIndex=firstPending<0?trip.steps.length:firstPending;
  if(['in_progress','interrupted','completed','aborted'].includes(trip.status)&&!trip.startedAt){
    trip.startedAt=trip.steps.find(s=>s.completedAt)?.completedAt||trip.updatedAt||trip.createdAt||null;
  }
  trip.startedAt=trip.startedAt||null;
  trip.completedAt=trip.status==='completed'?(trip.completedAt||trip.steps[trip.steps.length-1]?.completedAt||null):(trip.completedAt||null);
  trip.interruptedAt=trip.status==='interrupted'?(trip.interruptedAt||trip.stateChangedAt||null):(trip.interruptedAt||null);
  trip.interruptReason=trip.interruptReason||'';trip.interruptionIssueId=trip.interruptionIssueId||null;
  trip.abortedAt=trip.abortedAt||null;trip.abortReason=trip.abortReason||'';trip.abortReasonCode=trip.abortReasonCode||null;
  trip.cancelReason=trip.cancelReason||'';trip.cancelReasonCode=trip.cancelReasonCode||null;
  trip.completionPending=trip.completionPending&&typeof trip.completionPending==='object'?trip.completionPending:null;
  trip.pendingHandover=trip.pendingHandover&&typeof trip.pendingHandover==='object'?trip.pendingHandover:null;
  normalizeTripProofPolicy(trip);
  normalizeTripResourceSegments(trip);
  normalizeTripPassengers(trip);
  normalizeTripExecutionSnapshots(trip);
  normalizeTripProofs(trip);
  normalizeTripNavigationRuntime(trip);
  rebuildTripActualMetrics(trip);
  return trip;
}

function canTripTransition(trip,nextState,{correction=false,db=null}={}){
  if(!trip)return {ok:false,error:'找不到行程'};
  const current=trip.status||'scheduled';
  if(current===nextState)return {ok:true,noOp:true,from:current,to:nextState};
  const table=correction?TRIP_CORRECTION_TRANSITIONS:TRIP_STATUS_TRANSITIONS;
  if(!(table[current]||[]).includes(nextState))return {ok:false,error:`Trip 狀態不可由 ${current} 轉為 ${nextState}${correction?'（correction）':''}`,from:current,to:nextState};
  if(nextState==='completed'){
    const readiness=tripCompletionReadinessInDb(db||store?.state,trip);if(!readiness.ok)return {ok:false,error:readiness.reasons.join('；'),from:current,to:nextState,readiness};
  }
  return {ok:true,from:current,to:nextState};
}

function transitionTripInDb(db,tripOrId,nextState,{at=nowISO(),actorUserId=null,reason='',reasonCode=null,correction=false,issueId=null,metadata=null}={}){
  const trip=typeof tripOrId==='string'?(db.trips||[]).find(x=>x.id===tripOrId):tripOrId;
  normalizeTripRuntime(trip);
  const check=canTripTransition(trip,nextState,{correction,db});
  if(!check.ok||check.noOp)return check;
  const previous=trip.status;
  trip.status=nextState;
  trip.stateChangedAt=at;
  trip.updatedAt=at;
  if(nextState==='in_progress'){
    if(!correction)trip.startedAt=trip.startedAt||at;
    trip.completedAt=null;
    trip.interruptedAt=null;
    const seg=ensureTripResourceSegment(trip,{driverId:trip.driverId,vehicleId:trip.vehicleId,assignedAt:at,source:previous==='interrupted'?'resume':'initial_start',issueId});
    seg.startedAt=seg.startedAt||at;
  }
  if(nextState==='interrupted'){
    trip.interruptedAt=at;trip.interruptReason=String(reason||'').trim();trip.interruptionIssueId=issueId||trip.interruptionIssueId||null;
    closeTripResourceSegment(trip,at,'interrupted',issueId);
  }
  if(nextState==='completed'){trip.completedAt=at;closeTripResourceSegment(trip,at,'completed',issueId);}
  if(nextState==='cancelled'){
    trip.cancelledAt=trip.cancelledAt||at;
    trip.cancelledByUserId=actorUserId||trip.cancelledByUserId||null;
    if(reason)trip.cancelReason=reason;trip.cancelReasonCode=reasonCode||trip.cancelReasonCode||inferTripReasonCode(reason);
    closeTripResourceSegment(trip,at,'cancelled',issueId);
  }
  if(nextState==='aborted'){
    trip.abortedAt=trip.abortedAt||at;trip.abortedByUserId=actorUserId||trip.abortedByUserId||null;trip.abortReason=String(reason||'').trim();trip.abortReasonCode=reasonCode||trip.abortReasonCode||inferTripReasonCode(reason);
    if(trip.pendingHandover?.active){trip.pendingHandover.active=false;trip.pendingHandover.abortedAt=at;}
    closeTripResourceSegment(trip,at,'aborted',issueId);
  }
  if(correction&&nextState==='scheduled'){
    trip.startedAt=null;
    trip.completedAt=null;
  }
  const event=appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_state_transitioned',at,actorUserId,reason,metadata:{from:previous,to:nextState,correction:!!correction,issueId:issueId||null,reasonCode:reasonCode||null,...(metadata&&typeof metadata==='object'?deepClone(metadata):{})}});
  return {ok:true,from:previous,to:nextState,trip,event};
}

function applyStopMilestoneInDb(trip,step,milestone,at){
  normalizeTripStopRuntime(step,Math.max(0,(trip.steps||[]).indexOf(step)));
  if(step.status==='completed')return {ok:false,error:'此 Stop 已完成'};
  if(milestone==='arrived'){
    if(step.type==='depart')return {ok:false,error:'出發 Stop 不使用到站事件'};
    step.arrivedAt=step.arrivedAt||at;step.status='arrived';
  }else if(milestone==='service_started'){
    if(step.type==='depart')return {ok:false,error:'出發 Stop 不使用服務開始事件'};
    step.arrivedAt=step.arrivedAt||at;step.serviceStartedAt=step.serviceStartedAt||at;step.status='servicing';
  }else if(milestone==='passenger_boarded'){
    if(step.type!=='pickup')return {ok:false,error:'只有接送 Stop 可以記錄乘客上車'};
    step.arrivedAt=step.arrivedAt||at;step.serviceStartedAt=step.serviceStartedAt||at;step.passengerBoardedAt=step.passengerBoardedAt||at;step.status='servicing';
  }else if(milestone==='passenger_dropped_off'){
    if(step.type!=='dropoff')return {ok:false,error:'只有送達 Stop 可以記錄乘客下車'};
    step.arrivedAt=step.arrivedAt||at;step.serviceStartedAt=step.serviceStartedAt||at;step.passengerDroppedOffAt=step.passengerDroppedOffAt||at;step.status='servicing';
  }else if(milestone==='departed'){
    if(step.type==='pickup'&&!step.passengerBoardedAt)return {ok:false,error:'尚未記錄乘客上車，不能離開接送 Stop'};
    if(step.type==='dropoff'&&!step.passengerDroppedOffAt)return {ok:false,error:'尚未記錄乘客安全下車，不能離開送達 Stop'};
    step.departedAt=step.departedAt||at;step.completedAt=at;step.actualAt=at;step.status='completed';
  }else return {ok:false,error:'未知 Stop milestone'};
  trip.updatedAt=at;
  return {ok:true,step};
}

function completeStopCompatInDb(trip,step,at){
  normalizeTripStopRuntime(step,Math.max(0,(trip.steps||[]).indexOf(step)));
  if(step.status==='completed')return {ok:false,error:'此 Stop 已完成'};
  if(step.type==='depart'){
    step.departedAt=step.departedAt||at;
  }else{
    step.arrivedAt=step.arrivedAt||at;
    step.serviceStartedAt=step.serviceStartedAt||at;
    if(step.type==='pickup')step.passengerBoardedAt=step.passengerBoardedAt||at;
    if(step.type==='dropoff')step.passengerDroppedOffAt=step.passengerDroppedOffAt||at;
    step.departedAt=step.departedAt||at;
  }
  step.completedAt=at;step.actualAt=at;step.status='completed';trip.updatedAt=at;
  return {ok:true,step};
}

function buildTripStepsFromItem(tripId,item,bookings){
  const start=new Date(item.startAt),steps=[],dispatchStops=Array.isArray(item.stops)&&item.stops.length?item.stops:[...(item.pickups||[]).map(p=>({...p,type:'pickup'})),...(item.dropoffs||[]).map(p=>({...p,type:'dropoff'}))],firstStop=dispatchStops[0]||item.pickups?.[0],legByBooking=new Map((item.bookingLegRefs||[]).map(r=>[r.bookingId,r.legId||null]));
  steps.push(makeTripStop({id:`${tripId}_depart`,type:'depart',sequence:1,scheduledAt:addMinutes(start,-20).toISOString(),title:`準備下一趟｜${bookings.map(b=>b.name).join('＋')}`,name:`出發前往${firstStop?.name||'第一站'}`,destination:firstStop?.address||item.firstPickupAddress,contacts:firstStop?[{name:firstStop.name,phone:Booking.get(firstStop.bookingId)?.phone||''}]:[],note:'依調度方案出發'}));
  dispatchStops.forEach((stop,i)=>{const isPickup=stop.type==='pickup',isLast=i===dispatchStops.length-1,b=Booking.get(stop.bookingId),bookingLegId=stop.legId||stop.bookingLegId||legByBooking.get(stop.bookingId)||null,passengerId=tripPassengerRuntimeId(tripId,stop.bookingId,i);steps.push(makeTripStop({id:`${tripId}_${isPickup?'pickup':'dropoff'}_${i}`,type:isPickup?'pickup':'dropoff',sequence:i+2,scheduledAt:stop.at,title:`${isPickup?'接送':'送達'}｜${stop.name}`,name:isPickup?stop.name:`送達${stop.name}`,destination:stop.address,contacts:[{name:stop.name,phone:b?.phone||''}],note:isPickup?Booking.needsText(b):(isLast?'完成最後送達後，完整趟次才 +1。':'完成此乘客送達後繼續下一站。'),bookingId:stop.bookingId||null,bookingLegId,passengerId}));});
  return {steps,dispatchStops};
}
function tripMutationHash(value=''){let h=2166136261,text=String(value);for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}
function tripMutationFingerprint(trip){
  return tripMutationHash(JSON.stringify({id:trip?.id,revision:Number(trip?.revision)||0,status:trip?.status,driverId:trip?.driverId,vehicleId:trip?.vehicleId,bookingIds:trip?.bookingIds||[],bookingLegRefs:trip?.bookingLegRefs||[],start:trip?.steps?.[0]?.scheduledAt||null,end:trip?.steps?.[trip.steps.length-1]?.scheduledAt||null,updatedAt:trip?.updatedAt||trip?.createdAt||null}));
}
function routeRepairEstimatedEmptyKm(trip,item){
  if(item?.assignmentExplanation&&Number.isFinite(Number(item.emptyKm)))return Math.round(Number(item.emptyKm)*10)/10;
  const driverId=item?.driverId||trip?.driverId,driver=Organization.driver(driverId),start=new Date(item?.startAt||trip?.steps?.[0]?.scheduledAt||nowISO());
  if(!driverId||!driver||Number.isNaN(start.getTime())||!item?.firstPickupAddress)return 0;
  const day=dateKey(start),previous=store.state.trips.filter(t=>t.id!==trip?.id&&t.driverId===driverId&&t.date===day&&!['cancelled','aborted'].includes(t.status)&&tripEndAt(t)<=start).sort((a,b)=>tripEndAt(b)-tripEndAt(a))[0];
  const previousDropoff=previous?tripLastDropoffAddress(previous):'',from=previousDropoff||(driver.serviceArea||'');
  return from?Math.round(Dispatch.estimateDriveKm(from,item.firstPickupAddress,{departureAt:start})*10)/10:0;
}
function tripRoutePatchFromItem(trip,item,{actorUserId=null,reason='Route Repair',repairType='route_repair'}={}){
  const bookings=(item.bookingIds||[]).map(id=>Booking.get(id)).filter(Boolean);if(!bookings.length)return null;
  const built=buildTripStepsFromItem(trip.id,item,bookings),start=new Date(item.startAt),at=nowISO(),passengers=buildTripPassengers(trip.id,bookings,item.bookingLegRefs||[]);
  return {date:dateKey(start),bookingIds:[...(item.bookingIds||[])],bookingLegRefs:[...(item.bookingLegRefs||[])],pickupLocation:makeLocationSnapshot(item.firstPickupAddress),dropoffLocation:makeLocationSnapshot(item.finalDropoffAddress),passengerSummary:bookings.map(b=>b.name).join('＋'),passengerCount:item.passengerUnits,isPooled:(item.bookingIds||[]).length>1,dispatchStops:built.dispatchStops,passengerLoadTimeline:item.loadTimeline||[],routeOptimizationSnapshot:{sequenceMode:item.poolValidation?.route?.sequenceMode||'single',sequenceEvaluatedCount:item.poolValidation?.route?.sequenceEvaluatedCount||1,optimizerVersion:Dispatch?.optimizerVersion||trip.routeOptimizationSnapshot?.optimizerVersion||'route-repair',routingVersion:Dispatch?.routing?.version||trip.routeOptimizationSnapshot?.routingVersion||null,repairType},poolingPolicySnapshot:(item.bookingIds||[]).length>1?(item.poolingPolicySnapshot||null):null,poolingFareMultiplier:(item.bookingIds||[]).length>1?(item.poolingPolicySnapshot?.fareMultiplier??null):null,needs:bookings.map(b=>Booking.needsText(b)).filter(x=>x!=='一般接送需求').join('／')||'一般乘客',pickupAddress:(item.pickups||[]).map(p=>p.address).join('／'),dropoffAddress:(item.dropoffs||[]).map(p=>p.address).join('／'),estimatedEmptyKm:routeRepairEstimatedEmptyKm(trip,item),estimatedLoadedKm:item.loadedKm,optimizerScore:item.score,currentStepIndex:0,runtimeSchemaVersion:TRIP_RUNTIME_SCHEMA_VERSION,passengers,startedAt:null,completedAt:null,steps:built.steps,routeRepairedAt:at,routeRepairReason:reason,updatedAt:at,routeRepairActorUserId:actorUserId};
}
function buildTripFromPlanItem(plan,item,index){
  const bookings=item.bookingIds.map(id=>Booking.get(id)).filter(Boolean);if(!bookings.length)return null;
  const id=uid('trip'),start=new Date(item.startAt),code=`CR-${dateKey(start).slice(5).replace('-','')}-${String(store.state.trips.length+index+1).padStart(3,'0')}`,built=buildTripStepsFromItem(id,item,bookings),passengers=buildTripPassengers(id,bookings,item.bookingLegRefs||[]);
  return {id,organizationId:plan.organizationId,dispatchPlanId:plan.id,code,date:dateKey(start),driverId:item.driverId,vehicleId:item.vehicleId,status:'scheduled',stateChangedAt:nowISO(),startedAt:null,bookingIds:item.bookingIds,bookingLegRefs:item.bookingLegRefs||[],pickupLocation:makeLocationSnapshot(item.firstPickupAddress),dropoffLocation:makeLocationSnapshot(item.finalDropoffAddress),passengerSummary:bookings.map(b=>b.name).join('＋'),passengerCount:item.passengerUnits,isPooled:item.isPooled,dispatchStops:built.dispatchStops,passengerLoadTimeline:item.loadTimeline||[],routeOptimizationSnapshot:{sequenceMode:item.poolValidation?.route?.sequenceMode||'single',sequenceEvaluatedCount:item.poolValidation?.route?.sequenceEvaluatedCount||1,optimizerVersion:plan.optimizerVersion||null,routingVersion:plan.routingVersion||null},poolingPolicySnapshot:item.poolingPolicySnapshot||null,poolingFareMultiplier:item.isPooled?(item.poolingPolicySnapshot?.fareMultiplier??null):null,needs:bookings.map(b=>Booking.needsText(b)).filter(x=>x!=='一般接送需求').join('／')||'一般乘客',pickupAddress:item.pickups.map(p=>p.address).join('／'),dropoffAddress:item.dropoffs.map(p=>p.address).join('／'),estimatedEmptyKm:item.emptyKm,estimatedLoadedKm:item.loadedKm,optimizerScore:item.score,currentStepIndex:0,runtimeSchemaVersion:TRIP_RUNTIME_SCHEMA_VERSION,revision:0,mutationReceipts:[],passengers,createdAt:nowISO(),updatedAt:nowISO(),completedAt:null,steps:built.steps};
}

function tripExecutionAccess(trip,actorUserId){
  if(!trip||!actorUserId)return {ok:false,error:'缺少行程或操作人員'};
  if(!Identity?.canUser?.(actorUserId,'trip.execute',trip.organizationId))return {ok:false,error:'你沒有執行此行程的權限'};
  const assignedDriver=Organization.driver(trip.driverId);
  if(!assignedDriver||assignedDriver.userId!==actorUserId)return {ok:false,error:'只有本趟實際指派司機可以執行或回報此行程'};
  return {ok:true,driver:assignedDriver};
}

Trip = {
  mutationKey:makeTripMutationKey,
  hasActiveRecipientForDriver(recipientId,organizationId,driverId){
    return store.state.trips.some(t=>t.organizationId===organizationId&&t.driverId===driverId&&!isTripTerminalStatus(t.status)&&(t.bookingIds||[]).some(id=>Booking.get(id)?.recipientId===recipientId));
  },
  canCancelForBookingInDb(db,booking){
    const tripIds=[...new Set(scheduledBookingLegs(booking).map(l=>l.tripId).filter(Boolean))],trips=tripIds.map(id=>(db.trips||[]).find(t=>t.id===id)).filter(Boolean);
    if(trips.length!==tripIds.length)return {ok:false,error:'已有 Leg 排車但找不到完整 Trip，請聯絡客服',trips:[]};
    if(trips.some(t=>t.status!=='scheduled'))return {ok:false,error:'其中一段行程已開始或已結束，無法由需求者直接取消',trips};
    return {ok:true,trips};
  },
  prepareBookingCancellation(booking,{actorUserId=null}={}){
    const check=this.canCancelForBookingInDb(store.state,booking);if(!check.ok)return {...check,operations:[]};
    const operations=[];
    for(const trip of check.trips){
      const expectedFingerprint=tripMutationFingerprint(trip);
      if((trip.bookingIds||[]).length<=1){operations.push({tripId:trip.id,type:'cancel_trip',expectedFingerprint});continue;}
      const repair=Dispatch.prepareRouteRepair(trip,{excludeBookingIds:[booking.id]});if(!repair.ok)return {ok:false,error:`共乘行程 ${trip.code||trip.id} 無法安全移除本需求：${repair.error}`,tripId:trip.id,operations:[]};
      if(repair.mode==='cancel_trip'){operations.push({tripId:trip.id,type:'cancel_trip',expectedFingerprint});continue;}
      const patch=tripRoutePatchFromItem(trip,repair.item,{actorUserId,reason:'共乘成員取消後重建剩餘路線',repairType:'booking_cancelled'});if(!patch)return {ok:false,error:`共乘行程 ${trip.code||trip.id} 無法建立剩餘路線快照`,tripId:trip.id,operations:[]};
      operations.push({tripId:trip.id,type:'route_repair',expectedFingerprint,patch,remainingBookingIds:[...(repair.item.bookingIds||[])]});
    }
    return {ok:true,trips:check.trips,operations};
  },
  canCancelForBooking(booking){ return this.prepareBookingCancellation(booking); },
  cancelForBookingInDb(db,booking,{actorUserId=null,reason='',prepared=null}={}){
    const check=this.canCancelForBookingInDb(db,booking);if(!check.ok)return {...check,cancelledTripIds:[],repairedTripIds:[]};
    const prep=prepared||this.prepareBookingCancellation(booking,{actorUserId});if(!prep?.ok)return {...(prep||{}),ok:false,cancelledTripIds:[],repairedTripIds:[]};
    const currentIds=new Set(check.trips.map(t=>t.id)),ops=prep.operations||[];
    if(ops.some(op=>!currentIds.has(op.tripId)))return {ok:false,error:'取消前 Trip 關聯已改變，請重新整理後再試',cancelledTripIds:[],repairedTripIds:[]};
    for(const op of ops){const t=(db.trips||[]).find(x=>x.id===op.tripId);if(!t||t.status!=='scheduled'||tripMutationFingerprint(t)!==op.expectedFingerprint)return {ok:false,error:'取消前共乘 Trip 已被其他調度異動，請重新整理後再試',cancelledTripIds:[],repairedTripIds:[]};}
    const at=nowISO(),cancelledTripIds=[],repairedTripIds=[],repairDetails=[];
    for(const op of ops){const t=(db.trips||[]).find(x=>x.id===op.tripId);if(op.type==='cancel_trip'){const moved=transitionTripInDb(db,t,'cancelled',{at,actorUserId,reason:String(reason||'').trim(),reasonCode:'booking_cancelled'});if(!moved.ok)return {ok:false,error:moved.error,cancelledTripIds:[],repairedTripIds:[]};normalizeTripPassengers(t);rebuildTripPassengerProjection(t);bumpTripRevisionInDb(t,at,db,'booking_cancel_trip');cancelledTripIds.push(t.id);continue;}t.routeRepairHistory=Array.isArray(t.routeRepairHistory)?t.routeRepairHistory:[];t.routeRepairHistory.push({at,actorUserId,repairType:'booking_cancelled',reason:String(reason||'').trim(),removedBookingId:booking.id,beforeBookingIds:[...(t.bookingIds||[])],afterBookingIds:[...(op.patch.bookingIds||[])]});Object.assign(t,deepClone(op.patch));normalizeTripRuntime(t);bumpTripRevisionInDb(t,at,db,'booking_cancel_route_repair');appendTripExecutionSnapshotInDb(db,t,{source:'booking_cancelled_route_repair',capturedAt:at,actorUserId,reason:'共乘成員取消後重建剩餘路線'});repairedTripIds.push(t.id);repairDetails.push({tripId:t.id,remainingBookingIds:[...(op.remainingBookingIds||[])]});}
    return {ok:true,cancelledTripIds,repairedTripIds,repairDetails};
  },
  applyPreparedRouteRepairs(changes,{actorUserId=null,reason='Route Repair',repairType='booking_changed'}={}){
    if(!Array.isArray(changes)||!changes.length)return {ok:true,changed:0,tripIds:[]};
    const prepared=[];
    for(const change of changes){const trip=this.get(change.tripId);if(!trip||trip.status!=='scheduled')return {ok:false,error:`Trip ${change.tripId} 已開始、已結束或不存在，未變更任何 Trip`};if(change.mode==='cancel_trip'){prepared.push({change,trip,oldDriverId:trip.driverId,oldVehicleId:trip.vehicleId,expectedFingerprint:tripMutationFingerprint(trip),patch:null});continue;}const patch=tripRoutePatchFromItem(trip,change.item,{actorUserId,reason,repairType});if(!patch)return {ok:false,error:`Trip ${trip.code||trip.id} 無法建立 Route Repair 快照`};prepared.push({change,trip,oldDriverId:trip.driverId,oldVehicleId:trip.vehicleId,expectedFingerprint:tripMutationFingerprint(trip),patch});}
    try{
      store.mutate(db=>{for(const row of prepared){const t=db.trips.find(x=>x.id===row.trip.id);if(!t||t.status!=='scheduled'||tripMutationFingerprint(t)!==row.expectedFingerprint)throw new Error('ROUTE_REPAIR_STALE');}const at=nowISO();for(const row of prepared){const t=db.trips.find(x=>x.id===row.trip.id);if(row.change.mode==='cancel_trip'){const moved=transitionTripInDb(db,t,'cancelled',{at,actorUserId,reason,reasonCode:'route_repair_cancelled'});if(!moved.ok)throw new Error(`ROUTE_REPAIR_STATE:${moved.error}`);normalizeTripPassengers(t);rebuildTripPassengerProjection(t);bumpTripRevisionInDb(t,at,db,'route_repair_cancel_trip');continue;}t.routeRepairHistory=Array.isArray(t.routeRepairHistory)?t.routeRepairHistory:[];t.routeRepairHistory.push({at,actorUserId,repairType,reason,beforeBookingIds:[...(t.bookingIds||[])],afterBookingIds:[...(row.patch.bookingIds||[])],oldDriverId:t.driverId,newDriverId:row.change.item.driverId,oldVehicleId:t.vehicleId,newVehicleId:row.change.item.vehicleId});Object.assign(t,deepClone(row.patch));t.driverId=row.change.item.driverId;t.vehicleId=row.change.item.vehicleId;t.estimatedEmptyKm=row.change.item.emptyKm;t.optimizerScore=row.change.item.score;normalizeTripRuntime(t);bumpTripRevisionInDb(t,at,db,'route_repair');appendTripExecutionSnapshotInDb(db,t,{source:`route_repair:${repairType}`,capturedAt:at,actorUserId,reason});}});
    }catch(error){if(error?.message==='ROUTE_REPAIR_STALE')return {ok:false,error:'Route Repair 前 Trip 已被其他調度異動，未變更任何 Trip'};if(String(error?.message||'').startsWith('ROUTE_REPAIR_STATE:'))return {ok:false,error:String(error.message).slice('ROUTE_REPAIR_STATE:'.length)};throw error;}
    const tripIds=prepared.map(x=>x.trip.id);
    if(typeof Notification!=='undefined'&&Notification?.queue){for(const row of prepared){const id=row.trip.id,t=this.get(id),oldDriver=Organization.driver(row.oldDriverId),newDriver=Organization.driver(t?.driverId);if(t?.status==='cancelled'){if(oldDriver?.userId)Notification.queue({organizationId:t.organizationId,recipientId:oldDriver.userId,channel:'line',template:'trip_cancelled',eventType:'trip_cancelled',payload:{tripId:id,tripCode:t?.code||'',reason,repairType}});continue;}if(oldDriver?.userId&&row.oldDriverId&&row.oldDriverId!==t?.driverId)Notification.queue({organizationId:t.organizationId,recipientId:oldDriver.userId,channel:'line',template:'trip_unassigned',eventType:'trip_unassigned',payload:{tripId:id,tripCode:t?.code||'',reason,repairType,newDriverId:t?.driverId||null}});if(newDriver?.userId)Notification.queue({organizationId:t.organizationId,recipientId:newDriver.userId,channel:'line',template:'trip_route_repaired',eventType:'trip_route_repaired',payload:{tripId:id,tripCode:t?.code||'',reason,repairType,oldDriverId:row.oldDriverId||null}});for(const bid of t?.bookingIds||[]){const b=Booking.get(bid);if(b?.requestedByUserId)Notification.queue({organizationId:t.organizationId,recipientId:b.requestedByUserId,channel:'line',template:'trip_route_updated',eventType:'trip_route_updated',payload:{tripId:id,tripCode:t?.code||'',reason}});}}}
    return {ok:true,changed:tripIds.length,tripIds};
  },
  get(id){ const trip=store.state.trips.find(t=>t.id===id); return normalizeTripRuntime(trip); },
  list(organizationId,date=null){ return store.state.trips.filter(t=>t.organizationId===organizationId&&(!date||t.date===date)).map(normalizeTripRuntime); },
  forDriver(driverId,date=null){ return store.state.trips.filter(t=>t.driverId===driverId&&(!date||t.date===date)).map(normalizeTripRuntime).sort((a,b)=>new Date(a.steps?.[0]?.scheduledAt||0)-new Date(b.steps?.[0]?.scheduledAt||0)); },
  nextForDriver(driverId,date=dateKey()){ return this.forDriver(driverId,date).find(t=>!isTripTerminalStatus(t.status)); },
  currentStep(trip){ normalizeTripRuntime(trip); return trip?.steps?.[trip.currentStepIndex]||null; },
  passengers(tripOrId){ const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return trip?.passengers||[]; },
  passengerSummaryRuntime(tripOrId){return this.passengers(tripOrId).map(p=>`${p.name}：${tripPassengerStatusLabel(p.status)}`).join('、');},
  resourceSegments(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(trip?.resourceSegments||[]);},
  executionSnapshots(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(trip?.executionSnapshots||[]);},
  activeExecutionSnapshot(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(activeTripExecutionSnapshot(trip));},
  actualMetrics(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(rebuildTripActualMetrics(trip));},
  serviceProofs(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);normalizeTripProofs(trip);return deepClone(trip?.serviceProofs||[]);},
  activeServiceProofs(tripOrId){return this.serviceProofs(tripOrId).filter(p=>p.status!=='superseded');},
  executionWindow(tripOrId,at=nowISO()){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(tripExecutionWindowState(trip,at));},
  correctionAvailability(tripOrId,actorUserId,at=nowISO()){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(tripCompletedCorrectionAvailability(trip,actorUserId,at));},
  async proofPhoto(tripOrId,proofId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId),proof=(trip?.serviceProofs||[]).find(p=>p.id===proofId);if(!proof)return {ok:false,error:'找不到 Proof'};return loadTripProofPhotoP1(proof.photo);},
  navigationStatus(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);normalizeTripNavigationRuntime(trip);return deepClone(trip?.liveNavigation||null);},
  offlineQueue({pendingOnly=true}={}){const rows=Array.isArray(store.state.tripOfflineQueue)?store.state.tripOfflineQueue:[];return deepClone(pendingOnly?rows.filter(x=>!TRIP_QUEUE_SETTLED_STATUSES.includes(x.status)):rows);},
  async hydrateOutbox(){return hydrateTripOutboxFromIdb();},
  async migrateLegacyProofPhotos(){return migrateLegacyProofPhotosToIdb();},
  async syncOfflineQueue(){
    if(tripOutboxSyncPromise)return tripOutboxSyncPromise;
    tripOutboxSyncPromise=(async()=>{
      await hydrateTripOutboxFromIdb();
      if(tripAppOffline())return {ok:false,offline:true,pending:this.offlineQueue().length,error:'目前離線'};
      const pending=this.offlineQueue();if(!pending.length)return {ok:true,synced:0,failed:0,pending:0,mode:TripSyncAdapter.mode};
      let response;try{response=await TripSyncAdapter.syncBatch(pending,{deviceId:TRIP_DEVICE_ID,sessionId:TRIP_SESSION_ID,clientNow:nowISO()});}catch(e){response={ok:false,error:e.message||'sync 失敗',results:[]};}
      const byId=new Map(),byRequest=new Map();for(const r of response?.results||[]){if(r?.id)byId.set(r.id,r);if(r?.requestId)byRequest.set(r.requestId,r);}
      const sentIds=new Set(pending.map(x=>x.id)),persistRows=[];let synced=0,failed=0,stillPending=0;
      store.mutate(db=>{for(const row of db.tripOfflineQueue||[]){if(!sentIds.has(row.id)||row.status==='synced')continue;const r=byId.get(row.id)||byRequest.get(row.requestId)||null;row.attempts=(Number(row.attempts)||0)+1;row.syncMode=response?.mode||TripSyncAdapter.mode;if(!r){row.status='pending';row.lastError=response?.ok===false?(response.error||'同步批次失敗'):'伺服器未回傳此 requestId，保留待同步';stillPending++;persistRows.push(deepClone(row));continue;}if(r.ok===true){row.status='synced';row.syncedAt=r.serverRecordedAt||response?.serverRecordedAt||nowISO();row.serverRecordedAt=row.syncedAt;row.serverRevision=r.serverRevision??null;row.lastError=null;synced++;if(row.mutationType==='trip_event'){const e=(db.tripEvents||[]).find(x=>x.id===row.referenceId);if(e)e.serverRecordedAt=row.syncedAt;}}else{row.status=r.permanent?'rejected':'failed';row.syncedAt=null;row.serverRecordedAt=r.serverRecordedAt||null;row.serverRevision=r.serverRevision??null;row.lastError=r.error||r.message||response?.error||'伺服器拒絕此項目';failed++;}persistRows.push(deepClone(row));}});
      if(persistRows.length)await Promise.all(persistRows.map(persistTripQueueRowP2));
      await cleanupTripP2Storage();const remaining=this.offlineQueue().length;return {ok:failed===0&&stillPending===0&&response?.ok!==false,synced,failed,pending:remaining,mode:response?.mode||TripSyncAdapter.mode,error:failed||stillPending?(response?.error||'部分項目尚未同步'):null};
    })();
    try{return await tripOutboxSyncPromise;}finally{tripOutboxSyncPromise=null;updateSyncUI();}
  },
  captureProof(tripId,stepId,input={},actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;const step=(trip.steps||[]).find(s=>s.id===stepId);if(!step||step.type!=='dropoff')return {ok:false,error:'服務證明 只能綁定送達 Stop'};if(!step.completedAt&&!step.passengerDroppedOffAt)return {ok:false,error:'此送達 Stop 尚未完成，不能建立服務證明'};const receiverName=String(input.receiverName||'').trim().slice(0,80);if(!receiverName)return {ok:false,error:'請填寫實際收受／確認人'};const expectedRevision=options.expectedRevision??trip.revision,idempotencyKey=options.idempotencyKey||makeTripMutationKey('proof_service',tripId,`${stepId}:${receiverName}`,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;const at=nowISO();let result={ok:false,error:'服務證明儲存失敗'},proof=null,completedByThisProof=false;
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}normalizeTripProofs(t);const s=t.steps.find(x=>x.id===stepId);proof={id:uid('proof'),schemaVersion:TRIP_PROOF_SCHEMA_VERSION,sequence:t.serviceProofs.length+1,status:'active',supersededAt:null,supersededByUserId:null,supersededReason:'',supersededByCorrectionEventId:null,tripId,stepId:s.id,bookingId:s.bookingId||null,bookingLegId:s.bookingLegId||null,passengerId:s.passengerId||null,receiverName,receiverRole:String(input.receiverRole||'other'),note:String(input.note||'').trim().slice(0,500),driverConfirmed:true,capturedAt:at,actorUserId,gps:input.gps&&validCoords(input.gps)?{lat:Number(input.gps.lat),lng:Number(input.gps.lng),accuracyMeters:Number.isFinite(Number(input.gps.accuracyMeters))?Math.round(Number(input.gps.accuracyMeters)):null,capturedAt:input.gps.capturedAt||at,source:'device_geolocation'}:null,photo:input.photo?.objectKey?{name:String(input.photo.name||'proof.jpg').slice(0,120),type:String(input.photo.type||'image/jpeg'),size:Number(input.photo.size)||null,storage:String(input.photo.storage||'indexeddb'),objectKey:String(input.photo.objectKey),legacyInline:false}:null};t.serviceProofs.push(proof);queueTripOfflineMutationInDb(db,{tripId,mutationType:'trip_proof_of_service',referenceId:proof.id,payload:proof,queuedAt:at});appendTripEventInDb(db,{tripId,eventType:'trip_proof_of_service_captured',at,actorUserId,stepId:s.id,reason:'proof_of_service',metadata:{proofId:proof.id,sequence:proof.sequence,bookingId:proof.bookingId,receiverName:proof.receiverName,receiverRole:proof.receiverRole,hasGps:!!proof.gps,hasPhoto:!!proof.photo,policy:deepClone(t.proofPolicy)}});const readiness=tripCompletionReadinessInDb(db,t);if(t.currentStepIndex>=t.steps.length&&t.status==='in_progress'&&readiness.ok){const moved=transitionTripInDb(db,t,'completed',{at,actorUserId,reason:'proof_requirements_satisfied'});if(!moved.ok){result=moved;return;}completedByThisProof=true;t.completionPending=null;}else if(t.currentStepIndex>=t.steps.length&&!readiness.ok){t.completionPending={at,reasons:[...readiness.reasons],proofStepIds:readiness.proofMissing.map(x=>x.stepId),blockingIssueIds:readiness.blockingIssues.map(x=>x.id)};}finalizeTripMutationInDb(t,{key:idempotencyKey,action:'proof_service',at,actorUserId,stepId:s.id,db});result={ok:true,tripCompleted:t.status==='completed'};});if(!result.ok)return result;const updated=this.get(tripId);if(completedByThisProof){Audit.log('trip_completed',`完整行程完成：${updated.passengerSummary}`,{tripId,actorUserId,completionSource:'proof'});for(const id of updated.bookingIds||[]){const b=Booking.get(id);if(b)Notification.queue({organizationId:updated.organizationId,recipientId:b.recipientId,channel:'line',template:'trip_completed',eventType:'TRIP_COMPLETED',payload:{tripId}});}}return {ok:true,proof:deepClone(proof),trip:updated,completedByThisProof};
    }finally{releaseTripMutationLock(lock);}
  },
  recordLocationSample(tripId,position={},actorUserId){
    const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;if(isTripTerminalStatus(trip.status))return {ok:false,error:'已結束 Trip 不再更新 ETA'};const lat=Number(position.lat),lng=Number(position.lng);if(!Number.isFinite(lat)||lat<-90||lat>90||!Number.isFinite(lng)||lng<-180||lng>180)return {ok:false,error:'GPS 座標不合法'};const at=position.at||nowISO(),sample={id:uid('gps'),schemaVersion:2,at,lat,lng,deviceId:TRIP_DEVICE_ID,sessionId:TRIP_SESSION_ID,serverRecordedAt:null,accuracyMeters:Number.isFinite(Number(position.accuracyMeters))?Math.max(0,Number(position.accuracyMeters)):null,speedMps:Number.isFinite(Number(position.speedMps))?Math.max(0,Number(position.speedMps)):null,heading:Number.isFinite(Number(position.heading))?Number(position.heading):null,actorUserId};let nav=null,deviationEvent=null;
    persistTripGpsP2(sample);store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const oldLevel=t.liveNavigation?.deviationLevel||'unavailable';t.locationSamples.push(sample);if(t.locationSamples.length>TRIP_LOCATION_SAMPLE_LIMIT)t.locationSamples.splice(0,t.locationSamples.length-TRIP_LOCATION_SAMPLE_LIMIT);nav=computeTripNavigationProjection(t,sample);t.liveNavigation=nav;queueTripOfflineMutationInDb(db,{tripId,mutationType:'trip_location_sample',referenceId:sample.id,payload:sample,queuedAt:at});const newLevel=nav.deviationLevel;if(['warning','critical'].includes(newLevel)&&newLevel!==oldLevel)deviationEvent=appendTripEventInDb(db,{tripId,eventType:'trip_route_deviation_detected',at,actorUserId,stepId:nav.stepId,reason:newLevel,metadata:{deviationKm:nav.deviationKm,level:newLevel,distanceToTargetKm:nav.distanceToTargetKm,accuracyMeters:nav.accuracyMeters,etaAt:nav.etaAt,source:nav.source}});else if(['warning','critical'].includes(oldLevel)&&newLevel==='normal')deviationEvent=appendTripEventInDb(db,{tripId,eventType:'trip_route_deviation_cleared',at,actorUserId,stepId:nav.stepId,reason:'back_in_corridor',metadata:{previousLevel:oldLevel,deviationKm:nav.deviationKm,accuracyMeters:nav.accuracyMeters}});});return {ok:true,navigation:deepClone(nav),deviationEvent:deepClone(deviationEvent)};
  },
  recordActualDistance(tripId,{emptyKm=null,loadedKm=null,source='gps_or_odometer'}={},actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};const canManage=Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId),execute=tripExecutionAccess(trip,actorUserId);if(!canManage&&!execute.ok)return {ok:false,error:'只有本趟司機或調度管理者可以回寫實際里程'};
      const e=emptyKm===null||emptyKm===''?null:Number(emptyKm),l=loadedKm===null||loadedKm===''?null:Number(loadedKm);if((e!==null&&(!Number.isFinite(e)||e<0))||(l!==null&&(!Number.isFinite(l)||l<0)))return {ok:false,error:'實際公里必須為 0 以上數字'};if(e===null&&l===null)return {ok:false,error:'請至少提供一項實際公里'};
      const expectedRevision=options.expectedRevision??trip.revision,idempotencyKey=options.idempotencyKey||makeTripMutationKey('actual_distance',tripId,`${e??'-'}:${l??'-'}`,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;const at=nowISO();let result={ok:false,error:'里程回寫失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}normalizeTripActualDistance(t);if(e!==null)t.actualDistance.emptyKm=Math.round(e*10)/10;if(l!==null)t.actualDistance.loadedKm=Math.round(l*10)/10;t.actualDistance.source=String(source||'gps_or_odometer');t.actualDistance.recordedAt=at;t.actualDistance.recordedByUserId=actorUserId||null;appendTripEventInDb(db,{tripId,eventType:'trip_actual_distance_recorded',at,actorUserId,reason:t.actualDistance.source,metadata:{emptyKm:t.actualDistance.emptyKm,loadedKm:t.actualDistance.loadedKm,source:t.actualDistance.source,expectedRevision,idempotencyKey}});finalizeTripMutationInDb(t,{key:idempotencyKey,action:'actual_distance',at,actorUserId,db});result={ok:true};});return result.ok?{ok:true,trip:this.get(tripId),metrics:this.actualMetrics(tripId)}:result;
    }finally{releaseTripMutationLock(lock);}
  },
  uiPolicy(){return deepClone(TRIP_P2_RETENTION_POLICY);},
  deviceContext(){return {deviceId:TRIP_DEVICE_ID,deviceIdSource:TRIP_DEVICE_ID_SOURCE,sessionId:TRIP_SESSION_ID};},
  executionAccess(tripOrId,actorUserId){const trip=typeof tripOrId==='string'?this.get(tripOrId):tripOrId;return tripExecutionAccess(trip,actorUserId);},
  async withMutationLock(tripId,task){if(!tripId||typeof task!=='function')return {ok:false,error:'缺少 Trip 或操作函式'};return withTripMutationExclusiveLock(tripId,task);},
  async storeProofBlob(args={}){return persistTripProofBlobP2(args);},
  async deleteProofBlob(objectKey){if(!objectKey)return false;return tripIdbDelete(TRIP_P2_IDB.stores.proof,objectKey);},
  configureSyncAdapter(adapter){if(adapter?.syncBatch)TripSyncAdapter.syncBatch=adapter.syncBatch.bind(adapter);if(adapter?.mode)TripSyncAdapter.mode=adapter.mode;return {ok:true,mode:TripSyncAdapter.mode};},
  configureNavigationAdapters(config){TripNavigationAdapter.configure(config||{});return {ok:true};},
  async cleanupRetention(){return cleanupTripP2Storage();},
  async refreshNavigation(tripId,position={},actorUserId){const base=this.recordLocationSample(tripId,position,actorUserId);if(!base.ok)return base;const trip=this.get(tripId),step=trip?.steps?.[trip?.currentStepIndex],target=tripStepLocationSnapshot(trip,step),previous=previousNavigableStepLocation(trip,step),pos={lat:Number(position.lat),lng:Number(position.lng)};const enriched=await TripNavigationAdapter.enrich({origin:previous,target,position:pos,scheduledAt:step?.scheduledArrivalAt||step?.scheduledAt||null,trip,step});if(enriched.source==='fallback')return {...base,adapterFallback:true};let adapterEvent=null;store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);adapterEvent=applyNavigationAdapterResultInDb(db,t,enriched,{actorUserId,at:position.at||nowISO()});});return {ok:true,navigation:deepClone(this.get(tripId).liveNavigation),deviationEvent:deepClone(adapterEvent||base.deviationEvent||null),adapterFallback:false};},
  canTransition(tripOrId,nextState,options={}){ const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId); return canTripTransition(trip,nextState,options); },
  stopRuntime(step){ return normalizeTripStopRuntime(step); },
  classifyTiming(step,timestamp){ const planned=step?.scheduledArrivalAt||step?.scheduledDepartureAt||step?.scheduledAt; const diff=new Date(timestamp)-new Date(planned); if(diff<-60000)return {label:`提早${PHASE_LABELS[step.type]}`,detail:`提早 ${durationText(diff)}`,diff}; if(diff>60000)return {label:`延遲${PHASE_LABELS[step.type]}`,detail:`晚 ${durationText(diff)}`,diff}; return {label:`準時${PHASE_LABELS[step.type]}`,detail:'於預定時間完成',diff}; },
  createFromDispatch(plan,actorUserId){
    const fail=(error,details={})=>{ const rows=[];rows.ok=false;rows.error=error;rows.details=details;return rows; };
    if(!plan?.id) return fail('缺少調度方案');

    store.refreshFromStorage?.();
    const storedPlan=store.state.dispatchPlans.find(p=>p.id===plan.id);
    if(!storedPlan) return fail('找不到調度方案，請重新產生最佳化方案');
    if(storedPlan.status!=='confirmed') return fail('調度方案尚未確認，禁止直接建立行程；請先確認方案');
    if(!actorUserId||!Identity?.canUser?.(actorUserId,'booking.schedule',storedPlan.organizationId)) return fail('你沒有套用調度方案／建立行程 的權限');
    const freshness=Dispatch.validatePlanFreshness?.(storedPlan);
    if(freshness&&!freshness.ok) return fail(freshness.error,{dispatchPlanId:storedPlan.id,staleReason:freshness.staleReason||null});

    const planItems=Array.isArray(storedPlan.items)?storedPlan.items:[];
    if(!planItems.length) return fail('調度方案沒有可套用的行程，請重新最佳化');

    const seenBookingIds=new Set(),seenLegKeys=new Set(),plannedWindows=[],prepared=[];
    for(let index=0;index<planItems.length;index++){
      const item=planItems[index];
      if(!item?.feasible||!item.driverId||!item.vehicleId) return fail(`第 ${index+1} 趟缺少可執行的司機／車輛，請重新最佳化`,{itemId:item?.id||null});
      const start=new Date(item.startAt),end=new Date(item.endAt);
      if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start) return fail(`第 ${index+1} 趟時間資料不合法，請重新最佳化`,{itemId:item?.id||null});
      const windowStart=addMinutes(start,-20),windowEnd=end;

      const needs=(item.bookingIds||[]).map(id=>Booking.get(id)).filter(Boolean).map(b=>Booking.needsText(b)).join('／');
      const resource=Organization.validateTripResourceAssignment({
        organizationId:storedPlan.organizationId,driverId:item.driverId,vehicleId:item.vehicleId,
        startAt:windowStart,endAt:windowEnd,needs,
        passengerUnits:Number(item.passengerUnits)||1,wheelchairUnits:Number(item.wheelchairUnits)||0,
        actorUserId,requireActor:true
      });
      if(!resource.ok) return fail(`第 ${index+1} 趟資源已失效：${resource.error}`,{itemId:item.id});

      const internalConflict=plannedWindows.find(w=>w.start<windowEnd&&w.end>windowStart&&(w.driverId===item.driverId||w.vehicleId===item.vehicleId));
      if(internalConflict){
        const kind=internalConflict.driverId===item.driverId?'司機':'車輛';
        return fail(`調度方案內有${kind}時段重疊，請重新最佳化`,{itemId:item.id,conflictItemId:internalConflict.itemId});
      }

      const ids=[...new Set(item.bookingIds||[])];
      if(!ids.length) return fail(`第 ${index+1} 趟沒有 Booking`,{itemId:item.id});
      if(ids.some(id=>seenBookingIds.has(id))) return fail('同一 Booking 被同一方案重複排入多趟 Trip，請重新最佳化',{itemId:item.id});

      const refs=(item.bookingLegRefs||ids.map(bookingId=>({bookingId,legId:Booking.nextPendingLeg(bookingId)?.id||null})));
      if(refs.length!==ids.length) return fail(`第 ${index+1} 趟 Booking Leg 數量不一致，請重新最佳化`,{itemId:item.id});
      for(const ref of refs){
        const legKey=`${ref.bookingId}:${ref.legId||''}`;
        if(!ref.bookingId||!ref.legId) return fail(`第 ${index+1} 趟缺少 Booking Leg，請重新最佳化`,{itemId:item.id,bookingId:ref.bookingId||null});
        if(seenLegKeys.has(legKey)) return fail('同一 Booking Leg 被重複排車，請重新最佳化',{itemId:item.id,legKey});
        const check=Booking.canScheduleLegForTrip(ref.bookingId,ref.legId,{tripId:`__preview__:${storedPlan.id}:${index}`,organizationId:storedPlan.organizationId,userId:actorUserId});
        if(!check.ok) return fail(`Booking 已異動，無法套用方案：${check.error}`,{itemId:item.id,bookingId:ref.bookingId,legId:ref.legId});
        seenLegKeys.add(legKey);
      }
      ids.forEach(id=>seenBookingIds.add(id));
      plannedWindows.push({itemId:item.id,driverId:item.driverId,vehicleId:item.vehicleId,start:windowStart,end:windowEnd});
      prepared.push({...deepClone(item),bookingIds:ids,bookingLegRefs:deepClone(refs)});
    }

    const staged=deepClone(store.state),created=[];
    for(let index=0;index<prepared.length;index++){
      const item=prepared[index],trip=buildTripFromPlanItem(storedPlan,item,index);
      if(!trip) return fail(`第 ${index+1} 趟無法建立行程，整批已取消`,{itemId:item.id});
      for(const ref of item.bookingLegRefs){
        const transition=Booking.scheduleLegForTripInDb(staged,ref.bookingId,ref.legId,{tripId:trip.id,organizationId:storedPlan.organizationId,userId:actorUserId,source:'dispatch_plan'});
        if(!transition.ok) return fail(`Booking 在套用前已異動：${transition.error}；本次沒有建立任何 Trip`,{itemId:item.id,bookingId:ref.bookingId,legId:ref.legId});
      }
      staged.trips.push(trip);appendTripEventInDb(staged,{tripId:trip.id,eventType:'trip_created',at:trip.createdAt||nowISO(),actorUserId,reason:'dispatch_plan',metadata:{dispatchPlanId:storedPlan.id,status:'scheduled',driverId:trip.driverId,vehicleId:trip.vehicleId}});appendTripExecutionSnapshotInDb(staged,trip,{source:'dispatch_plan',capturedAt:trip.createdAt||nowISO(),actorUserId,reason:'Trip 建立時凍結執行資料'});rebuildTripActualMetrics(trip);created.push(trip);
    }
    const stagedPlan=staged.dispatchPlans.find(p=>p.id===storedPlan.id);
    if(!stagedPlan||stagedPlan.status!=='confirmed') return fail('調度方案狀態已變更，本次沒有建立任何 Trip');
    stagedPlan.status='applied';stagedPlan.appliedAt=nowISO();stagedPlan.appliedByUserId=actorUserId;stagedPlan.appliedTripIds=created.map(t=>t.id);stagedPlan.appliedCount=created.length;

    store.mutate(db=>{
      db.bookings=staged.bookings;
      db.bookingEvents=staged.bookingEvents;
      db.trips=staged.trips;
      db.tripEvents=staged.tripEvents;
      db.dispatchPlans=staged.dispatchPlans;
    });

    created.forEach(trip=>{
      Audit.log('trip_created_from_dispatch',`由調度方案建立 ${trip.code}`,{tripId:trip.id,dispatchPlanId:storedPlan.id,organizationId:trip.organizationId});
      trip.bookingIds.forEach(bookingId=>{ const b=Booking.get(bookingId); if(b) Notification.queue({organizationId:trip.organizationId,recipientId:b.recipientId,channel:'line',template:'booking_confirmed',eventType:'TRIP_CREATED',payload:{tripId:trip.id,code:trip.code}}); });
    });
    created.ok=true;created.error=null;
    return created;
  },
  createManual(input,organizationId,actorUserId){
    const creationMutationKey=String(input?.clientMutationKey||'').trim();
    if(creationMutationKey){store.refreshFromStorage?.();const existing=(store.state.trips||[]).find(t=>t.creationMutationKey===creationMutationKey);if(existing)return {ok:true,duplicate:true,trip:this.get(existing.id)};}
    const pickupAt=new Date(input.pickupAt),endAt=addMinutes(pickupAt,Math.max(8,Dispatch.estimateDriveMinutes(input.pickupAddress,input.destination,{departureAt:pickupAt})+(Dispatch.policy?.routingServiceBufferMin||4))),id=uid('trip'),contact=[{name:input.name,phone:input.phone}],code=`CR-${dateKey(pickupAt).slice(5).replace('-','')}-${String(store.state.trips.length+1).padStart(3,'0')}`;
    const resource=Organization.validateTripResourceAssignment({organizationId,driverId:input.driverId,vehicleId:input.vehicleId,startAt:addMinutes(pickupAt,-20),endAt,needs:input.needs||'',passengerUnits:1,wheelchairUnits:/輪椅/.test(input.needs||'')?1:0,actorUserId,requireActor:true});
    if(!resource.ok) return resource;
    if(input.bookingId){ const bookingCheck=Booking.canScheduleLegForTrip(input.bookingId,input.bookingLegId,{tripId:id,organizationId,userId:actorUserId}); if(!bookingCheck.ok) return bookingCheck; }
    const pickupLocation=makeLocationSnapshot(input.pickupAddress,input.pickupAccessNote||''),dropoffLocation=makeLocationSnapshot(input.destination,input.destinationAccessNote||'');
    const createdAt=nowISO();
    const trip={id,organizationId,dispatchPlanId:null,code,date:dateKey(pickupAt),driverId:input.driverId,vehicleId:input.vehicleId,status:'scheduled',stateChangedAt:createdAt,startedAt:null,bookingIds:input.bookingId?[input.bookingId]:[],bookingLegRefs:input.bookingId?[{bookingId:input.bookingId,legId:input.bookingLegId||null}]:[],passengerSummary:input.name,passengerCount:1,isPooled:false,needs:input.needs||'一般乘客',pickupAddress:input.pickupAddress,dropoffAddress:input.destination,pickupLocation,dropoffLocation,currentStepIndex:0,runtimeSchemaVersion:TRIP_RUNTIME_SCHEMA_VERSION,revision:0,mutationReceipts:[],creationMutationKey:creationMutationKey||null,passengers:[],createdAt,updatedAt:createdAt,completedAt:null,steps:[
      makeTripStop({id:`${id}_depart`,type:'depart',sequence:1,scheduledAt:addMinutes(pickupAt,-20).toISOString(),title:`準備下一趟｜${input.name}`,name:`出發前往${input.name}`,destination:input.pickupAddress,contacts:contact,note:`確認車況與乘客需求：${input.needs||'一般乘客'}`}),
      makeTripStop({id:`${id}_pickup`,type:'pickup',sequence:2,scheduledAt:pickupAt.toISOString(),title:`接送｜${input.name}`,name:input.name,destination:input.pickupAddress,contacts:contact,note:`${input.pickupAccessNote?`上車注意：${input.pickupAccessNote}。`:''}接到乘客後前往：${input.destination}`,bookingId:input.bookingId||null,bookingLegId:input.bookingLegId||null,passengerId:tripPassengerRuntimeId(id,input.bookingId||null,0)}),
      makeTripStop({id:`${id}_dropoff`,type:'dropoff',sequence:3,scheduledAt:endAt.toISOString(),title:'目的地',name:`送達${input.name}`,destination:input.destination,contacts:contact,note:`${input.destinationAccessNote?`下車注意：${input.destinationAccessNote}。`:''}確認乘客安全下車後，完整趟次才加 1。`,bookingId:input.bookingId||null,bookingLegId:input.bookingLegId||null,passengerId:tripPassengerRuntimeId(id,input.bookingId||null,0)})
    ]};
    trip.passengers=buildTripPassengers(id,input.bookingId?[Booking.get(input.bookingId)].filter(Boolean):[],trip.bookingLegRefs,{bookingId:input.bookingId||null,bookingLegId:input.bookingLegId||null,name:input.name,phone:input.phone,seatUnits:1,wheelchairUnits:/輪椅/.test(input.needs||'')?1:0});
    normalizeTripPassengers(trip);
    let bookingTransition={ok:true},duplicateTrip=null;
    store.mutate(db=>{
      if(creationMutationKey){duplicateTrip=(db.trips||[]).find(t=>t.creationMutationKey===creationMutationKey)||null;if(duplicateTrip)return;}
      if(input.bookingId){bookingTransition=Booking.scheduleLegForTripInDb(db,input.bookingId,input.bookingLegId,{tripId:trip.id,organizationId,userId:actorUserId,source:'manual_trip'});if(!bookingTransition.ok)return;}
      db.trips.push(trip);
      appendTripEventInDb(db,{tripId:trip.id,eventType:'trip_created',at:createdAt,actorUserId,reason:'manual_trip',metadata:{status:'scheduled',driverId:trip.driverId,vehicleId:trip.vehicleId,creationMutationKey:creationMutationKey||null}});
      appendTripExecutionSnapshotInDb(db,trip,{source:'manual_trip',capturedAt:createdAt,actorUserId,reason:'Trip 建立時凍結執行資料'});
      rebuildTripActualMetrics(trip);enforceTripInvariantsInDb(db,trip,'manual_trip_created');
    });
    if(duplicateTrip)return {ok:true,duplicate:true,trip:this.get(duplicateTrip.id)};
    if(!bookingTransition.ok) return bookingTransition;
    Audit.log('trip_created_manual',`手動建立 ${code}｜${resource.driver.name}／${resource.vehicle.plate}`,{tripId:id,organizationId,driverId:input.driverId,vehicleId:input.vehicleId,actorUserId});
    return {ok:true,trip};
  },
  assign(tripId,driverId,vehicleId,actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId); if(!trip) return {ok:false,error:'找不到行程'};
      if(trip.status!=='scheduled') return {ok:false,error:'只有尚未開始的行程可以一般改派；進行中行程如需交接請走異常處理流程'};
      const expectedRevision=options.expectedRevision??trip.revision,idempotencyKey=options.idempotencyKey||makeTripMutationKey('assign',tripId,`${driverId}:${vehicleId}`,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;
      const peakPassengerUnits=Math.max(Number(trip.passengerCount||1),...(trip.passengerLoadTimeline||[]).map(x=>Number(x.seatsUsed??x.passengers??0)||0)),peakWheelchairUnits=Math.max(/輪椅/.test(trip.needs||'')?1:0,...(trip.passengerLoadTimeline||[]).map(x=>Number(x.wheelchairSlotsUsed??x.wheelchairs??0)||0));
      const resource=Organization.validateTripResourceAssignment({organizationId:trip.organizationId,driverId,vehicleId,startAt:trip.steps?.[0]?.scheduledAt,endAt:trip.steps?.[trip.steps.length-1]?.scheduledAt,needs:trip.needs||'',passengerUnits:peakPassengerUnits,wheelchairUnits:peakWheelchairUnits,ignoreTripId:tripId,actorUserId,requireActor:true});
      if(!resource.ok) return resource;
      const at=nowISO();store.mutate(db=>{ const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,idempotencyKey});if(!g.ok||g.duplicate)return; const previous={driverId:t.driverId,vehicleId:t.vehicleId};t.driverId=driverId;t.vehicleId=vehicleId;ensureTripResourceSegment(t,{driverId,vehicleId,assignedAt:at,source:'prestart_reassignment'});appendTripEventInDb(db,{tripId,eventType:'trip_resource_assigned',at,actorUserId,metadata:{from:previous,to:{driverId,vehicleId},expectedRevision,idempotencyKey,resourceSegments:deepClone(t.resourceSegments)}});finalizeTripMutationInDb(t,{key:idempotencyKey,action:'assign',at,actorUserId,db}); });
      Audit.log('trip_assigned',`行程 ${tripId} 改派 ${resource.driver.name}／${resource.vehicle.plate}`,{tripId,driverId,vehicleId,actorUserId,organizationId:trip.organizationId});
      return {ok:true,trip:this.get(tripId)};
    }finally{releaseTripMutationLock(lock);}
  },
  recordCurrentStopMilestone(tripId,milestone,actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId),step=this.currentStep(trip);if(!trip||!step)return {ok:false,error:'沒有可執行的 Stop'};
      const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;if(trip.status==='interrupted')return {ok:false,error:'此行程已中斷，需由調度完成處理並恢復後才能繼續執行 Stop'};if(['completed','cancelled','aborted'].includes(trip.status))return {ok:false,error:'此行程已完成、取消或終止，不能再執行 Stop'};
      const expectedRevision=options.expectedRevision??trip.revision,expectedStepId=options.expectedStepId||step.id,idempotencyKey=options.idempotencyKey||makeTripMutationKey(`milestone_${milestone}`,tripId,expectedStepId,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,expectedStepId,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip,step}:guard;
      if(milestone==='passenger_boarded'){const p=validatePassengerStateForStep(trip,step,'onboard');if(!p.ok)return p;}if(milestone==='passenger_dropped_off'){const p=validatePassengerStateForStep(trip,step,'dropped_off');if(!p.ok)return p;}
      const timestamp=nowISO();let result={ok:false,error:'Stop 執行失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,expectedStepId,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}const s=t.steps[t.currentStepIndex];if(milestone==='passenger_boarded')result=applyPassengerStateForStepInDb(db,t,s,'onboard',timestamp,actorUserId,{reason:milestone});else if(milestone==='passenger_dropped_off')result=applyPassengerStateForStepInDb(db,t,s,'dropped_off',timestamp,actorUserId,{reason:milestone});else result={ok:true};if(!result.ok)return;result=applyStopMilestoneInDb(t,s,milestone,timestamp);if(!result.ok)return;appendTripEventInDb(db,{tripId,eventType:'trip_stop_milestone',at:timestamp,actorUserId,stepId:s.id,reason:milestone,metadata:{milestone,stopRuntime:tripStopRuntimeSnapshot(s),expectedRevision,idempotencyKey}});if(t.status==='scheduled'){const moved=transitionTripInDb(db,t,'in_progress',{at:timestamp,actorUserId,reason:`stop_${milestone}`});if(!moved.ok){result=moved;return;}}finalizeTripMutationInDb(t,{key:idempotencyKey,action:`milestone_${milestone}`,at:timestamp,actorUserId,stepId:s.id,db});result={ok:true};});
      if(!result.ok)return result;Audit.log('trip_stop_milestone',`${step.name}｜${milestone}`,{tripId,stepId:step.id,milestone,actorUserId});return {ok:true,trip:this.get(tripId),step:this.get(tripId)?.steps?.find(s=>s.id===step.id)||null};
    }finally{releaseTripMutationLock(lock);}
  },
  arriveCurrentStop(tripId,actorUserId,options={}){ return this.recordCurrentStopMilestone(tripId,'arrived',actorUserId,options); },
  startCurrentStopService(tripId,actorUserId,options={}){ return this.recordCurrentStopMilestone(tripId,'service_started',actorUserId,options); },
  boardCurrentPassenger(tripId,actorUserId,options={}){ return this.recordCurrentStopMilestone(tripId,'passenger_boarded',actorUserId,options); },
  dropoffCurrentPassenger(tripId,actorUserId,options={}){ return this.recordCurrentStopMilestone(tripId,'passenger_dropped_off',actorUserId,options); },
  departCurrentStop(tripId,actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId),step=this.currentStep(trip);if(!trip||!step)return {ok:false,error:'沒有可執行的 Stop'};const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;if(trip.status==='interrupted')return {ok:false,error:'此行程已中斷，需由調度恢復後才能離開目前 Stop'};if(['completed','cancelled','aborted'].includes(trip.status))return {ok:false,error:'此行程已完成、取消或終止，不能再執行 Stop'};
      const expectedRevision=options.expectedRevision??trip.revision,expectedStepId=options.expectedStepId||step.id,idempotencyKey=options.idempotencyKey||makeTripMutationKey('depart_stop',tripId,expectedStepId,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,expectedStepId,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;
      const timestamp=nowISO(),timing=this.classifyTiming(step,timestamp);let result={ok:false,error:'Stop 執行失敗'},final=false;
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,expectedStepId,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}const s=t.steps[t.currentStepIndex];result=applyStopMilestoneInDb(t,s,'departed',timestamp);if(!result.ok)return;appendTripEventInDb(db,{tripId,eventType:'trip_step_completed',at:timestamp,actorUserId,stepId:s.id,reason:'departed',metadata:{timing:timing.detail,stopRuntime:tripStopRuntimeSnapshot(s),expectedRevision,idempotencyKey}});const next=t.steps.findIndex(x=>x.status!=='completed');t.currentStepIndex=next<0?t.steps.length:next;final=t.currentStepIndex>=t.steps.length;if(final){const readiness=tripCompletionReadinessInDb(db,t);if(readiness.ok){result=transitionTripInDb(db,t,'completed',{at:timestamp,actorUserId,reason:'all_stops_completed'});t.completionPending=null;}else{if(t.status==='scheduled')transitionTripInDb(db,t,'in_progress',{at:timestamp,actorUserId,reason:'all_stops_completed_pending_requirements'});t.completionPending={at:timestamp,reasons:[...readiness.reasons],proofStepIds:readiness.proofMissing.map(x=>x.stepId),blockingIssueIds:readiness.blockingIssues.map(x=>x.id)};result={ok:true,pendingCompletion:true,readiness};}}else if(t.status==='scheduled')result=transitionTripInDb(db,t,'in_progress',{at:timestamp,actorUserId,reason:'first_stop_departed'});else result={ok:true};if(result.ok)finalizeTripMutationInDb(t,{key:idempotencyKey,action:'depart_stop',at:timestamp,actorUserId,stepId:s.id,db});});
      if(!result.ok)return result;Audit.log('trip_step_completed',`完成${PHASE_LABELS[step.type]}：${step.name}（${timing.detail}）`,{tripId,stepId:step.id,actorUserId,stopRuntime:true});const updated=this.get(tripId),tripCompleted=updated?.status==='completed';if(tripCompleted){Audit.log('trip_completed',`完整行程完成：${updated.passengerSummary}`,{tripId,actorUserId});updated.bookingIds.forEach(id=>{const b=Booking.get(id);if(b)Notification.queue({organizationId:updated.organizationId,recipientId:b.recipientId,channel:'line',template:'trip_completed',eventType:'TRIP_COMPLETED',payload:{tripId}});});}return {ok:true,timing,final:tripCompleted,pendingCompletion:!!updated?.completionPending,trip:updated};
    }finally{releaseTripMutationLock(lock);}
  },
  completeCurrentStep(tripId,actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};if(options.idempotencyKey&&tripMutationReceipt(trip,options.idempotencyKey))return {ok:true,duplicate:true,trip,final:trip.status==='completed'};const step=this.currentStep(trip);if(!step)return {ok:false,error:'沒有可完成的步驟'};const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;if(trip.status==='interrupted')return {ok:false,error:'此行程已中斷，需由調度完成處理並恢復後才能繼續執行步驟'};if(['completed','cancelled','aborted'].includes(trip.status))return {ok:false,error:'此行程已完成、取消或終止，不能再執行步驟'};if(trip.status==='scheduled'){const window=tripExecutionWindowState(trip);if(!window.ok)return {ok:false,tooEarly:true,error:window.error,executionWindow:window};}
      const expectedRevision=options.expectedRevision??trip.revision,expectedStepId=options.expectedStepId||step.id,idempotencyKey=options.idempotencyKey||makeTripMutationKey('complete_step',tripId,expectedStepId,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,expectedStepId,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip,final:trip.status==='completed'}:guard;
      if(step.type==='pickup'){const p=validatePassengerStateForStep(trip,step,'onboard');if(!p.ok)return p;}if(step.type==='dropoff'){const p=validatePassengerStateForStep(trip,step,'dropped_off');if(!p.ok)return p;}
      const timestamp=nowISO(),timing=this.classifyTiming(step,timestamp);let final=false,result={ok:false,error:'Stop 執行失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,expectedStepId,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}const s=t.steps[t.currentStepIndex];if(s.type==='pickup')result=applyPassengerStateForStepInDb(db,t,s,'onboard',timestamp,actorUserId,{reason:'pickup_completed'});else if(s.type==='dropoff')result=applyPassengerStateForStepInDb(db,t,s,'dropped_off',timestamp,actorUserId,{reason:'dropoff_completed'});else result={ok:true};if(!result.ok)return;result=completeStopCompatInDb(t,s,timestamp);if(!result.ok)return;appendTripEventInDb(db,{tripId,eventType:'trip_step_completed',at:timestamp,actorUserId,stepId:s.id,reason:'compat_one_tap',metadata:{timing:timing.detail,stopRuntime:tripStopRuntimeSnapshot(s),expectedRevision,idempotencyKey}});const next=t.steps.findIndex(x=>x.status!=='completed');t.currentStepIndex=next<0?t.steps.length:next;final=t.currentStepIndex>=t.steps.length;if(final){const readiness=tripCompletionReadinessInDb(db,t);if(readiness.ok){result=transitionTripInDb(db,t,'completed',{at:timestamp,actorUserId,reason:'all_stops_completed'});t.completionPending=null;}else{if(t.status==='scheduled')transitionTripInDb(db,t,'in_progress',{at:timestamp,actorUserId,reason:'all_stops_completed_pending_requirements'});t.completionPending={at:timestamp,reasons:[...readiness.reasons],proofStepIds:readiness.proofMissing.map(x=>x.stepId),blockingIssueIds:readiness.blockingIssues.map(x=>x.id)};result={ok:true,pendingCompletion:true,readiness};}}else if(t.status==='scheduled')result=transitionTripInDb(db,t,'in_progress',{at:timestamp,actorUserId,reason:'first_stop_completed'});else result={ok:true};if(result.ok)finalizeTripMutationInDb(t,{key:idempotencyKey,action:'complete_step',at:timestamp,actorUserId,stepId:s.id,db});});
      if(!result.ok)return result;Audit.log('trip_step_completed',`完成${PHASE_LABELS[step.type]}：${step.name}（${timing.detail}）`,{tripId,stepId:step.id,actorUserId,stopRuntime:true});const updated=this.get(tripId),tripCompleted=updated?.status==='completed';if(tripCompleted){Audit.log('trip_completed',`完整行程完成：${updated.passengerSummary}`,{tripId,actorUserId});updated.bookingIds.forEach(id=>{const b=Booking.get(id);if(b)Notification.queue({organizationId:updated.organizationId,recipientId:b.recipientId,channel:'line',template:'trip_completed',eventType:'TRIP_COMPLETED',payload:{tripId}});});}return {ok:true,timing,final:tripCompleted,pendingCompletion:!!updated?.completionPending,trip:updated};
    }finally{releaseTripMutationLock(lock);}
  },
  undoLastStep(tripId,actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};if(options.idempotencyKey&&tripMutationReceipt(trip,options.idempotencyKey))return {ok:true,duplicate:true,trip};const formalCorrection=options.formalCorrection===true,correctionReason=String(options.correctionReason||'').trim(),canManage=!!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId);if(formalCorrection){if(trip.status!=='completed')return {ok:false,error:'正式修正 只適用於已完成 Trip'};if(!canManage)return {ok:false,error:'只有調度員或負責人可以執行正式修正'};if(correctionReason.length<4)return {ok:false,error:'正式修正 請填寫至少 4 個字的修正原因'};}else{const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;}if(trip.status==='interrupted')return {ok:false,error:'中斷中的行程不能 Undo，請先由調度完成事故處理'};if(['cancelled','aborted'].includes(trip.status))return {ok:false,error:'已取消或終止行程不能返回步驟'};if(trip.status==='completed'&&!formalCorrection){const correction=tripCompletedCorrectionAvailability(trip,actorUserId);if(!correction.ok)return correction;}
      const index=Math.max(0,Math.min(trip.currentStepIndex-1,trip.steps.length-1)),step=trip.steps[index];if(!step?.actualAt&&!step?.completedAt)return {ok:false,error:'沒有可返回的步驟'};
      const expectedRevision=options.expectedRevision??trip.revision,expectedStepId=options.expectedStepId||step.id,idempotencyKey=options.idempotencyKey||makeTripMutationKey('undo_step',tripId,expectedStepId,expectedRevision),receipt=tripMutationReceipt(trip,idempotencyKey);if(receipt)return {ok:true,duplicate:true,trip};if(Number(expectedRevision)!==Number(trip.revision))return {ok:false,stale:true,error:'此行程已更新，請重新整理後再返回上一步'};
      const correctedAt=nowISO(),correctionReasonCode=formalCorrection?'formal_dispatch_correction':'undo_last_stop';let result={ok:true},correctionEvent=null;
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);if(Number(t.revision)!==Number(expectedRevision)){result={ok:false,stale:true,error:'此行程已被其他操作更新，已阻擋重複 Undo'};return;}const s=t.steps[index];if(s?.id!==expectedStepId){result={ok:false,stale:true,error:'可返回的 Stop 已改變，已阻擋舊畫面 Undo'};return;}const active=tripEventHistoryFromDb(db,tripId,{includeCorrected:false});const targetEventIds=active.filter(e=>e.stepId===s.id&&['trip_stop_milestone','trip_step_completed','trip_stop_runtime_migrated','trip_passenger_state_changed'].includes(e.eventType)).map(e=>e.id);normalizeTripProofs(t);const supersededProofs=(t.serviceProofs||[]).filter(p=>p.stepId===s.id&&p.status!=='superseded');const supersededProofIds=supersededProofs.map(p=>p.id);if(supersededProofIds.length){active.filter(e=>e.eventType==='trip_proof_of_service_captured'&&supersededProofIds.includes(e.metadata?.proofId)).forEach(e=>targetEventIds.push(e.id));supersededProofs.forEach(p=>{p.status='superseded';p.supersededAt=correctedAt;p.supersededByUserId=actorUserId||null;p.supersededReason=correctionReasonCode;});}if(t.status==='completed'){const stateEvent=[...active].reverse().find(e=>e.eventType==='trip_state_transitioned'&&e.metadata?.to==='completed');if(stateEvent)targetEventIds.push(stateEvent.id);}else if(index===0&&t.status==='in_progress'){const stateEvent=[...active].reverse().find(e=>e.eventType==='trip_state_transitioned'&&e.metadata?.to==='in_progress');if(stateEvent)targetEventIds.push(stateEvent.id);}const before=tripStopRuntimeSnapshot(s),beforePassengers=deepClone(t.passengers||[]),previousTripStatus=t.status,target=index===0?'scheduled':'in_progress';s.arrivedAt=null;s.serviceStartedAt=null;s.passengerBoardedAt=null;s.passengerDroppedOffAt=null;s.departedAt=null;s.completedAt=null;s.actualAt=null;s.status='pending';t.currentStepIndex=index;t.completedAt=null;t.completionPending=null;t.updatedAt=correctedAt;rebuildTripPassengerProjection(t);if(t.status!==target)result=transitionTripInDb(db,t,target,{at:correctedAt,actorUserId,reason:correctionReasonCode,correction:true});if(!result.ok)return;correctionEvent=appendTripEventInDb(db,{tripId,eventType:'trip_event_corrected',at:correctedAt,actorUserId,stepId:s.id,reason:correctionReasonCode,targetEventIds:[...new Set(targetEventIds)],metadata:{action:formalCorrection?'formal_completed_trip_correction':'undo_step_completion',correctionMode:formalCorrection?'manager_formal':'driver_limited',correctionReason:formalCorrection?correctionReason:'',previousTripStatus,targetTripStatus:target,before,beforePassengers,afterPassengers:deepClone(t.passengers||[]),supersededProofIds,expectedRevision,idempotencyKey}});if(supersededProofs.length){supersededProofs.forEach(p=>{p.supersededByCorrectionEventId=correctionEvent?.id||null;queueTripOfflineMutationInDb(db,{tripId,mutationType:'trip_proof_of_service_superseded',referenceId:p.id,payload:deepClone(p),queuedAt:correctedAt});});appendTripEventInDb(db,{tripId,eventType:'trip_proof_of_service_superseded',at:correctedAt,actorUserId,stepId:s.id,reason:correctionReasonCode,metadata:{proofIds:supersededProofIds,correctionEventId:correctionEvent?.id||null,correctionMode:formalCorrection?'manager_formal':'driver_limited',correctionReason:formalCorrection?correctionReason:''}});}finalizeTripMutationInDb(t,{key:idempotencyKey,action:formalCorrection?'formal_correction':'undo_step',at:correctedAt,actorUserId,stepId:s.id,db});result={ok:true,supersededProofIds};});
      if(!result.ok)return result;Audit.log(formalCorrection?'trip_formal_correction':'trip_step_undone',`${formalCorrection?'正式修正':'撤銷'}${PHASE_LABELS[step.type]}：${step.name}${formalCorrection?`｜${correctionReason}`:''}`,{tripId,stepId:step.id,actorUserId,correction:true,formalCorrection,correctionReason:formalCorrection?correctionReason:'',tripEventId:correctionEvent?.id||null});return {ok:true,trip:this.get(tripId),correctionEvent,supersededProofIds:result.supersededProofIds||[]};
    }finally{releaseTripMutationLock(lock);}
  },
  interrupt(tripId,actorUserId,{issueId=null,reason='現場異常需暫停行程',expectedRevision=null,idempotencyKey=null}={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};
      if(!actorUserId||!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId))return {ok:false,error:'只有調度員或負責人可以中斷進行中的 Trip'};
      if(trip.status!=='in_progress')return {ok:false,error:'只有進行中的 Trip 可以進入中斷狀態'};
      const issue=issueId?(store.state.issues||[]).find(i=>i.id===issueId):null;if(issueId&&(!issue||issue.tripId!==tripId))return {ok:false,error:'指定 Issue 不屬於此 Trip'};if(issue?.status==='resolved')return {ok:false,error:'已結案 Issue 不能再用來中斷 Trip'};
      const revision=expectedRevision??trip.revision,key=idempotencyKey||makeTripMutationKey('interrupt',tripId,issueId||'manual',revision),guard=checkTripMutationGuard(trip,{expectedRevision:revision,idempotencyKey:key});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;
      const at=nowISO();let result={ok:false,error:'中斷失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision:revision,idempotencyKey:key});if(!g.ok||g.duplicate){result=g;return;}result=transitionTripInDb(db,t,'interrupted',{at,actorUserId,reason,issueId,metadata:{action:'interrupt'}});if(result.ok)finalizeTripMutationInDb(t,{key,action:'interrupt',at,actorUserId,stepId:t.steps?.[t.currentStepIndex]?.id||null,db});});
      if(!result.ok)return result;Audit.log('trip_interrupted',`中斷行程 ${trip.code}：${reason}`,{tripId,issueId,actorUserId,organizationId:trip.organizationId});const current=this.get(tripId),driver=Organization.driver(current.driverId);if(driver?.userId)Notification.queue({organizationId:current.organizationId,recipientId:driver.userId,channel:'line',template:'trip_interrupted',eventType:'trip_interrupted',payload:{tripId,tripCode:current.code,reason,issueId}});return {ok:true,trip:current};
    }finally{releaseTripMutationLock(lock);}
  },
  handoverResources(tripId,{driverId,vehicleId,issueId=null,note='資源交接'},actorUserId,options={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};
      if(!actorUserId||!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId))return {ok:false,error:'只有調度員或負責人可以執行中途資源交接'};
      if(trip.status!=='interrupted')return {ok:false,error:'只有已中斷的 Trip 可以換車／換司機'};
      if(driverId===trip.driverId&&vehicleId===trip.vehicleId)return {ok:false,error:'新司機與新車輛都與目前資源相同，沒有需要交接'};
      const issue=issueId?(store.state.issues||[]).find(i=>i.id===issueId):null;if(issueId&&(!issue||issue.tripId!==tripId))return {ok:false,error:'指定 Issue 不屬於此 Trip'};if(issue?.status==='resolved')return {ok:false,error:'已結案 Issue 不能作為交接原因'};
      const at=nowISO(),window=tripRemainingResourceWindow(trip,at),remainingPassengers=(trip.passengers||[]).filter(p=>!tripPassengerTerminal(p.status)),handoverManifest=handoverManifestForTrip(trip),passengerUnits=Math.max(1,remainingPassengers.reduce((sum,p)=>sum+Math.max(1,Number(p.seatUnits)||1),0)),wheelchairUnits=remainingPassengers.reduce((sum,p)=>sum+Math.max(0,Number(p.wheelchairUnits)||0),0);
      const resource=Organization.validateTripResourceAssignment({organizationId:trip.organizationId,driverId,vehicleId,startAt:window.start,endAt:window.end,needs:trip.needs||'',passengerUnits,wheelchairUnits,ignoreTripId:tripId,actorUserId,requireActor:true});if(!resource.ok)return resource;
      const expectedRevision=options.expectedRevision??trip.revision,idempotencyKey=options.idempotencyKey||makeTripMutationKey('handover',tripId,`${driverId}:${vehicleId}`,expectedRevision),guard=checkTripMutationGuard(trip,{expectedRevision,idempotencyKey});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;
      let result={ok:false,error:'資源交接失敗'},oldDriverId=trip.driverId,oldVehicleId=trip.vehicleId;
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision,idempotencyKey});if(!g.ok||g.duplicate){result=g;return;}if(t.status!=='interrupted'){result={ok:false,error:'Trip 已不在中斷狀態，已阻擋舊畫面交接'};return;}oldDriverId=t.driverId;oldVehicleId=t.vehicleId;const manifestCheck=validateHandoverManifest(t,handoverManifest);if(!manifestCheck.ok){result=manifestCheck;return;}t.driverId=driverId;t.vehicleId=vehicleId;const segment=ensureTripResourceSegment(t,{driverId,vehicleId,assignedAt:at,source:'interruption_handover',issueId});t.pendingHandover={active:true,at,issueId,from:{driverId:oldDriverId,vehicleId:oldVehicleId},to:{driverId,vehicleId},manifest:deepClone(handoverManifest),note:String(note||'').trim()};appendTripEventInDb(db,{tripId,eventType:'trip_resource_handed_over',at,actorUserId,stepId:t.steps?.[t.currentStepIndex]?.id||null,reason:note,metadata:{issueId,from:{driverId:oldDriverId,vehicleId:oldVehicleId},to:{driverId,vehicleId},segment:deepClone(segment),handoverManifest:deepClone(handoverManifest),remainingPassengerUnits:passengerUnits,remainingWheelchairUnits:wheelchairUnits,expectedRevision,idempotencyKey}});finalizeTripMutationInDb(t,{key:idempotencyKey,action:'handover',at,actorUserId,stepId:t.steps?.[t.currentStepIndex]?.id||null,db});result={ok:true};});
      if(!result.ok)return result;const updated=this.get(tripId),oldDriver=Organization.driver(oldDriverId),newDriver=Organization.driver(driverId);Audit.log('trip_resource_handed_over',`${updated.code} 中途交接：${oldDriver?.name||oldDriverId} → ${newDriver?.name||driverId}`,{tripId,issueId,oldDriverId,newDriverId:driverId,oldVehicleId,newVehicleId:vehicleId,actorUserId});if(oldDriver?.userId&&oldDriver.userId!==newDriver?.userId)Notification.queue({organizationId:updated.organizationId,recipientId:oldDriver.userId,channel:'line',template:'trip_handover_released',eventType:'trip_handover_released',payload:{tripId,tripCode:updated.code,note,newDriverId:driverId,newVehicleId:vehicleId}});if(newDriver?.userId)Notification.queue({organizationId:updated.organizationId,recipientId:newDriver.userId,channel:'line',template:'trip_handover_assigned',eventType:'trip_handover_assigned',payload:{tripId,tripCode:updated.code,note,oldDriverId,oldVehicleId}});for(const bid of updated.bookingIds||[]){const b=Booking.get(bid);const recipientId=b?.requestedByUserId||b?.recipientId;if(recipientId)Notification.queue({organizationId:updated.organizationId,recipientId,channel:'line',template:'trip_handover_updated',eventType:'trip_handover_updated',payload:{tripId,tripCode:updated.code,note}});}return {ok:true,trip:updated,oldDriverId,oldVehicleId};
    }finally{releaseTripMutationLock(lock);}
  },
  resume(tripId,actorUserId,{issueId=null,reason='異常排除，恢復行程',expectedRevision=null,idempotencyKey=null}={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};if(!actorUserId||!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId))return {ok:false,error:'只有調度員或負責人可以恢復中斷 Trip'};if(trip.status!=='interrupted')return {ok:false,error:'只有已中斷 Trip 可以恢復'};
      if(trip.pendingHandover?.active){const manifestCheck=validateHandoverManifest(trip,trip.pendingHandover.manifest||[]);if(!manifestCheck.ok)return manifestCheck;}
      const window=tripRemainingResourceWindow(trip,nowISO()),remainingPassengers=(trip.passengers||[]).filter(p=>!tripPassengerTerminal(p.status)),resource=Organization.validateTripResourceAssignment({organizationId:trip.organizationId,driverId:trip.driverId,vehicleId:trip.vehicleId,startAt:window.start,endAt:window.end,needs:trip.needs||'',passengerUnits:Math.max(1,remainingPassengers.reduce((sum,p)=>sum+Math.max(1,Number(p.seatUnits)||1),0)),wheelchairUnits:remainingPassengers.reduce((sum,p)=>sum+Math.max(0,Number(p.wheelchairUnits)||0),0),ignoreTripId:tripId,actorUserId,requireActor:true});if(!resource.ok)return resource;
      const revision=expectedRevision??trip.revision,key=idempotencyKey||makeTripMutationKey('resume',tripId,trip.currentStepIndex,revision),guard=checkTripMutationGuard(trip,{expectedRevision:revision,idempotencyKey:key});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;const at=nowISO();let result={ok:false,error:'恢復失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision:revision,idempotencyKey:key});if(!g.ok||g.duplicate){result=g;return;}result=transitionTripInDb(db,t,'in_progress',{at,actorUserId,reason,issueId,metadata:{action:'resume',handoverValidated:!!t.pendingHandover?.active}});if(result.ok){if(t.pendingHandover?.active){t.pendingHandover.active=false;t.pendingHandover.resumedAt=at;t.pendingHandover.resumedBy=actorUserId;}finalizeTripMutationInDb(t,{key,action:'resume',at,actorUserId,stepId:t.steps?.[t.currentStepIndex]?.id||null,db});}});if(!result.ok)return result;const updated=this.get(tripId),driver=Organization.driver(updated.driverId);Audit.log('trip_resumed',`恢復行程 ${updated.code}`,{tripId,issueId,actorUserId});if(driver?.userId)Notification.queue({organizationId:updated.organizationId,recipientId:driver.userId,channel:'line',template:'trip_resumed',eventType:'trip_resumed',payload:{tripId,tripCode:updated.code,reason}});return {ok:true,trip:updated};
    }finally{releaseTripMutationLock(lock);}
  },
  abort(tripId,actorUserId,{issueId=null,reason='中途異常無法繼續',reasonCode=null,expectedRevision=null,idempotencyKey=null}={}){
    const lock=acquireTripMutationLock(tripId,actorUserId);if(!lock.ok)return lock;
    try{
      store.refreshFromStorage?.();const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};if(!actorUserId||!Identity?.canUser?.(actorUserId,'trip.manage',trip.organizationId))return {ok:false,error:'只有調度員或負責人可以終止中斷 Trip'};if(trip.status!=='interrupted')return {ok:false,error:'只有已中斷 Trip 可以正式終止'};const revision=expectedRevision??trip.revision,key=idempotencyKey||makeTripMutationKey('abort',tripId,issueId||'manual',revision),guard=checkTripMutationGuard(trip,{expectedRevision:revision,idempotencyKey:key});if(!guard.ok||guard.duplicate)return guard.duplicate?{ok:true,duplicate:true,trip}:guard;const at=nowISO();let result={ok:false,error:'終止失敗'};
      store.mutate(db=>{const t=db.trips.find(x=>x.id===tripId);normalizeTripRuntime(t);const g=checkTripMutationGuard(t,{expectedRevision:revision,idempotencyKey:key});if(!g.ok||g.duplicate){result=g;return;}result=transitionTripInDb(db,t,'aborted',{at,actorUserId,reason,reasonCode:reasonCode||inferTripReasonCode(reason),issueId,metadata:{action:'abort'}});if(result.ok)finalizeTripMutationInDb(t,{key,action:'abort',at,actorUserId,stepId:t.steps?.[t.currentStepIndex]?.id||null,db});});if(!result.ok)return result;const updated=this.get(tripId),driver=Organization.driver(updated.driverId);Audit.log('trip_aborted',`終止行程 ${updated.code}：${reason}`,{tripId,issueId,actorUserId});if(driver?.userId)Notification.queue({organizationId:updated.organizationId,recipientId:driver.userId,channel:'line',template:'trip_aborted',eventType:'trip_aborted',payload:{tripId,tripCode:updated.code,reason}});for(const bid of updated.bookingIds||[]){const b=Booking.get(bid),recipientId=b?.requestedByUserId||b?.recipientId;if(recipientId)Notification.queue({organizationId:updated.organizationId,recipientId,channel:'line',template:'trip_aborted',eventType:'trip_aborted',payload:{tripId,tripCode:updated.code,reason}});}return {ok:true,trip:updated};
    }finally{releaseTripMutationLock(lock);}
  },
  reportIssue({tripId,driverId,type,note,actorUserId}){
    const trip=this.get(tripId);if(!trip)return {ok:false,error:'找不到行程'};
    const access=tripExecutionAccess(trip,actorUserId);if(!access.ok)return access;
    if(driverId&&driverId!==trip.driverId)return {ok:false,error:'回報司機與本趟指派司機不一致'};
    if(!String(type||'').trim())return {ok:false,error:'請選擇或輸入異常類型'};
    if(isTripTerminalStatus(trip.status))return {ok:false,error:'已完成、取消或終止 Trip 不能再新增現場異常'};
    const step=this.currentStep(trip),createdAt=nowISO(),severity=classifyIssueSeverity(type),issue={id:uid('iss'),schemaVersion:ISSUE_SCHEMA_VERSION,organizationId:trip.organizationId,tripId,stepId:step?.id||null,driverId:trip.driverId,type:String(type).trim(),note:note||'',severity,requiresDispatch:['critical','emergency'].includes(severity)||/車輛|交通事故|突發送醫/.test(type||''),status:'open',createdAt,updatedAt:createdAt,ackSlaMinutes:issueSlaMinutes(severity),ackDueAt:addMinutes(new Date(createdAt),issueSlaMinutes(severity)).toISOString(),acknowledgedAt:null,acknowledgedBy:null,handlingAt:null,handlingBy:null,resolvedAt:null,resolvedBy:null,resolutionCode:null,resolutionNote:''};
    store.mutate(db=>{db.issues.unshift(issue);queueTripOfflineMutationInDb(db,{tripId,mutationType:'trip_issue_reported',referenceId:issue.id,payload:issue,queuedAt:issue.createdAt});appendTripEventInDb(db,{tripId,eventType:'trip_issue_reported',at:issue.createdAt,actorUserId,stepId:step?.id||null,reason:issue.type,metadata:{issueId:issue.id,note:issue.note,severity:issue.severity,requiresDispatch:issue.requiresDispatch}});}); Audit.log('issue_reported',`回報異常：${issue.type}`,{tripId,driverId:trip.driverId,issueId:issue.id,severity,actorUserId}); return {ok:true,issue};
  },
  acknowledgeIssue(issueId,userId){
    const issue=(store.state.issues||[]).find(x=>x.id===issueId);if(!issue)return {ok:false,error:'找不到異常'};normalizeIssueRuntime(issue);if(!userId||!Identity?.canUser?.(userId,'issue.manage',issue.organizationId))return {ok:false,error:'你沒有處理此異常的權限'};let result={ok:false,error:'接手失敗'};store.mutate(db=>{result=transitionIssueInDb(db,issueId,'acknowledged',{actorUserId:userId,reason:'dispatcher_acknowledged'});});if(result.ok)Audit.log('issue_acknowledged',`接手異常 ${issueId}`,{issueId,actorUserId:userId,organizationId:issue.organizationId});return result;
  },
  startIssueHandling(issueId,userId){
    const issue=(store.state.issues||[]).find(x=>x.id===issueId);if(!issue)return {ok:false,error:'找不到異常'};normalizeIssueRuntime(issue);if(!userId||!Identity?.canUser?.(userId,'issue.manage',issue.organizationId))return {ok:false,error:'你沒有處理此異常的權限'};let result={ok:false,error:'開始處理失敗'};store.mutate(db=>{result=transitionIssueInDb(db,issueId,'handling',{actorUserId:userId,reason:'handling_started'});});if(result.ok)Audit.log('issue_handling_started',`開始處理異常 ${issueId}`,{issueId,actorUserId:userId,organizationId:issue.organizationId});return result;
  },
  resolveIssue(issueId,userId,{resolutionCode='other',resolutionNote=''}={}){
    const issue=(store.state.issues||[]).find(x=>x.id===issueId);if(!issue)return {ok:false,error:'找不到異常'};normalizeIssueRuntime(issue);if(!userId||!Identity?.canUser?.(userId,'issue.manage',issue.organizationId))return {ok:false,error:'你沒有處理此異常的權限'};if(issue.status!=='handling')return {ok:false,error:'Issue 必須先接手並進入處理中，才能結案'};const linkedTrip=this.get(issue.tripId);if(linkedTrip?.status==='interrupted')return {ok:false,error:'Trip 仍在中斷狀態，請先恢復或終止 Trip，再結案 Issue'};if(!String(resolutionNote||'').trim())return {ok:false,error:'請填寫結案說明'};let result={ok:false,error:'結案失敗'};store.mutate(db=>{result=transitionIssueInDb(db,issueId,'resolved',{actorUserId:userId,reason:'issue_resolved',resolutionCode,resolutionNote});if(result.ok){const t=(db.trips||[]).find(x=>x.id===issue.tripId);if(t){normalizeTripRuntime(t);const readiness=tripCompletionReadinessInDb(db,t);if(t.currentStepIndex>=t.steps.length&&t.status==='in_progress'&&readiness.ok){const completedAt=nowISO(),moved=transitionTripInDb(db,t,'completed',{at:completedAt,actorUserId:userId,reason:'blocking_issues_resolved'});if(moved.ok){t.completionPending=null;bumpTripRevisionInDb(t,completedAt,db,'blocking_issue_resolved_auto_complete');result.tripAutoCompleted=true;}}}}});if(result.ok){Audit.log('issue_resolved',`處理異常 ${issueId}`,{issueId,resolutionCode,actorUserId:userId,organizationId:issue.organizationId});if(result.tripAutoCompleted){const updated=this.get(issue.tripId);Audit.log('trip_completed',`完整行程完成：${updated?.passengerSummary||''}`,{tripId:issue.tripId,actorUserId:userId,completionSource:'issue_resolved'});for(const id of updated?.bookingIds||[]){const b=Booking.get(id);if(b)Notification.queue({organizationId:updated.organizationId,recipientId:b.recipientId,channel:'line',template:'trip_completed',eventType:'TRIP_COMPLETED',payload:{tripId:updated.id}});}}}return result;
  },
  issueStatusLabel,issueSeverityLabel,issueStatusClass,issueSeverityClass,issueSlaState,
  proofRequirements(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(tripProofRequirementRows(trip));},
  completionReadiness(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);const r=tripCompletionReadinessInDb(store.state,trip);return {ok:r.ok,reasons:[...r.reasons],proofMissing:r.proofMissing.map(x=>({stepId:x.stepId,requireGps:x.requireGps,requirePhoto:x.requirePhoto})),blockingIssueIds:r.blockingIssues.map(x=>x.id)};},
  invariantReport(tripOrId){const trip=typeof tripOrId==='string'?this.get(tripOrId):normalizeTripRuntime(tripOrId);return deepClone(tripInvariantReportInDb(store.state,trip));},
  inferReasonCode(text=''){return inferTripReasonCode(text);},
  eventHistory(tripId,{includeCorrected=true}={}){ return tripEventHistoryFromDb(store.state,tripId,{includeCorrected}); },
  effectiveEventHistory(tripId){ return tripEventHistoryFromDb(store.state,tripId,{includeCorrected:false}); },
  async initialize(){
    if(tripInitializationPromise)return tripInitializationPromise;
    tripInitializationPromise=(async()=>{
      const device=await hydrateTripDeviceIdentityFromIdb();
      const runtime=this.migrateRuntimeModel();
      const events=this.migrateEventHistory();
      const passengers=this.migratePassengerRuntimeHistory();
      const issues=this.migrateIssueStateModel();
      const legacyProof=await this.migrateLegacyProofPhotos();
      const outbox=await this.hydrateOutbox();
      const retention=await this.cleanupRetention();
      const sync=!tripAppOffline()?await this.syncOfflineQueue():{ok:false,offline:true,pending:this.offlineQueue().length};
      return {ok:true,device,runtime,events,passengers,issues,legacyProof,outbox,retention,sync};
    })().catch(error=>({ok:false,error:String(error?.message||error)}));
    return tripInitializationPromise;
  },
  migrateEventHistory(){
    const trips=store.state.trips||[],known=new Set((store.state.tripEvents||[]).map(e=>e.tripId));
    const pending=trips.filter(t=>!known.has(t.id));if(!pending.length)return {ok:true,changed:0};
    let changed=0;
    store.mutate(db=>{
      db.tripEvents=Array.isArray(db.tripEvents)?db.tripEvents:[];
      for(const t of db.trips||[]){
        if((db.tripEvents||[]).some(e=>e.tripId===t.id))continue;
        normalizeTripRuntime(t);
        appendTripEventInDb(db,{tripId:t.id,eventType:'trip_history_migrated',at:t.createdAt||t.updatedAt||nowISO(),actorUserId:null,reason:'v12_25_32_baseline',metadata:{status:t.status,currentStepIndex:t.currentStepIndex,runtimeSchemaVersion:t.runtimeSchemaVersion}});
        for(const step of t.steps||[]){
          normalizeTripStopRuntime(step);
          const runtime=tripStopRuntimeSnapshot(step);
          if(step.completedAt||step.actualAt)appendTripEventInDb(db,{tripId:t.id,eventType:'trip_step_completed',at:step.completedAt||step.actualAt,actorUserId:null,stepId:step.id,reason:'migration_baseline',metadata:{migrated:true,stopRuntime:runtime}});
          else if(step.arrivedAt||step.serviceStartedAt||step.passengerBoardedAt||step.passengerDroppedOffAt||step.departedAt)appendTripEventInDb(db,{tripId:t.id,eventType:'trip_stop_runtime_migrated',at:step.departedAt||step.passengerDroppedOffAt||step.passengerBoardedAt||step.serviceStartedAt||step.arrivedAt||t.updatedAt||nowISO(),actorUserId:null,stepId:step.id,reason:'migration_baseline',metadata:{migrated:true,stopRuntime:runtime}});
        }
        if((t.passengers||[]).length)appendTripEventInDb(db,{tripId:t.id,eventType:'trip_passenger_runtime_migrated',at:t.updatedAt||t.createdAt||nowISO(),actorUserId:null,reason:'migration_baseline',metadata:{passengers:deepClone(t.passengers)}});
        if(t.status!=='scheduled')appendTripEventInDb(db,{tripId:t.id,eventType:'trip_state_migrated',at:t.stateChangedAt||t.updatedAt||nowISO(),actorUserId:null,reason:'migration_baseline',metadata:{status:t.status}});
        changed++;
      }
    });
    return {ok:true,changed};
  },
  migratePassengerRuntimeHistory(){
    const pending=(store.state.trips||[]).filter(t=>(t.passengers||[]).length&&!(store.state.tripEvents||[]).some(e=>e.tripId===t.id&&['trip_passenger_runtime_migrated','trip_passenger_state_changed'].includes(e.eventType)));
    if(!pending.length)return {ok:true,changed:0};let changed=0;
    store.mutate(db=>{for(const t of db.trips||[]){normalizeTripRuntime(t);if(!(t.passengers||[]).length||(db.tripEvents||[]).some(e=>e.tripId===t.id&&['trip_passenger_runtime_migrated','trip_passenger_state_changed'].includes(e.eventType)))continue;appendTripEventInDb(db,{tripId:t.id,eventType:'trip_passenger_runtime_migrated',at:t.updatedAt||t.createdAt||nowISO(),actorUserId:null,reason:'v12_25_33_passenger_baseline',metadata:{passengers:deepClone(t.passengers)}});changed++;}});
    return {ok:true,changed};
  },
  migrateRuntimeModel(){
    const needs=(store.state.trips||[]).some(t=>t.runtimeSchemaVersion!==TRIP_RUNTIME_SCHEMA_VERSION||!Array.isArray(t.passengers)||!Array.isArray(t.resourceSegments)||!Array.isArray(t.executionSnapshots)||!t.executionSnapshots.length||!Array.isArray(t.serviceProofs)||!Array.isArray(t.locationSamples)||t.liveNavigation?.schemaVersion!==TRIP_NAVIGATION_SCHEMA_VERSION||t.actualMetrics?.schemaVersion!==TRIP_ACTUAL_METRICS_SCHEMA_VERSION||!Number.isFinite(Number(t.revision))||(t.steps||[]).some((s,i)=>s.schemaVersion!==TRIP_RUNTIME_SCHEMA_VERSION||!('completedAt' in s)||!('sequence' in s)));
    if(!needs)return {ok:true,changed:0};
    let changed=0;store.mutate(db=>(db.trips||[]).forEach(t=>{normalizeTripRuntime(t);if(!(t.executionSnapshots||[]).length)appendTripExecutionSnapshotInDb(db,t,{source:'migration_baseline',capturedAt:nowISO(),actorUserId:null,reason:'V12.25.36 建立行程 Runtime / Snapshot 基準',emitEvent:false});rebuildTripActualMetrics(t);changed++;}));
    return {ok:true,changed};
  },
  migrateIssueStateModel(){const pending=(store.state.issues||[]).some(i=>i.schemaVersion!==ISSUE_SCHEMA_VERSION||!ISSUE_STATUSES.includes(i.status)||!i.severity);if(!pending)return {ok:true,changed:0};let changed=0;store.mutate(db=>(db.issues||[]).forEach(i=>{normalizeIssueRuntime(i);changed++;}));return {ok:true,changed};},
  issues(organizationId){ return store.state.issues.filter(i=>i.organizationId===organizationId).map(normalizeIssueRuntime); }
};
}


{
const BENEFIT_RULESET_SCHEMA_VERSION=1;
const BENEFIT_ASSESSMENT_SCHEMA_VERSION=2;
const BENEFIT_SNAPSHOT_SCHEMA_VERSION=2;
const BENEFIT_DEFAULT_PROGRAM_CODE='transportation_primary';
const BENEFIT_RULESET_STATUSES=Object.freeze(['draft','published','retired']);
const BENEFIT_ASSESSMENT_STATUSES=Object.freeze(['eligible_estimate','not_eligible','insufficient_data','ruleset_required']);
const BENEFIT_CALCULATION_MODES=Object.freeze(['fixed_amount','percentage','none']);

function benefitDateOnly(value){
  const s=String(value||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const d=s?new Date(s):null;return d&&!Number.isNaN(d.getTime())?dateKey(d):null;
}
function benefitBoolOrNull(value){return value===true||value==='true'?true:value===false||value==='false'?false:null;}
function benefitNumberOrNull(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function benefitStringArray(value){
  const values=Array.isArray(value)?value:String(value||'').split(/[,，、\s]+/);
  return [...new Set(values.map(v=>String(v||'').trim()).filter(Boolean))];
}
function benefitCmsLevels(value){return [...new Set(benefitStringArray(value).map(Number).filter(v=>Number.isInteger(v)&&v>=1&&v<=8))].sort((a,b)=>a-b);}
function benefitSourceSnapshot(source={}){return {agency:String(source.agency||'').trim(),title:String(source.title||'').trim(),url:String(source.url||'').trim(),publishedAt:benefitDateOnly(source.publishedAt),checkedAt:benefitDateOnly(source.checkedAt)};}
function benefitJurisdictionSnapshot(j={}){return {country:String(j.country||'TW').trim().toUpperCase()||'TW',city:String(j.city||'').trim()||null};}
function benefitConditionsSnapshot(c={}){return {cmsLevels:benefitCmsLevels(c.cmsLevels),requireApprovedCarePlan:benefitBoolOrNull(c.requireApprovedCarePlan),requireTransportationApproved:benefitBoolOrNull(c.requireTransportationApproved),identityCategories:benefitStringArray(c.identityCategories),residenceCities:benefitStringArray(c.residenceCities)};}
function benefitCalculationSnapshot(c={}){
  const mode=BENEFIT_CALCULATION_MODES.includes(c.mode)?c.mode:'none';
  return {mode,currency:String(c.currency||'TWD').trim().toUpperCase()||'TWD',amount:benefitNumberOrNull(c.amount),percentage:benefitNumberOrNull(c.percentage),maxAmount:benefitNumberOrNull(c.maxAmount)};
}
function normalizeBenefitRuleset(input={},existing=null){
  const now=nowISO();return {
    id:existing?.id||input.id||uid('brule'),schemaVersion:BENEFIT_RULESET_SCHEMA_VERSION,
    code:String(input.code??existing?.code??BENEFIT_DEFAULT_PROGRAM_CODE).trim()||Benefit.constants.defaultProgramCode,
    version:String(input.version??existing?.version??'').trim(),name:String(input.name??existing?.name??'').trim(),serviceType:String(input.serviceType??existing?.serviceType??'transportation').trim()||'transportation',
    jurisdiction:benefitJurisdictionSnapshot(input.jurisdiction??existing?.jurisdiction??{}),effectiveFrom:benefitDateOnly(input.effectiveFrom??existing?.effectiveFrom),effectiveTo:benefitDateOnly(input.effectiveTo??existing?.effectiveTo),
    status:BENEFIT_RULESET_STATUSES.includes(existing?.status)?existing.status:'draft',source:benefitSourceSnapshot(input.source??existing?.source??{}),conditions:benefitConditionsSnapshot(input.conditions??existing?.conditions??{}),calculation:benefitCalculationSnapshot(input.calculation??existing?.calculation??{}),
    createdByUserId:existing?.createdByUserId||input.createdByUserId||null,createdAt:existing?.createdAt||input.createdAt||now,updatedByUserId:input.updatedByUserId??existing?.updatedByUserId??null,updatedAt:now,publishedByUserId:existing?.publishedByUserId||null,publishedAt:existing?.publishedAt||null,retiredByUserId:existing?.retiredByUserId||null,retiredAt:existing?.retiredAt||null
  };
}
function benefitIntervalOverlap(aFrom,aTo,bFrom,bTo){const a1=aFrom||'0000-01-01',a2=aTo||'9999-12-31',b1=bFrom||'0000-01-01',b2=bTo||'9999-12-31';return a1<=b2&&b1<=a2;}
function benefitRulesetValidation(ruleset,{forPublish=false,allRulesets=[]}={}){
  const errors=[],warnings=[];if(!ruleset) return {ok:false,errors:['找不到 補助規則集'],warnings};
  if(!ruleset.code)errors.push('缺少 program code');if(!ruleset.version)errors.push('缺少 ruleset version');if(!ruleset.name)errors.push('缺少規則名稱');if(ruleset.serviceType!=='transportation')warnings.push('目前 Benefit P0 只針對 transportation 完成主流程驗證');
  if(!ruleset.effectiveFrom)errors.push('缺少 effectiveFrom');if(ruleset.effectiveTo&&ruleset.effectiveFrom&&ruleset.effectiveTo<ruleset.effectiveFrom)errors.push('effectiveTo 不能早於 effectiveFrom');
  const src=ruleset.source||{};if(forPublish){if(!src.agency)errors.push('發布前必須填寫規則來源機關');if(!src.title)errors.push('發布前必須填寫規則來源標題');if(!/^https?:\/\//i.test(src.url||''))errors.push('發布前必須填寫 http/https 官方來源 URL');if(!src.checkedAt)errors.push('發布前必須填寫來源 checkedAt');}
  const calc=ruleset.calculation||{};if(calc.mode==='fixed_amount'&&(calc.amount===null||calc.amount<0))errors.push('fixed_amount 必須設定非負 amount');if(calc.mode==='percentage'){if(calc.percentage===null||calc.percentage<0||calc.percentage>100)errors.push('percentage 必須介於 0–100');if(calc.maxAmount!==null&&calc.maxAmount<0)errors.push('maxAmount 不可為負數');}if(calc.mode==='none')warnings.push('此 Ruleset 只做資格判斷，不會產生補助金額');
  const duplicate=allRulesets.find(x=>x.id!==ruleset.id&&x.code===ruleset.code&&x.version===ruleset.version);if(duplicate)errors.push(`同一 program code 已存在 version ${ruleset.version}`);
  if(forPublish){
    const overlap=allRulesets.find(x=>x.id!==ruleset.id&&x.status==='published'&&x.code===ruleset.code&&x.serviceType===ruleset.serviceType&&String(x.jurisdiction?.country||'TW')===String(ruleset.jurisdiction?.country||'TW')&&String(x.jurisdiction?.city||'')===String(ruleset.jurisdiction?.city||'')&&benefitIntervalOverlap(x.effectiveFrom,x.effectiveTo,ruleset.effectiveFrom,ruleset.effectiveTo));
    if(overlap)errors.push(`與已發布 Ruleset ${overlap.version} 的有效期間重疊`);
  }
  return {ok:!errors.length,errors,warnings};
}
function benefitAppendRulesetEventInDb(db,event){db.benefitRulesetEvents=Array.isArray(db.benefitRulesetEvents)?db.benefitRulesetEvents:[];db.benefitRulesetEvents.unshift({id:uid('bruleevt'),schemaVersion:1,createdAt:nowISO(),...event});}
function benefitAppendAssessmentEventInDb(db,event){db.benefitAssessmentEvents=Array.isArray(db.benefitAssessmentEvents)?db.benefitAssessmentEvents:[];db.benefitAssessmentEvents.unshift({id:uid('bassevt'),schemaVersion:1,createdAt:nowISO(),...event});}
function benefitRuleMatchesDate(r,date){const d=benefitDateOnly(date)||dateKey();return (!r.effectiveFrom||r.effectiveFrom<=d)&&(!r.effectiveTo||r.effectiveTo>=d);}
function benefitRecipientResidenceCity(recipient){try{return locationCity(CareRecipient?.primaryAddress?.(recipient)||'')||null;}catch{return null;}}
function benefitActorIsSuper(actorUserId){return !!store.state.users.find(u=>u.id===actorUserId&&u.active!==false&&u.platformRole==='super_admin');}
function benefitCanReadOwn(actorUserId,recipientId){return !!actorUserId&&!!recipientId&&!!CareRecipient?.relationForUser?.(actorUserId,recipientId)&&!!Identity?.canUser?.(actorUserId,'benefit.assessment.read_own',APP_CONFIG.requesterOrganizationId);}
function benefitCanCreateOwn(actorUserId,recipientId){return !!actorUserId&&!!recipientId&&!!CareRecipient?.relationForUser?.(actorUserId,recipientId)&&!!Identity?.canUser?.(actorUserId,'benefit.assessment.create_own',APP_CONFIG.requesterOrganizationId);}
function benefitCanReadServed(actorUserId,recipientId,organizationId){return !!actorUserId&&!!organizationId&&!!Identity?.canUser?.(actorUserId,'benefit.assessment.read_served',organizationId)&&!!CareRecipient?.canRead?.(recipientId,{actorUserId,organizationId});}
function benefitCanReadServedAny(actorUserId,recipientId){return !!actorUserId&&!!recipientId&&!!Identity?.activeMembershipsForUser?.(actorUserId)?.some(m=>benefitCanReadServed(actorUserId,recipientId,m.organizationId));}
function benefitCanCreateServed(actorUserId,recipientId,organizationId){return !!actorUserId&&!!organizationId&&!!Identity?.canUser?.(actorUserId,'benefit.assessment.create_served',organizationId)&&!!CareRecipient?.canRead?.(recipientId,{actorUserId,organizationId});}
function benefitAssessmentStatusLabel(status){return ({eligible_estimate:'預估符合',not_eligible:'預估不符合',insufficient_data:'資料不足',ruleset_required:'待規則'})[status]||status;}
function benefitResultFromRuleset(ruleset,{recipientId=null,requestedService='transportation',serviceDate=null,facts={}}={}){
  const reasons=[],warnings=[],missing=[],failed=[];const date=benefitDateOnly(serviceDate)||dateKey(),recipient=recipientId?CareRecipient?.get?.(recipientId):null;
  if(!ruleset)return {status:'ruleset_required',eligibility:{eligible:null,confidence:'unavailable'},estimatedSubsidy:null,estimatedCopay:null,currency:'TWD',reasons,warnings:['尚未有可套用的 Published 補助規則集。'],missingFields:[],ruleset:null};
  if(ruleset.serviceType!==requestedService)failed.push(`服務類型 ${requestedService} 不在此 Ruleset 適用範圍`);
  if(!benefitRuleMatchesDate(ruleset,date))failed.push(`服務日期 ${date} 不在 Ruleset 有效期間`);else reasons.push(`服務日期 ${date} 位於 Ruleset 有效期間`);
  const residenceCity=String(facts.residenceCity||benefitRecipientResidenceCity(recipient)||'').trim();
  if(ruleset.jurisdiction?.city){if(!residenceCity)missing.push('residenceCity');else if(residenceCity!==ruleset.jurisdiction.city)failed.push(`居住地 ${residenceCity} 不符合 ${ruleset.jurisdiction.city}`);else reasons.push(`居住地符合 ${ruleset.jurisdiction.city}`);}
  const c=ruleset.conditions||{},cms=benefitNumberOrNull(facts.cmsLevel);
  if((c.cmsLevels||[]).length){if(cms===null)missing.push('cmsLevel');else if(!c.cmsLevels.includes(Number(cms)))failed.push(`CMS ${cms} 不在適用等級`);else reasons.push(`CMS ${cms} 符合適用等級`);}
  for(const [field,required,label] of [['approvedCarePlan',c.requireApprovedCarePlan,'照顧計畫核定'],['transportationApproved',c.requireTransportationApproved,'交通服務核定']]){if(required===null||required===undefined)continue;const actual=benefitBoolOrNull(facts[field]);if(actual===null)missing.push(field);else if(actual!==required)failed.push(`${label}條件不符合`);else reasons.push(`${label}條件符合`);}
  if((c.identityCategories||[]).length){const cat=String(facts.identityCategory||'').trim();if(!cat)missing.push('identityCategory');else if(!c.identityCategories.includes(cat))failed.push(`身分類別 ${cat} 不在適用範圍`);else reasons.push(`身分類別 ${cat} 符合`);}
  if((c.residenceCities||[]).length){if(!residenceCity)missing.push('residenceCity');else if(!c.residenceCities.includes(residenceCity))failed.push(`居住地 ${residenceCity} 不在條件清單`);else reasons.push(`居住地 ${residenceCity} 符合條件`);}
  if(failed.length)return {status:'not_eligible',eligibility:{eligible:false,confidence:'estimated'},estimatedSubsidy:0,estimatedCopay:benefitNumberOrNull(facts.eligibleCost),currency:ruleset.calculation?.currency||'TWD',reasons:[...reasons,...failed],warnings:['此結果是系統依目前 Ruleset 的預估，不代表主管機關正式核定。'],missingFields:[...new Set(missing)],ruleset};
  if(missing.length)return {status:'insufficient_data',eligibility:{eligible:null,confidence:'estimated'},estimatedSubsidy:null,estimatedCopay:null,currency:ruleset.calculation?.currency||'TWD',reasons,warnings:[`缺少必要資料：${[...new Set(missing)].join('、')}`,'補助資格與金額仍以主管機關正式核定為準。'],missingFields:[...new Set(missing)],ruleset};
  const calc=ruleset.calculation||{mode:'none',currency:'TWD'};let subsidy=null,copay=null;
  if(calc.mode==='fixed_amount'){subsidy=Math.max(0,Number(calc.amount)||0);const cost=benefitNumberOrNull(facts.eligibleCost);copay=cost===null?null:Math.max(0,Math.round((cost-subsidy)*100)/100);reasons.push(`依 Ruleset fixed_amount 計算`);}
  else if(calc.mode==='percentage'){const cost=benefitNumberOrNull(facts.eligibleCost);if(cost===null)return {status:'insufficient_data',eligibility:{eligible:null,confidence:'estimated'},estimatedSubsidy:null,estimatedCopay:null,currency:calc.currency||'TWD',reasons,warnings:['percentage 規則需要 eligibleCost 才能計算金額。'],missingFields:['eligibleCost'],ruleset};const raw=cost*(Number(calc.percentage)||0)/100;subsidy=calc.maxAmount===null||calc.maxAmount===undefined?raw:Math.min(raw,Number(calc.maxAmount)||0);subsidy=Math.max(0,Math.round(subsidy*100)/100);copay=Math.max(0,Math.round((cost-subsidy)*100)/100);reasons.push(`依 eligibleCost × ${calc.percentage}% 計算${calc.maxAmount!==null&&calc.maxAmount!==undefined?`，上限 ${calc.maxAmount}`:''}`);}
  else warnings.push('此 Ruleset 僅判斷資格，未設定金額公式。');
  warnings.push('此結果是系統試算，不等同主管機關正式核定。');
  return {status:'eligible_estimate',eligibility:{eligible:true,confidence:'estimated'},estimatedSubsidy:subsidy,estimatedCopay:copay,currency:calc.currency||'TWD',reasons,warnings,missingFields:[],ruleset};
}

Benefit = {
  constants:Object.freeze({rulesetSchemaVersion:BENEFIT_RULESET_SCHEMA_VERSION,assessmentSchemaVersion:BENEFIT_ASSESSMENT_SCHEMA_VERSION,snapshotSchemaVersion:BENEFIT_SNAPSHOT_SCHEMA_VERSION,defaultProgramCode:BENEFIT_DEFAULT_PROGRAM_CODE}),
  statusLabel:benefitAssessmentStatusLabel,
  canManageRulesets(actorUserId){return !!actorUserId&&!!Identity?.canUser?.(actorUserId,'benefit.ruleset.manage',null);},
  canReadRulesets(actorUserId){return !!actorUserId&&(this.canManageRulesets(actorUserId)||!!Identity?.canUserInAnyOrganization?.(actorUserId,'benefit.ruleset.read'));},
  canReadAssessment(assessmentOrId,actorUserId,organizationId=null){const a=typeof assessmentOrId==='string'?(store.state.benefitAssessments||[]).find(x=>x.id===assessmentOrId):assessmentOrId;if(!a||!actorUserId)return false;if(benefitActorIsSuper(actorUserId)&&Identity.canUser(actorUserId,'benefit.assessment.read_all',null))return true;return benefitCanReadOwn(actorUserId,a.recipientId)||(organizationId?benefitCanReadServed(actorUserId,a.recipientId,organizationId):benefitCanReadServedAny(actorUserId,a.recipientId));},
  canCreateAssessment(recipientId,actorUserId,organizationId=null){if(!recipientId||!actorUserId)return false;if(benefitActorIsSuper(actorUserId)&&Identity.canUser(actorUserId,'benefit.assessment.create_all',null))return true;return benefitCanCreateOwn(actorUserId,recipientId)||benefitCanCreateServed(actorUserId,recipientId,organizationId);},
  rulesets({includeDraft=false,includeRetired=false,actorUserId=null}={}){if(actorUserId&&!this.canReadRulesets(actorUserId))return [];return [...(store.state.benefitRulesets||[])].filter(r=>(includeDraft||r.status!=='draft')&&(includeRetired||r.status!=='retired')).sort((a,b)=>String(b.effectiveFrom||'').localeCompare(String(a.effectiveFrom||''))||String(b.version||'').localeCompare(String(a.version||'')));},
  ruleset(id){return (store.state.benefitRulesets||[]).find(r=>r.id===id)||null;},
  validateRuleset(input,{forPublish=false}={}){const r=input?.id?normalizeBenefitRuleset(input,input):normalizeBenefitRuleset(input);return benefitRulesetValidation(r,{forPublish,allRulesets:store.state.benefitRulesets||[]});},
  createRuleset(input,actorUserId){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有平台超級管理者可以新增 補助規則集'};const r=normalizeBenefitRuleset({...input,createdByUserId:actorUserId,updatedByUserId:actorUserId});const validation=benefitRulesetValidation(r,{forPublish:false,allRulesets:store.state.benefitRulesets||[]});if(!validation.ok)return {ok:false,error:validation.errors.join('；'),validation};store.mutate(db=>{db.benefitRulesets=db.benefitRulesets||[];db.benefitRulesets.unshift(r);benefitAppendRulesetEventInDb(db,{rulesetId:r.id,eventType:'created',actorUserId,detail:`建立 Draft ${r.code} ${r.version}`});});Audit.log('benefit.ruleset.created',`建立 Benefit Draft ${r.code} ${r.version}`,{actorUserId,benefitRulesetId:r.id});return {ok:true,ruleset:r,validation};},
  updateDraftRuleset(id,input,actorUserId){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有平台超級管理者可以修改 補助規則集'};const old=this.ruleset(id);if(!old)return {ok:false,error:'找不到 補助規則集'};if(old.status!=='draft')return {ok:false,error:'已發布或退役 Ruleset 不可直接修改；請建立新版本'};const next=normalizeBenefitRuleset({...input,updatedByUserId:actorUserId},old);const validation=benefitRulesetValidation(next,{forPublish:false,allRulesets:store.state.benefitRulesets||[]});if(!validation.ok)return {ok:false,error:validation.errors.join('；'),validation};store.mutate(db=>{const i=(db.benefitRulesets||[]).findIndex(x=>x.id===id);db.benefitRulesets[i]=next;benefitAppendRulesetEventInDb(db,{rulesetId:id,eventType:'draft_updated',actorUserId,detail:`更新 Draft ${next.code} ${next.version}`});});Audit.log('benefit.ruleset.updated',`更新 Benefit Draft ${next.code} ${next.version}`,{actorUserId,benefitRulesetId:id});return {ok:true,ruleset:next,validation};},
  publishRuleset(id,actorUserId){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有平台超級管理者可以發布 補助規則集'};const old=this.ruleset(id);if(!old)return {ok:false,error:'找不到 補助規則集'};if(old.status!=='draft')return {ok:false,error:'只有 Draft 可以發布'};const validation=benefitRulesetValidation(old,{forPublish:true,allRulesets:store.state.benefitRulesets||[]});if(!validation.ok)return {ok:false,error:validation.errors.join('；'),validation};const at=nowISO();store.mutate(db=>{const r=(db.benefitRulesets||[]).find(x=>x.id===id);r.status='published';r.publishedAt=at;r.publishedByUserId=actorUserId;r.updatedAt=at;r.updatedByUserId=actorUserId;benefitAppendRulesetEventInDb(db,{rulesetId:id,eventType:'published',actorUserId,detail:`發布 ${r.code} ${r.version}`});});Audit.log('benefit.ruleset.published',`發布 補助規則集 ${old.code} ${old.version}`,{actorUserId,benefitRulesetId:id});return {ok:true,ruleset:this.ruleset(id),validation};},
  retireRuleset(id,actorUserId){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有平台超級管理者可以退役 補助規則集'};const old=this.ruleset(id);if(!old)return {ok:false,error:'找不到 補助規則集'};if(old.status!=='published')return {ok:false,error:'只有 已發布規則集 可以退役'};const at=nowISO();store.mutate(db=>{const r=(db.benefitRulesets||[]).find(x=>x.id===id);r.status='retired';r.retiredAt=at;r.retiredByUserId=actorUserId;r.updatedAt=at;r.updatedByUserId=actorUserId;benefitAppendRulesetEventInDb(db,{rulesetId:id,eventType:'retired',actorUserId,detail:`退役 ${r.code} ${r.version}`});});Audit.log('benefit.ruleset.retired',`退役 補助規則集 ${old.code} ${old.version}`,{actorUserId,benefitRulesetId:id});return {ok:true,ruleset:this.ruleset(id)};},
  rulesetHistory(id){return (store.state.benefitRulesetEvents||[]).filter(e=>e.rulesetId===id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));},
  getActiveRuleset({programCode=Benefit.constants.defaultProgramCode,requestedService='transportation',serviceDate=null,residenceCity=null}={}){const d=benefitDateOnly(serviceDate)||dateKey();const rows=(store.state.benefitRulesets||[]).filter(r=>r.status==='published'&&r.code===programCode&&r.serviceType===requestedService&&benefitRuleMatchesDate(r,d));const exactCity=residenceCity?rows.filter(r=>r.jurisdiction?.city===residenceCity):[];const national=rows.filter(r=>!r.jurisdiction?.city);const candidates=exactCity.length?exactCity:national;return [...candidates].sort((a,b)=>String(b.effectiveFrom||'').localeCompare(String(a.effectiveFrom||''))||String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')))[0]||null;},
  evaluate({recipientId,programCode=Benefit.constants.defaultProgramCode,requestedService='transportation',serviceDate=null,facts={}}={}){const recipient=recipientId?CareRecipient?.get?.(recipientId):null;const normalizedFacts={cmsLevel:benefitNumberOrNull(facts.cmsLevel),residenceCity:String(facts.residenceCity||benefitRecipientResidenceCity(recipient)||'').trim()||null,approvedCarePlan:benefitBoolOrNull(facts.approvedCarePlan),transportationApproved:benefitBoolOrNull(facts.transportationApproved),identityCategory:String(facts.identityCategory||'').trim()||null,eligibleCost:benefitNumberOrNull(facts.eligibleCost)};const rule=this.getActiveRuleset({programCode,requestedService,serviceDate,residenceCity:normalizedFacts.residenceCity});return {...benefitResultFromRuleset(rule,{recipientId,requestedService,serviceDate,facts:normalizedFacts}),facts:normalizedFacts,programCode,requestedService,serviceDate:benefitDateOnly(serviceDate)||dateKey()};},
  assess({organizationId=null,recipientId,programCode=Benefit.constants.defaultProgramCode,cmsLevel=null,requestedService='transportation',serviceDate=null,facts={},actorUserId=null}={}){if(!recipientId||!CareRecipient?.get?.(recipientId))return {ok:false,error:'找不到服務對象'};if(actorUserId&&!this.canCreateAssessment(recipientId,actorUserId,organizationId))return {ok:false,error:'你沒有建立此服務對象 Benefit Assessment 的權限'};const mergedFacts={...facts,cmsLevel:facts.cmsLevel??cmsLevel};const result=this.evaluate({recipientId,programCode,requestedService,serviceDate,facts:mergedFacts}),rule=result.ruleset,at=nowISO();const assessment={id:uid('benefit'),schemaVersion:BENEFIT_ASSESSMENT_SCHEMA_VERSION,organizationId:organizationId||null,recipientId,programCode,requestedService,serviceDate:result.serviceDate,facts:deepClone(result.facts),status:result.status,eligibility:deepClone(result.eligibility),estimatedSubsidy:result.estimatedSubsidy,estimatedCopay:result.estimatedCopay,currency:result.currency||'TWD',rulesetId:rule?.id||null,rulesetVersion:rule?.version||null,rulesetEffectiveFrom:rule?.effectiveFrom||null,rulesetEffectiveTo:rule?.effectiveTo||null,rulesetSource:rule?benefitSourceSnapshot(rule.source):null,reasons:[...(result.reasons||[])],warnings:[...(result.warnings||[])],missingFields:[...(result.missingFields||[])],explanation:[...(result.reasons||[]),...(result.warnings||[])].join('；'),createdByUserId:actorUserId||null,createdAt:at};store.mutate(db=>{db.benefitAssessments=db.benefitAssessments||[];db.benefitAssessments.unshift(assessment);benefitAppendAssessmentEventInDb(db,{assessmentId:assessment.id,recipientId,organizationId:organizationId||null,eventType:'assessment_created',actorUserId:actorUserId||null,status:assessment.status,rulesetId:assessment.rulesetId,rulesetVersion:assessment.rulesetVersion,detail:assessment.explanation});});Audit.log('benefit.assessment.created',`Benefit Assessment ${assessment.id}：${benefitAssessmentStatusLabel(assessment.status)}`,{actorUserId:actorUserId||null,organizationId:organizationId||null,recipientId,benefitAssessmentId:assessment.id,benefitRulesetId:assessment.rulesetId});return {ok:true,assessment};},
  getAssessment(id,actorUserId=null,organizationId=null){const a=(store.state.benefitAssessments||[]).find(x=>x.id===id)||null;if(!a)return null;if(actorUserId&&!this.canReadAssessment(a,actorUserId,organizationId))return null;return a;},
  list(organizationId=null,{actorUserId=null,recipientId=null}={}){let rows=[...(store.state.benefitAssessments||[])];if(organizationId)rows=rows.filter(x=>x.organizationId===organizationId);if(recipientId)rows=rows.filter(x=>x.recipientId===recipientId);if(actorUserId)rows=rows.filter(x=>this.canReadAssessment(x,actorUserId,organizationId));return rows;},
  history(recipientId,{actorUserId=null,organizationId=null}={}){const rows=this.list(null,{actorUserId,recipientId}).filter(x=>!organizationId||x.organizationId===organizationId||this.canReadAssessment(x,actorUserId,organizationId));return rows;},
  assessmentEvents(assessmentId,{actorUserId=null,organizationId=null}={}){const a=this.getAssessment(assessmentId,actorUserId,organizationId);if(!a)return [];return (store.state.benefitAssessmentEvents||[]).filter(e=>e.assessmentId===assessmentId).sort((x,y)=>new Date(y.createdAt)-new Date(x.createdAt));},
  snapshotForBooking({organizationId=null,recipientId=null,requestedService='transportation',serviceDate=null,capturedAt=null}={}){const captured=capturedAt||nowISO(),rows=(store.state.benefitAssessments||[]).filter(x=>x.recipientId===recipientId&&x.requestedService===requestedService).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)),requestedDate=benefitDateOnly(serviceDate);const latest=requestedDate?(rows.find(x=>x.serviceDate===requestedDate)||null):(rows[0]||null);if(latest){return {schemaVersion:BENEFIT_SNAPSHOT_SCHEMA_VERSION,status:latest.status||'ruleset_required',programCode:latest.programCode||Benefit.constants.defaultProgramCode,cmsLevel:latest.facts?.cmsLevel??latest.cmsLevel??null,requestedService:latest.requestedService||requestedService,serviceDate:requestedDate||latest.serviceDate||null,eligibility:deepClone(latest.eligibility||null),estimatedSubsidy:latest.estimatedSubsidy??null,estimatedCopay:latest.estimatedCopay??null,currency:latest.currency||'TWD',rulesetId:latest.rulesetId??null,rulesetVersion:latest.rulesetVersion??null,rulesetEffectiveFrom:latest.rulesetEffectiveFrom??null,rulesetEffectiveTo:latest.rulesetEffectiveTo??null,rulesetSource:deepClone(latest.rulesetSource||null),sourceAssessmentId:latest.id||null,reasons:[...(latest.reasons||[])],warnings:[...(latest.warnings||[])],explanation:latest.explanation||'',capturedAt:captured};}return {schemaVersion:BENEFIT_SNAPSHOT_SCHEMA_VERSION,status:'ruleset_required',programCode:BENEFIT_DEFAULT_PROGRAM_CODE,cmsLevel:null,requestedService,serviceDate:requestedDate,eligibility:{eligible:null,confidence:'unavailable'},estimatedSubsidy:null,estimatedCopay:null,currency:'TWD',rulesetId:null,rulesetVersion:null,rulesetEffectiveFrom:null,rulesetEffectiveTo:null,rulesetSource:null,sourceAssessmentId:null,reasons:[],warnings:['尚未建立可供 Booking 使用的 Benefit Assessment。'],explanation:'尚未有可套用的 Benefit Assessment／版本化政府補助規則，因此快照保留為待規則狀態。',capturedAt:captured};},
  validate(){const errors=[],warnings=[],rules=store.state.benefitRulesets||[],assessments=store.state.benefitAssessments||[],events=store.state.benefitAssessmentEvents||[];const ids=new Set(),versions=new Set();for(const r of rules){if(ids.has(r.id))errors.push(`BenefitRuleset 重複 id：${r.id}`);ids.add(r.id);const key=`${r.code}:${r.version}`;if(versions.has(key))errors.push(`BenefitRuleset 重複版本：${key}`);versions.add(key);const v=benefitRulesetValidation(r,{forPublish:r.status==='published',allRulesets:rules});v.errors.forEach(e=>errors.push(`Ruleset ${r.id}：${e}`));v.warnings.forEach(w=>warnings.push(`Ruleset ${r.id}：${w}`));}const recipients=new Set((store.state.careRecipients||[]).map(r=>r.id));const ruleIds=new Set(rules.map(r=>r.id));for(const a of assessments){if(!a.id)errors.push('BenefitAssessment 缺少 id');if(a.schemaVersion!==BENEFIT_ASSESSMENT_SCHEMA_VERSION)warnings.push(`Assessment ${a.id} schemaVersion 尚未升級`);if(a.recipientId&&!recipients.has(a.recipientId))errors.push(`Assessment ${a.id} 找不到 recipient ${a.recipientId}`);if(!BENEFIT_ASSESSMENT_STATUSES.includes(a.status))errors.push(`Assessment ${a.id} status 無效：${a.status}`);if(a.rulesetId&&!ruleIds.has(a.rulesetId))warnings.push(`Assessment ${a.id} 的 rulesetId ${a.rulesetId} 已不存在，但快照仍保留`);if(!events.some(e=>e.assessmentId===a.id))warnings.push(`Assessment ${a.id} 缺少 append-only event baseline`);}return {ok:!errors.length,errors,warnings,stats:{rulesets:rules.length,publishedRulesets:rules.filter(r=>r.status==='published').length,draftRulesets:rules.filter(r=>r.status==='draft').length,assessments:assessments.length,assessmentEvents:events.length}};},
  migrate(){let changed=0;store.mutate(db=>{db.benefitRulesets=Array.isArray(db.benefitRulesets)?db.benefitRulesets:[];db.benefitRulesetEvents=Array.isArray(db.benefitRulesetEvents)?db.benefitRulesetEvents:[];db.benefitAssessments=Array.isArray(db.benefitAssessments)?db.benefitAssessments:[];db.benefitAssessmentEvents=Array.isArray(db.benefitAssessmentEvents)?db.benefitAssessmentEvents:[];db.benefitRulesets=db.benefitRulesets.map(r=>{if(r.schemaVersion===BENEFIT_RULESET_SCHEMA_VERSION&&r.conditions&&r.calculation&&r.source)return r;changed++;return {...normalizeBenefitRuleset(r,r),status:BENEFIT_RULESET_STATUSES.includes(r.status)?r.status:'draft',updatedAt:r.updatedAt||r.createdAt||nowISO()};});db.benefitAssessments=db.benefitAssessments.map(a=>{if(a.schemaVersion===BENEFIT_ASSESSMENT_SCHEMA_VERSION&&a.facts&&Array.isArray(a.reasons)&&Array.isArray(a.warnings))return a;changed++;const status=BENEFIT_ASSESSMENT_STATUSES.includes(a.status)?a.status:'ruleset_required',createdAt=a.createdAt||nowISO();return {...a,schemaVersion:BENEFIT_ASSESSMENT_SCHEMA_VERSION,programCode:a.programCode||Benefit.constants.defaultProgramCode,requestedService:a.requestedService||'transportation',serviceDate:a.serviceDate||benefitDateOnly(createdAt)||dateKey(),facts:{cmsLevel:a.cmsLevel??null,residenceCity:null,approvedCarePlan:null,transportationApproved:null,identityCategory:null,eligibleCost:null},status,eligibility:a.eligibility||{eligible:status==='eligible_estimate'?true:status==='not_eligible'?false:null,confidence:'legacy'},estimatedSubsidy:a.estimatedSubsidy??null,estimatedCopay:a.estimatedCopay??null,currency:a.currency||'TWD',rulesetId:a.rulesetId||null,rulesetVersion:a.rulesetVersion||null,rulesetEffectiveFrom:a.rulesetEffectiveFrom||null,rulesetEffectiveTo:a.rulesetEffectiveTo||null,rulesetSource:a.rulesetSource||null,reasons:Array.isArray(a.reasons)?a.reasons:(a.explanation?[a.explanation]:[]),warnings:Array.isArray(a.warnings)?a.warnings:['由舊版 Benefit 骨架遷移；未補造任何政府規則或補助金額。'],missingFields:Array.isArray(a.missingFields)?a.missingFields:[],createdByUserId:a.createdByUserId||null,createdAt};});const known=new Set(db.benefitAssessmentEvents.map(e=>e.assessmentId));for(const a of db.benefitAssessments){if(known.has(a.id))continue;benefitAppendAssessmentEventInDb(db,{assessmentId:a.id,recipientId:a.recipientId||null,organizationId:a.organizationId||null,eventType:'migration_baseline',actorUserId:null,status:a.status,rulesetId:a.rulesetId||null,rulesetVersion:a.rulesetVersion||null,detail:'V12.25.47 建立 Benefit Assessment append-only 歷史基準',createdAt:a.createdAt||nowISO()});changed++;}});return {ok:true,changed};},
  initialize(){const migration=this.migrate(),validation=this.validate();if(!validation.ok)console.warn('[Benefit] validation errors',validation.errors);return {ok:validation.ok,migration,validation};}
};
}


{
const BENEFIT_AUTH_SCHEMA_VERSION=1, BENEFIT_LEDGER_SCHEMA_VERSION=1;
const BENEFIT_AUTH_STATUSES=['active','revoked'];
function p1Date(v){const x=String(v||'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(x))return x;const d=x?new Date(x):null;return d&&!Number.isNaN(d.getTime())?dateKey(d):null;}
function p1Num(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function p1AuthorizationMatches(a,{recipientId,programCode,serviceDate}={}){const d=p1Date(serviceDate)||dateKey();return a&&a.status==='active'&&a.approved!==false&&a.recipientId===recipientId&&(!programCode||a.programCode===programCode)&&(!a.validFrom||a.validFrom<=d)&&(!a.validTo||a.validTo>=d);}
function p1ActorIsSuper(actorUserId){return !!(store.state.users||[]).find(u=>u.id===actorUserId&&u.active!==false&&u.platformRole==='super_admin');}
function p1OwnRelation(actorUserId,recipientId){return !!actorUserId&&!!recipientId&&!!CareRecipient?.relationForUser?.(actorUserId,recipientId);}
function p1Served(actorUserId,recipientId,organizationId){return !!actorUserId&&!!organizationId&&!!CareRecipient?.canRead?.(recipientId,{actorUserId,organizationId});}
function p1ServedAny(actorUserId,recipientId){return !!Identity?.activeMembershipsForUser?.(actorUserId)?.some(m=>p1Served(actorUserId,recipientId,m.organizationId));}
function p1CanReadRecipient(actorUserId,recipientId,organizationId=null){if(!actorUserId)return false;if(p1ActorIsSuper(actorUserId)&&Identity.canUser(actorUserId,'benefit.authorization.read_all',null))return true;if(p1OwnRelation(actorUserId,recipientId)&&Identity.canUser(actorUserId,'benefit.authorization.read_own',APP_CONFIG.requesterOrganizationId))return true;return organizationId?p1Served(actorUserId,recipientId,organizationId)&&Identity.canUser(actorUserId,'benefit.authorization.read_served',organizationId):p1ServedAny(actorUserId,recipientId);}
function p1CanManage(actorUserId,recipientId,organizationId=null){if(!actorUserId)return false;if(p1ActorIsSuper(actorUserId)&&Identity.canUser(actorUserId,'benefit.authorization.manage_all',null))return true;return !!organizationId&&p1Served(actorUserId,recipientId,organizationId)&&Identity.canUser(actorUserId,'benefit.authorization.manage_served',organizationId);}
function p1AppendLedger(db,e){db.benefitLedger=Array.isArray(db.benefitLedger)?db.benefitLedger:[];const row={id:uid('bledger'),schemaVersion:BENEFIT_LEDGER_SCHEMA_VERSION,currency:'TWD',amount:0,reservedDelta:0,settledDelta:0,authorizationDelta:0,createdAt:nowISO(),...e};db.benefitLedger.unshift(row);return row;}
function p1AppendAuthEvent(db,e){db.benefitAuthorizationEvents=Array.isArray(db.benefitAuthorizationEvents)?db.benefitAuthorizationEvents:[];const row={id:uid('bauthevt'),schemaVersion:1,createdAt:nowISO(),...e};db.benefitAuthorizationEvents.unshift(row);return row;}
function p1BookingBenefit(bookingId){return Booking?.commercialSnapshot?.(bookingId)?.benefit||null;}

Benefit.canManageAuthorization=(actorUserId,recipientId,organizationId=null)=>p1CanManage(actorUserId,recipientId,organizationId);
Benefit.canReadAuthorization=(a,actorUserId,organizationId=null)=>!!a&&p1CanReadRecipient(actorUserId,a.recipientId,organizationId);
Benefit.authorizations=function({actorUserId=null,organizationId=null,recipientId=null,includeRevoked=false}={}){let rows=[...(store.state.benefitAuthorizations||[])];if(recipientId)rows=rows.filter(x=>x.recipientId===recipientId);if(!includeRevoked)rows=rows.filter(x=>x.status!=='revoked');if(actorUserId)rows=rows.filter(x=>this.canReadAuthorization(x,actorUserId,organizationId));return rows.sort((a,b)=>String(b.validFrom||'').localeCompare(String(a.validFrom||''))||new Date(b.createdAt||0)-new Date(a.createdAt||0));};
Benefit.getAuthorization=function(id){return (store.state.benefitAuthorizations||[]).find(x=>x.id===id)||null;};
Benefit.getActiveAuthorization=function({recipientId,programCode=Benefit.constants.defaultProgramCode,serviceDate=null}={}){return (store.state.benefitAuthorizations||[]).filter(a=>p1AuthorizationMatches(a,{recipientId,programCode,serviceDate})).sort((a,b)=>String(b.validFrom||'').localeCompare(String(a.validFrom||''))||new Date(b.createdAt||0)-new Date(a.createdAt||0))[0]||null;};
Benefit.saveAuthorization=function(input={},actorUserId){const recipientId=String(input.recipientId||''),organizationId=input.organizationId||null;if(!CareRecipient?.get?.(recipientId))return {ok:false,error:'找不到服務對象'};if(!p1CanManage(actorUserId,recipientId,organizationId))return {ok:false,error:'你沒有管理此服務對象正式核定資料的權限'};const amount=p1Num(input.approvedAmount),units=p1Num(input.approvedUnits),validFrom=p1Date(input.validFrom),validTo=p1Date(input.validTo);if(amount===null||amount<0)return {ok:false,error:'核定總額必須是 0 以上數字'};if(!validFrom)return {ok:false,error:'請填有效起日'};if(validTo&&validTo<validFrom)return {ok:false,error:'有效迄日不能早於起日'};const referenceNo=String(input.referenceNo||'').trim();if(!referenceNo)return {ok:false,error:'正式核定請填寫核定文號／識別碼，避免把試算資料誤當正式核定'};const at=nowISO(),a={id:uid('bauth'),schemaVersion:BENEFIT_AUTH_SCHEMA_VERSION,organizationId,recipientId,programCode:String(input.programCode||Benefit.constants.defaultProgramCode).trim()||Benefit.constants.defaultProgramCode,validFrom,validTo,approved:true,status:'active',approvedAmount:amount,approvedUnits:units,currency:'TWD',source:String(input.source||'manual'),referenceNo,createdByUserId:actorUserId,createdAt:at,updatedAt:at};store.mutate(db=>{db.benefitAuthorizations=db.benefitAuthorizations||[];db.benefitAuthorizations.unshift(a);p1AppendAuthEvent(db,{authorizationId:a.id,recipientId,eventType:'created',actorUserId,detail:`建立正式核定 ${a.programCode}，核定 ${a.currency} ${a.approvedAmount}`});});Audit.log('benefit.authorization.created',`正式核定 ${a.id}`,{actorUserId,recipientId,organizationId,benefitAuthorizationId:a.id});let autoReserved=0;for(const b of Booking?.futureActiveForRecipient?.(recipientId,new Date(validFrom+'T00:00:00'))||[]){if((!a.validTo||b.pickupDate<=a.validTo)&&b.pickupDate>=a.validFrom){const r=this.reserveForBooking(b.id,{actorUserId,reason:'authorization_created'});if(r.ok&&!r.duplicate)autoReserved+=Number(r.reservedAmount||0);}}return {ok:true,authorization:a,autoReserved};};
Benefit.revokeAuthorization=function(id,actorUserId,reason=''){const a=this.getAuthorization(id);if(!a)return {ok:false,error:'找不到正式核定'};if(!p1CanManage(actorUserId,a.recipientId,a.organizationId))return {ok:false,error:'你沒有撤銷此核定資料的權限'};if(a.status==='revoked')return {ok:true,authorization:a,duplicate:true};const bal=this.getBalance(id);if(bal.reserved>0)return {ok:false,error:'仍有 Booking 保留額度，請先釋放後再撤銷'};store.mutate(db=>{const x=(db.benefitAuthorizations||[]).find(v=>v.id===id);x.status='revoked';x.revokedAt=nowISO();x.revokedByUserId=actorUserId;p1AppendAuthEvent(db,{authorizationId:id,recipientId:a.recipientId,eventType:'revoked',actorUserId,detail:String(reason||'撤銷正式核定')});});Audit.log('benefit.authorization.revoked',`撤銷正式核定 ${id}`,{actorUserId,recipientId:a.recipientId});return {ok:true,authorization:this.getAuthorization(id)};};
Benefit.getLedger=function({actorUserId=null,organizationId=null,authorizationId=null,recipientId=null,bookingId=null,tripId=null}={}){let rows=[...(store.state.benefitLedger||[])];if(authorizationId)rows=rows.filter(x=>x.authorizationId===authorizationId);if(recipientId)rows=rows.filter(x=>x.recipientId===recipientId);if(bookingId)rows=rows.filter(x=>x.bookingId===bookingId);if(tripId)rows=rows.filter(x=>x.tripId===tripId);if(actorUserId)rows=rows.filter(x=>{const a=this.getAuthorization(x.authorizationId);return a&&this.canReadAuthorization(a,actorUserId,organizationId);});return rows.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));};
Benefit.getBalance=function(authorizationId){const a=this.getAuthorization(authorizationId);if(!a)return {authorizationId,approved:0,adjustment:0,reserved:0,settled:0,available:0,currency:'TWD'};const rows=(store.state.benefitLedger||[]).filter(x=>x.authorizationId===authorizationId),adjustment=rows.reduce((s,x)=>s+Number(x.authorizationDelta||0),0),reserved=rows.reduce((s,x)=>s+Number(x.reservedDelta||0),0),settled=rows.reduce((s,x)=>s+Number(x.settledDelta||0),0),approved=Number(a.approvedAmount||0),available=Math.max(0,approved+adjustment-reserved-settled);return {authorizationId,approved,adjustment,reserved:Math.max(0,reserved),settled:Math.max(0,settled),available,currency:a.currency||'TWD'};};
Benefit.reserveForBooking=function(bookingId,{actorUserId=null,reason='booking_created'}={}){const b=Booking?.get?.(bookingId);if(!b)return {ok:false,error:'找不到 Booking'};const snap=p1BookingBenefit(bookingId);if(!snap||snap.estimatedSubsidy===null||snap.estimatedSubsidy===undefined||Number(snap.estimatedSubsidy)<=0)return {ok:false,skipped:true,error:'Booking 沒有可保留的補助估算'};const auth=this.getActiveAuthorization({recipientId:b.recipientId,programCode:snap.programCode||Benefit.constants.defaultProgramCode,serviceDate:b.pickupDate});if(!auth)return {ok:false,skipped:true,error:'沒有有效的正式核定額度'};const existing=this.getLedger({authorizationId:auth.id,bookingId}).reduce((s,x)=>s+Number(x.reservedDelta||0),0);if(existing>0)return {ok:true,duplicate:true,authorization:auth,reservedAmount:existing,balance:this.getBalance(auth.id)};const bal=this.getBalance(auth.id),requested=Math.max(0,Number(snap.estimatedSubsidy||0)),amount=Math.min(requested,bal.available);if(amount<=0)return {ok:false,error:'正式核定可用額度不足',balance:bal};let entry;store.mutate(db=>{entry=p1AppendLedger(db,{authorizationId:auth.id,recipientId:b.recipientId,bookingId,tripId:null,entryType:'reserve',amount,reservedDelta:amount,settledDelta:0,authorizationDelta:0,currency:auth.currency||'TWD',reason,actorUserId,rulesetId:snap.rulesetId||null,rulesetVersion:snap.rulesetVersion||null,sourceAssessmentId:snap.sourceAssessmentId||null});});Audit.log('benefit.booking.reserved',`Booking ${bookingId} 保留補助 ${amount}`,{bookingId,recipientId:b.recipientId,benefitAuthorizationId:auth.id,amount,actorUserId});return {ok:true,entry,authorization:auth,reservedAmount:amount,partial:amount<requested,balance:this.getBalance(auth.id)};};
Benefit.releaseForBooking=function(bookingId,{actorUserId=null,reason='booking_cancelled'}={}){const rows=this.getLedger({bookingId}),groups={};for(const x of rows)groups[x.authorizationId]=(groups[x.authorizationId]||0)+Number(x.reservedDelta||0);let released=0;store.mutate(db=>{for(const [authorizationId,amount] of Object.entries(groups)){if(amount<=0)continue;const a=(db.benefitAuthorizations||[]).find(x=>x.id===authorizationId);if(!a)continue;p1AppendLedger(db,{authorizationId,recipientId:a.recipientId,bookingId,tripId:null,entryType:'release',amount,reservedDelta:-amount,settledDelta:0,authorizationDelta:0,currency:a.currency||'TWD',reason,actorUserId});released+=amount;}});if(released>0)Audit.log('benefit.booking.released',`Booking ${bookingId} 釋放補助 ${released}`,{bookingId,amount:released,actorUserId});return {ok:true,releasedAmount:released};};
Benefit.settleFromTrip=function(tripId,{actorUserId=null,reason='trip_completed'}={}){const t=Trip?.get?.(tripId);if(!t)return {ok:false,error:'找不到 Trip'};if(t.status!=='completed')return {ok:false,error:'Trip 尚未完成，不能結算補助'};let settled=0,entries=[];for(const bookingId of t.bookingIds||[]){const rows=this.getLedger({bookingId}),groups={};for(const x of rows)groups[x.authorizationId]=(groups[x.authorizationId]||0)+Number(x.reservedDelta||0);store.mutate(db=>{for(const [authorizationId,amount] of Object.entries(groups)){if(amount<=0)continue;const a=(db.benefitAuthorizations||[]).find(x=>x.id===authorizationId);if(!a)continue;const e=p1AppendLedger(db,{authorizationId,recipientId:a.recipientId,bookingId,tripId,entryType:'settle',amount,reservedDelta:-amount,settledDelta:amount,authorizationDelta:0,currency:a.currency||'TWD',reason,actorUserId});entries.push(e);settled+=amount;}});}if(settled>0)Audit.log('benefit.trip.settled',`Trip ${tripId} 結算補助 ${settled}`,{tripId,amount:settled,actorUserId});return {ok:true,settledAmount:settled,entries};};
Benefit.reopenSettlementForTrip=function(tripId,{actorUserId=null,reason='formal_trip_correction'}={}){const rows=this.getLedger({tripId}),groups={};for(const x of rows)groups[x.authorizationId]=(groups[x.authorizationId]||0)+Number(x.settledDelta||0);let reopened=0;store.mutate(db=>{for(const [authorizationId,amount] of Object.entries(groups)){if(amount<=0)continue;const a=(db.benefitAuthorizations||[]).find(x=>x.id===authorizationId);if(!a)continue;const bookingIds=[...new Set(rows.filter(x=>x.authorizationId===authorizationId&&x.bookingId).map(x=>x.bookingId))];for(const bookingId of bookingIds){const bookingSettled=rows.filter(x=>x.authorizationId===authorizationId&&x.bookingId===bookingId).reduce((s,x)=>s+Number(x.settledDelta||0),0);if(bookingSettled<=0)continue;p1AppendLedger(db,{authorizationId,recipientId:a.recipientId,bookingId,tripId,entryType:'settlement_reopened',amount:bookingSettled,reservedDelta:bookingSettled,settledDelta:-bookingSettled,authorizationDelta:0,currency:a.currency||'TWD',reason,actorUserId});reopened+=bookingSettled;}}});if(reopened>0)Audit.log('benefit.trip.settlement_reopened',`Trip ${tripId} Correction 回轉結算 ${reopened}`,{tripId,amount:reopened,actorUserId});return {ok:true,reopenedAmount:reopened};};
Benefit.adjust=function(authorizationId,amount,reason,actorUserId){const a=this.getAuthorization(authorizationId),n=p1Num(amount),text=String(reason||'').trim();if(!a)return {ok:false,error:'找不到正式核定'};if(!p1CanManage(actorUserId,a.recipientId,a.organizationId)||!Identity.canUser(actorUserId,'benefit.ledger.adjust',a.organizationId))return {ok:false,error:'你沒有調整 Benefit Ledger 的權限'};if(n===null||n===0)return {ok:false,error:'調整額度不可為 0'};if(text.length<4)return {ok:false,error:'請填寫至少 4 個字的調整原因'};const bal=this.getBalance(authorizationId),newEntitlement=bal.approved+bal.adjustment+n;if(newEntitlement<bal.reserved+bal.settled)return {ok:false,error:'調整後核定總額不能低於已保留＋已結算金額'};let entry;store.mutate(db=>{entry=p1AppendLedger(db,{authorizationId,recipientId:a.recipientId,bookingId:null,tripId:null,entryType:'adjustment',amount:Math.abs(n),reservedDelta:0,settledDelta:0,authorizationDelta:n,currency:a.currency||'TWD',reason:text,actorUserId});});Audit.log('benefit.ledger.adjusted',`Benefit ${authorizationId} 額度調整 ${n}`,{benefitAuthorizationId:authorizationId,recipientId:a.recipientId,amount:n,actorUserId,reason:text});return {ok:true,entry,balance:this.getBalance(authorizationId)};};
Benefit.reconciliation=function({actorUserId=null,organizationId=null}={}){const auths=this.authorizations({actorUserId,organizationId,includeRevoked:true});const rows=auths.map(a=>({authorization:a,balance:this.getBalance(a.id)}));return {authorizations:rows,totalApproved:rows.reduce((s,x)=>s+x.balance.approved+x.balance.adjustment,0),totalReserved:rows.reduce((s,x)=>s+x.balance.reserved,0),totalSettled:rows.reduce((s,x)=>s+x.balance.settled,0),totalAvailable:rows.reduce((s,x)=>s+x.balance.available,0)};};

const _p0Validate=Benefit.validate.bind(Benefit),_p0Migrate=Benefit.migrate.bind(Benefit);
Benefit.validate=function(){const base=_p0Validate(),errors=[...base.errors],warnings=[...base.warnings],auths=store.state.benefitAuthorizations||[],ledger=store.state.benefitLedger||[],recipients=new Set((store.state.careRecipients||[]).map(x=>x.id)),authIds=new Set();for(const a of auths){if(!a.id)errors.push('BenefitAuthorization 缺少 id');if(authIds.has(a.id))errors.push(`BenefitAuthorization 重複 id：${a.id}`);authIds.add(a.id);if(!recipients.has(a.recipientId))errors.push(`Authorization ${a.id} 找不到 recipient ${a.recipientId}`);if(!BENEFIT_AUTH_STATUSES.includes(a.status))errors.push(`Authorization ${a.id} status 無效`);if(Number(a.approvedAmount)<0)errors.push(`Authorization ${a.id} approvedAmount 不可為負數`);const bal=this.getBalance(a.id);if(bal.reserved<0||bal.settled<0)errors.push(`Authorization ${a.id} Ledger 餘額異常`);if(bal.approved+bal.adjustment<bal.reserved+bal.settled)errors.push(`Authorization ${a.id} 已保留＋已結算超過核定總額`);}for(const e of ledger){if(!e.id)errors.push('BenefitLedger 缺少 id');if(!authIds.has(e.authorizationId))errors.push(`Ledger ${e.id} 找不到 Authorization ${e.authorizationId}`);}return {ok:!errors.length,errors,warnings,stats:{...base.stats,authorizations:auths.length,ledgerEntries:ledger.length}};};
Benefit.migrate=function(){const base=_p0Migrate();let changed=base.changed||0;store.mutate(db=>{if(!Array.isArray(db.benefitAuthorizations)){db.benefitAuthorizations=[];changed++;}if(!Array.isArray(db.benefitAuthorizationEvents)){db.benefitAuthorizationEvents=[];changed++;}if(!Array.isArray(db.benefitLedger)){db.benefitLedger=[];changed++;}db.benefitAuthorizations=db.benefitAuthorizations.map(a=>({...a,schemaVersion:BENEFIT_AUTH_SCHEMA_VERSION,status:BENEFIT_AUTH_STATUSES.includes(a.status)?a.status:'active',approved:a.approved!==false,currency:a.currency||'TWD',approvedAmount:Math.max(0,Number(a.approvedAmount)||0)}));});return {ok:true,changed};};
Benefit.initialize=function(){const migration=this.migrate(),validation=this.validate();if(!validation.ok)console.warn('[Benefit P1] validation errors',validation.errors);return {ok:validation.ok,migration,validation};};

const _bookingCreateForRequester=Booking.createForRequester.bind(Booking);Booking.createForRequester=function(input,userId){const r=_bookingCreateForRequester(input,userId);if(r?.ok&&r.booking?.id)Benefit.reserveForBooking(r.booking.id,{actorUserId:userId,reason:'booking_created'});return r;};
const _bookingAmendOwn=Booking.amendOwn.bind(Booking);Booking.amendOwn=function(id,userId,input,reasonText){const r=_bookingAmendOwn(id,userId,input,reasonText);if(r?.ok){Benefit.releaseForBooking(id,{actorUserId:userId,reason:'booking_amended_reprice'});Benefit.reserveForBooking(id,{actorUserId:userId,reason:'booking_amended'});}return r;};
const _bookingCancelOwn=Booking.cancelOwn.bind(Booking);Booking.cancelOwn=async function(id,userId,reasonCode,reasonText){const r=await _bookingCancelOwn(id,userId,reasonCode,reasonText);if(r?.ok)Benefit.releaseForBooking(id,{actorUserId:userId,reason:'booking_cancelled'});return r;};
const _bookingExpireStaleOpen=Booking.expireStaleOpen.bind(Booking);Booking.expireStaleOpen=function(options={}){const r=_bookingExpireStaleOpen(options);for(const id of r?.bookingIds||[])Benefit.releaseForBooking(id,{actorUserId:null,reason:'booking_expired'});return r;};
const _bookingTransition=Booking.transition.bind(Booking);Booking.transition=function(id,action,context={}){const r=_bookingTransition(id,action,context);if(r?.ok&&action==='reject')Benefit.releaseForBooking(id,{actorUserId:context.userId||null,reason:'booking_rejected'});return r;};
function p1SettleIfCompleted(result,actorUserId){const t=result?.trip;if(result?.ok&&t?.status==='completed')Benefit.settleFromTrip(t.id,{actorUserId,reason:'trip_completed'});return result;}
const _tripCaptureProof=Trip.captureProof.bind(Trip);Trip.captureProof=function(tripId,stepId,input,actorUserId,options){return p1SettleIfCompleted(_tripCaptureProof(tripId,stepId,input,actorUserId,options),actorUserId);};
const _tripDepart=Trip.departCurrentStop.bind(Trip);Trip.departCurrentStop=function(tripId,actorUserId,options){return p1SettleIfCompleted(_tripDepart(tripId,actorUserId,options),actorUserId);};
const _tripComplete=Trip.completeCurrentStep.bind(Trip);Trip.completeCurrentStep=function(tripId,actorUserId,options){return p1SettleIfCompleted(_tripComplete(tripId,actorUserId,options),actorUserId);};
const _tripUndo=Trip.undoLastStep.bind(Trip);Trip.undoLastStep=function(tripId,actorUserId,options={}){const wasCompleted=Trip.get(tripId)?.status==='completed',r=_tripUndo(tripId,actorUserId,options);if(r?.ok&&wasCompleted&&options?.formalCorrection===true)Benefit.reopenSettlementForTrip(tripId,{actorUserId,reason:'formal_trip_correction'});return r;};
const _tripResolveIssue=Trip.resolveIssue.bind(Trip);Trip.resolveIssue=function(issueId,userId,input={}){const r=_tripResolveIssue(issueId,userId,input);if(r?.ok&&r.tripAutoCompleted){const issue=(store.state.issues||[]).find(x=>x.id===issueId);if(issue?.tripId)Benefit.settleFromTrip(issue.tripId,{actorUserId:userId,reason:'trip_completed_after_issue_resolution'});}return r;};
}


{
let session=null;
const OTP_CHALLENGES = new Map();

const ROLE_PERMISSIONS = Object.freeze({
  super_admin:Object.freeze([
    'platform.dashboard.read','platform.organization.manage','platform.membership.manage','platform.report.manage',
    'booking.market.read','booking.audit.read','booking.leg.assign_organization','booking.sync_google',
    'care_recipient.directory.read','care_recipient.create','care_recipient.update','care_recipient.archive','care_recipient.relation.manage','care_recipient.audit.read',
    'benefit.dashboard.read','benefit.ruleset.read','benefit.ruleset.manage','benefit.assessment.read_all','benefit.assessment.create_all','benefit.authorization.read_all','benefit.authorization.manage_all','benefit.ledger.read_all','benefit.ledger.adjust','benefit.audit.read','account.read_own'
  ]),
  driver:Object.freeze([
    'driver.dashboard.read','trip.read_own','trip.execute','issue.create','analytics.read_own',
    'booking.read_claimed_own','booking.release_own','booking.audit.read_participated',
    'account.read_own','system_report.create'
  ]),
  dispatcher:Object.freeze([
    'dispatch.dashboard.read','dispatch.manage',
    'booking.market.read','booking.market.claim','booking.read_claimed','booking.manage_claimed','booking.schedule','booking.release','booking.reject','booking.audit.read','booking.sync_google',
    'trip.read_all','trip.manage','issue.read','issue.manage','analytics.read_fleet','care_recipient.directory.read','care_recipient.read_served',
    'benefit.dashboard.read','benefit.ruleset.read','benefit.assessment.read_served','benefit.assessment.create_served','benefit.authorization.read_served','benefit.ledger.read_served','account.read_own','system_report.create'
  ]),
  owner:Object.freeze([
    'owner.dashboard.read','company.staff.manage','vehicle.manage',
    'booking.market.read','booking.market.claim','booking.read_claimed','booking.manage_claimed','booking.schedule','booking.release','booking.reject','booking.audit.read','booking.sync_google',
    'trip.read_all','trip.manage','issue.read','issue.manage','analytics.read_fleet',
    'care_recipient.directory.read','care_recipient.read_served','care_recipient.create','care_recipient.update','care_recipient.archive',
    'benefit.dashboard.read','benefit.ruleset.read','benefit.assessment.read_served','benefit.assessment.create_served','benefit.authorization.read_served','benefit.authorization.manage_served','benefit.ledger.read_served','benefit.ledger.adjust',
    'account.read_own','system_report.create'
  ]),
  requester:Object.freeze([
    'requester.dashboard.read','booking.create_own','booking.read_own','booking.edit_own','booking.cancel_own','booking.audit.read_own',
    'care_recipient.self.read','care_recipient.self.update',
    'benefit.dashboard.read','benefit.ruleset.read','benefit.assessment.read_own','benefit.assessment.create_own','benefit.authorization.read_own','benefit.ledger.read_own','account.read_own','system_report.create'
  ])
});

function membershipStatus(membership){ return membership?.status||'active'; }
function isActiveMembership(membership){ return membershipStatus(membership)==='active'; }
function permissionsForRole(role){ return ROLE_PERMISSIONS[role]||[]; }
function isPlatformSuperAdmin(user){ return user?.platformRole==='super_admin'; }
function requesterOrganization(){ return store.state.organizations.find(o=>o.id===APP_CONFIG.requesterOrganizationId&&o.active!==false)||null; }
function normalizeIdentityEmail(value=''){ return String(value||'').trim().toLowerCase(); }
function validIdentityEmail(value=''){ return /^\S+@\S+\.\S+$/.test(normalizeIdentityEmail(value)); }
function validIdentityPhone(value=''){ return /^09\d{8}$/.test(digitsOnly(value)); }
function persistSession(){ if(session) SessionStore.setItem(APP_CONFIG.sessionKey,JSON.stringify(session)); else SessionStore.removeItem(APP_CONFIG.sessionKey); }
function activeMembershipsForUser(userId){
  return store.state.memberships.filter(m=>m.userId===userId&&isActiveMembership(m)&&store.state.organizations.some(o=>o.id===m.organizationId&&o.active!==false));
}
function firstActiveOrganizationId(){ return store.state.organizations.find(o=>o.active!==false)?.id||null; }


const LOGIN_SECURITY_POLICY=Object.freeze({captchaAfter:3,lockAfter:5,forceResetAfter:10,lockMs:3*60*1000,captchaDigits:4});
LoginSecurity=(()=>{
  const loadAll=()=>{try{return JSON.parse(LocalStore.getItem(APP_CONFIG.loginSecurityKey)||'{}')||{};}catch{return {};}};
  const saveAll=data=>LocalStore.setItem(APP_CONFIG.loginSecurityKey,JSON.stringify(data));
  const normalize=phone=>digitsOnly(phone);
  const fresh=()=>({failures:0,lockedUntil:0,forceReset:false,captchaCode:'',captchaIssuedAt:0,updatedAt:Date.now()});
  const read=phone=>{const key=normalize(phone),all=loadAll();return {...fresh(),...(all[key]||{})};};
  const write=(phone,state)=>{const key=normalize(phone);if(!key)return;const all=loadAll();all[key]={...state,updatedAt:Date.now()};saveAll(all);};
  const randomCode=()=>String(Math.floor(Math.random()*10**LOGIN_SECURITY_POLICY.captchaDigits)).padStart(LOGIN_SECURITY_POLICY.captchaDigits,'0');
  const ensureCaptcha=(phone,force=false)=>{const state=read(phone);if(force||!state.captchaCode){state.captchaCode=randomCode();state.captchaIssuedAt=Date.now();write(phone,state);}return state.captchaCode;};
  const status=phone=>{
    const state=read(phone),now=Date.now();
    const locked=Number(state.lockedUntil||0)>now;
    const remainingMs=locked?Number(state.lockedUntil)-now:0;
    const forceReset=!!state.forceReset||state.failures>=LOGIN_SECURITY_POLICY.forceResetAfter;
    const captchaRequired=!forceReset&&state.failures>=LOGIN_SECURITY_POLICY.captchaAfter;
    return {...state,locked,remainingMs,forceReset,captchaRequired};
  };
  return {
    policy:LOGIN_SECURITY_POLICY,
    status,
    ensureCaptcha,
    refreshCaptcha(phone){return ensureCaptcha(phone,true);},
    beforeAttempt(phone,captchaInput=''){
      const s=status(phone);
      if(s.forceReset)return {ok:false,reason:'force_reset',error:'密碼已連續輸入錯誤 10 次，請先使用「忘記密碼」設定新密碼。'};
      if(s.locked)return {ok:false,reason:'locked',remainingMs:s.remainingMs,error:'密碼錯誤已達 5 次，登入暫停 3 分鐘。'};
      if(s.captchaRequired){
        const expected=ensureCaptcha(phone);
        if(String(captchaInput||'').trim()!==expected){ensureCaptcha(phone,true);return {ok:false,reason:'captcha',error:'數字驗證碼錯誤，已重新產生一組驗證碼。'};}
      }
      return {ok:true};
    },
    recordFailure(phone){
      const s=read(phone);s.failures=Number(s.failures||0)+1;
      if(s.failures>=LOGIN_SECURITY_POLICY.forceResetAfter){s.forceReset=true;s.lockedUntil=0;}
      else if(s.failures===LOGIN_SECURITY_POLICY.lockAfter){s.lockedUntil=Date.now()+LOGIN_SECURITY_POLICY.lockMs;}
      if(s.failures>=LOGIN_SECURITY_POLICY.captchaAfter&&!s.forceReset){s.captchaCode=randomCode();s.captchaIssuedAt=Date.now();}
      write(phone,s);return status(phone);
    },
    clear(phone){const key=normalize(phone);if(!key)return;const all=loadAll();delete all[key];saveAll(all);},
    clearAll(){LocalStore.removeItem(APP_CONFIG.loginSecurityKey);}
  };
})();
function makeOtp(){ return String(Math.floor(100000+Math.random()*900000)); }
function createOtpChallenge(type,phone,membershipIds=[]){
  const code=makeOtp(),id=uid('otp');
  const challenge={id,type,phone,code,membershipIds,createdAt:Date.now(),expiresAt:Date.now()+5*60*1000,attempts:0};
  OTP_CHALLENGES.set(`${type}:${phone}`,challenge);return challenge;
}
function verifyOtpChallenge(type,phone,code){
  const key=`${type}:${phone}`,challenge=OTP_CHALLENGES.get(key);
  if(!challenge) return {ok:false,error:'請先取得驗證碼'};
  if(Date.now()>challenge.expiresAt){ OTP_CHALLENGES.delete(key); return {ok:false,error:'驗證碼已過期，請重新取得'}; }
  challenge.attempts+=1;
  if(challenge.attempts>5){ OTP_CHALLENGES.delete(key); return {ok:false,error:'驗證碼嘗試次數過多，請重新取得'}; }
  if(String(code)!==challenge.code) return {ok:false,error:'驗證碼錯誤'};
  return {ok:true,challenge};
}
function ensureRequesterMembership(userId,preferredMembershipId=null){
  const reqOrg=requesterOrganization(); if(!reqOrg) return {ok:false,error:'需求者組織尚未建立'};
  const rows=store.state.memberships.filter(m=>m.userId===userId&&m.organizationId===reqOrg.id&&m.role==='requester').sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const live=rows.find(m=>membershipStatus(m)!=='revoked');
  if(live){
    if(membershipStatus(live)==='suspended') return {ok:false,error:'你的需求者身分目前已暫停，請聯絡平台管理者'};
    return {ok:true,membership:live,created:false};
  }
  if(rows.some(m=>membershipStatus(m)==='revoked')) return {ok:false,error:'你的需求者身分曾被撤銷，需由 平台超級管理者確認後才能重新建立'};
  const membership={id:String(preferredMembershipId||'').trim()||uid('mem'),userId,organizationId:reqOrg.id,role:'requester',status:'active',createdAt:nowISO(),updatedAt:nowISO(),activatedAt:nowISO()};
  store.mutate(db=>db.memberships.push(membership));
  recordMembershipEvent({membershipId:membership.id,eventType:'created',fromStatus:null,toStatus:'active',fromRole:null,toRole:'requester',actorUserId:null,note:'需求者自行建立／社群登入建立 Membership'});
  return {ok:true,membership,created:true};
}
function startMembershipSession(user,membership,provider='password'){
  session={userId:user.id,membershipId:membership.id,organizationId:membership.organizationId,loginAt:nowISO(),loginProvider:provider};persistSession();
}
function recordMembershipEvent({membershipId,eventType='updated',fromStatus=null,toStatus=null,fromRole=null,toRole=null,actorUserId=null,note=''}){
  const membership=store.state.memberships.find(m=>m.id===membershipId);
  if(!membership)return null;
  const event={id:uid('mevt'),membershipId,userId:membership.userId,organizationId:membership.organizationId,eventType,fromStatus,toStatus,fromRole,toRole,actorUserId:actorUserId||Identity?.currentUser?.()?.id||null,createdAt:nowISO(),note:String(note||'')};
  store.mutate(db=>{db.membershipEvents=db.membershipEvents||[];db.membershipEvents.push(event);});
  return event;
}
function allowedMembershipTransitions(status){
  if(Identity?.isSuperAdmin?.()) return ['active','revoked'];
  return status==='active'?['active','revoked']:['revoked'];
}
function loadSession(){
  try{ const raw=SessionStore.getItem(APP_CONFIG.sessionKey);session=raw?JSON.parse(raw):null; }catch{ session=null; }
  if(!session) return null;
  const user=store.state.users.find(u=>u.id===session.userId&&u.active);
  if(!user){ session=null;persistSession();return null; }
  if(isPlatformSuperAdmin(user)){
    session={...session,platformRole:'super_admin',membershipId:null,organizationId:null,viewOrganizationId:(store.state.organizations.some(o=>o.id===session.viewOrganizationId&&o.active!==false)?session.viewOrganizationId:firstActiveOrganizationId())};persistSession();return session;
  }
  const current=store.state.memberships.find(m=>m.id===session.membershipId&&m.userId===user.id);
  if(!isActiveMembership(current)){
    const fallback=activeMembershipsForUser(user.id)[0];
    if(!fallback){session=null;persistSession();return null;}
    session={...session,membershipId:fallback.id,organizationId:fallback.organizationId,switchedAt:nowISO()};persistSession();
  }
  return session;
}

Identity = {
  init(){ return loadSession(); },
  startBackendSession({user:backendUser,memberships:backendMemberships=[],organizations:backendOrganizations=[],provider='password'}){
    const backendUserId=String(backendUser?.userId||'').trim();if(!backendUserId)return {ok:false,error:'後端沒有回傳使用者識別碼'};
    // 組織要先進本機，成員資格才算數：activeMembershipsForUser 會要求成員資格
    // 指向的組織存在於 store.state.organizations，否則那筆身分會被濾掉。以前組織
    // 是靠整份資料庫鏡像帶進來的，改成登入後才向伺服器載入之後，這裡本機是空的，
    // 剛註冊完的人就會看到「沒有有效身分」。
    const incomingOrgs=(Array.isArray(backendOrganizations)?backendOrganizations:[])
      .map(o=>({id:window.gsOrganizationId(o.id),name:o.name||'',type:o.type||'',active:o.active!==false}))
      .filter(o=>o.id);
    if(incomingOrgs.length){
      store.mutate(db=>{incomingOrgs.forEach(o=>{const existing=db.organizations.find(x=>x.id===o.id);if(existing)Object.assign(existing,o);else db.organizations.push(o);});},{remote:false,reason:'backend_session_orgs'});
    }
    const localUserId=window.gsUserId(backendUserId);let user=store.state.users.find(u=>u.id===localUserId);
    const normalizedPhone=digitsOnly(backendUser?.phone||'');
    if(!user){
      user={id:localUserId,name:backendUser.displayName||'使用者',phone:normalizedPhone,email:backendUser.email||'',password:'',active:true,platformRole:backendUser.platformRole||null,createdAt:nowISO(),source:'backend_session'};
      store.mutate(db=>db.users.push(user),{remote:false,reason:'backend_session'});
    }else{
      store.mutate(db=>{const u=db.users.find(x=>x.id===localUserId);if(backendUser.displayName)u.name=backendUser.displayName;if(normalizedPhone)u.phone=normalizedPhone;if(backendUser.email)u.email=backendUser.email;u.platformRole=backendUser.platformRole||u.platformRole||null;u.password='';u.active=true;u.updatedAt=nowISO();},{remote:false,reason:'backend_session'});
      user=store.state.users.find(u=>u.id===localUserId);
    }
    if(String(backendUser.platformRole||'').toLowerCase()==='super_admin'||isPlatformSuperAdmin(user)){
      store.mutate(db=>{const u=db.users.find(x=>x.id===localUserId);u.platformRole='super_admin';u.password='';},{remote:false,reason:'backend_session'});
      session={userId:localUserId,platformRole:'super_admin',membershipId:null,organizationId:null,viewOrganizationId:firstActiveOrganizationId(),loginAt:nowISO(),loginProvider:provider};persistSession();
      Audit.log('identity.login_success',`平台超級管理者後端驗證登入 ${user.name}`,{actorUserId:localUserId});return {ok:true,user:store.state.users.find(u=>u.id===localUserId),membership:null,platformRole:'super_admin'};
    }
    const normalizedMemberships=(Array.isArray(backendMemberships)?backendMemberships:[]).filter(m=>String(m.status||'').toLowerCase()==='active').map(m=>({id:String(m.membershipId||''),userId:localUserId,organizationId:window.gsOrganizationId(m.organizationId),role:String(m.role||''),status:'active',source:'backend_session',createdAt:nowISO(),updatedAt:nowISO()})).filter(m=>m.id&&m.organizationId&&m.role);
    if(normalizedMemberships.length){
      store.mutate(db=>normalizedMemberships.forEach(m=>{const existing=db.memberships.find(x=>x.id===m.id);if(existing)Object.assign(existing,m);else db.memberships.push(m);}),{remote:false,reason:'backend_session'});
    }
    const memberships=activeMembershipsForUser(localUserId),membership=memberships.find(m=>m.organizationId===APP_CONFIG.defaultOrganizationId)||memberships[0];
    if(!membership)return {ok:false,reason:'no_active_identity',error:'此帳號目前沒有有效身分，請聯絡平台管理者'};
    startMembershipSession(store.state.users.find(u=>u.id===localUserId),membership,provider);
    Audit.log('identity.login_success',`後端驗證登入 ${user.name}`,{actorUserId:localUserId,organizationId:membership.organizationId,membershipId:membership.id,provider});
    return {ok:true,user:store.state.users.find(u=>u.id===localUserId),membership};
  },
  logout(){
    const userId=session?.userId||null,organizationId=session?.organizationId||null;session=null;persistSession();CloudIdentity?.clearSessionToken?.();
    if(userId) Audit.log('identity.logout','使用者登出',{actorUserId:userId,organizationId});
  },
  get session(){ return session; },
  currentUser(){ return session?store.state.users.find(u=>u.id===session.userId):null; },
  currentMembership(){ return session?.membershipId?store.state.memberships.find(m=>m.id===session.membershipId):null; },
  currentRole(){ const user=this.currentUser(); return isPlatformSuperAdmin(user)?'super_admin':(this.currentMembership()?.role||null); },
  isSuperAdmin(){ return isPlatformSuperAdmin(this.currentUser()); },
  membershipOrganizationId(){ return this.currentMembership()?.organizationId||null; },
  scopeOrganizationId(){ return this.isSuperAdmin()?(session?.viewOrganizationId||null):this.membershipOrganizationId(); },
  organizationId(){ return this.scopeOrganizationId(); }, // compatibility alias for existing domain modules
  currentOrganization(){ const id=this.scopeOrganizationId();return id?store.state.organizations.find(o=>o.id===id):null; },
  membershipStatus,isActiveMembership,permissionsForRole,allowedMembershipTransitions,
  currentPermissions(){ return this.isSuperAdmin()?permissionsForRole('super_admin'):(isActiveMembership(this.currentMembership())?permissionsForRole(this.currentRole()):[]); },
  has(permission){ const permissions=this.currentPermissions();return permissions.includes('*')||permissions.includes(permission); },
  can(permission){ return this.has(permission); },
  canAny(permissions=[]){ return permissions.some(p=>this.has(p)); },
  canAll(permissions=[]){ return permissions.every(p=>this.has(p)); },
  activeMembershipForUserInOrganization(userId,organizationId){ return activeMembershipsForUser(userId).find(m=>m.organizationId===organizationId)||null; },
  permissionsForUserInOrganization(userId,organizationId=null){
    const user=store.state.users.find(u=>u.id===userId&&u.active!==false); if(!user)return [];
    if(isPlatformSuperAdmin(user))return permissionsForRole('super_admin');
    if(!organizationId)return [];
    const membership=this.activeMembershipForUserInOrganization(userId,organizationId); return membership?permissionsForRole(membership.role):[];
  },
  canUser(userId,permission,organizationId=null){ const permissions=this.permissionsForUserInOrganization(userId,organizationId);return permissions.includes('*')||permissions.includes(permission); },
  canUserInAnyOrganization(userId,permission){
    const user=store.state.users.find(u=>u.id===userId&&u.active!==false); if(!user)return false;
    if(isPlatformSuperAdmin(user))return this.canUser(userId,permission,null);
    return activeMembershipsForUser(userId).some(m=>this.canUser(userId,permission,m.organizationId));
  },
  membershipsForUser(userId,{includeInactive=true}={}){ const rows=store.state.memberships.filter(m=>m.userId===userId);return includeInactive?rows:rows.filter(isActiveMembership); },
  activeMembershipsForUser(userId=this.currentUser()?.id){ return userId?activeMembershipsForUser(userId):[]; },
  availableOrganizations(){
    if(this.isSuperAdmin()) return store.state.organizations.filter(o=>o.active!==false).map(organization=>({membership:null,organization,viewOnly:true}));
    return this.activeMembershipsForUser().map(m=>({membership:m,organization:store.state.organizations.find(o=>o.id===m.organizationId)})).filter(x=>x.organization);
  },
  setSuperAdminViewOrganization(organizationId){
    if(!this.isSuperAdmin())return {ok:false,error:'只有平台超級管理者可以切換平台檢視組織'};
    const target=store.state.organizations.find(o=>o.id===organizationId&&o.active!==false);
    if(!target)return {ok:false,error:'找不到可檢視的組織'};
    session={...session,platformRole:'super_admin',membershipId:null,organizationId:null,viewOrganizationId:organizationId,switchedAt:nowISO()};
    persistSession();
    return {ok:true,organizationId};
  },
  switchOrganization(organizationId){
    const user=this.currentUser();if(!user)return {ok:false,error:'尚未登入'};
    if(this.isSuperAdmin()){
      const organization=store.state.organizations.find(o=>o.id===organizationId&&o.active!==false);if(!organization)return {ok:false,error:'找不到有效組織'};
      const from=session.viewOrganizationId||null;session={...session,viewOrganizationId:organizationId,organizationId:null,membershipId:null,switchedAt:nowISO()};persistSession();
      Audit.log('identity.platform_scope_changed',`平台查看範圍 ${from||'-'} → ${organizationId}`,{actorUserId:user.id,targetOrganizationId:organizationId});return {ok:true,membership:null,organization,viewOnly:true};
    }
    const membership=activeMembershipsForUser(user.id).find(m=>m.organizationId===organizationId);if(!membership)return {ok:false,error:'你在此組織沒有有效組織身分'};
    if(session.organizationId===organizationId&&session.membershipId===membership.id)return {ok:true,membership,organization:this.currentOrganization(),unchanged:true};
    const from=session.organizationId;session={...session,membershipId:membership.id,organizationId:membership.organizationId,switchedAt:nowISO()};persistSession();
    Audit.log('identity.organization_switched',`切換身分 ${from||'-'} → ${organizationId}`,{actorUserId:user.id,organizationId,membershipId:membership.id,fromOrganizationId:from});return {ok:true,membership,organization:store.state.organizations.find(o=>o.id===organizationId)};
  },
  switchMembership(membershipId){
    const user=this.currentUser();if(!user||this.isSuperAdmin())return {ok:false,error:'目前帳號不使用 Membership 切換'};
    const membership=activeMembershipsForUser(user.id).find(m=>m.id===membershipId);if(!membership)return {ok:false,error:'找不到有效身分'};
    return this.switchOrganization(membership.organizationId);
  },
  hasRequesterIdentity(userId){
    return store.state.memberships.some(m=>m.userId===userId&&m.organizationId===APP_CONFIG.requesterOrganizationId&&m.role==='requester'&&membershipStatus(m)==='active');
  },
  setRequesterIdentity(userId,enabled){
    const isPlatform=this.can('platform.membership.manage'),isCompany=this.can('company.staff.manage');
    if(!isPlatform&&!isCompany)return {ok:false,error:'你沒有調整需求者身分的權限'};
    const user=store.state.users.find(u=>u.id===userId&&u.active);if(!user)return {ok:false,error:'找不到有效 User'};if(isPlatformSuperAdmin(user))return {ok:false,error:'平台超級管理者不能成為需求者'};
    if(isCompany&&!isPlatform){
      const companyOrgId=this.membershipOrganizationId();
      const staffMembership=store.state.memberships.find(m=>m.userId===userId&&m.organizationId===companyOrgId&&['driver','dispatcher'].includes(m.role)&&membershipStatus(m)!=='revoked');
      if(!staffMembership)return {ok:false,error:'負責人只能替自己公司的司機或調度員調整需求者身分'};
    }
    const reqOrg=requesterOrganization();if(!reqOrg)return {ok:false,error:'需求者組織尚未建立'};
    const rows=store.state.memberships.filter(m=>m.userId===userId&&m.organizationId===reqOrg.id&&m.role==='requester').sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
    const live=rows.find(m=>membershipStatus(m)!=='revoked');
    if(enabled){
      if(live){
        if(membershipStatus(live)==='suspended')store.mutate(db=>{const m=db.memberships.find(x=>x.id===live.id);m.status='active';m.updatedAt=nowISO();m.activatedAt=nowISO();});
        Audit.log('identity.requester_identity_granted',`授予需求者身分：${user.name}`,{actorUserId:this.currentUser()?.id,targetUserId:userId,organizationId:reqOrg.id,membershipId:live.id,reused:true});
        return {ok:true,membership:store.state.memberships.find(m=>m.id===live.id),created:false};
      }
      const revoked=rows.find(m=>membershipStatus(m)==='revoked');
      if(revoked){
        store.mutate(db=>{const m=db.memberships.find(x=>x.id===revoked.id);m.status='active';m.updatedAt=nowISO();m.activatedAt=nowISO();m.reactivatedAt=nowISO();m.revokedAt=null;m.revokedBy=null;});
        recordMembershipEvent({membershipId:revoked.id,eventType:'reactivated',fromStatus:'revoked',toStatus:'active',fromRole:'requester',toRole:'requester',actorUserId:this.currentUser()?.id,note:'重新啟用需求者身分'});
        Audit.log('identity.requester_identity_reactivated',`重新啟用需求者身分：${user.name}`,{actorUserId:this.currentUser()?.id,targetUserId:userId,organizationId:reqOrg.id,membershipId:revoked.id});
        return {ok:true,membership:store.state.memberships.find(m=>m.id===revoked.id),created:false,reactivated:true};
      }
      const membership={id:uid('mem'),userId,organizationId:reqOrg.id,role:'requester',status:'active',createdAt:nowISO(),updatedAt:nowISO(),activatedAt:nowISO(),grantedByActor:this.currentUser()?.id||null};
      store.mutate(db=>db.memberships.push(membership));
      recordMembershipEvent({membershipId:membership.id,eventType:'created',fromStatus:null,toStatus:'active',fromRole:null,toRole:'requester',actorUserId:this.currentUser()?.id,note:'管理者授予需求者身分'});
      Audit.log('identity.requester_identity_granted',`授予需求者身分：${user.name}`,{actorUserId:this.currentUser()?.id,targetUserId:userId,organizationId:reqOrg.id,membershipId:membership.id});
      return {ok:true,membership,created:true};
    }
    if(!live)return {ok:true,removed:false};
    store.mutate(db=>{const m=db.memberships.find(x=>x.id===live.id);m.status='revoked';m.updatedAt=nowISO();m.revokedAt=nowISO();m.revokedBy=this.currentUser()?.id||null;});
    recordMembershipEvent({membershipId:live.id,eventType:'revoked',fromStatus:membershipStatus(live),toStatus:'revoked',fromRole:'requester',toRole:'requester',actorUserId:this.currentUser()?.id,note:'撤銷需求者身分'});
    Audit.log('identity.requester_identity_revoked',`撤銷需求者身分：${user.name}`,{actorUserId:this.currentUser()?.id,targetUserId:userId,organizationId:reqOrg.id,membershipId:live.id});
    return {ok:true,removed:true};
  },
  updateMemberProfile(membershipId,{name,phone}){
    if(!this.can('platform.membership.manage'))return {ok:false,error:'只有 平台超級管理者可以修改組織成員資料'};
    const membership=store.state.memberships.find(m=>m.id===membershipId);if(!membership)return {ok:false,error:'找不到 Membership'};
    const user=store.state.users.find(u=>u.id===membership.userId);if(!user)return {ok:false,error:'找不到使用者'};
    const cleanName=String(name||'').trim(),cleanPhone=digitsOnly(phone);if(!cleanName)return {ok:false,error:'請輸入姓名'};if(!validIdentityPhone(cleanPhone))return {ok:false,error:'成員手機請輸入 09 開頭共 10 位數字'};
    if(store.state.users.some(u=>u.id!==user.id&&digitsOnly(u.phone)===cleanPhone))return {ok:false,error:'此手機號碼已被其他帳號使用'};
    const previousName=user.name,previousPhone=user.phone;store.mutate(db=>{const u=db.users.find(x=>x.id===user.id);u.name=cleanName;u.phone=cleanPhone;u.updatedAt=nowISO();});
    Audit.log('identity.member_profile_updated',`更新成員資料 ${previousName}`,{actorUserId:this.currentUser()?.id,organizationId:membership.organizationId,membershipId,targetUserId:user.id,previousPhone,newPhone:cleanPhone});return {ok:true,user:store.state.users.find(u=>u.id===user.id)};
  },
  setOrganizationOwner(organizationId,membershipId){
    if(!this.can('platform.membership.manage'))return {ok:false,error:'只有 平台超級管理者可以更換組織負責人'};
    const organization=Organization.get(organizationId);if(!organization)return {ok:false,error:'找不到組織'};if(organization.systemManaged||organization.id===APP_CONFIG.requesterOrganizationId)return {ok:false,error:'需求者組織沒有公司負責人'};
    const target=store.state.memberships.find(m=>m.id===membershipId&&m.organizationId===organizationId&&isActiveMembership(m));if(!target||!['owner','driver','dispatcher'].includes(target.role))return {ok:false,error:'請選擇此組織有效的公司成員'};
    const currentOwner=store.state.memberships.find(m=>m.organizationId===organizationId&&m.role==='owner'&&membershipStatus(m)!=='revoked');if(currentOwner?.id===target.id)return {ok:true,membership:target,unchanged:true};
    const targetPreviousRole=target.role,currentOwnerRestoreRole=currentOwner&&['driver','dispatcher'].includes(currentOwner.previousRoleBeforeOwner)?currentOwner.previousRoleBeforeOwner:'dispatcher';
    if(targetPreviousRole==='driver'){
      const driverCheck=Organization.canDeactivateDriverProfile(target.userId,organizationId);
      if(!driverCheck.ok)return driverCheck;
    }
    store.mutate(db=>{
      const t=db.memberships.find(m=>m.id===target.id);if(targetPreviousRole!=='owner')t.previousRoleBeforeOwner=targetPreviousRole;t.role='owner';t.updatedAt=nowISO();
      if(currentOwner&&currentOwner.id!==target.id){const old=db.memberships.find(m=>m.id===currentOwner.id);old.role=currentOwnerRestoreRole;delete old.previousRoleBeforeOwner;old.updatedAt=nowISO();}
    });
    if(targetPreviousRole==='driver')Organization.deactivateDriverProfile(target.userId,organizationId,this.currentUser()?.id);
    if(currentOwner&&currentOwner.id!==target.id&&currentOwnerRestoreRole==='driver')Organization.ensureDriverProfileForUser(currentOwner.userId,organizationId,this.currentUser()?.id);
    const targetUser=store.state.users.find(u=>u.id===target.userId),oldUser=currentOwner?store.state.users.find(u=>u.id===currentOwner.userId):null;
    recordMembershipEvent({membershipId:target.id,eventType:'role_changed',fromStatus:membershipStatus(target),toStatus:membershipStatus(target),fromRole:targetPreviousRole,toRole:'owner',actorUserId:this.currentUser()?.id,note:'平台超級管理者指定為公司負責人'});
    if(currentOwner&&currentOwner.id!==target.id)recordMembershipEvent({membershipId:currentOwner.id,eventType:'role_changed',fromStatus:membershipStatus(currentOwner),toStatus:membershipStatus(currentOwner),fromRole:'owner',toRole:currentOwnerRestoreRole,actorUserId:this.currentUser()?.id,note:'更換負責人後恢復原工作角色'});
    Audit.log('identity.organization_owner_changed',`更換 ${organization.name} 負責人：${oldUser?.name||'未指定'} → ${targetUser?.name||'未知'}`,{actorUserId:this.currentUser()?.id,organizationId,membershipId:target.id,targetUserId:target.userId,previousOwnerUserId:currentOwner?.userId||null,restoredPreviousRole:currentOwnerRestoreRole});
    return {ok:true,membership:store.state.memberships.find(m=>m.id===target.id)};
  },
  setMembershipStatus(membershipId,status){
    const isPlatform=this.can('platform.membership.manage'),isCompany=this.can('company.staff.manage');if(!isPlatform&&!isCompany)return {ok:false,error:'你沒有成員管理權限'};
    if(status==='suspended')status='revoked';
    if(!['active','revoked'].includes(status))return {ok:false,error:'無效的 Membership status'};
    const target=store.state.memberships.find(m=>m.id===membershipId);if(!target)return {ok:false,error:'找不到 Membership'};
    if(target.organizationId!==this.scopeOrganizationId())return {ok:false,error:'不可管理其他組織的 Membership'};
    if(isCompany&&!isPlatform){
      if(!['driver','dispatcher'].includes(target.role))return {ok:false,error:'負責人只能管理本公司的司機與調度員'};
      if(membershipStatus(target)==='revoked'&&status==='active')return {ok:false,error:'已撤銷的公司工作帳號只能由 平台超級管理者恢復'};
    }
    const previous=membershipStatus(target)==='suspended'?'revoked':membershipStatus(target);
    if(!allowedMembershipTransitions(previous).includes(status))return {ok:false,error:'無效的 Membership 狀態轉換'};
    if(status==='active'){
      const sibling=store.state.memberships.find(m=>m.id!==membershipId&&m.userId===target.userId&&m.organizationId===target.organizationId&&membershipStatus(m)!=='revoked');
      if(sibling)return {ok:false,error:'此 User 在目前組織已有另一筆有效組織身分，請先處理重複資料'};
      if(target.role==='owner'){
        const otherOwner=store.state.memberships.find(m=>m.id!==membershipId&&m.organizationId===target.organizationId&&m.role==='owner'&&membershipStatus(m)!=='revoked');
        if(otherOwner)return {ok:false,error:'此組織已經有負責人；一個組織只能有一位負責人'};
      }
    }
    if(previous===status)return {ok:true,membership:target,unchanged:true};
    if(status==='revoked'&&target.role==='driver'){
      const driverCheck=Organization.canDeactivateDriverProfile(target.userId,target.organizationId);
      if(!driverCheck.ok)return driverCheck;
    }
    store.mutate(db=>{
      const m=db.memberships.find(x=>x.id===membershipId);m.status=status;m.updatedAt=nowISO();
      if(status==='active'){m.activatedAt=nowISO();m.reactivatedAt=previous==='revoked'?nowISO():(m.reactivatedAt||null);m.revokedAt=null;m.revokedBy=null;m.suspendedAt=null;}
      if(status==='revoked'){m.revokedAt=nowISO();m.revokedBy=this.currentUser()?.id||null;m.suspendedAt=null;}
    });
    recordMembershipEvent({membershipId,eventType:status==='revoked'?'revoked':'reactivated',fromStatus:previous,toStatus:status,fromRole:target.role,toRole:target.role,actorUserId:this.currentUser()?.id,note:status==='revoked'?(isPlatform?'平台超級管理者撤銷公司工作帳號':'公司負責人撤銷／停權工作帳號'):'平台超級管理者恢復公司工作帳號'});
    if(target.role==='driver'){if(status==='active')Organization.ensureDriverProfileForUser(target.userId,target.organizationId,this.currentUser()?.id);else Organization.deactivateDriverProfile(target.userId,target.organizationId,this.currentUser()?.id);}
    Audit.log('identity.membership_status_changed',`Membership ${membershipId}: ${previous} → ${status}`,{actorUserId:this.currentUser()?.id,organizationId:target.organizationId,membershipId,targetUserId:target.userId});
    if(session?.membershipId===membershipId&&status!=='active'){const fallback=activeMembershipsForUser(session.userId)[0];if(fallback){session={...session,membershipId:fallback.id,organizationId:fallback.organizationId,switchedAt:nowISO()};persistSession();}else{session=null;persistSession();}}
    return {ok:true,membership:store.state.memberships.find(m=>m.id===membershipId)};
  },
  setMembershipRole(membershipId,role){
    if(!this.can('platform.membership.manage'))return {ok:false,error:'只有 平台超級管理者可以調整組織成員角色'};if(!['owner','dispatcher','driver'].includes(role))return {ok:false,error:'公司組織只允許負責人、調度員、司機'};
    const target=store.state.memberships.find(m=>m.id===membershipId);if(!target)return {ok:false,error:'找不到 Membership'};if(membershipStatus(target)==='revoked')return {ok:false,error:'已撤銷 Membership 不可修改角色'};
    if(target.organizationId!==this.scopeOrganizationId())return {ok:false,error:'請先切換到該組織'};const targetOrg=store.state.organizations.find(o=>o.id===target.organizationId);if(targetOrg?.id===APP_CONFIG.requesterOrganizationId||targetOrg?.type==='requester_hub')return {ok:false,error:'需求者組織角色固定為需求者'};
    if(role==='owner'&&target.role!=='owner')return this.setOrganizationOwner(target.organizationId,target.id);
    const previous=target.role;
    if(previous==='driver'&&role!=='driver'){
      const driverCheck=Organization.canDeactivateDriverProfile(target.userId,target.organizationId);
      if(!driverCheck.ok)return driverCheck;
    }
    store.mutate(db=>{const m=db.memberships.find(x=>x.id===membershipId);m.role=role;if(previous==='owner'&&role!=='owner')delete m.previousRoleBeforeOwner;m.updatedAt=nowISO();});
    if(role==='driver')Organization.ensureDriverProfileForUser(target.userId,target.organizationId,this.currentUser()?.id);else if(previous==='driver')Organization.deactivateDriverProfile(target.userId,target.organizationId,this.currentUser()?.id);
    recordMembershipEvent({membershipId,eventType:'role_changed',fromStatus:membershipStatus(target),toStatus:membershipStatus(target),fromRole:previous,toRole:role,actorUserId:this.currentUser()?.id,note:'平台超級管理者調整公司角色'});Audit.log('identity.membership_role_changed',`Membership ${membershipId}: ${previous} → ${role}`,{actorUserId:this.currentUser()?.id,organizationId:target.organizationId,membershipId,targetUserId:target.userId});return {ok:true,membership:store.state.memberships.find(m=>m.id===membershipId)};
  },
  membershipHistory(membershipId){
    return (store.state.membershipEvents||[]).filter(e=>e.membershipId===membershipId).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  },
  canViewMembershipHistory(membershipId){
    const m=store.state.memberships.find(x=>x.id===membershipId);if(!m)return false;if(this.isSuperAdmin())return true;
    const me=this.currentMembership();return !!(me&&me.role==='owner'&&isActiveMembership(me)&&me.organizationId===m.organizationId);
  },
  validate(){
    const errors=[],warnings=[],users=store.state.users||[],memberships=store.state.memberships||[],organizations=store.state.organizations||[],drivers=store.state.drivers||[],external=store.state.externalIdentities||[],membershipEvents=store.state.membershipEvents||[];
    const userIds=new Set(users.map(u=>u.id)),orgIds=new Set(organizations.map(o=>o.id));
    const phoneMap=new Map(),emailMap=new Map();
    users.forEach(u=>{const p=digitsOnly(u.phone),e=normalizeIdentityEmail(u.email);if(p){if(phoneMap.has(p)&&phoneMap.get(p)!==u.id)errors.push(`手機重複：${p}`);else phoneMap.set(p,u.id);}if(e){if(emailMap.has(e)&&emailMap.get(e)!==u.id)errors.push(`Email 重複：${e}`);else emailMap.set(e,u.id);}if(isPlatformSuperAdmin(u)&&memberships.some(m=>m.userId===u.id&&membershipStatus(m)!=='revoked'))errors.push(`平台超級管理者 ${u.id} 不得有 Membership`);});
    const liveMembershipKey=new Set();
    memberships.forEach(m=>{
      if(!userIds.has(m.userId))errors.push(`Membership ${m.id} 的 userId 不存在`);if(!orgIds.has(m.organizationId))errors.push(`Membership ${m.id} 的 organizationId 不存在`);
      if(m.role==='requester'&&m.organizationId!==APP_CONFIG.requesterOrganizationId)errors.push(`需求者 Membership ${m.id} 不在需求者組織`);
      if(m.organizationId===APP_CONFIG.requesterOrganizationId&&m.role!=='requester'&&membershipStatus(m)!=='revoked')errors.push(`需求者組織出現非 requester：${m.id}`);
      if(membershipStatus(m)!=='revoked'){const key=`${m.userId}:${m.organizationId}`;if(liveMembershipKey.has(key))errors.push(`同一 User 在同一組織有多個未撤銷 Membership：${key}`);else liveMembershipKey.add(key);}
      if(m.role==='driver'&&isActiveMembership(m)&&!drivers.some(d=>d.userId===m.userId&&d.organizationId===m.organizationId&&d.active!==false))errors.push(`Driver Membership ${m.id} 缺少有效 Driver Profile`);
    });
    organizations.filter(o=>!o.systemManaged).forEach(o=>{const owners=memberships.filter(m=>m.organizationId===o.id&&m.role==='owner'&&membershipStatus(m)!=='revoked');if(owners.length>1)errors.push(`${o.name} 有 ${owners.length} 位未撤銷負責人`);if(owners.length===0)warnings.push(`${o.name} 尚未指定負責人`);});const taxMap=new Map();organizations.forEach(o=>{const tax=String(o.taxId||'').replace(/\D/g,'');if(!tax)return;if(taxMap.has(tax)&&taxMap.get(tax)!==o.id)errors.push(`統一編號重複：${tax}`);else taxMap.set(tax,o.id);});
    drivers.filter(d=>d.active!==false).forEach(d=>{if(!memberships.some(m=>m.userId===d.userId&&m.organizationId===d.organizationId&&m.role==='driver'&&isActiveMembership(m)))errors.push(`Driver Profile ${d.id} 沒有對應 active driver Membership`);if(Object.prototype.hasOwnProperty.call(d,'name')||Object.prototype.hasOwnProperty.call(d,'phone'))errors.push(`Driver Profile ${d.id} 不應重複保存姓名／手機，請由 User 讀取`);});
    membershipEvents.forEach(e=>{if(!memberships.some(m=>m.id===e.membershipId))warnings.push(`MembershipEvent ${e.id} 找不到 Membership ${e.membershipId}`);});
    const extKeys=new Set();external.forEach(x=>{const key=`${x.provider}:${x.providerUserId}`;if(extKeys.has(key))errors.push(`ExternalIdentity 重複：${key}`);else extKeys.add(key);if(!userIds.has(x.userId))errors.push(`ExternalIdentity ${x.id} 的 User 不存在`);});
    return {ok:errors.length===0,errors,warnings,checkedAt:nowISO()};
  }
};



function backendAuthToken(){return String(SessionStore.getItem(APP_CONFIG.authSessionTokenKey)||'');}
function persistBackendAuthToken(token){const value=String(token||'').trim();if(value)SessionStore.setItem(APP_CONFIG.authSessionTokenKey,value);else SessionStore.removeItem(APP_CONFIG.authSessionTokenKey);}
function backendApiError(message,code='BACKEND_ERROR'){const error=new Error(String(message||'後端服務錯誤'));error.code=code;return error;}
// V12.25.79 production hotfix: expose auth helpers across runtime scopes.
window.backendAuthToken=backendAuthToken;
window.backendApiError=backendApiError;
async function backendJsonPost(url,payload={},extraHeaders={}){
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json',...extraHeaders},credentials:'same-origin',cache:'no-store',body:JSON.stringify(payload)});
  const result=await response.json().catch(()=>null);
  if(response.status===404)throw backendApiError('Netlify Functions 尚未部署；請部署完整正式專案，不要只替換 index.html','FUNCTION_NOT_DEPLOYED');
  if(!response.ok||!result?.ok)throw backendApiError(result?.error?.message||`後端請求失敗（HTTP ${response.status}）`,result?.error?.code||`HTTP_${response.status}`);
  return result;
}

CloudIdentity=Object.freeze({
  token:backendAuthToken,
  saveSessionToken:persistBackendAuthToken,
  clearSessionToken(){persistBackendAuthToken('');},
  async registerRequester({name,email,phone,password}){
    const result=await backendJsonPost(APP_CONFIG.identityRegisterUrl,{
      name:String(name||'').trim(),email:String(email||'').trim(),phone:String(phone||'').replace(/\D/g,''),password:String(password||'')
    });
    const user=result?.data?.user||{},membership=result?.data?.membership||{};
    if(!user.userId||!membership.membershipId)throw backendApiError('後端未回傳完整的使用者／成員資格資料','INVALID_BACKEND_RESPONSE');
    this.saveSessionToken(result?.data?.sessionToken||'');
    return {user,membership,memberships:result?.data?.memberships||[membership],sessionToken:result?.data?.sessionToken||''};
  },
  async passwordLogin({phone,password}){
    const result=await backendJsonPost(APP_CONFIG.identityPasswordLoginUrl,{phone:String(phone||'').replace(/\D/g,''),password:String(password||'')});
    const data=result?.data||{};
    if(!data.user?.userId)throw backendApiError('登入後端未回傳使用者資料','INVALID_BACKEND_RESPONSE');
    this.saveSessionToken(data.sessionToken||'');
    return data;
  },
  async resumeSession(){
    const token=this.token();if(!token)throw backendApiError('登入工作階段不存在','SESSION_REQUIRED');
    const result=await backendJsonPost(APP_CONFIG.identitySessionUrl,{sessionToken:token});
    const data=result?.data||{};if(data.sessionToken)this.saveSessionToken(data.sessionToken);return data;
  },
  async createStaff({organizationId,name,phone,password,role,alsoRequester=false}){
    const token=this.token();if(!token)throw backendApiError('登入工作階段已遺失，請重新登入','SESSION_REQUIRED');
    const result=await backendJsonPost(APP_CONFIG.identityCreateStaffUrl,{sessionToken:token,organizationId,name:String(name||'').trim(),phone:String(phone||'').replace(/\D/g,''),password:String(password||''),role:String(role||''),alsoRequester:!!alsoRequester});
    return result?.data||{};
  },
  async requestPasswordReset({phone}){
    const result=await backendJsonPost(APP_CONFIG.identityRequestPasswordResetUrl,{phone:String(phone||'').replace(/\D/g,'')});return result?.data||{};
  },
  async confirmPasswordReset({phone,otp,newPassword}){
    const result=await backendJsonPost(APP_CONFIG.identityConfirmPasswordResetUrl,{phone:String(phone||'').replace(/\D/g,''),otp:String(otp||'').replace(/\D/g,''),newPassword:String(newPassword||'')});return result?.data||{};
  },
  async updateAccount({name,phone,newPassword='',currentPassword=''}){
    const token=this.token();if(!token)throw backendApiError('登入工作階段已遺失，請重新登入','SESSION_REQUIRED');
    const result=await backendJsonPost(APP_CONFIG.identityUpdateAccountUrl,{name:String(name||'').trim(),phone:String(phone||'').replace(/\D/g,''),newPassword:String(newPassword||''),currentPassword:String(currentPassword||'')},{Authorization:`Bearer ${token}`});
    const data=result?.data||{};if(data.sessionToken)this.saveSessionToken(data.sessionToken);return data;
  }
});

}


{
const passengerCount=t=>Number.isFinite(t.passengerCount)?t.passengerCount:(t.bookingIds?.length||1);
const round1=v=>Math.round(Number(v||0)*10)/10;

Analytics = {
  driverDaily(driverId,date){
    const cloud=(store.state.kpiDaily||[]).find(r=>r.driverId===driverId&&r.date===date);
    if(cloud)return {driverId,date,emptyKm:Number(cloud.emptyKm)||0,loadedKm:Number(cloud.loadedKm)||0,loadFactor:Number(cloud.loadFactor)||0,onTimeRate:cloud.onTimeRate===null?null:Number(cloud.onTimeRate),avgWaitMinutes:cloud.avgWaitMinutes===null?null:Number(cloud.avgWaitMinutes),avgPassengerWaitMinutes:cloud.avgWaitMinutes===null?null:Number(cloud.avgWaitMinutes),avgDriverWaitMinutes:null,avgTripDurationMinutes:null,cancellationRate:Number(cloud.cancellationRate)||0,poolRate:Number(cloud.poolRate)||0,completedTrips:Number(cloud.completedTrips)||0,scheduledTrips:Number(cloud.scheduledTrips)||0,utilizationKm:Number(cloud.utilizationKm)||0,onTimeStops:0,timedStops:0,passengerWaitMinutesTotal:0,passengerWaitCount:0,driverWaitMinutesTotal:0,driverWaitCount:0,durationMinutesTotal:0,durationCount:0,actualDistanceTrips:0,estimatedDistanceTrips:Number(cloud.scheduledTrips)||0,distanceDataQuality:'sheet'};
    const driver=Organization.driver(driverId),trips=Trip.forDriver(driverId,date);
    let emptyKm=0,loadedKm=0,loadNumerator=0,loadDenominator=0,onTimeStops=0,timedStops=0,passengerWaitTotal=0,passengerWaitCount=0,driverWaitTotal=0,driverWaitCount=0,durationTotal=0,durationCount=0,poolTrips=0,completed=0,cancelled=0,actualDistanceTrips=0,estimatedDistanceTrips=0;
    let previous=null;
    trips.forEach(t=>{
      if(t.status==='cancelled'){cancelled++;return;}
      const m=Trip.actualMetrics(t)||{},from=previous?tripLastDropoffAddress(previous):(driver?.serviceArea||''),to=tripFirstPickupAddress(t),actualEmpty=m.actualEmptyKm,actualLoaded=m.actualLoadedKm;
      if(actualEmpty!==null&&actualEmpty!==undefined)emptyKm+=actualEmpty;else emptyKm+=Number.isFinite(Number(t.estimatedEmptyKm))?Number(t.estimatedEmptyKm):Dispatch.estimateDriveKm(from,to);
      if(actualLoaded!==null&&actualLoaded!==undefined)loadedKm+=actualLoaded;else loadedKm+=Number.isFinite(Number(t.estimatedLoadedKm))?Number(t.estimatedLoadedKm):Dispatch.estimateDriveKm(tripFirstPickupAddress(t),tripLastDropoffAddress(t));
      if(actualEmpty!==null||actualLoaded!==null)actualDistanceTrips++;else estimatedDistanceTrips++;
      const vehicle=Organization.vehicle(t.vehicleId),cap=Math.max(1,vehicle?.capacity||1);loadNumerator+=Math.min(passengerCount(t),cap);loadDenominator+=cap;
      if(t.isPooled)poolTrips++;if(t.status==='completed')completed++;
      onTimeStops+=Number(m.onTimeStops)||0;timedStops+=Number(m.timedStops)||0;passengerWaitTotal+=Number(m.passengerWaitMinutesTotal)||0;passengerWaitCount+=Number(m.passengerWaitCount)||0;driverWaitTotal+=Number(m.driverWaitMinutesTotal)||0;driverWaitCount+=Number(m.driverWaitCount)||0;
      if(m.actualDurationMinutes!==null&&m.actualDurationMinutes!==undefined){durationTotal+=Number(m.actualDurationMinutes)||0;durationCount++;}
      previous=t;
    });
    const active=trips.length-cancelled,totalKm=emptyKm+loadedKm;
    return {driverId,date,emptyKm:round1(emptyKm),loadedKm:round1(loadedKm),loadFactor:loadDenominator?Math.round(loadNumerator/loadDenominator*100):0,onTimeRate:timedStops?Math.round(onTimeStops/timedStops*100):null,avgWaitMinutes:passengerWaitCount?round1(passengerWaitTotal/passengerWaitCount):null,avgPassengerWaitMinutes:passengerWaitCount?round1(passengerWaitTotal/passengerWaitCount):null,avgDriverWaitMinutes:driverWaitCount?round1(driverWaitTotal/driverWaitCount):null,avgTripDurationMinutes:durationCount?round1(durationTotal/durationCount):null,cancellationRate:trips.length?Math.round(cancelled/trips.length*100):0,poolRate:active?Math.round(poolTrips/active*100):0,completedTrips:completed,scheduledTrips:trips.length,utilizationKm:totalKm?Math.round(loadedKm/totalKm*100):0,onTimeStops,timedStops,passengerWaitMinutesTotal:round1(passengerWaitTotal),passengerWaitCount,driverWaitMinutesTotal:round1(driverWaitTotal),driverWaitCount,durationMinutesTotal:round1(durationTotal),durationCount,actualDistanceTrips,estimatedDistanceTrips,distanceDataQuality:actualDistanceTrips&&!estimatedDistanceTrips?'actual':actualDistanceTrips?'mixed':'estimated'};
  },
  fleetDaily(organizationId,date){
    const rows=Organization.drivers(organizationId).map(d=>this.driverDaily(d.id,date));
    const totalTrips=rows.reduce((s,r)=>s+r.scheduledTrips,0),completed=rows.reduce((s,r)=>s+r.completedTrips,0),emptyKm=rows.reduce((s,r)=>s+r.emptyKm,0),loadedKm=rows.reduce((s,r)=>s+r.loadedKm,0),timedStops=rows.reduce((s,r)=>s+r.timedStops,0),onTimeStops=rows.reduce((s,r)=>s+r.onTimeStops,0),passengerWaitCount=rows.reduce((s,r)=>s+r.passengerWaitCount,0),passengerWaitTotal=rows.reduce((s,r)=>s+r.passengerWaitMinutesTotal,0),driverWaitCount=rows.reduce((s,r)=>s+r.driverWaitCount,0),driverWaitTotal=rows.reduce((s,r)=>s+r.driverWaitMinutesTotal,0),durationCount=rows.reduce((s,r)=>s+r.durationCount,0),durationTotal=rows.reduce((s,r)=>s+r.durationMinutesTotal,0),actualDistanceTrips=rows.reduce((s,r)=>s+r.actualDistanceTrips,0),estimatedDistanceTrips=rows.reduce((s,r)=>s+r.estimatedDistanceTrips,0);
    const weighted=(key)=>totalTrips?Math.round(rows.reduce((s,r)=>s+(r[key]??0)*r.scheduledTrips,0)/totalTrips):0;
    return {date,totalTrips,completedTrips:completed,emptyKm:round1(emptyKm),loadedKm:round1(loadedKm),loadFactor:weighted('loadFactor'),onTimeRate:timedStops?Math.round(onTimeStops/timedStops*100):null,avgWaitMinutes:passengerWaitCount?round1(passengerWaitTotal/passengerWaitCount):null,avgPassengerWaitMinutes:passengerWaitCount?round1(passengerWaitTotal/passengerWaitCount):null,avgDriverWaitMinutes:driverWaitCount?round1(driverWaitTotal/driverWaitCount):null,avgTripDurationMinutes:durationCount?round1(durationTotal/durationCount):null,cancellationRate:weighted('cancellationRate'),poolRate:weighted('poolRate'),utilizationKm:(emptyKm+loadedKm)?Math.round(loadedKm/(emptyKm+loadedKm)*100):0,actualDistanceTrips,estimatedDistanceTrips,distanceDataQuality:actualDistanceTrips&&!estimatedDistanceTrips?'actual':actualDistanceTrips?'mixed':'estimated',drivers:rows};
  }
};
}


const NAVS=Object.freeze([
  {id:'requester-home',icon:'⌂',label:'我的首頁',permission:'requester.dashboard.read'},
  {id:'requester-new',icon:'＋',label:'我要預約',permission:'booking.create_own'},
  {id:'requester-bookings',icon:'≡',label:'我的預約',permission:'booking.read_own'},
  {id:'driver-home',icon:'⌂',label:'工作台',permission:'driver.dashboard.read'},
  {id:'driver-trips',icon:'≡',label:'我的行程',permission:'trip.read_own'},
  {id:'driver-kpi',icon:'◫',label:'我的關鍵績效',permission:'analytics.read_own'},
  {id:'dispatch-home',icon:'▦',label:'調度台',permission:'dispatch.dashboard.read'},
  {id:'dispatch-trips',icon:'≡',label:'派車／行程',permission:'trip.read_all'},
  {id:'dispatch-issues',icon:'!',label:'異常中心',permission:'issue.read'},
  {id:'owner-home',icon:'▦',label:'公司總覽',permission:'owner.dashboard.read'},
  {id:'owner-users',icon:'♙',label:'公司人員',permission:'company.staff.manage'},
  {id:'owner-vehicles',icon:'▣',label:'車輛管理',permission:'vehicle.manage'},
  {id:'platform-home',icon:'◇',label:'平台總覽',permission:'platform.dashboard.read'},
  {id:'platform-organizations',icon:'▦',label:'組織管理',permission:'platform.organization.manage'},
  {id:'platform-members',icon:'♙',label:'組織成員',permission:'platform.membership.manage'},
  {id:'platform-reports',icon:'!',label:'問題回報',permission:'platform.report.manage'},
  {id:'benefits',icon:'$',label:'補助管理',permission:'benefit.dashboard.read'},
  {id:'care-recipients',icon:'♧',label:'服務對象',permission:'care_recipient.directory.read'},
  {id:'demand-market',icon:'◎',label:'需求接案',permission:'booking.market.read'},
  {id:'account',icon:'☻',label:'我的帳戶',permission:'account.read_own'}
]);

const NAV_ICON_SVG=Object.freeze({
  'requester-home':'<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9 21v-6h6v6"/>',
  'requester-new':'<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 9h17M12 12v5M9.5 14.5h5"/>',
  'requester-bookings':'<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1.2 1.2L7.5 4.8M4 12l1.2 1.2 2.3-2.4M4 18l1.2 1.2 2.3-2.4"/>',
  'driver-home':'<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9 21v-6h6v6"/>',
  'driver-trips':'<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h4.5a3.5 3.5 0 0 1 0 7H9a3.5 3.5 0 0 0 0 7h8"/>',
  'driver-kpi':'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  'dispatch-home':'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'dispatch-trips':'<path d="M4 7h11M4 12h7M4 17h5"/><path d="M17 13.5 21 17l-4 3.5M21 17h-8"/>',
  'dispatch-issues':'<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.4v.1"/>',
  'owner-home':'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'owner-users':'<circle cx="9" cy="8" r="3"/><path d="M3.5 20c.4-4 2.4-6 5.5-6s5.1 2 5.5 6"/><circle cx="17.5" cy="9" r="2.3"/><path d="M15.5 15c3.4-.2 5 1.4 5.4 4"/>',
  'owner-vehicles':'<path d="m4 15 1.5-5h13l1.5 5"/><path d="M3 15h18v4H3z"/><circle cx="6.5" cy="19" r="1.5"/><circle cx="17.5" cy="19" r="1.5"/><path d="M7 10 8.5 6h7L17 10"/>',
  'platform-home':'<path d="m12 3 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/>',
  'platform-organizations':'<path d="M4 21V6l8-3v18M12 8h8v13M7 8h2M7 12h2M7 16h2M15 11h2M15 15h2M15 19h2"/>',
  'platform-members':'<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.8 20c.3-4 2.1-6 5.2-6s5 2 5.2 6M14 14.5c3.9-.2 6 1.6 6.4 5.5"/>',
  'platform-reports':'<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M12 7.5v4M12 14.5v.1"/>',
  'benefits':'<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 11h6M9 15h3"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="M17.5 15.5v4M16 17.5h3"/>',
  'care-recipients':'<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/><path d="M9 12h2l1-2 1.5 4 1-2H17"/>',
  'demand-market':'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  'account':'<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.6-4.5 3.1-7 7.5-7s6.9 2.5 7.5 7"/>'
});
function navIcon(id,fallback=''){
  const inner=NAV_ICON_SVG[id];
  if(!inner)return `<span class="nav-fallback">${escapeHTML(fallback)}</span>`;
  return `<svg class="nav-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const NAV_ORDER_BY_ROLE=Object.freeze({
  requester:['requester-home','requester-new','requester-bookings','benefits','account'],
  driver:['driver-home','driver-trips','driver-kpi','account'],
  dispatcher:['dispatch-home','demand-market','dispatch-trips','dispatch-issues','care-recipients','benefits','account'],
  owner:['owner-home','demand-market','dispatch-trips','owner-users','owner-vehicles','care-recipients','benefits','dispatch-issues','account'],
  super_admin:['platform-home','platform-organizations','platform-members','platform-reports','benefits','care-recipients','demand-market','account']
});
const MOBILE_PRIMARY_NAV_BY_ROLE=Object.freeze({
  requester:['requester-home','requester-new','requester-bookings','benefits'],
  driver:['driver-home','driver-trips','driver-kpi','account'],
  dispatcher:['dispatch-home','demand-market','dispatch-trips','dispatch-issues'],
  owner:['owner-home','dispatch-trips','owner-users','owner-vehicles'],
  super_admin:['platform-home','platform-organizations','platform-members','platform-reports']
});
const visibleNavs=()=>{
  const allowed=NAVS.filter(nav=>Identity.can(nav.permission)),order=NAV_ORDER_BY_ROLE[role()]||[];
  return [...allowed].sort((a,b)=>{const ai=order.indexOf(a.id),bi=order.indexOf(b.id);return (ai<0?999:ai)-(bi<0?999:bi)||NAVS.indexOf(a)-NAVS.indexOf(b);});
};
const canView=(viewId)=>NAVS.some(nav=>nav.id===viewId&&Identity.can(nav.permission));

let currentView='';
let currentDestination='';
let selectedBookingId='';
let selectedBookingLegId='';
let selectedCreateTripMutationKey='';
let selectedAssignTripId='';
let selectedAssignTripRevision=null;
let selectedHandoverTripId='';
let selectedHandoverIssueId='';
let selectedHandoverTripRevision=null;
let selectedResolveIssueId='';
let selectedFormalCorrectionTripId='';
let selectedFormalCorrectionTripRevision=null;
let selectedTripDate=dateKey();
let selectedCalendarMonth=dateKey().slice(0,7);
let demandMarketDate='';
let editingRequesterBookingId='';
let requesterWizardStep=1;
let requesterDraftDirty=false;
let dispatchTripFilters={quick:'all',driver:'all',vehicle:'all',query:''};
let selectedCareRecipientId='';
let pendingOrganizationStatusChange=null;
let optimizerDate=dateKey();
let optimizerObjectiveProfile='balanced';
let kpiDate=dateKey();
let clockTimer=null;
let bookingExpiryTimer=null;
let pendingProofLocation=null;
let pendingProofPhoto=null;

const role=()=>Identity.currentRole();
const orgId=()=>Identity.organizationId();
const currentDriver=()=>Organization.driverForUser(Identity.currentUser()?.id,Identity.membershipOrganizationId());
function preferredOperationalDate(){
  const today=dateKey(),scopeOrg=orgId();if(!scopeOrg)return today;
  const dates=[...new Set([
    ...(store.state.trips||[]).filter(t=>t.organizationId===scopeOrg&&t.date).map(t=>t.date),
    ...(store.state.bookings||[]).filter(b=>b.organizationId===scopeOrg&&b.pickupDate).map(b=>b.pickupDate)
  ])].sort();
  if(dates.includes(today))return today;
  return dates.find(d=>d>=today)||dates[dates.length-1]||today;
}
function driverOperationalDate(){ return selectedTripDate||preferredOperationalDate(); }
const statusPill=(status)=>{const cls=status==='completed'?'green':status==='in_progress'?'blue':status==='interrupted'?'purple':status==='cancelled'||status==='aborted'?'red':'yellow',symbol=status==='completed'?'✓':status==='cancelled'||status==='aborted'?'×':status==='interrupted'?'!':status==='in_progress'?'●':'○';return `<span class="pill ${cls}"><span class="status-symbol" aria-hidden="true">${symbol}</span>${STATUS_LABELS[status]||status}</span>`;};
const bookingStatusPill=(status)=>{const cls=status==='scheduled'?'green':status==='partially_scheduled'?'blue':status==='rejected'||status==='cancelled'||status==='expired'?'gray':'yellow',symbol=status==='scheduled'?'✓':status==='rejected'||status==='cancelled'||status==='expired'?'×':status==='partially_scheduled'?'●':'○',label=({pending:'待處理',partially_scheduled:'部分已排車',scheduled:'全部已排車',rejected:'不受理',cancelled:'已取消',expired:'已過期'})[status]||status;return `<span class="pill ${cls}"><span class="status-symbol" aria-hidden="true">${symbol}</span>${label}</span>`;};
const BOOKING_STATE_LABELS_UI=Object.freeze({open:'公開待接',claimed:'已接案',partially_scheduled:'部分已排車',scheduled:'全部已排車',rejected:'不受理',cancelled:'已取消',expired:'已過期'});
function bookingReasonOptions(action){
  const codes=action==='cancel'?['requester_schedule_change','requester_health','requester_no_longer_needed','requester_duplicate','other']:action==='release'?['provider_capacity','provider_time_conflict','provider_vehicle_mismatch','provider_out_of_area','provider_staffing','other']:['invalid_information','unsupported_service','duplicate_booking','provider_out_of_area','other'];
  return codes.map(code=>`<option value="${code}">${escapeHTML(Booking.reasonLabel(code))}</option>`).join('');
}
function openBookingAction(action,bookingId){
  const b=Booking.get(bookingId);if(!b){showToast('找不到預約');return;}
  const cfg=action==='cancel'?{title:'取消預約',desc:'取消代表需求本身終止，不會回到公開需求池。',hint:[Booking.STATE.PARTIALLY_SCHEDULED,Booking.STATE.SCHEDULED].includes(Booking.stateOf(b))?'尚未開始的單人 Trip 會同步取消；尚未開始的共乘 Trip 會原子化移除本需求並重新計算剩餘乘客路線。已開始行程仍需聯絡承接公司處理。':'若已被承接，承接公司會保留取消紀錄。',button:'確認取消'}:action==='release'?{title:'退回公開需求池',desc:'退單只解除目前承接關係，需求仍有效並重新開放其他服務單位接案。',hint:'原承接公司、操作者、原因與版本都會保留在 預約事件歷史。',button:'確認退回'}:{title:'標記不受理',desc:'不受理會終止這筆需求，不會重新回到公開需求池。',hint:'若只是目前公司無法承接，建議改用「退回公開池」。',button:'確認不受理'};
  $('bookingActionBookingId').value=bookingId;$('bookingActionType').value=action;$('bookingActionTitle').textContent=cfg.title;$('bookingActionDescription').textContent=cfg.desc;$('bookingActionReasonCode').innerHTML=bookingReasonOptions(action);$('bookingActionReasonText').value='';$('bookingActionHint').textContent=cfg.hint;$('confirmBookingActionBtn').textContent=cfg.button;$('confirmBookingActionBtn').className=`btn ${action==='release'?'warning':'danger'}`;openModal('bookingActionModal');
}
function bookingEventDetail(e){
  const parts=[]; if(e.fromState||e.toState)parts.push(`${BOOKING_STATE_LABELS_UI[e.fromState]||e.fromState||'—'} → ${BOOKING_STATE_LABELS_UI[e.toState]||e.toState||'—'}`); if(e.metadata?.label)parts.push(`Leg：${e.metadata.label}`); if(e.metadata?.revisionNo!==undefined)parts.push(`Revision ${e.metadata.revisionNo}`); if(Array.isArray(e.metadata?.changedFields)&&e.metadata.changedFields.length)parts.push(`修改：${e.metadata.changedFields.join('、')}`); if(e.metadata?.commercialSnapshotId)parts.push(`商業快照：${e.metadata.commercialSnapshotId}`); if(e.eventType==='duplicate_detected'){if(e.metadata?.score!==undefined)parts.push(`重複信心 ${e.metadata.score}/100`);if(Array.isArray(e.metadata?.reasons)&&e.metadata.reasons.length)parts.push(`判定：${e.metadata.reasons.join('、')}`);}  if(e.reasonCode)parts.push(`原因：${Booking.reasonText(e.reasonCode,e.reasonText)}`); else if(e.reasonText)parts.push(e.reasonText); if(e.organizationId)parts.push(`組織：${Organization.get(e.organizationId)?.name||e.organizationId}`); if(e.tripId)parts.push(`Trip：${e.tripId}`); if(e.bookingVersion)parts.push(`v${e.bookingVersion}`); return parts.join('・');
}
function openBookingHistory(bookingId){
  const userId=Identity.currentUser()?.id;if(!Booking.canReadEvents(bookingId,userId)){showToast('你沒有查看此預約異動歷史的權限');return;}
  const b=Booking.get(bookingId),rows=Booking.events(bookingId,userId),revisions=Booking.revisions(bookingId,userId),snapshots=[...(b?.commercialSnapshots||[])].sort((a,b)=>new Date(b.capturedAt)-new Date(a.capturedAt));$('bookingHistoryContext').textContent=`${b?.pickupDate||''} ${b?.pickupTime||''}｜${b?.name||'預約'}｜${bookingId}`;
  const eventHtml=rows.map(e=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(Booking.eventLabel(e.eventType))}</h4><p>${formatDateTime(e.createdAt)}・操作者：${escapeHTML(Booking.eventActorName(e.actorUserId))}<br>${escapeHTML(bookingEventDetail(e))}</p></div><span class="pill ${e.eventType==='cancelled'||e.eventType==='rejected'||e.eventType==='expired'?'gray':e.eventType==='released'?'yellow':'blue'}">${escapeHTML(({booking:'預約',system:'系統',google_sheet:'試算表匯入',import:'匯入',requester:'需求者'})[e.source]||'系統')}</span></div></div>`).join('')||'<div class="empty">目前沒有預約事件</div>';
  const revisionHtml=revisions.length?`<div class="issue-category-title">預約修訂歷史</div>${revisions.map(r=>`<div class="list-item"><h4>修訂版 ${r.revisionNo}</h4><p>${formatDateTime(r.createdAt)}・${escapeHTML(r.reasonText||'修改預約')}<br>修改欄位：${escapeHTML((r.changedFields||[]).join('、')||'—')}<br>修改前版本：${r.snapshot?.bookingVersion||'—'}</p></div>`).join('')}`:'';
  const snapshotHtml=`<div class="issue-category-title">報價／補助快照</div>${snapshots.map(x=>`<div class="list-item"><div class="list-item-head"><div><h4>預約版本 ${x.bookingVersion}・${'商業快照'}</h4><p>${formatDateTime(x.capturedAt)}<br>報價：${x.quote?.estimatedFare!=null?`新臺幣 ${Number(x.quote.estimatedFare).toLocaleString('zh-TW')} 元`:escapeHTML(({ruleset_required:'待載入規則',estimated:'已估算',unavailable:'無法估算'})[x.quote?.status]||'待載入規則')}<br>補助：${x.benefit?.estimatedSubsidy!=null?`新臺幣 ${Number(x.benefit.estimatedSubsidy).toLocaleString('zh-TW')} 元`:escapeHTML(({ruleset_required:'待載入規則',eligible_estimate:'預估符合',not_eligible:'預估不符合',insufficient_data:'資料不足'})[x.benefit?.status]||'待載入規則')}<br><span class="muted">定價規則集：${escapeHTML(x.quote?.pricingRulesetVersion||'未載入')}・補助規則集：${escapeHTML(x.benefit?.rulesetVersion||'未載入')}</span></p></div><span class="pill purple">不可變更</span></div></div>`).join('')||'<div class="empty">目前沒有商業快照</div>'}`;
  $('bookingHistoryList').innerHTML=eventHtml+revisionHtml+snapshotHtml;openModal('bookingHistoryModal');
}
async function confirmBookingAction(){
  const action=$('bookingActionType').value,bookingId=$('bookingActionBookingId').value,reasonCode=$('bookingActionReasonCode').value,reasonText=$('bookingActionReasonText').value.trim(),userId=Identity.currentUser()?.id;
  let result={ok:false,error:'不支援的預約操作'};
  if(action==='cancel')result=await Booking.cancelOwn(bookingId,userId,reasonCode,reasonText);
  else if(action==='release')result=Booking.release(bookingId,userId,reasonCode,reasonText);
  else if(action==='reject')result=Booking.reject(bookingId,userId,reasonCode,reasonText);
  if(!result.ok){showToast(result.error||'操作失敗');return;}
  closeModal('bookingActionModal');render();showToast(action==='cancel'?'預約已取消':action==='release'?'已退回公開需求池':'已標記不受理');
}
const phasePill=(type)=>`<span class="pill ${type==='dropoff'?'green':type==='pickup'?'yellow':'blue'}">${PHASE_LABELS[type]}</span>`;
function membershipStatusOptions(membership){
  const raw=Identity.membershipStatus(membership),current=raw==='suspended'?'revoked':raw,allowed=Identity.allowedMembershipTransitions(current);
  return allowed.map(status=>`<option value="${status}" ${status===current?'selected':''}>${MEMBERSHIP_STATUS_LABELS[status]||status}</option>`).join('');
}

function showToastRaw_(message){ const el=$('toast'); if(!el)return; el.textContent=message; el.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>el.classList.remove('show'),2600); }
function showToast(message){
  if(authoritativeProduction_?.()&&authoritativeSuccessToast_?.(message)&&authoritativePendingForCurrentActor_?.().length){
    if(typeof navigator!=='undefined'&&navigator.onLine===false){showToastRaw_('目前離線：操作只暫存在此裝置，尚未寫入正式資料庫');return;}
    showToastRaw_('正在寫入正式資料庫…');
    Promise.resolve(authoritativeFlush_()).then(r=>{if(r?.ok)showToastRaw_(message);else showToastRaw_(`操作未完成：${r?.error||'正式資料庫未確認'}`);}).catch(error=>showToastRaw_(`操作未完成：${error?.message||error}`));
    return;
  }
  showToastRaw_(message);
}
function clearFieldErrors(scope=document){
  if(!scope?.querySelectorAll)return;
  scope.querySelectorAll('.form-field.has-error').forEach(w=>w.classList.remove('has-error'));
  scope.querySelectorAll('[aria-invalid="true"]').forEach(el=>{el.removeAttribute('aria-invalid');if((el.getAttribute('aria-describedby')||'').endsWith('-error'))el.removeAttribute('aria-describedby');});
  scope.querySelectorAll('.field-error-message').forEach(el=>el.remove());
}
function markFieldError(fieldId,message,{focus=false}={}){
  const field=$(fieldId);if(!field)return false;const wrap=field.closest('.form-field')||field.parentElement;if(!wrap)return false;
  wrap.classList.add('has-error');field.setAttribute('aria-invalid','true');const errorId=`${fieldId}-error`;field.setAttribute('aria-describedby',errorId);
  let error=wrap.querySelector('.field-error-message');if(!error){error=document.createElement('div');error.className='field-error-message';error.id=errorId;wrap.appendChild(error);}error.textContent=message;
  if(focus){setTimeout(()=>{field.focus({preventScroll:true});field.scrollIntoView({block:'center',behavior:'smooth'});},0);}return true;
}
function validateFieldRules(scope,rules){
  clearFieldErrors(scope);let first=null;for(const rule of rules){const field=$(rule.id);if(!field)continue;let ok=true;try{ok=rule.test?!!rule.test(field):String(field.value||'').trim()!=='';}catch{ok=false;}if(!ok){markFieldError(rule.id,rule.message);if(!first)first=field;}}
  if(first){setTimeout(()=>{first.focus({preventScroll:true});first.scrollIntoView({block:'center',behavior:'smooth'});},0);showToast('請修正標示欄位');return false;}return true;
}
function routeFieldError(message,mapping){
  const text=String(message||'操作失敗');for(const [pattern,fieldId] of mapping){if(text.includes(pattern)&&markFieldError(fieldId,text,{focus:true})){showToast('請檢查標示欄位');return true;}}showToast(text);return false;
}
function showUndoSnackbar(message,onUndo,duration=7000){
  const bar=$('undoSnackbar'),msg=$('undoSnackbarMessage'),action=$('undoSnackbarAction');if(!bar||!msg||!action)return;
  clearTimeout(showUndoSnackbar.timer);showUndoSnackbar.handler=onUndo;msg.textContent=message;action.disabled=false;action.textContent='復原';bar.classList.add('show');
  showUndoSnackbar.timer=setTimeout(()=>{bar.classList.remove('show');showUndoSnackbar.handler=null;},duration);
}
async function runUndoSnackbar(){
  const action=$('undoSnackbarAction'),bar=$('undoSnackbar'),handler=showUndoSnackbar.handler;if(!handler)return;action.disabled=true;action.textContent='復原中…';
  try{await handler();bar?.classList.remove('show');showUndoSnackbar.handler=null;}catch(error){action.disabled=false;action.textContent='復原';showToast(error?.message||'復原失敗');}
}
function mobileIdentityLabel(){const o=currentOrg(),r=Identity.currentRole();return `${o?.name||'平台'}・${ROLE_LABELS[r]||r||(Identity.isSuperAdmin()?'超級管理者':'目前身分')}`;}
function renderMobileIdentityContext(){const btn=$('mobileIdentityContextText');if(btn)btn.textContent=mobileIdentityLabel();}
function openMobileIdentityContext(){
  const list=$('identityContextList');if(!list)return;const currentId=orgId(),options=Identity.availableOrganizations();
  list.innerHTML=options.map(({membership,organization,viewOnly})=>{const label=viewOnly?'查看模式':(ROLE_LABELS[membership?.role]||membership?.role||'');const active=organization.id===currentId;return `<button class="identity-context-option ${active?'active':''}" type="button" data-identity-org="${escapeHTML(organization.id)}"><span><strong>${escapeHTML(organization.name)}</strong><small>${escapeHTML(label||'目前組織')}</small></span><span class="check">${active?'✓':'›'}</span></button>`;}).join('')||'<div class="empty">目前沒有可切換的組織</div>';
  list.querySelectorAll('[data-identity-org]').forEach(btn=>btn.addEventListener('click',()=>{const target=btn.dataset.identityOrg;if(target===currentId){closeModal('identityContextModal');return;}closeModal('identityContextModal');switchOrganization(target);}));openModal('identityContextModal');
}
function offerCompletedStepUndo(tripId,stepId,stepName){
  const updated=Trip.get(tripId);if(!updated)return;const expectedRevision=updated.revision,actorUserId=Identity.currentUser()?.id;if(!actorUserId)return;
  showUndoSnackbar(`已完成「${stepName||'目前步驟'}」`,async()=>{const current=Trip.get(tripId);if(!current){showToast('找不到行程');return;}const key=Trip.mutationKey('undo_step',tripId,stepId,current.revision);const r=await Trip.withMutationLock(tripId,()=>Trip.undoLastStep(tripId,actorUserId,{expectedRevision:current.revision,expectedStepId:stepId,idempotencyKey:key}));if(!r.ok){showToast(r.error);render();return;}render();showToast(r.duplicate?'相同復原操作已處理':'已復原上一個完成步驟');});
}
function openModal(id){ $(id)?.classList.add('open'); }
function closeModal(id){ $(id)?.classList.remove('open'); }
function updateSyncUI(){ const online=navigator.onLine,pending=Trip?.offlineQueue?.()?.length||0,badge=$('onlineBadge'); if(badge){ badge.className=`pill ${online?'green':'yellow'}`; badge.textContent=online?(pending?`線上・${pending}待同步`:'線上'):(pending?`離線・${pending}待同步`:'離線執行'); } }
function currentOrg(){ return Identity.currentOrganization()||Organization.get(orgId()); }
function renderOrganizationSwitcher(){
  const select=$('organizationSwitcher'); if(!select) return;
  const options=Identity.availableOrganizations();
  if(options.length<=1){ select.classList.add('hidden'); select.innerHTML=''; return; }
  select.innerHTML=options.map(({membership,organization,viewOnly})=>`<option value="${organization.id}" ${organization.id===orgId()?'selected':''}>${escapeHTML(organization.name)}${viewOnly?'｜查看':`｜${ROLE_LABELS[membership?.role]||membership?.role||''}`}</option>`).join('');
  select.classList.remove('hidden');
}
function applyIdentityContext(){
  const user=Identity.currentUser(),membership=Identity.currentMembership(),currentRole=Identity.currentRole();
  if(!user) return false;
  if(!Identity.isSuperAdmin()&&(!membership||!Identity.isActiveMembership(membership))) return false;
  $('sideUserName').textContent=user.name||'使用者';
  $('sideRoleText').textContent=ROLE_LABELS[currentRole]||currentRole||'角色';
  $('roleBadge').textContent=ROLE_LABELS[currentRole]||currentRole||'';
  renderOrganizationSwitcher();
  renderMobileIdentityContext();
  return true;
}
function switchOrganization(organizationId){
  const previousView=currentView;
  const result=Identity.switchOrganization(organizationId);
  if(!result.ok){ showToast(result.error); renderOrganizationSwitcher(); return; }
  selectedTripDate=preferredOperationalDate(); selectedCalendarMonth=selectedTripDate.slice(0,7); optimizerDate=selectedTripDate; kpiDate=selectedTripDate; editingRequesterBookingId='';
  applyIdentityContext();
  if(Identity.isSuperAdmin()&&previousView==='platform-members') currentView='platform-members';
  else currentView=canView(previousView)?previousView:(visibleNavs()[0]?.id||'');
  renderNav(); render();
  showToast(`已切換至 ${result.organization?.name||'組織'}`);
}

// Auth service bridge: keep main runtime and release scripts on the same instances.
window.CloudIdentity=CloudIdentity;

function assertIdentityServicesReady_(){
  if(!CloudIdentity||typeof CloudIdentity.registerRequester!=='function'){
    throw new Error('帳號建立服務尚未完成初始化');
  }
  return true;
}


function openRegisterRequester(){
  clearFieldErrors($('registerRequesterModal'));
  $('registerNameInput').value='';$('registerEmailInput').value='';$('registerPhoneInput').value=$('loginPhone').value||'';$('registerPasswordInput').value='';openModal('registerRequesterModal');
}
async function confirmRegisterRequester(){
  const scope=$('registerRequesterModal');if(!validateFieldRules(scope,[
    {id:'registerNameInput',message:'請輸入姓名'},
    {id:'registerEmailInput',message:'請輸入有效的電子信箱',test:f=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value.trim())},
    {id:'registerPhoneInput',message:'請輸入 09 開頭的 10 位手機號碼',test:f=>/^09\d{8}$/.test(f.value.replace(/\D/g,''))},
    {id:'registerPasswordInput',message:'密碼至少需要 8 碼',test:f=>f.value.length>=8}
  ]))return;

  const btn=$('confirmRegisterBtn');
  const payload={
    name:$('registerNameInput').value.trim(),
    email:$('registerEmailInput').value.trim(),
    phone:$('registerPhoneInput').value.replace(/\D/g,''),
    password:$('registerPasswordInput').value
  };

  setButtonBusy(btn,true,'正在建立帳號…');
  try{
    let result;
    {
      assertIdentityServicesReady_();
      const cloud=await CloudIdentity.registerRequester(payload);
      result=Identity.startBackendSession({user:cloud.user,memberships:cloud.memberships||[cloud.membership],organizations:cloud.organizations||[],provider:'password'});
      if(!result.ok)throw new Error(`後端帳號已建立，但登入身分載入失敗：${result.error}`);
    }
    closeModal('registerRequesterModal');$('registerPasswordInput').value='';
    $('loginScreen').classList.add('hidden');$('appShell').classList.remove('hidden');setupApp();
    showToast('需求者帳號已建立');
  }catch(error){
    const message=String(error?.message||error||'建立帳號失敗');
    routeFieldError(message,[
      ['姓名','registerNameInput'],
      ['電子信箱','registerEmailInput'],
      ['Email','registerEmailInput'],
      ['手機','registerPhoneInput'],
      ['電話','registerPhoneInput']
    ]);
    if(!/姓名|電子信箱|Email|手機|電話/.test(message))showToast(message);
  }finally{
    setButtonBusy(btn,false);
  }
}
function formatLockCountdown(ms){
  const total=Math.max(0,Math.ceil(ms/1000)),m=Math.floor(total/60),s=total%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function renderLoginSecurityState(){
  const phone=$('loginPhone').value.trim(),state=LoginSecurity.status(phone),panel=$('loginSecurityPanel'),row=$('loginCaptchaRow'),msg=$('loginSecurityMessage'),loginBtn=$('loginBtn'),password=$('loginPassword'),forgot=$('forgotPasswordBtn');
  panel.classList.remove('warning','danger');forgot.classList.remove('security-required');
  password.disabled=false;loginBtn.disabled=false;
  if(state.forceReset){
    panel.classList.remove('hidden');panel.classList.add('danger');row.classList.add('hidden');msg.textContent=`此帳號已連續輸入錯誤 ${state.failures} 次，密碼登入已暫停。請先選擇「忘記密碼」設定新密碼。`;password.disabled=true;loginBtn.disabled=true;forgot.classList.add('security-required');forgot.textContent='必須先使用忘記密碼';return;
  }
  if(state.locked){
    panel.classList.remove('hidden');panel.classList.add('danger');row.classList.add('hidden');msg.textContent=`密碼輸入錯誤已達 ${state.failures} 次，暫停輸入 3 分鐘。剩餘 ${formatLockCountdown(state.remainingMs)}。`;password.disabled=true;loginBtn.disabled=true;forgot.textContent='忘記密碼';return;
  }
  if(state.captchaRequired){
    panel.classList.remove('hidden');panel.classList.add('warning');row.classList.remove('hidden');$('loginCaptchaCode').textContent=LoginSecurity.ensureCaptcha(phone);msg.textContent=`已連續輸入錯誤 ${state.failures} 次。從第 3 次起，下一次登入前必須先填寫隨機數字驗證碼。`;forgot.textContent='忘記密碼';return;
  }
  panel.classList.add('hidden');row.classList.add('hidden');msg.textContent='';$('loginCaptchaInput').value='';forgot.textContent='忘記密碼';
}
function openForgotPassword(){
  $('forgotPhoneInput').value=$('loginPhone').value;$('resetOtpInput').value='';$('newPasswordInput').value='';$('resetOtpHint').classList.add('hidden');openModal('forgotPasswordModal');
}
async function login(){
  const phone=$('loginPhone').value.trim(),
        password=$('loginPassword').value;

  const gate=LoginSecurity.beforeAttempt(
    phone,
    $('loginCaptchaInput').value
  );

  if(!gate.ok){
    enhanceStaticAccessibility();
    renderLoginSecurityState();
    showToast(gate.error);
    return;
  }

  const btn=$('loginBtn');
  setButtonBusy(btn,true,'登入中…');

  try{
    let result;

    {
      assertIdentityServicesReady_();

      const cloud=await CloudIdentity.passwordLogin({
        phone,
        password
      });

      // Backend authentication is authoritative. Establish the app session first;
      // Google Database hydration runs in the background and must not block login.
      result=Identity.startBackendSession({
        user:cloud.user,
        memberships:cloud.memberships||[],
        organizations:cloud.organizations||[],
        provider:'password'
      });

      if(!result.ok){
        throw window.backendApiError(
          result.error,
          result.reason||'SESSION_FAILED'
        );
      }
    }

    LoginSecurity.clear(phone);
    renderLoginSecurityState();

    $('loginPassword').value='';
    $('loginScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');

    setupApp();

    {
      setTimeout(async()=>{
        try{
          const sync=await AppStateDatabase.loadAll({
            silent:true,
            strictProduction:true
          });

          if(!sync?.ok){
            console.warn(
              '[Login] Google Database background sync failed',
              sync?.error||sync
            );
            updateSyncUI();
            return;
          }

          try{Benefit.migrate();}catch(error){
            console.warn('[Login] Benefit cloud normalization warning',error);
          }

          try{
            Trip.migrateRuntimeModel?.();
            Trip.migrateEventHistory?.();
            Trip.migratePassengerRuntimeHistory?.();
            Trip.migrateIssueStateModel?.();
          }catch(error){
            console.warn('[Login] Trip cloud normalization warning',error);
          }

          if(Identity.currentUser()){
            applyIdentityContext();
            renderNav();
            render();
            updateSyncUI();
          }
        }catch(error){
          console.warn(
            '[Login] Google Database background sync failed',
            error
          );
          updateSyncUI();
        }
      },150);
    }

  }catch(error){
    if(error?.code==='INVALID_CREDENTIALS'){
      const state=LoginSecurity.recordFailure(phone);
      $('loginCaptchaInput').value='';
      renderLoginSecurityState();

      if(state.forceReset){
        showToast('登入失敗次數已達上限，請使用忘記密碼重設');
      }else if(state.locked){
        showToast('登入暫停 3 分鐘');
      }else if(state.captchaRequired){
        showToast(
          `帳號或密碼錯誤；目前累計 ${state.failures} 次，下一次需填數字驗證碼`
        );
      }else{
        showToast('帳號或密碼錯誤');
      }
    }else if(error?.code==='LOGIN_RATE_LIMITED'){
      showToast(
        error?.message||
        '伺服器已暫停此手機的密碼登入，請稍後再試'
      );
    }else if(error?.code==='PASSWORD_RESET_REQUIRED'){
      showToast(
        error?.message||
        '伺服器要求先重設密碼'
      );
      setTimeout(()=>openForgotPassword(),350);
    }else{
      showToast(error?.message||'登入失敗');
    }
  }finally{
    setButtonBusy(btn,false);
  }
}
async function logout(){ const actor=authoritativeCurrentActor_();let flushed={ok:true};try{flushed=await store.flushAuthoritative?.()||{ok:true};}catch(error){flushed={ok:false,error};}if(!flushed.ok&&actor)authoritativeDiscardActorQueue_(actor);Identity.logout();clearProductionSensitiveCache_();clearInterval(clockTimer);clearInterval(bookingExpiryTimer);document.body.classList.remove('driver-mode');$('appShell').classList.add('hidden');$('loginScreen').classList.remove('hidden');if(!flushed.ok)showToast('尚未由伺服器確認的異動已丟棄，避免未同步資料殘留在此裝置');}
function setupApp(){
  if(!applyIdentityContext()){ logout(); return; }
  Booking.expireStaleOpen({source:'app_setup'});
  selectedTripDate=preferredOperationalDate();selectedCalendarMonth=selectedTripDate.slice(0,7);optimizerDate=selectedTripDate;kpiDate=selectedTripDate;
  currentView=visibleNavs()[0]?.id||''; renderNav(); render(); updateSyncUI();
  clearInterval(clockTimer);clearInterval(bookingExpiryTimer); clockTimer=setInterval(()=>{ if(Identity.can('trip.read_own')&&currentView==='driver-home') updateDriverClock(); },1000);
  bookingExpiryTimer=setInterval(()=>{const result=Booking.expireStaleOpen({source:'expiry_timer'});if(result.count>0)render();},60000);
}
function navGroupMeta(nav){
  const id=nav?.id||'';
  if(['requester-home','driver-home','dispatch-home','owner-home','platform-home'].includes(id))return ['today','今日工作'];
  if(['requester-new','requester-bookings','demand-market','dispatch-trips','dispatch-issues'].includes(id))return ['booking','預約與派車'];
  if(['owner-users','owner-vehicles','platform-members','platform-organizations'].includes(id))return ['resources','人員與車輛'];
  if(id==='care-recipients')return ['recipient','服務對象'];
  if(['driver-kpi','benefits'].includes(id))return ['analytics','數據與補助'];
  return ['system','系統與帳戶'];
}
function renderNav(){
  const navs=visibleNavs();
  const groups=[];
  navs.forEach(nav=>{const [key,label]=navGroupMeta(nav);let g=groups.find(x=>x.key===key);if(!g){g={key,label,items:[]};groups.push(g);}g.items.push(nav);});
  const desktopMarkup=groups.map(g=>`<div class="nav-group" data-nav-group="${g.key}"><div class="nav-group-title">${g.label}</div>${g.items.map(({id,icon,label})=>`<button class="nav-btn ${id===currentView?'active':''}" data-view="${id}" type="button"><span class="nav-icon-wrap" aria-hidden="true">${navIcon(id,icon)}</span><span>${label}</span></button>`).join('')}</div>`).join('');
  const useMore=navs.length>4;
  const mobilePriority=MOBILE_PRIMARY_NAV_BY_ROLE[role()]||[];
  const prioritized=[
    ...mobilePriority.map(id=>navs.find(n=>n.id===id)).filter(Boolean),
    ...navs.filter(n=>!mobilePriority.includes(n.id))
  ];
  const primaryNavs=useMore?prioritized.slice(0,4):navs;
  const primaryIds=new Set(primaryNavs.map(n=>n.id));
  const secondaryNavs=useMore?navs.filter(n=>!primaryIds.has(n.id)):[];
  const mobileMarkup=primaryNavs.map(({id,icon,label})=>`<button class="nav-btn ${id===currentView?'active':''}" data-view="${id}" type="button" aria-label="${escapeHTML(label)}"><span class="nav-icon-wrap" aria-hidden="true">${navIcon(id,icon)}</span><span>${label}</span></button>`).join('')+(useMore?`<button type="button" class="nav-btn mobile-more-btn ${secondaryNavs.some(n=>n.id===currentView)?'active has-active':''}" id="mobileMoreBtn" type="button" aria-label="更多功能"><span class="nav-icon-wrap" aria-hidden="true"><svg class="nav-symbol" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></span><span>更多</span></button>`:'');
  $('desktopNav').innerHTML=desktopMarkup;
  $('mobileNav').innerHTML=mobileMarkup;
  $('mobileNav').style.gridTemplateColumns=`repeat(${Math.max(primaryNavs.length+(useMore?1:0),1)},minmax(64px,1fr))`;
  const moreNav=$('mobileMoreNav');
  if(moreNav) moreNav.innerHTML=secondaryNavs.map(({id,icon,label})=>`<button class="nav-btn ${id===currentView?'active':''}" data-view="${id}" type="button"><span class="nav-icon-wrap" aria-hidden="true">${navIcon(id,icon)}</span><span>${label}</span></button>`).join('');
  document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>{
    if(!canView(btn.dataset.view)){ showToast('你沒有此頁面的檢視權限'); return; }
    const nextView=btn.dataset.view;
    let requesterDraftAutoSaved=false;
    if(currentView==='requester-new'&&nextView!=='requester-new'&&!editingRequesterBookingId&&requesterHasUnsavedDraftOnPage()){
      saveRequesterDraftFromDom({markDirty:false});
      requesterDraftDirty=false;
      requesterDraftAutoSaved=true;
    }
    currentView=nextView;if(currentView==='requester-new'){const d=loadRequesterDraft();requesterWizardStep=Math.max(1,Math.min(4,Number(d?.step)||1));} closeModal('mobileMoreModal'); renderNav(); render();
    if(requesterDraftAutoSaved)showToast('預約草稿已自動保存，可從首頁繼續填寫');
  }));
  $('mobileMoreBtn')?.addEventListener('click',()=>openModal('mobileMoreModal'));
}
function enhanceResponsiveTables(){
  const mobile=typeof window!=='undefined'&&window.matchMedia?.('(max-width:899px)').matches;
  $('contentRoot')?.querySelectorAll('table').forEach(table=>{
    const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    if(!headers.length)return;
    table.classList.add('mobile-card-table');
    table.querySelectorAll('tbody tr').forEach(row=>{
      [...row.children].forEach((cell,index)=>{
        if(cell.tagName!=='TD')return;
        const label=headers[index]||'';cell.dataset.label=label;
        if(mobile&&/(操作|動作|管理)/.test(label)&&!cell.querySelector('.mobile-table-actions')){
          const details=document.createElement('details');details.className='mobile-table-actions';
          const summary=document.createElement('summary');summary.textContent='主要／更多操作';details.appendChild(summary);
          const content=document.createElement('div');content.className='mobile-table-actions-content';
          while(cell.firstChild)content.appendChild(cell.firstChild);
          details.appendChild(content);cell.appendChild(details);
        }
      });
    });
  });
}
function bindInlineViewJumps(){
  $('contentRoot')?.querySelectorAll('[data-ui-view]').forEach(btn=>btn.addEventListener('click',()=>{
    const target=btn.dataset.uiView; if(!canView(target)){showToast('你沒有此頁面的檢視權限');return;} currentView=target; renderNav(); render();
  }));
}
function render(){
  const currentRoleClass=role();
  document.body.classList.remove('ui-role-requester','ui-role-driver','ui-role-dispatcher','ui-role-owner','ui-role-super_admin');
  document.body.classList.add(`ui-role-${currentRoleClass}`);
  document.body.classList.toggle('driver-mode',currentRoleClass==='driver');
  const nav=NAVS.find(n=>n.id===currentView);
  if(!currentView||!canView(currentView)){
    const fallback=visibleNavs()[0];
    if(!fallback){ $('topTitle').textContent='無可用功能'; $('contentRoot').innerHTML='<div class="empty">此帳號目前沒有可使用的功能，請聯絡管理員。</div>'; return; }
    currentView=fallback.id;
  }
  const activeNav=NAVS.find(n=>n.id===currentView); $('topTitle').textContent=activeNav?.label||'工作台';
  const renderer=VIEW_RENDERERS[currentView],root=$('contentRoot');
  root.setAttribute('aria-busy','true');
  root.innerHTML='<div class="ui-loading" aria-label="頁面載入中"><div class="ui-skeleton"></div><div class="ui-skeleton"></div><div class="ui-skeleton"></div></div>';
  try{
    root.innerHTML=renderer?renderer():'<div class="ui-state"><div class="ui-state-icon">○</div><h3>此頁尚未完成</h3><p>請從其他功能繼續操作。</p></div>';
  }catch(error){
    console.error('[介面呈現]',currentView,error);
    root.innerHTML=`<section class="ui-state error"><div class="ui-state-icon">!</div><h3>頁面資料載入失敗</h3><p>頁面：${escapeHTML(activeNav?.label||currentView)}<br>${escapeHTML(error?.message||'未知錯誤')}</p><button class="btn primary" id="retryCurrentViewBtn" type="button">重新載入此頁</button></section>`;
  }finally{root.setAttribute('aria-busy','false');}
  $('retryCurrentViewBtn')?.addEventListener('click',()=>render()); bindViewEvents(); bindRequesterWizardEvents(); bindInlineViewJumps(); enhanceResponsiveTables(); enhanceStaticAccessibility(); updateSyncUI(); if(Identity.can('trip.read_own')&&currentView==='driver-home') updateDriverClock();
}

function renderKpiCards(k){
  const f=(v,s='')=>v===null||v===undefined?'—':`${v}${s}`,distanceNote=k.distanceDataQuality==='actual'?`定位／里程表實績 ${k.actualDistanceTrips||0} 趟`:k.distanceDataQuality==='mixed'?`實績 ${k.actualDistanceTrips||0} 趟・估算 ${k.estimatedDistanceTrips||0} 趟`:`尚無里程實績・目前 ${k.estimatedDistanceTrips||0} 趟為估算`;
  return `<div class="kpi-grid">
    <div class="kpi-card"><span>空車公里</span><strong>${f(k.emptyKm,' 公里')}</strong><div class="kpi-sub">${escapeHTML(distanceNote)}</div></div>
    <div class="kpi-card"><span>平均載客率</span><strong>${f(k.loadFactor,'%')}</strong><div class="kpi-sub">目前仍依實際執行行程的車輛容量計算</div></div>
    <div class="kpi-card"><span>準時率</span><strong>${f(k.onTimeRate,'%')}</strong><div class="kpi-sub">依實際到站時間；延遲 ≤ 5 分</div></div>
    <div class="kpi-card"><span>乘客平均等待</span><strong>${f(k.avgPassengerWaitMinutes??k.avgWaitMinutes,' 分')}</strong><div class="kpi-sub">司機到站後平均等候：${f(k.avgDriverWaitMinutes,' 分')}</div></div>
    <div class="kpi-card"><span>取消率</span><strong>${f(k.cancellationRate,'%')}</strong></div>
    <div class="kpi-card"><span>共乘率</span><strong>${f(k.poolRate,'%')}</strong></div>
    <div class="kpi-card"><span>完成趟次</span><strong>${f(k.completedTrips,' 趟')}</strong><div class="kpi-sub">實際平均行程時間：${f(k.avgTripDurationMinutes,' 分')}</div></div>
    <div class="kpi-card"><span>載客里程占比</span><strong>${f(k.utilizationKm,'%')}</strong><div class="kpi-sub">有實際里程時優先使用實績</div></div>
  </div>`;
}
function renderDriverKpiTable(date){
  const canManageStatus=['owner','dispatcher'].includes(role());
  return `<div class="kpi-table-wrap"><table class="kpi-table"><thead><tr><th>司機／當日車輛</th><th>狀態</th><th>空車公里</th><th>載客率</th><th>準時率</th><th>等待</th><th>取消率</th><th>共乘率</th><th>完成</th></tr></thead><tbody>${Organization.drivers(orgId()).map(d=>{ const k=Analytics.driverDaily(d.id,date),plates=[...new Set(Trip.forDriver(d.id,date).map(t=>Organization.vehicle(t.vehicleId)?.plate).filter(Boolean))],statusClass=d.status==='on_duty'?'green':d.status==='unavailable'?'red':d.status==='break'?'yellow':'gray'; return `<tr><td><strong>${escapeHTML(d.name)}</strong><br>${escapeHTML(plates.join('、')||'尚無派車')}</td><td><span class="pill ${statusClass}">${escapeHTML(Organization.driverStatusLabel(d.status))}</span>${canManageStatus?`<div style="margin-top:6px">${d.status==='unavailable'?`<button type="button" class="btn outline sm driver-manager-status-btn" data-driver="${d.id}" data-status="off_duty">恢復可執勤</button>`:`<button type="button" class="btn danger sm driver-manager-status-btn" data-driver="${d.id}" data-status="unavailable">設為不可派車</button>`}</div>`:''}</td><td>${k.emptyKm}</td><td>${k.loadFactor}%</td><td>${k.onTimeRate??'—'}${k.onTimeRate!==null?'%':''}</td><td>${k.avgWaitMinutes??'—'}${k.avgWaitMinutes!==null?' 分':''}</td><td>${k.cancellationRate}%</td><td>${k.poolRate}%</td><td><strong>${k.completedTrips}</strong></td></tr>`; }).join('')}</tbody></table></div>`;
}

function careRecipientRoleLabel(rel){
  return ({self:'本人',spouse:'配偶',child:'子女',parent:'父母',sibling:'手足',family:'家屬',caregiver:'照顧者',other:'其他'})[rel?.relationship]||rel?.relationship||'關係人';
}
function careRecipientDirectoryRows(){
  const userId=Identity.currentUser()?.id||'';
  if(Identity.isSuperAdmin())return CareRecipient.list({includeArchived:true});
  if(role()==='requester')return CareRecipient.listForUser(userId,{includeArchived:true});
  if(Identity.can('care_recipient.read_served'))return CareRecipient.listServedByOrganization(Identity.membershipOrganizationId(),{includeArchived:false,actorUserId:userId});
  return [];
}
function careRecipientFixedNeedsText(recipient){
  const n=CareRecipient.defaultServiceNeeds(recipient),parts=[n.aidNeed,n.companions?`預設陪同 ${n.companions} 人`:null,n.specialNeed,n.requiresAccessibleVehicle?'需無障礙車':null,n.requiresEscort?'需陪同協助':null];
  return [...new Set(parts.filter(Boolean))].join('・')||'尚未設定固定需求';
}
function careRecipientsView(){
  const userId=Identity.currentUser()?.id||'',rows=careRecipientDirectoryRows(),active=rows.filter(r=>r.status==='active'),archived=rows.filter(r=>r.status==='archived'),managed=rows.filter(r=>CareRecipient.canManage(r.id,{actorUserId:userId}));
  const scope=Identity.isSuperAdmin()?'平台全部服務對象':role()==='owner'?'目前組織建立或曾承接的服務對象':'目前組織曾承接服務的對象';
  return `<div class="page-head"><div><h2>服務對象主檔</h2><p>${escapeHTML(scope)}。公開需求池與完整主檔權限分開管理。</p></div><div class="page-actions">${Identity.can('care_recipient.create')?'<button type="button" class="btn primary" id="openAddCareRecipientBtn">＋ 新增服務對象</button>':''}</div></div>
  <div class="metric-grid"><div class="metric"><span>目前可查看</span><strong>${rows.length}</strong><small>${escapeHTML(scope)}</small></div><div class="metric"><span>有效主檔</span><strong>${active.length}</strong><small>可建立新預約</small></div><div class="metric"><span>可管理</span><strong>${managed.length}</strong><small>本人／家屬／組織負責人或平台治理</small></div><div class="metric"><span>封存</span><strong>${archived.length}</strong><small>歷史保留、不刪除</small></div></div>
  ${Identity.can('care_recipient.read_served')&&!Identity.isSuperAdmin()?'<section class="card"><div class="smart-modal-hint"><strong>組織權限：</strong>負責人可新增並維護由目前組織建立的服務對象；對其他來源但曾由公司承接的服務對象維持唯讀。調度員只可查看曾承接服務的對象；公開需求在接案前仍只有去識別資訊。</div></section>':''}
  <div class="list">${rows.map(r=>{const rel=CareRecipient.relationForUser(userId,r.id),canManage=CareRecipient.canManage(r.id,{actorUserId:userId}),n=careRecipientFixedNeedsText(r);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(CareRecipient.displayName(r))}</h4><p>${formatPhone(CareRecipient.primaryPhone(r)||'')||'未填手機'}・${escapeHTML(CareRecipient.primaryAddress(r)||'未填地址')}<br>固定需求：${escapeHTML(n)}${rel?`<br>你的關係：${escapeHTML(careRecipientRoleLabel(rel))}${rel.canBook?'・可預約':''}${rel.canManageProfile?'・可管理主檔':''}`:''}</p></div><span class="pill ${r.status==='active'?'green':'gray'}">${r.status==='active'?'有效':'已封存'}</span></div><div class="item-actions"><button type="button" class="btn outline sm care-recipient-detail-btn" data-recipient="${r.id}">查看主檔</button>${canManage?`<button type="button" class="btn primary sm care-recipient-edit-btn" data-recipient="${r.id}">編輯</button>${r.status==='active'?`<button type="button" class="btn danger sm care-recipient-archive-btn" data-recipient="${r.id}">封存</button>`:`<button type="button" class="btn success sm care-recipient-restore-btn" data-recipient="${r.id}">恢復</button>`}`:''}</div></div>`;}).join('')||'<div class="empty">目前沒有可查看的服務對象。</div>'}</div>`;
}
function openCareRecipientEditor(recipientId=''){
  clearFieldErrors($('careRecipientEditModal'));
  const userId=Identity.currentUser()?.id||'',readResult=recipientId?CareRecipient.read(recipientId,{actorUserId:userId,organizationId:Identity.membershipOrganizationId()}):null,r=readResult?.ok?readResult.recipient:null;
  if(r&&!CareRecipient.canManage(r.id,{actorUserId:userId})){showToast('你沒有修改此服務對象的權限');return;}
  if(!r&&!Identity.can('care_recipient.create')){showToast('你沒有新增服務對象權限');return;}
  selectedCareRecipientId=r?.id||'';$('careRecipientEditId').value=r?.id||'';const selfRecipient=role()==='requester'&&r&&CareRecipient.selfForUser(userId)?.id===r.id;$('careRecipientEditTitle').textContent=selfRecipient?'編輯我的接送資料':(r?'編輯服務對象':'新增服務對象');
  $('crNameInput').readOnly=!!selfRecipient;$('crPhoneInput').readOnly=!!selfRecipient;
  $('crNameInput').value=selfRecipient?(Identity.currentUser()?.name||''):(r?.identity?.displayName||'');$('crPhoneInput').value=selfRecipient?(Identity.currentUser()?.phone||''):(r?.contacts?.primaryPhone||'');$('crBirthDateInput').value=r?.identity?.birthDate||'';$('crGenderInput').value=r?.identity?.gender||'unspecified';$('crAddressInput').value=r?.addresses?.primary||'';$('crEmergencyNameInput').value=r?.contacts?.emergencyContacts?.[0]?.name||'';$('crEmergencyPhoneInput').value=r?.contacts?.emergencyContacts?.[0]?.phone||'';
  $('crWalkingInput').value=r?.mobility?.walkingAbility||'unknown';$('crWheelchairInput').value=r?.mobility?.wheelchairType||'none';$('crAccessibleInput').value=String(!!r?.mobility?.requiresAccessibleVehicle);$('crEscortInput').value=String(!!r?.mobility?.requiresEscort);$('crTransferInput').value=r?.mobility?.transferAssistance||'unknown';$('crDefaultCompanionsInput').value=Number(r?.servicePreferences?.defaultCompanions||0)||0;$('crDefaultAidInput').value=r?.mobility?.defaultAidNeed||'';$('crDefaultSpecialInput').value=r?.mobility?.defaultSpecialNeeds||'';$('crNotesInput').value=r?.servicePreferences?.notes||'';openModal('careRecipientEditModal');
}
function saveCareRecipient(){
  const scope=$('careRecipientEditModal'),emergencyPhoneRaw=String($('crEmergencyPhoneInput').value||'').replace(/\D/g,'');if(!validateFieldRules(scope,[{id:'crNameInput',message:'請輸入姓名'},{id:'crPhoneInput',message:'請輸入有效主要聯絡手機',test:f=>/^09\d{8}$/.test(f.value.replace(/\D/g,''))},{id:'crAddressInput',message:'請輸入主要／常用上車地址'},...(emergencyPhoneRaw?[{id:'crEmergencyPhoneInput',message:'緊急聯絡電話格式不正確',test:f=>f.value.replace(/\D/g,'').length>=9}]:[])]))return;
  const actorUserId=Identity.currentUser()?.id||null,editingId=$('careRecipientEditId').value,existingRaw=editingId?CareRecipient.get(editingId):null,emergencyName=$('crEmergencyNameInput').value.trim(),emergencyPhone=String($('crEmergencyPhoneInput').value||'').replace(/\D/g,''),existingExtraContacts=(existingRaw?.contacts?.emergencyContacts||[]).slice(1),firstEmergency=(emergencyName||emergencyPhone)?[{id:existingRaw?.contacts?.emergencyContacts?.[0]?.id||undefined,name:emergencyName||'緊急聯絡人',relationship:existingRaw?.contacts?.emergencyContacts?.[0]?.relationship||'other',phone:emergencyPhone,priority:1}]:[],input={name:$('crNameInput').value.trim(),phone:$('crPhoneInput').value.trim(),birthDate:$('crBirthDateInput').value||null,gender:$('crGenderInput').value,address:$('crAddressInput').value.trim(),emergencyContacts:[...firstEmergency,...existingExtraContacts],mobility:{walkingAbility:$('crWalkingInput').value,wheelchairType:$('crWheelchairInput').value,requiresAccessibleVehicle:$('crAccessibleInput').value==='true',requiresEscort:$('crEscortInput').value==='true',transferAssistance:$('crTransferInput').value,defaultAidNeed:$('crDefaultAidInput').value.trim(),defaultSpecialNeeds:$('crDefaultSpecialInput').value.trim()},servicePreferences:{defaultPickupAddress:$('crAddressInput').value.trim(),defaultCompanions:Math.max(0,Number($('crDefaultCompanionsInput').value)||0),notes:$('crNotesInput').value.trim()}};
  const selfEditing=role()==='requester'&&editingId&&CareRecipient.selfForUser(actorUserId)?.id===editingId;if(selfEditing){input.name=Identity.currentUser()?.name||input.name;input.phone=Identity.currentUser()?.phone||input.phone;}
  let result;if($('careRecipientEditId').value){result=CareRecipient.update($('careRecipientEditId').value,{identity:{displayName:input.name,birthDate:input.birthDate,gender:input.gender},contacts:{primaryPhone:String(input.phone||'').replace(/\D/g,''),emergencyContacts:input.emergencyContacts},addresses:{primary:input.address,commonPickup:input.address},mobility:input.mobility,servicePreferences:input.servicePreferences},{actorUserId});}else result=CareRecipient.create(input,{actorUserId,organizationId:Identity.isSuperAdmin()?null:Identity.membershipOrganizationId(),linkUserId:null,relationship:'family',source:Identity.isSuperAdmin()?'platform_manual':'organization_owner_manual'});
  if(!result?.ok){routeFieldError(result?.error||'服務對象儲存失敗',[['姓名','crNameInput'],['手機','crPhoneInput'],['電話','crPhoneInput'],['地址','crAddressInput'],['緊急聯絡','crEmergencyPhoneInput'],['輪椅','crWheelchairInput']]);return;}closeModal('careRecipientEditModal');render();showToast($('careRecipientEditId').value?'服務對象主檔已更新':'服務對象已建立');
}
function openCareRecipientDetail(recipientId){
  const userId=Identity.currentUser()?.id||'',organizationId=Identity.membershipOrganizationId();if(!CareRecipient.canRead(recipientId,{actorUserId:userId,organizationId})){showToast('你沒有查看此服務對象完整資料的權限');return;}
  const readResult=CareRecipient.read(recipientId,{actorUserId:userId,organizationId});if(!readResult.ok){showToast(readResult.error);return;}const r=readResult.recipient;selectedCareRecipientId=r.id;const relations=CareRecipient.relationsForRecipient(r.id),history=CareRecipient.history(r.id),canManage=CareRecipient.canManageRelations(r.id,{actorUserId:userId}),showRelations=Identity.isSuperAdmin()||!!CareRecipient.relationForUser(userId,r.id),canAudit=Identity.can('care_recipient.audit.read');
  $('careRecipientDetailContent').innerHTML=`<div class="grid-equal"><section class="card"><div class="card-head"><div><h3>${escapeHTML(CareRecipient.displayName(r))}</h3><p>${r.status==='active'?'有效主檔':'已封存'}</p></div><span class="pill ${r.status==='active'?'green':'gray'}">${r.status==='active'?'有效':'封存'}</span></div><div class="meta">生日：${escapeHTML(r.identity?.birthDate||'未填')}<br>性別：${escapeHTML(({female:'女',male:'男',other:'其他',unspecified:'未指定'})[r.identity?.gender]||'未指定')}<br>手機：${formatPhone(CareRecipient.primaryPhone(r)||'')||'未填'}<br>緊急聯絡：${escapeHTML(r.contacts?.emergencyContacts?.[0]?.name||'未填')} ${formatPhone(r.contacts?.emergencyContacts?.[0]?.phone||'')}<br>地址：${escapeHTML(CareRecipient.primaryAddress(r)||'未填')}<br>固定需求：${escapeHTML(careRecipientFixedNeedsText(r))}<br>備註：${escapeHTML(r.servicePreferences?.notes||'無')}</div>${CareRecipient.canManage(r.id,{actorUserId:userId})?`<div class="item-actions"><button type="button" class="btn primary sm care-recipient-detail-edit-btn" data-recipient="${r.id}">編輯主檔</button></div>`:''}</section>${showRelations?`<section class="card"><div class="card-head"><div><h3>關係人</h3><p>使用者 ↔ 服務對象</p></div>${canManage?`<button type="button" class="btn outline sm care-recipient-add-relation-btn" data-recipient="${r.id}">＋ 新增</button>`:''}</div><div class="list">${relations.map(rel=>{const u=store.state.users.find(x=>x.id===rel.userId);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(u?.name||rel.userId)}</h4><p>${formatPhone(u?.phone||'')}<br>${rel.canBook?'✓ 可預約':'— 不可預約'}・${rel.canManageProfile?'✓ 可管理主檔':'— 不可管理主檔'}</p>${canManage?`<select class="inline-select cr-rel-relationship-select" data-relation="${rel.id}"><option value="self" ${rel.relationship==='self'?'selected':''}>本人</option><option value="spouse" ${rel.relationship==='spouse'?'selected':''}>配偶</option><option value="child" ${rel.relationship==='child'?'selected':''}>子女</option><option value="parent" ${rel.relationship==='parent'?'selected':''}>父母</option><option value="sibling" ${rel.relationship==='sibling'?'selected':''}>手足</option><option value="family" ${rel.relationship==='family'?'selected':''}>家屬</option><option value="caregiver" ${rel.relationship==='caregiver'?'selected':''}>照顧者</option><option value="other" ${rel.relationship==='other'?'selected':''}>其他</option></select>`:`<div class="small muted">${escapeHTML(careRecipientRoleLabel(rel))}</div>`}</div>${rel.isPrimaryContact?'<span class="pill blue">主要聯絡</span>':''}</div>${canManage?`<div class="item-actions"><button type="button" class="btn outline sm cr-rel-toggle-book-btn" data-relation="${rel.id}" data-next="${rel.canBook?'false':'true'}">${rel.canBook?'取消預約權':'開放預約權'}</button><button type="button" class="btn outline sm cr-rel-toggle-manage-btn" data-relation="${rel.id}" data-next="${rel.canManageProfile?'false':'true'}">${rel.canManageProfile?'取消管理權':'開放管理權'}</button>${rel.isPrimaryContact?'':`<button type="button" class="btn outline sm cr-rel-primary-btn" data-relation="${rel.id}">設為主要聯絡</button>`}<button type="button" class="btn danger sm cr-rel-revoke-btn" data-relation="${rel.id}">撤銷關係</button></div>`:''}</div>`;}).join('')||'<div class="empty">尚無關係人</div>'}</div></section>`:''}</div>${canAudit?`<section class="card"><div class="card-head"><div><h3>異動歷史</h3><p>主檔、封存、關係與合併事件皆保留</p></div><span class="pill purple">${history.length} 筆</span></div><div class="list">${history.slice(0,30).map(e=>{const actor=store.state.users.find(u=>u.id===e.actorUserId);const changes=Array.isArray(e.changes)&&e.changes.length?`<br>${e.changes.map(c=>`${escapeHTML(c.field)}：${escapeHTML(String(c.from))} → ${escapeHTML(String(c.to))}`).join('<br>')}`:'';return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(({created:'建立主檔',updated:'更新主檔',archived:'封存',restored:'恢復',relation_linked:'新增關係',relation_updated:'更新關係',relation_revoked:'撤銷關係',merged:'合併主檔',migrated:'第一階段歷史基準'})[e.eventType]||e.eventType)}</h4><p>${escapeHTML(e.detail||'')} ${changes}</p></div><span class="pill gray">${formatDateTime(e.createdAt)}</span></div><div class="small muted">操作者：${escapeHTML(actor?.name||'系統')}</div></div>`;}).join('')||'<div class="empty">尚無異動紀錄</div>'}</div></section>`:''}`;
  bindCareRecipientDetailEvents();openModal('careRecipientDetailModal');
}
function bindCareRecipientDetailEvents(){
  document.querySelector('.care-recipient-detail-edit-btn')?.addEventListener('click',e=>{closeModal('careRecipientDetailModal');openCareRecipientEditor(e.currentTarget.dataset.recipient);});
  document.querySelector('.care-recipient-add-relation-btn')?.addEventListener('click',e=>{openCareRecipientRelation(e.currentTarget.dataset.recipient);});
  document.querySelectorAll('.cr-rel-toggle-book-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=CareRecipient.updateRelation(btn.dataset.relation,{canBook:btn.dataset.next==='true'},Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}openCareRecipientDetail(selectedCareRecipientId);showToast('預約權限已更新');}));
  document.querySelectorAll('.cr-rel-toggle-manage-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=CareRecipient.updateRelation(btn.dataset.relation,{canManageProfile:btn.dataset.next==='true'},Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}openCareRecipientDetail(selectedCareRecipientId);showToast('主檔管理權限已更新');}));
  document.querySelectorAll('.cr-rel-relationship-select').forEach(select=>select.addEventListener('change',()=>{const result=CareRecipient.updateRelation(select.dataset.relation,{relationship:select.value},Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}openCareRecipientDetail(selectedCareRecipientId);showToast('關係已更新');}));
  document.querySelectorAll('.cr-rel-primary-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=CareRecipient.updateRelation(btn.dataset.relation,{isPrimaryContact:true},Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}openCareRecipientDetail(selectedCareRecipientId);showToast('已設為主要聯絡人');}));
  document.querySelectorAll('.cr-rel-revoke-btn').forEach(btn=>btn.addEventListener('click',()=>{if(!confirm('確定撤銷這位使用者與服務對象的關係？'))return;const result=CareRecipient.revokeRelation(btn.dataset.relation,Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}if(CareRecipient.canRead(selectedCareRecipientId,{actorUserId:Identity.currentUser()?.id,organizationId:Identity.membershipOrganizationId()}))openCareRecipientDetail(selectedCareRecipientId);else closeModal('careRecipientDetailModal');showToast('關係已撤銷');}));
}
function openCareRecipientRelation(recipientId){
  if(!CareRecipient.canManageRelations(recipientId,{actorUserId:Identity.currentUser()?.id})){showToast('你沒有管理關係人的權限');return;}$('crRelationRecipientId').value=recipientId;$('crRelationPhoneInput').value='';$('crRelationshipInput').value='family';$('crRelationCanBookInput').checked=true;$('crRelationCanManageInput').checked=false;openModal('careRecipientRelationModal');
}
function saveCareRecipientRelation(){
  const recipientId=$('crRelationRecipientId').value,phone=String($('crRelationPhoneInput').value||'').replace(/\D/g,''),user=(store.state.users||[]).find(u=>String(u.phone||'').replace(/\D/g,'')===phone&&u.active!==false);if(!user){showToast('找不到此手機的有效使用者；請先完成帳號建立');return;}if(CareRecipient.relationForUser(user.id,recipientId)){showToast('這個使用者已經是此服務對象的關係人');return;}
  const rel=CareRecipient.linkUser(user.id,recipientId,{relationship:$('crRelationshipInput').value,isPrimaryContact:false,canBook:$('crRelationCanBookInput').checked,canManageProfile:$('crRelationCanManageInput').checked,actorUserId:Identity.currentUser()?.id});if(!rel){showToast('建立關係失敗');return;}closeModal('careRecipientRelationModal');openCareRecipientDetail(recipientId);showToast('關係人已新增');
}
function requesterBookingsRows(){ return Booking.listForRequesterUser(Identity.currentUser()?.id||''); }
function bookingLegSummary(b){
  const legs=b?.legs||[]; if(!legs.length)return `${escapeHTML(b.pickupDate||'')} ${escapeHTML(b.pickupTime||'')}｜${escapeHTML(b.pickupAddress||'')} → ${escapeHTML(b.destination||'')}`;
  return legs.map(l=>{const p=l.requestedPickupAt?localDateTimeParts(l.requestedPickupAt):{date:'時間未填',time:''};const status=l.status==='scheduled'?'已排車':l.status==='cancelled'?'已取消':'待排車';const legOrgId=l.scheduledOrganizationId||l.assignedOrganizationId||b.organizationId||null,legOrg=Organization.get(legOrgId)?.name||'';const notes=[legOrg?`承接：${escapeHTML(legOrg)}`:'',l.pickup?.accessNote?`上車：${escapeHTML(l.pickup.accessNote)}`:'',l.dropoff?.accessNote?`下車：${escapeHTML(l.dropoff.accessNote)}`:''].filter(Boolean).join('・');return `${escapeHTML(l.label)} ${escapeHTML(p.date)} ${escapeHTML(p.time)}｜${escapeHTML(locationSnapshotAddress(l.pickup))} → ${escapeHTML(locationSnapshotAddress(l.dropoff))}（${escapeHTML(status)}）${notes?`<br><span class="muted small">${notes}</span>`:''}`;}).join('<br>');
}
function bookingNextLegLabel(b){ const leg=Booking.nextPendingLeg(b);return leg?.label||'行程'; }
function bookingLegOrganizationAssignmentControl(b){
  if(!Identity.can('booking.leg.assign_organization'))return '';
  const leg=Booking.nextPendingLeg(b);if(!leg)return '';
  const current=leg.assignedOrganizationId||b.organizationId||'';
  const options=Organization.serviceOrganizations().map(o=>`<option value="${escapeHTML(o.id)}" ${o.id===current?'selected':''}>${escapeHTML(o.name)}</option>`).join('');
  return `<select class="inline-select booking-leg-org-select" data-booking="${escapeHTML(b.id)}" data-leg="${escapeHTML(leg.id)}" aria-label="指定下一行程段承接組織"><option value="">指定 ${escapeHTML(leg.label||'下一行程段')} 承接組織</option>${options}</select>`;
}
function bookingServiceOrgName(booking){ return Organization.get(booking?.organizationId)?.name||(booking?.claimStatus==='open'?'公開需求池・等待接案':booking?.claimStatus==='expired'?'公開期限已到':'尚未指定承接單位'); }
const REQUESTER_BOOKING_DRAFT_PREFIX='careRideRequesterBookingDraftV2';
function requesterDraftKey(){ const userId=Identity.currentUser()?.id||''; return userId?`${REQUESTER_BOOKING_DRAFT_PREFIX}:${userId}`:''; }
function loadRequesterDraft(){
  const key=requesterDraftKey();if(!key)return null;
  try{const raw=LocalStore.getItem(key);if(!raw)return null;const d=JSON.parse(raw);if(!d||typeof d!=='object')return null;const age=Date.now()-new Date(d.updatedAt||0).getTime();if(Number.isFinite(age)&&age>30*24*60*60*1000){LocalStore.removeItem(key);return null;}return d;}catch(e){return null;}
}
function requesterDraftMeaningful(d){
  if(!d)return false;
  return !![d.pickupAddress,d.pickupAccessNote,d.destination,d.destinationAccessNote,d.specialNeed,d.note].some(v=>String(v||'').trim())||d.tripType==='來回'||!!d.aidNeed||String(d.companions??'')!==''||d.poolingConsent==='yes'||Number(d.step||1)>1;
}
function collectRequesterDraftFromDom(){
  if(editingRequesterBookingId)return null;
  const get=id=>$(id)?.value??'';
  return {step:Math.max(1,Math.min(4,Number(requesterWizardStep)||1)),pickupAddress:get('rqPickup').trim(),pickupAccessNote:get('rqPickupAccessNote').trim(),destination:get('rqDestination').trim(),destinationAccessNote:get('rqDestinationAccessNote').trim(),pickupDate:get('rqDate'),pickupTime:get('rqTime'),tripType:get('rqTripType')||'單程',returnDate:get('rqReturnDate'),returnTime:get('rqReturnTime'),aidNeed:get('rqAidNeed'),companions:get('rqCompanions'),specialNeed:get('rqSpecialNeed').trim(),poolingConsent:get('rqPoolingConsent')||'no',note:get('rqNote').trim(),updatedAt:nowISO()};
}
function saveRequesterDraftFromDom({markDirty=true}={}){
  if(editingRequesterBookingId)return null;const d=collectRequesterDraftFromDom(),key=requesterDraftKey();if(!d||!key)return null;
  try{if(requesterDraftMeaningful(d))LocalStore.setItem(key,JSON.stringify(d));else LocalStore.removeItem(key);}catch(e){}
  if(markDirty)requesterDraftDirty=requesterDraftMeaningful(d);return d;
}
function clearRequesterDraft(){const key=requesterDraftKey();if(key){try{LocalStore.removeItem(key);}catch(e){}}requesterDraftDirty=false;}
function requesterDraftSummary(d){
  if(!d)return '';
  const route=[d.pickupAddress||'尚未填上車地址',d.destination||'尚未填目的地'].join(' → '),time=[d.pickupDate||'日期未填',d.pickupTime||'時間未填'].join(' ');
  return `${route}・${time}`;
}
function requesterDraftHomeCard(){
  const d=loadRequesterDraft();if(!requesterDraftMeaningful(d))return '';
  const updated=d.updatedAt?formatDateTime(d.updatedAt):'最近';
  return `<section class="card requester-draft-card"><div class="card-head"><div><h3>你有一筆尚未完成的預約</h3><p>${escapeHTML(requesterDraftSummary(d))}</p></div><span class="pill blue">草稿</span></div><div class="draft-time">最後保存：${escapeHTML(updated)}・目前第 ${Math.max(1,Math.min(4,Number(d.step)||1))} / 4 步</div><div class="requester-draft-actions"><button class="btn primary" id="requesterResumeDraftBtn" type="button">繼續填寫</button><button class="btn outline" id="requesterDiscardDraftHomeBtn" type="button">捨棄草稿</button></div></section>`;
}
function requesterDraftInlineNotice(){
  const d=loadRequesterDraft();if(editingRequesterBookingId||!requesterDraftMeaningful(d))return '';
  return `<div class="requester-draft-inline" role="status"><div><strong>已載入尚未完成的預約草稿</strong><span>${escapeHTML(requesterDraftSummary(d))}<br>系統會在你輸入時自動保存。</span></div><button class="btn outline sm" id="requesterDiscardDraftBtn" type="button">捨棄草稿</button></div>`;
}
function bindRequesterDraftAutosave(){
  if(editingRequesterBookingId)return;
  ['rqPickup','rqPickupAccessNote','rqDestination','rqDestinationAccessNote','rqDate','rqTime','rqTripType','rqReturnDate','rqReturnTime','rqAidNeed','rqCompanions','rqSpecialNeed','rqPoolingConsent','rqNote'].forEach(id=>{const el=$(id);if(!el)return;const handler=()=>saveRequesterDraftFromDom({markDirty:true});el.addEventListener('input',handler);el.addEventListener('change',handler);});
}
function requesterHasUnsavedDraftOnPage(){const d=collectRequesterDraftFromDom();return requesterDraftMeaningful(d);}

function requesterHome(){
  const u=Identity.currentUser(),rows=requesterBookingsRows(),pending=rows.filter(b=>['pending','partially_scheduled'].includes(b.status)).length,scheduled=rows.filter(b=>b.status==='scheduled').length,next=[...rows].filter(b=>{const dt=Booking.dateTime(b);return ['pending','partially_scheduled','scheduled'].includes(b.status)&&!!dt&&dt>=new Date();}).sort((a,b)=>(Booking.dateTime(a)?.getTime()??Number.MAX_SAFE_INTEGER)-(Booking.dateTime(b)?.getTime()??Number.MAX_SAFE_INTEGER))[0];
  const recent=rows.slice(0,3);
  return `<section class="card requester-welcome"><div><h2>${escapeHTML(u?.name||'您好')}，今天需要接送嗎？</h2><p>預約長照接送、查看下一趟安排，或先試算可能適用的補助。</p></div><button class="btn" id="requesterQuickBookBtn" type="button">＋ 我要預約接送</button></section>
  ${requesterDraftHomeCard()}
  <div class="requester-quick-grid">
    <button class="requester-quick" id="requesterQuickBookCard" type="button"><span class="quick-icon">＋</span><strong>預約接送</strong><span>建立單程或來回需求</span></button>
    <button class="requester-quick" data-ui-view="requester-bookings" type="button"><span class="quick-icon">≡</span><strong>我的預約</strong><span>查看進度與歷史紀錄</span></button>
    <button class="requester-quick" data-ui-view="benefits" type="button"><span class="quick-icon">$</span><strong>補助試算</strong><span>快速查看可能適用額度</span></button>
  </div>
  <div class="requester-status-strip"><div><span>等待處理</span><strong>${pending}</strong></div><div><span>已安排</span><strong>${scheduled}</strong></div><div><span>全部預約</span><strong>${rows.length}</strong></div></div>
  ${next?`<section class="card requester-next"><div class="card-head"><div><h3>下一筆接送</h3><p>${escapeHTML(next.pickupDate)} ${escapeHTML(next.pickupTime)}・${escapeHTML(bookingServiceOrgName(next))}</p></div>${bookingStatusPill(next.status)}</div><div class="route-line"><strong>${escapeHTML(Booking.dispatchView(next)?.pickupAddress||next.pickupAddress)}</strong><br>↓<br><strong>${escapeHTML(Booking.dispatchView(next)?.destination||next.destination)}</strong></div><div class="item-actions"><button class="btn outline" data-ui-view="requester-bookings" type="button">查看預約詳情</button></div></section>`:`<section class="card requester-empty-state"><div class="empty-icon">🚐</div><h3>目前沒有待執行接送</h3><p>需要看診、復健、洗腎或日照接送時，可以直接建立預約需求。</p><button class="btn primary" id="requesterEmptyBookBtn" type="button">建立第一筆預約</button></section>`}
  <section class="card"><div class="card-head"><div><h3>最近預約</h3><p>只顯示最近 3 筆，需要完整紀錄可前往「我的預約」</p></div><button class="btn outline sm" id="requesterAllBookingsBtn" type="button">查看全部</button></div>${recent.map(b=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(b.pickupDate)} ${escapeHTML(b.pickupTime)}｜${escapeHTML(b.name)}</h4><p>${escapeHTML(bookingServiceOrgName(b))}<br>${bookingLegSummary(b)}</p></div>${bookingStatusPill(b.status)}</div></div>`).join('')||'<div class="ui-state"><div class="ui-state-icon">＋</div><h3>還沒有預約紀錄</h3><p>建立第一筆接送需求後，進度與歷史會顯示在這裡。</p></div>'}</section>`;
}

function requesterNew(){
  const u=Identity.currentUser(),tomorrow=dateKey(addMinutes(new Date(),24*60)),selfRecipient=CareRecipient.selfForUser(u?.id||'');
  const editing=editingRequesterBookingId?Booking.get(editingRequesterBookingId):null;
  if(editing&&(!Booking.canEditOwn(editing.id,u?.id).ok||editing.requestedByUserId!==u?.id))editingRequesterBookingId='';
  const b=editingRequesterBookingId?Booking.get(editingRequesterBookingId):null,draft=b?null:loadRequesterDraft();
  const fixed=selfRecipient?careRecipientFixedNeedsText(selfRecipient):'尚未建立；第一次送出預約時會自動建立你的接送主檔';
  const defaultPickup=b?.pickupAddress??(draft&&Object.prototype.hasOwnProperty.call(draft,'pickupAddress')?draft.pickupAddress:(selfRecipient?CareRecipient.defaultPickupAddress(selfRecipient):''));
  const tripType=b?.tripType||draft?.tripType||'單程',date=b?.pickupDate||draft?.pickupDate||tomorrow,time=b?.pickupTime||draft?.pickupTime||'09:00',returnDate=b?.returnDate||draft?.returnDate||date,returnTime=b?.returnTime||draft?.returnTime||'13:00';
  const aid=b?.aidNeed??draft?.aidNeed??'',companions=b?.companions===undefined||b?.companions===null?(draft?.companions??''):String(b.companions),title=b?'修改預約':'我要預約接送',submitLabel=b?'儲存預約修改':'送出接送需求';
  const step=Math.max(1,Math.min(4,Number(b?requesterWizardStep:(requesterWizardStep>1?requesterWizardStep:(draft?.step||1)))||1));
  requesterWizardStep=step;
  const indicator=(n,label,sub)=>`<button type="button" class="wizard-step-indicator ${step===n?'active':step>n?'done':''}" data-wizard-go="${n}" type="button" ${n>step+1?'disabled aria-disabled="true"':''}><strong><span class="num">${step>n?'✓':n}</span><span>${label}</span></strong><small>${sub}</small></button>`;
  const reviewRoute=`${defaultPickup||'尚未填上車地址'} → ${(b?.destination??draft?.destination)||'尚未填目的地'}`;
  return `<div class="page-head"><div><h2>${title}</h2><p>${b?'修改後系統會保留原紀錄；若已進入排車，請聯絡承接單位協助調整。':'只要 4 個步驟，依序確認乘車人、地點、時間與需求。'}</p></div>${b?'<div class="page-actions"><button type="button" class="btn outline" id="cancelRequesterEditBtn">放棄修改</button></div>':''}</div>
  ${requesterDraftInlineNotice()}
  <div class="booking-wizard" aria-label="預約接送四步驟">
    <div class="wizard-progress" aria-label="預約進度">${indicator(1,'接送對象','確認乘車人')}${indicator(2,'行程','上下車地點')}${indicator(3,'時間與需求','日期、共乘與特殊需求')}${indicator(4,'確認','檢查後送出')}</div>
    <section class="wizard-panel ${step===1?'active':''}" data-wizard-panel="1">
      <section class="card"><div class="card-head"><div><h3>接送對象</h3><p>本系統目前需求者預約固定為本人</p></div><span class="pill blue"><span class="status-symbol" aria-hidden="true">●</span>本人</span></div><div class="meta">姓名：${escapeHTML(u?.name||'')}<br>聯絡手機：${formatPhone(u?.phone||'')||'尚未設定'}<br>固定需求：${escapeHTML(fixed)}</div>${!selfRecipient?'<div class="wizard-help" style="margin-top:12px">第一次完成預約時，系統會自動建立你的本人接送主檔；不需要先到其他頁面設定。</div>':''}<div class="wizard-actions"><span class="small muted">第 1 / 4 步</span><div class="right"><button class="btn primary wizard-next-btn" data-next="2" type="button">下一步：填寫行程</button></div></div></section>
    </section>
    <section class="wizard-panel ${step===2?'active':''}" data-wizard-panel="2">
      <section class="card"><div class="card-head"><div><h3>從哪裡到哪裡</h3><p>請填完整門牌；公開需求池只會顯示行政區</p></div><span class="pill blue">2 / 4</span></div><div class="form-grid">
        <div class="form-field"><label for="rqPickup">上車地址</label><input id="rqPickup" value="${escapeHTML(defaultPickup)}" placeholder="請填完整地址與門牌" /></div>
        <div class="form-field"><label for="rqPickupAccessNote">上車注意事項 <span class="field-optional">選填</span></label><input id="rqPickupAccessNote" value="${escapeHTML(b?.pickupAccessNote??draft?.pickupAccessNote??'')}" placeholder="例如：巷口上車、地下室 B1" /></div>
        <div class="form-field"><label for="rqDestination">目的地</label><input id="rqDestination" value="${escapeHTML(b?.destination??draft?.destination??'')}" placeholder="例如：臺大醫院／完整地址" /></div>
        <div class="form-field"><label for="rqDestinationAccessNote">目的地注意事項 <span class="field-optional">選填</span></label><input id="rqDestinationAccessNote" value="${escapeHTML(b?.destinationAccessNote??draft?.destinationAccessNote??'')}" placeholder="例如：急診入口、接送區" /></div>
      </div><div class="wizard-actions"><button class="btn outline wizard-prev-btn" data-prev="1" type="button">上一步</button><div class="right"><button class="btn primary wizard-next-btn" data-next="3" type="button">下一步：時間與需求</button></div></div></section>
    </section>
    <section class="wizard-panel ${step===3?'active':''}" data-wizard-panel="3">
      <section class="card"><div class="card-head"><div><h3>時間與本次需求</h3><p>只填這一次不同的需求，固定需求會從本人接送主檔帶入</p></div><span class="pill blue">3 / 4</span></div><div class="form-grid">
        <div class="form-2"><div class="form-field"><label for="rqDate">去程日期</label><input id="rqDate" type="date" min="${dateKey()}" value="${escapeHTML(date)}" /></div><div class="form-field"><label for="rqTime">去程接送時間</label><input id="rqTime" type="time" value="${escapeHTML(time)}" /></div></div>
        <div class="form-field"><label for="rqTripType">行程類型</label><select id="rqTripType"><option value="單程" ${tripType==='單程'?'selected':''}>單程</option><option value="來回" ${tripType==='來回'?'selected':''}>來回</option></select></div>
        <div class="form-2 ${tripType==='來回'?'':'hidden'}" id="rqReturnFields"><div class="form-field"><label for="rqReturnDate">回程日期</label><input id="rqReturnDate" type="date" min="${dateKey()}" value="${escapeHTML(returnDate)}" /></div><div class="form-field"><label for="rqReturnTime">回程接送時間</label><input id="rqReturnTime" type="time" value="${escapeHTML(returnTime)}" /></div></div>
        <div class="form-2"><div class="form-field"><label for="rqAidNeed">本次輪椅／輔具需求</label><select id="rqAidNeed"><option value="" ${aid===''?'selected':''}>沿用固定需求／無</option><option value="手動輪椅" ${aid==='手動輪椅'?'selected':''}>手動輪椅</option><option value="電動輪椅" ${aid==='電動輪椅'?'selected':''}>電動輪椅</option><option value="助行器" ${aid==='助行器'?'selected':''}>助行器</option><option value="其他輔具" ${aid==='其他輔具'?'selected':''}>其他輔具</option></select></div><div class="form-field"><label for="rqCompanions">本次陪同人數</label><select id="rqCompanions"><option value="" ${companions===''?'selected':''}>沿用固定需求</option>${[0,1,2,3,4,5,6].map(n=>`<option value="${n}" ${companions===String(n)?'selected':''}>${n} 人${n===0?'（本次無陪同）':''}</option>`).join('')}</select></div></div>
        <div class="form-field"><label for="rqSpecialNeed">本次特殊需求</label><input id="rqSpecialNeed" value="${escapeHTML(b?.specialNeed??draft?.specialNeed??'')}" placeholder="例如：需要協助上下車、不可久候" /></div>
        <div class="form-field"><label for="rqPoolingConsent">是否同意共乘</label><select id="rqPoolingConsent"><option value="no" ${(b?.poolingConsent??draft?.poolingConsent??'no')==='no'?'selected':''}>不同意共乘</option><option value="yes" ${(b?.poolingConsent??draft?.poolingConsent??'no')==='yes'?'selected':''}>同意由服務單位依地方規則安排共乘</option></select></div>
        <div class="form-field"><label for="rqNote">備註 <span class="field-optional">選填</span></label><textarea id="rqNote" placeholder="其他想告訴承接服務端的事情">${escapeHTML(b?.note??draft?.note??'')}</textarea></div>
        <div class="wizard-help"><strong>共乘不會自動成立：</strong>系統仍會檢查時間、繞路、座位、陪同者、輪椅容量與所在地規則。</div>
      </div><div class="wizard-actions"><button class="btn outline wizard-prev-btn" data-prev="2" type="button">上一步</button><div class="right"><button class="btn primary wizard-next-btn" data-next="4" type="button">下一步：確認資料</button></div></div></section>
    </section>
    <section class="wizard-panel ${step===4?'active':''}" data-wizard-panel="4">
      <section class="card"><div class="card-head"><div><h3>確認並送出</h3><p>請再次確認接送對象、行程與需求</p></div><span class="pill green">4 / 4</span></div>
        ${b?`<div class="smart-modal-hint" style="margin-bottom:12px"><strong>目前費用與補助資訊：</strong>${escapeHTML(Booking.commercialSummary(b))}<br>儲存後會依目前規則重新計算，原本的紀錄仍會保留。</div>`:''}
        <div class="wizard-review" id="requesterWizardReview"><div class="wizard-review-row"><span>接送對象</span><strong>${escapeHTML(u?.name||'')}（本人）</strong></div><div class="wizard-review-row"><span>行程</span><strong id="wizardReviewRoute">${escapeHTML(reviewRoute)}</strong></div><div class="wizard-review-row"><span>時間</span><strong id="wizardReviewTime">${escapeHTML(date)} ${escapeHTML(time)}・${escapeHTML(tripType)}</strong></div><div class="wizard-review-row"><span>固定需求</span><strong>${escapeHTML(fixed)}</strong></div><div class="wizard-review-row"><span>報價／補助</span><strong>${b?escapeHTML(Booking.commercialSummary(b)):'送出時會依目前可用規則估算；若沒有正式資料，會顯示尚無估算結果'}</strong></div></div>
        <div class="wizard-actions"><button class="btn outline wizard-prev-btn" data-prev="3" type="button">上一步</button><div class="right"><button class="btn primary" id="submitRequesterBookingBtn" type="button">${submitLabel}</button></div></div>
      </section>
    </section>
  </div>`;
}
function requesterBookings(){
  const rows=requesterBookingsRows(),userId=Identity.currentUser()?.id;
  return `<div class="page-head"><div><h2>我的預約</h2><p>查看你建立的接送需求、目前進度，以及現在可修改或取消的項目。</p></div><div class="page-actions"><button type="button" class="btn primary" id="requesterNewBookingBtn">＋ 新增預約</button></div></div>
  <div class="list">${rows.map(b=>{const canCancel=Identity.can('booking.cancel_own')&&Booking.canCancelOwn(b.id,userId).ok,canEdit=Identity.can('booking.edit_own')&&Booking.canEditOwn(b.id,userId).ok;return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(b.pickupDate)} ${escapeHTML(b.pickupTime)}｜${escapeHTML(b.name)}</h4><p>服務組織：${escapeHTML(bookingServiceOrgName(b))}<br>${bookingLegSummary(b)}<br>${escapeHTML(Booking.needsText(b))}<br>共乘：${Dispatch.bookingPoolingConsented(b)?'已同意由服務單位依規則安排':'不同意共乘'}<br><span class="muted small">${escapeHTML(Booking.commercialSummary(b))}・修訂版 ${Math.max(0,Number(b.revisionNo)||0)}・版本 ${Math.max(1,Number(b.version)||1)}</span></p></div>${bookingStatusPill(b.status)}</div><div class="item-actions">${canEdit?`<button type="button" class="btn primary sm requester-edit-booking-btn" data-booking="${b.id}">修改預約</button>`:''}${canCancel?`<button type="button" class="btn danger sm requester-cancel-booking-btn" data-booking="${b.id}">取消預約</button>`:''}<button type="button" class="btn outline sm booking-history-btn" data-booking="${b.id}">異動歷史</button>${['partially_scheduled','scheduled'].includes(b.status)&&!canCancel?'<span class="pill green">已進入排車／執行／共乘時請聯絡承接公司</span>':''}</div></div>`;}).join('')||'<div class="ui-state"><div class="ui-state-icon">🚐</div><h3>目前沒有預約</h3><p>有看診、復健、洗腎或日照接送需求時，可以建立第一筆預約。</p><button class="btn primary" id="requesterEmptyNewBookingBtn" type="button">＋ 建立預約</button></div>'}</div>`;
}
function demandMarket(){
  const userId=Identity.currentUser()?.id,rows=Booking.openDemand(demandMarketDate||null,userId),membershipOrgId=Identity.membershipOrganizationId(),canClaim=Identity.can('booking.market.claim')&&!!membershipOrgId;
  const org=membershipOrgId?Organization.get(membershipOrgId):null;
  const myClaims=membershipOrgId?Booking.listClaimedByUser(membershipOrgId,userId).filter(b=>Booking.stateOf(b)===Booking.STATE.CLAIMED).map(b=>Booking.dispatchView(b)):[];
  return `<div class="page-head"><div><h2>公開需求接案池</h2><p>僅服務端工作角色與平台管理者可查看；需求者本人不會看到此頁。未接案前只顯示必要、去識別化資訊。</p></div><div class="page-actions"><input class="inline-date" id="demandMarketDateInput" type="date" min="${dateKey()}" value="${escapeHTML(demandMarketDate)}" /><button class="btn outline sm" id="clearDemandDateBtn" type="button">全部日期</button></div></div>
  <div class="metric-grid"><div class="metric"><span>公開待接</span><strong>${rows.length}</strong><small>尚未綁定任何組織</small></div><div class="metric"><span>你的身分</span><strong style="font-size:16px">${escapeHTML(ROLE_LABELS[role()]||role()||'-')}</strong><small>${canClaim?'可接案':'僅可查看'}</small></div><div class="metric"><span>接案單位</span><strong style="font-size:14px">${escapeHTML(org?.name||'—')}</strong><small>${canClaim?'接案後鎖定到此組織':'需切換至服務端組織身分'}</small></div><div class="metric"><span>我尚未排車的接案</span><strong>${myClaims.length}</strong><small>可在排車前退回公開池</small></div></div>
  <section class="card"><div class="smart-modal-hint"><strong>接案流程：</strong>需求者送單 → 公開需求池 → 調度人員／負責人依時間與區域接案 → 預約綁定承接組織 → 調度再安排實際司機與車輛。司機不會看到公開需求池；接案前服務端管理角色也不會取得完整聯絡資料。<br><strong>接案評分：</strong>0–100 分只代表目前組織的資源適配度，綜合可執行資源、預估空車、服務區域、既有需求共乘機會與工作量；不會自動搶單或改變併發鎖。<br><strong>有效期限：</strong>一般需求在預定接送前 30 分鐘停止公開接案；若建立時已距接送不足 30 分鐘，則可接案到預定接送時間。</div></section>
  <div class="list">${rows.map(b=>{const fit=membershipOrgId?Dispatch.marketFitScore(b,membershipOrgId,userId):null,fitClass=fit?.hardBlocked?'bad':fit?.score>=80?'good':fit?.score>=60?'warn':'bad';return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(b.pickupDate)} ${escapeHTML(b.pickupTime)}｜匿名需求</h4><p>${escapeHTML(b.pickupArea)} → ${escapeHTML(b.destinationArea)}<br>行程：${escapeHTML(b.tripType)}${b.tripType==='來回'&&b.returnDate?`・回程 ${escapeHTML(b.returnDate)} ${escapeHTML(b.returnTime)}`:''}<br>目的地概略：${escapeHTML(b.destinationLabel)}<br>${escapeHTML(b.needsSummary)}<br><span class="muted small">接案有效至：${b.marketExpiresAt?escapeHTML(formatDateTime(b.marketExpiresAt)):'依接送時間截止'}</span></p></div><span class="pill blue">公開待接</span></div>${fit?`<div class="market-fit"><div class="market-fit-head"><span class="market-fit-title">目前公司的接案適配</span><span class="market-fit-score ${fitClass}">${fit.hardBlocked?'不建議':`${fit.score}/100・${escapeHTML(fit.grade)}`}</span></div><div class="market-fit-reasons">${fit.reasons.map(r=>`• ${escapeHTML(r)}`).join('<br>')}${fit.breakdown&&Object.keys(fit.breakdown).length?`<br><strong>分數：</strong>資源 ${fit.breakdown.feasibility||0}・空車 ${fit.breakdown.deadhead||0}・區域 ${fit.breakdown.area||0}・共乘 ${fit.breakdown.pooling||0}・負載 ${fit.breakdown.balance||0}`:''}</div></div>`:''}<div class="item-actions">${canClaim?`<button type="button" class="btn primary sm demand-claim-btn" data-booking="${b.id}" data-version="${b.version}" ${fit?.hardBlocked?'disabled title="目前沒有可執行資源組合"':''}>由 ${escapeHTML(org?.name||'目前組織')} 接案</button>`:'<span class="pill gray">目前身分僅可查看</span>'}</div></div>`;}).join('')||'<div class="empty">目前沒有符合條件的公開需求。</div>'}</div>
  ${myClaims.length?`<section class="card" style="margin-top:16px"><div class="card-head"><div><h3>我已接案・尚未排車</h3><p>原接案人可在建立行程前退回公開需求池。</p></div><span class="pill yellow">${myClaims.length} 筆</span></div><div class="list">${myClaims.map(b=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(b.pickupDate)} ${escapeHTML(b.pickupTime)}｜${escapeHTML(b.name)}</h4><p>${bookingLegSummary(b)}<br>${escapeHTML(Booking.needsText(b))}</p></div><span class="pill yellow">已接案</span></div><div class="item-actions"><button type="button" class="btn warning sm booking-release-btn" data-booking="${b.id}">退回公開池</button><button type="button" class="btn outline sm booking-history-btn" data-booking="${b.id}">異動歷史</button></div></div>`).join('')}</div></section>`:''}`;
}


function accountAvatar(user,fallback='☺'){
  return user?.profilePhotoDataUrl?`<div class="avatar profile-avatar"><img src="${escapeHTML(user.profilePhotoDataUrl)}" alt="個人照片" /></div>`:`<div class="avatar">${fallback}</div>`;
}
function profilePhotoSection(user,fallback='☺'){
  const preview=user?.profilePhotoDataUrl?`<img src="${escapeHTML(user.profilePhotoDataUrl)}" alt="個人照片預覽" />`:fallback;
  return `<section class="card"><div class="card-head"><div><h3>個人照片</h3><p>照片由本人手動上傳，社群登入不會自動抓取社群大頭照。</p></div></div><div class="profile-photo-editor"><div class="profile-photo-preview">${preview}</div><div><div class="profile-photo-actions"><label class="btn outline sm" for="profilePhotoInput">選擇照片</label><input class="profile-photo-input" id="profilePhotoInput" type="file" accept="image/*" />${user?.profilePhotoDataUrl?'<button class="btn danger sm" id="removeProfilePhotoBtn" type="button">移除照片</button>':''}</div><p class="small muted" style="margin:8px 0 0">會縮小至 320×320 內並儲存在目前瀏覽器快取；帳號與權限仍以伺服器資料為準。</p></div></div></section>`;
}
function resizeProfilePhoto(file){
  return new Promise((resolve,reject)=>{
    if(!file?.type?.startsWith('image/')){reject(new Error('請選擇圖片檔案'));return;}
    if(file.size>8*1024*1024){reject(new Error('圖片請小於 8 MB'));return;}
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('無法讀取圖片'));
    reader.onload=()=>{const img=new Image();img.onerror=()=>reject(new Error('圖片格式無法處理'));img.onload=()=>{const max=320,scale=Math.min(1,max/Math.max(img.width,img.height)),w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale)),canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);resolve(canvas.toDataURL('image/jpeg',.82));};img.src=reader.result;};
    reader.readAsDataURL(file);
  });
}
async function saveProfilePhoto(file){
  const user=Identity.currentUser();if(!user||!file)return;
  try{const dataUrl=await resizeProfilePhoto(file);store.mutate(db=>{const u=db.users.find(x=>x.id===user.id);u.profilePhotoDataUrl=dataUrl;u.updatedAt=nowISO();});Audit.log('identity.profile_photo_updated','更新個人照片',{actorUserId:user.id});render();showToast('個人照片已更新');}catch(error){showToast(error.message||'照片處理失敗');}
}
function removeProfilePhoto(){
  const user=Identity.currentUser();if(!user)return;store.mutate(db=>{const u=db.users.find(x=>x.id===user.id);delete u.profilePhotoDataUrl;u.updatedAt=nowISO();});Audit.log('identity.profile_photo_removed','移除個人照片',{actorUserId:user.id});render();showToast('個人照片已移除');
}

function identityMembershipCard(){
  if(Identity.isSuperAdmin())return '';
  const rows=Identity.membershipsForUser(Identity.currentUser()?.id||'').filter(m=>Identity.membershipStatus(m)!=='revoked');
  if(rows.length<=1)return '';
  return `<section class="card"><div class="card-head"><div><h3>我的身分</h3><p>同一個使用者可同時是需求者與公司工作者</p></div><span class="pill purple">${rows.length} 個</span></div><div class="list">${rows.map(m=>{const o=Organization.get(m.organizationId),active=Identity.isActiveMembership(m),current=m.id===Identity.currentMembership()?.id;return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(o?.name||'未知組織')}</h4><p>${ROLE_LABELS[m.role]||m.role}・${MEMBERSHIP_STATUS_LABELS[Identity.membershipStatus(m)]||Identity.membershipStatus(m)}</p></div>${current?'<span class="pill green">目前身分</span>':active?`<button type="button" class="btn outline sm identity-switch-btn" data-org="${m.organizationId}">切換</button>`:'<span class="pill gray">不可使用</span>'}</div></div>`;}).join('')}</div></section>`;
}
function accountSectionErrorCard_(title,error){
  const message=runtimeErrorMessage_(error);
  return `<section class="card"><div class="card-head"><div><h3>${escapeHTML(title)}</h3><p>此區塊的資料檢查發生問題，但不影響其他帳戶功能。</p></div><span class="pill yellow">待檢查</span></div><div class="smart-modal-hint">${escapeHTML(message)}</div></section>`;
}
function safeAccountSection_(title,renderer){
  try{
    const html=renderer();
    return typeof html==='string'?html:'';
  }catch(error){
    console.error(`[Account] ${title} render failed`,error);
    return accountSectionErrorCard_(title,error);
  }
}
function identityHealthCard(){
  if(!Identity.isSuperAdmin())return '';
  try{
    const result=Identity?.validate?.()||{ok:false,errors:['Identity.validate 未回傳結果'],warnings:[]};
    const errors=Array.isArray(result.errors)?result.errors:[];
    const warnings=Array.isArray(result.warnings)?result.warnings:[];
    return `<section class="card"><div class="card-head"><div><h3>帳號身分健康檢查</h3><p>使用者／組織身分／司機資料／外部登入身分一致性</p></div><span class="pill ${result.ok?'green':'red'}">${result.ok?'正常':`${errors.length} 個錯誤`}</span></div><div class="meta">${result.ok?'✓ 沒有發現 Identity 結構錯誤':errors.slice(0,8).map(e=>`• ${escapeHTML(String(e))}`).join('<br>')||'結構待檢查'}${warnings.length?`<br><br>${warnings.slice(0,5).map(w=>`△ ${escapeHTML(String(w))}`).join('<br>')}`:''}</div></section>`;
  }catch(error){
    console.error('[Account] identity health check failed',error);
    return accountSectionErrorCard_('帳號身分健康檢查',error);
  }
}

function careRecipientHealthCard(){
  if(!Identity.isSuperAdmin())return '';
  try{
    const result=CareRecipient?.validate?.()||{ok:false,errors:['CareRecipient.validate 未回傳結果'],warnings:[],duplicateCandidates:[],activeCount:0,eventCount:0};
    const errors=Array.isArray(result.errors)?result.errors:[];
    const warnings=Array.isArray(result.warnings)?result.warnings:[];
    const pairs=Array.isArray(result.duplicateCandidates)?result.duplicateCandidates:[];
    const activeCount=Number.isFinite(Number(result.activeCount))?Number(result.activeCount):(CareRecipient?.list?.()?.length||0);
    const eventCount=Number.isFinite(Number(result.eventCount))?Number(result.eventCount):((store.state.careRecipientEvents||[]).length);

    return `<section class="card"><div class="card-head"><div><h3>服務對象資料治理</h3><p>檢查服務對象、關係人、預約引用與去重資料是否一致。</p></div><span class="pill ${result.ok?'green':'red'}">${result.ok?'結構正常':`${errors.length} 個錯誤`}</span></div>
      <div class="daily-summary"><div class="mini-stat"><strong>${activeCount}</strong><span>有效服務對象</span></div><div class="mini-stat"><strong>${pairs.length}</strong><span>重複候選</span></div><div class="mini-stat"><strong>${eventCount}</strong><span>異動事件</span></div></div>
      ${errors.length?`<div class="feasibility-box blocked"><div class="feasibility-title">資料關聯待處理</div>${errors.slice(0,6).map(e=>`• ${escapeHTML(String(e))}`).join('<br>')}</div>`:'<div class="feasibility-box ok"><div class="feasibility-title">✓ 基本資料關聯檢查完成</div></div>'}
      ${warnings.length?`<div class="smart-modal-hint" style="margin-top:10px">${warnings.slice(0,5).map(w=>`△ ${escapeHTML(String(w))}`).join('<br>')}</div>`:''}
    </section>`;
  }catch(error){
    console.error('[Account] care recipient health check failed',error);
    return accountSectionErrorCard_('服務對象資料治理',error);
  }
}
function appVersionNote(){ return `<div class="app-version-note" aria-label="應用程式版本">安心接送・版本 ${escapeHTML(APP_CONFIG.version)}</div>`; }
function requesterAccount(){
  const u=Identity.currentUser(),m=Identity.currentMembership(),selfRecipient=CareRecipient.selfForUser(u?.id||'');
  const selfCard=selfRecipient?`<section class="card"><div class="card-head"><div><h3>我的接送資料</h3><p>這是你本人的固定接送需求，不是「服務對象管理」功能。</p></div><button type="button" class="btn outline sm" id="editRequesterSelfProfileBtn" data-recipient="${selfRecipient.id}">編輯</button></div><div class="meta">常用上車地址：${escapeHTML(CareRecipient.primaryAddress(selfRecipient)||'未填')}<br>固定需求：${escapeHTML(careRecipientFixedNeedsText(selfRecipient))}</div></section>`:`<section class="card"><div class="card-head"><h3>我的接送資料</h3></div><div class="smart-modal-hint">尚未建立你的接送主檔。第一次送出預約時，系統會依你的帳號身分自動建立本人服務對象主檔。</div></section>`;
  return `<div class="page-head"><div><h2>我的帳戶</h2><p>需求者本人帳號身分與固定接送資料</p></div></div><section class="card"><div class="account-card">${accountAvatar(u,'☺')}<div><h3>${escapeHTML(u?.name||'')}</h3><p>${formatPhone(u?.phone||'')}${u?.email?`・${escapeHTML(u.email)}`:''}</p></div></div></section>${profilePhotoSection(u,'☺')}${identityMembershipCard()}${selfCard}<section class="card"><div class="card-head"><h3>需求者身分</h3></div><div class="meta">角色：${ROLE_LABELS[m?.role]||m?.role}<br>你只能建立與查看自己的接送需求，不會看到「服務對象」或「需求接案」功能。服務端接案後，你也不會因此加入該公司的組織身分。</div></section>${systemReportAccountCard()}${appVersionNote()}<button type="button" class="btn danger block account-logout-btn">登出目前帳號</button>`;
}
function submitRequesterBooking(){
  const editing=editingRequesterBookingId?Booking.get(editingRequesterBookingId):null;
  const permission=editing?'booking.edit_own':'booking.create_own';
  if(!Identity.can(permission)){showToast(editing?'你沒有修改預約權限':'你沒有建立預約權限');return;}
  const roundTrip=$('rqTripType').value==='來回',scope=$('contentRoot');if(!validateFieldRules(scope,[
    {id:'rqDate',message:'請選擇接送日期'},{id:'rqTime',message:'請選擇接送時間'},{id:'rqPickup',message:'請輸入上車地址'},{id:'rqDestination',message:'請輸入目的地'},
    ...(roundTrip?[{id:'rqReturnDate',message:'來回預約需要回程日期'},{id:'rqReturnTime',message:'來回預約需要回程時間'}]:[])
  ]))return;
  const input={pickupDate:$('rqDate').value,pickupTime:$('rqTime').value,pickupAddress:$('rqPickup').value.trim(),pickupAccessNote:$('rqPickupAccessNote').value.trim(),destination:$('rqDestination').value.trim(),destinationAccessNote:$('rqDestinationAccessNote').value.trim(),tripType:$('rqTripType').value,returnDate:roundTrip?$('rqReturnDate').value:'',returnTime:roundTrip?$('rqReturnTime').value:'',aidNeed:$('rqAidNeed').value,companions:$('rqCompanions').value,specialNeed:$('rqSpecialNeed').value.trim(),poolingConsent:$('rqPoolingConsent').value,note:$('rqNote').value.trim()};
  const result=editing?Booking.amendOwn(editing.id,Identity.currentUser()?.id,input,'需求者於 App 修改預約'):Booking.createForRequester(input,Identity.currentUser()?.id);
  if(!result.ok){routeFieldError(result.error,[['日期','rqDate'],['時間','rqTime'],['上車','rqPickup'],['地址','rqPickup'],['目的地','rqDestination'],['回程日期','rqReturnDate'],['回程時間','rqReturnTime'],['共乘','rqPoolingConsent']]);return;}
  if(!editing)clearRequesterDraft();
  editingRequesterBookingId='';currentView='requester-bookings';renderNav();render();showToast(editing?(result.reconfirmationRequired?'預約已修改；因接送條件變更，系統會重新安排承接單位':'預約已修改，原本的紀錄仍會保留'):'接送需求已送出，可在「我的預約」查看進度。');
}

function driverDutyActions(d){
  if(!d) return '';
  if(d.status==='unavailable') return '<span class="pill red">公司設定：不可派車</span>';
  if(d.status==='off_duty') return '<button type="button" class="btn primary sm driver-self-status-btn" data-status="on_duty">開始執勤</button>';
  if(d.status==='break') return '<button type="button" class="btn primary sm driver-self-status-btn" data-status="on_duty">繼續執勤</button><button type="button" class="btn outline sm driver-self-status-btn" data-status="off_duty">結束執勤</button>';
  return '<button type="button" class="btn warning sm driver-self-status-btn" data-status="break">開始休息</button><button type="button" class="btn outline sm driver-self-status-btn" data-status="off_duty">結束執勤</button>';
}
function renderOfflineExecutionBanner(){const pending=Trip?.offlineQueue?.()?.length||0,offline=typeof navigator!=='undefined'&&navigator.onLine===false;if(!offline&&!pending)return '';return `<div class="offline-execution-banner"><strong>${offline?'離線執行模式':'待同步 Trip 操作'}</strong><br>${offline?'Trip 執行仍會先寫入本機資料庫與 persistent queue。':'網路已恢復，佇列會自動進行本機同步確認。'}目前待同步 ${pending} 筆。<br><span class="small">離線操作會保留在本機佇列；網路恢復後系統會送往正式後端並等待伺服器確認，未確認前不視為完成同步。</span></div>`;}
function renderTripNavigationStatus(trip){const n=Trip.navigationStatus(trip),step=Trip.currentStep(trip);if(!step)return '';const eta=n?.etaAt?formatTime(n.etaAt):formatTime(step.scheduledAt),delay=n?.projectedDelayMinutes,dev=n?.deviationLevel||'unavailable',devText=dev==='critical'?`嚴重偏離 ${n.deviationKm??'—'} km`:dev==='warning'?`可能偏離 ${n.deviationKm??'—'} km`:dev==='normal'?`路線走廊正常 ${n.deviationKm??0} km`:'缺少可比較座標，未判定偏離',source=n?.source==='gps_straight_line_estimate'?'GPS 直線距離 × 路網係數估算':'排程 ETA';return `<div class="trip-nav-live"><strong>預計抵達 ${eta}</strong>${delay!==null&&delay!==undefined?`・預估${delay>0?`晚 ${delay}`:`早 ${Math.abs(delay)}`} 分`:''}<br>${n?.distanceToTargetKm!==null&&n?.distanceToTargetKm!==undefined?`距目標約 ${n.distanceToTargetKm} km・`:''}${escapeHTML(devText)}</div>`;}
function driverHome(){
  const d=currentDriver(),operationDate=driverOperationalDate(),trips=Trip.forDriver(d?.id,operationDate),active=Trip.nextForDriver(d?.id,operationDate),v=Organization.vehicle(active?.vehicleId),step=Trip.currentStep(active),k=Analytics.driverDaily(d?.id,operationDate);
  return `<div class="page-head"><div><h2>司機工作台</h2><p>${escapeHTML(d?.name||'')}・${escapeHTML(v?.plate||'下一趟尚未派車')}・${escapeHTML(Organization.driverStatusLabel(d?.status))}</p></div><div class="page-actions"><input class="inline-date" type="date" id="driverOperationDateInput" value="${operationDate}" aria-label="司機營運日">${driverDutyActions(d)}</div></div>
  <section class="card hero"><div class="hero-content"><div><h2>${active?'下一個任務已就緒':'此營運日任務已完成'}</h2><p>${active?`${escapeHTML(active.passengerSummary)}・${STATUS_LABELS[active.status]}`:`${operationDate} 目前沒有待執行行程`}</p></div><div class="hero-clock" id="driverNowClock">--:--:--<small>現在時間</small></div></div></section>
  <div class="metric-grid"><div class="metric"><span>營運日完整趟次</span><strong>${trips.filter(t=>t.status==='completed').length}</strong><small>送達後才計 1</small></div><div class="metric"><span>待執行</span><strong>${trips.filter(t=>!isTripTerminalStatus(t.status)).length}</strong></div><div class="metric"><span>未結異常</span><strong>${Trip.issues(orgId()).filter(i=>i.driverId===d?.id&&i.status!=='resolved'&&Trip.get(i.tripId)?.date===operationDate).length}</strong></div><div class="metric"><span>營運日準時率</span><strong>${k.onTimeRate??'—'}${k.onTimeRate!==null?'%':''}</strong></div></div>
  ${renderOfflineExecutionBanner()}${active?.status==='interrupted'?`<section class="card issue-card"><div class="card-head"><div><h3>行程已中斷，等待調度處理</h3><p>${escapeHTML(active.code)}・目前不可繼續操作停靠點</p></div>${statusPill(active.status)}</div><div class="task-note">原因：${escapeHTML(active.interruptReason||'現場異常')}<br>目前資源：${escapeHTML(Organization.driver(active.driverId)?.name||'未指派')}／${escapeHTML(Organization.vehicle(active.vehicleId)?.plate||'未派車')}<br>若調度完成換車／換司機並恢復，此畫面會自動以新的行程指派 繼續。</div>${renderTripPassengerRuntime(active)}</section>`:active&&!step&&active.completionPending?`<section class="card"><div class="card-head"><div><h3>所有停靠點已完成，等待完成條件</h3><p>${escapeHTML(active.code)} 尚未計為完成</p></div><span class="pill yellow">待補資料</span></div><div class="task-note">${escapeHTML((Trip.completionReadiness(active).reasons||[]).join('；')||'等待系統確認')}</div>${Trip.proofRequirements(active).some(x=>!x.satisfied)?`<button type="button" class="btn primary block proof-service-btn" data-trip="${active.id}">補 服務證明</button>`:''}<button type="button" class="btn secondary block" id="undoBtn" data-trip="${active.id}" data-revision="${active.revision}">誤觸／返回最後一步</button></section>`:active&&step?renderDriverTask(active,step):'<div class="empty">此營運日目前沒有待執行任務。</div>'}${active?renderRoute(active):''}`;
}
function renderTripPassengerRuntime(trip){const rows=Trip.passengers(trip);if(!rows.length)return '';return `<div class="smart-assign" style="margin-top:14px"><div class="smart-assign-head"><span class="smart-assign-title">乘客即時狀態</span><span class="efficiency-score">修訂版 ${trip.revision}</span></div><div class="list">${rows.map(p=>`<div class="list-item" style="padding:9px 10px"><div class="list-item-head"><div><h4>${escapeHTML(p.name)}</h4><p>${p.seatUnits} 席${p.wheelchairUnits?`・輪椅 ${p.wheelchairUnits}`:''}${p.bookingId?`・預約 ${escapeHTML(p.bookingId)}`:''}</p></div><span class="pill ${p.status==='dropped_off'?'green':p.status==='onboard'?'blue':p.status==='waiting'?'yellow':'gray'}">${escapeHTML(tripPassengerStatusLabelGlobal(p.status))}</span></div></div>`).join('')}</div></div>`;}
function renderDriverTask(trip,step){
  const executionWindow=Trip.executionWindow(trip),tooEarly=trip.status==='scheduled'&&!executionWindow.ok,openText=executionWindow.earliestAt?formatDateTime(executionWindow.earliestAt):'',undoIndex=Math.max(0,Math.min(trip.currentStepIndex-1,trip.steps.length-1)),undoStep=trip.steps[undoIndex],canUndo=!!(undoStep&&(undoStep.actualAt||undoStep.completedAt));
  return `<section class="card"><div class="card-head"><div><h3>目前任務</h3><p>${escapeHTML(trip.code)}・請依序完成下方任務・行程版本 ${trip.revision}</p></div>${phasePill(step.type)}</div>${tooEarly?`<div class="smart-modal-hint" style="margin-bottom:12px"><strong>尚未開放行程執行</strong><br>可於 ${escapeHTML(openText)} 後開始；目前僅可查看路線／聯絡資訊。系統會在核心規則層阻擋提前執行。</div>`:''}<div class="current-task"><div class="timebox"><strong id="driverCountdown">--:--:--</strong><span id="driverCountdownLabel">距預定時間</span><small>預定 ${formatTime(step.scheduledAt)}</small></div><div class="task-info"><h2>${escapeHTML(step.name)}</h2><div class="meta">地點：${escapeHTML(step.destination)}<br>電話：${step.contacts.map(c=>`${escapeHTML(c.name)} ${formatPhone(c.phone)}`).join('、')}<br>需求：${escapeHTML(trip.needs)}</div><div class="task-note">${escapeHTML(step.note)}</div></div></div>${renderTripPassengerRuntime(trip)}${renderTripNavigationStatus(trip)}<div class="action-grid">${Identity.can('trip.execute')?`<button type="button" class="btn primary" id="navBtn">開始導航</button><button type="button" class="btn outline" id="refreshTripEtaBtn" data-trip="${trip.id}">更新 ETA／定位</button><button type="button" class="btn secondary" id="contactBtn">聯絡乘客</button><button class="btn ${step.type==='dropoff'?'success':step.type==='pickup'?'warning':'primary'} primary-action" id="completeStepBtn" data-trip="${trip.id}" data-step="${step.id}" data-revision="${trip.revision}" ${tooEarly?'disabled aria-disabled="true"':''}>${tooEarly?'尚未到可執行時間':step.type==='depart'?'開始出發':step.type==='pickup'?'確認已接到乘客':'確認已安全送達'}</button><button type="button" class="btn secondary" id="undoBtn" data-trip="${trip.id}" data-step="${step.id}" data-revision="${trip.revision}" ${canUndo?'':'disabled aria-disabled="true"'}>${canUndo?'返回上一步':'尚無可返回步驟'}</button>`:''}${Identity.can('issue.create')?'<button type="button" class="btn danger" id="issueBtn">回報異常</button>':''}</div></section>`;
}
function renderRoute(trip){
  return `<section class="card"><div class="card-head"><div><h3>本趟流程</h3><p>${escapeHTML(trip.passengerSummary)}</p></div>${statusPill(trip.status)}</div><div class="route-list">${trip.steps.map((s,i)=>`<div class="route-row ${s.actualAt?'done':''} ${i===trip.currentStepIndex&&trip.status!=='completed'?'active':''}"><div class="route-step">${s.actualAt?'✓':i+1}</div><div><h4>${escapeHTML(s.title)}</h4><p>${formatTime(s.scheduledAt)}・${PHASE_LABELS[s.type]}・${escapeHTML(s.destination)}</p></div><div class="route-status">${s.actualAt?'完成':i===trip.currentStepIndex?'現在':'待執行'}</div></div>`).join('')}</div></section>`;
}
function driverTrips(){
  const operationDate=driverOperationalDate(),rows=Trip.forDriver(currentDriver()?.id,operationDate),actorUserId=Identity.currentUser()?.id;
  return `<div class="page-head"><div><h2>我的行程</h2><p>${operationDate}・每一趟行程都會顯示本趟指定車輛</p></div><div class="page-actions"><input class="inline-date" type="date" id="driverOperationDateInput" value="${operationDate}" aria-label="司機行程日期"></div></div>${renderOfflineExecutionBanner()}<div class="list">${rows.map(t=>{const completedDropoffs=(t.steps||[]).filter(s=>s.type==='dropoff'&&(s.completedAt||s.passengerDroppedOffAt)),proofs=Trip.activeServiceProofs(t),correction=Trip.correctionAvailability(t,actorUserId);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(t.code)}｜${escapeHTML(t.passengerSummary)}</h4><p>${formatTime(t.steps[0].scheduledAt)} 開始・車輛：${escapeHTML(Organization.vehicle(t.vehicleId)?.plate||'未派車')}<br>${escapeHTML(t.pickupAddress)} → ${escapeHTML(t.dropoffAddress)}<br>${escapeHTML(t.needs)}<br><span class="muted small">乘客狀態：${escapeHTML(Trip.passengerSummaryRuntime(t)||'—')}・修訂版 ${t.revision}・有效服務證明 ${proofs.length}/${completedDropoffs.length}</span></p></div>${statusPill(t.status)}</div><div class="item-actions"><button type="button" class="btn outline sm map-trip-btn" data-trip="${t.id}">導航／地圖</button><button type="button" class="btn outline sm trip-history-btn" data-trip="${t.id}">執行歷史</button>${completedDropoffs.length&&Identity.can('trip.execute')?`<button type="button" class="btn primary sm proof-service-btn" data-trip="${t.id}">服務證明</button>`:''}${correction.ok?`<button type="button" class="btn warning sm completed-trip-correction-btn" data-trip="${t.id}" data-revision="${t.revision}" data-step="${correction.stepId}">撤銷最後完成（${correction.remainingMinutes} 分內）</button>`:''}</div></div>`;}).join('')||'<div class="empty">此營運日尚無行程</div>'}</div>`;
}
function driverKpi(){ const k=Analytics.driverDaily(currentDriver()?.id,kpiDate); return `<div class="page-head"><div><h2>我的關鍵績效</h2><p>分析統計是唯讀層，不會改動行程資料</p></div><div class="page-actions"><input class="inline-date" type="date" id="kpiDateInput" value="${kpiDate}"></div></div><section class="card">${renderKpiCards(k)}</section>`; }
function systemReportAccountCard(){ return Identity.can('system_report.create')?`<section class="card"><div class="card-head"><div><h3>系統問題回報</h3><p>應用程式／後台操作問題會送給平台開發方</p></div></div><button class="btn outline block" id="openSystemReportBtn" type="button">回報系統問題</button></section>`:''; }
function driverAccount(){ const u=Identity.currentUser(),d=currentDriver(),next=Trip.nextForDriver(d?.id,driverOperationalDate()),v=Organization.vehicle(next?.vehicleId); return `<div class="page-head"><div><h2>我的帳戶</h2><p>帳號身分與組織已分離；車輛依每趟行程派定</p></div></div><section class="card"><div class="account-card">${accountAvatar(u,'👨🏻‍✈️')}<div><h3>${escapeHTML(u?.name||'')}</h3><p>${formatPhone(u?.phone||'')}・下一趟 ${escapeHTML(v?.plate||'尚未派車')}</p></div></div></section>${profilePhotoSection(u,'👨🏻‍✈️')}${identityMembershipCard()}<section class="card"><div class="card-head"><h3>所屬組織</h3></div><div class="meta">${escapeHTML(currentOrg()?.name||'')}<br>角色：${ROLE_LABELS[role()]}<br>司機資料僅保存營運欄位，姓名／手機直接引用帳號資料。</div></section>${systemReportAccountCard()}${appVersionNote()}<button type="button" class="btn danger block account-logout-btn">登出目前帳號</button>`; }
function superAdminAccountSettingsCard(u){
  return `<section class="card"><div class="card-head"><div><h3>平台超級管理者帳號</h3><p>帳號資料由伺服器更新；密碼只寫入伺服器端雜湊憑證，不會進入應用狀態資料或 GitHub。</p></div></div><div class="form-grid"><div class="form-field"><label for="superAdminNameInput">顯示名稱</label><input id="superAdminNameInput" value="${escapeHTML(u?.name||'')}" autocomplete="name" /></div><div class="form-field"><label for="superAdminPhoneInput">登入手機</label><input id="superAdminPhoneInput" value="${escapeHTML(u?.phone||'')}" inputmode="tel" autocomplete="username" /></div><div class="form-field"><label for="superAdminPasswordInput">新密碼</label><input id="superAdminPasswordInput" type="password" autocomplete="new-password" placeholder="至少 8 碼；留白則不變更" /></div><div class="form-field"><label for="superAdminCurrentPasswordInput">目前密碼</label><input id="superAdminCurrentPasswordInput" type="password" autocomplete="current-password" placeholder="變更手機或密碼時必填" /></div></div><button type="button" class="btn primary" id="saveSuperAdminAccountBtn">更新超級管理者帳號</button></section>`;
}
async function updateCurrentSuperAdminAccount(){
  const current=Identity.currentUser();if(!Identity.isSuperAdmin()||!current){showToast('只有平台超級管理者可以更新此帳號');return;}
  const name=String($('superAdminNameInput')?.value||'').trim(),phone=digitsOnly($('superAdminPhoneInput')?.value||''),password=String($('superAdminPasswordInput')?.value||''),currentPassword=String($('superAdminCurrentPasswordInput')?.value||''),btn=$('saveSuperAdminAccountBtn');
  if(!name){showToast('請輸入顯示名稱');return;}if(!/^09\d{8}$/.test(phone)){showToast('請輸入有效的 10 碼手機號碼');return;}if(password&&password.length<8){showToast('新密碼至少需要 8 碼');return;}
  // 伺服器要求：變更密碼或登入手機時必須通過目前密碼驗證，避免單靠被竊取的 session 就能接管帳號。
  const phoneChanged=digitsOnly(current.phone||'')!==phone;
  if((password||phoneChanged)&&!currentPassword){showToast('變更密碼或手機號碼前，請輸入目前的密碼');$('superAdminCurrentPasswordInput')?.focus();return;}
  setButtonBusy(btn,true,'更新中…');
  try{
    {const cloud=await CloudIdentity.updateAccount({name,phone,newPassword:password,currentPassword});store.mutate(db=>{const target=db.users.find(u=>u.id===current.id);if(target){target.name=cloud.user?.displayName||name;target.phone=cloud.user?.phone||phone;target.password='';delete target.passwordUpdatedAt;target.updatedAt=nowISO();}},{remote:false,reason:'backend_session'});}
    LoginSecurity.clear(phone);$('superAdminPasswordInput').value='';$('superAdminCurrentPasswordInput').value='';render();showToast(password?'帳號與伺服器密碼已更新':'平台超級管理者帳號已更新');
  }catch(error){showToast(error?.message||'帳號更新失敗');}
  finally{setButtonBusy(btn,false);}
}
function genericAccount(){
  const u=Identity.currentUser(),m=Identity.currentMembership();

  if(!u){
    return `<div class="page-head"><div><h2>我的帳戶</h2><p>登入狀態需要重新整理</p></div></div>
      <section class="card"><div class="ui-state error"><div class="ui-state-icon">!</div><h3>找不到目前使用者資料</h3><p>Google 資料同步後，目前 Session 對應的使用者已不存在或尚未載入。請登出後重新登入。</p><button class="btn danger account-logout-btn" type="button">登出並重新登入</button></div></section>`;
  }

  if(Identity.isSuperAdmin()){
    let currentOrgName='尚無有效組織';
    try{currentOrgName=currentOrg()?.name||currentOrgName;}catch(error){console.warn('[Account] current organization unavailable',error);}

    return `<div class="page-head"><div><h2>我的帳戶</h2><p>平台超級管理者</p></div></div>
      ${safeAccountSection_('帳號摘要',()=>`<section class="card"><div class="account-card">${accountAvatar(u,'◇')}<div><h3>${escapeHTML(u?.name||'')}</h3><p>${formatPhone(u?.phone||'')}${u?.email?`・${escapeHTML(u.email)}`:''}</p></div></div></section>`)}
      ${safeAccountSection_('個人照片',()=>profilePhotoSection(u,'◇'))}
      ${safeAccountSection_('平台超級管理者帳號',()=>superAdminAccountSettingsCard(u))}
      ${safeAccountSection_('帳號身分健康檢查',()=>identityHealthCard())}
      ${safeAccountSection_('服務對象資料治理',()=>careRecipientHealthCard())}
      <section class="card"><div class="card-head"><h3>平台身分</h3></div><div class="meta">角色：超級管理者<br>組織身分：無<br>目前查看：${escapeHTML(currentOrgName)}<br>可跨組織查看平台營運狀況，但不隸屬任何公司。</div></section>
      ${appVersionNote()}
      <button type="button" class="btn danger block account-logout-btn">登出目前帳號</button>`;
  }

  return `<div class="page-head"><div><h2>我的帳戶</h2><p>${ROLE_LABELS[m?.role]||m?.role||''}</p></div></div>
    <section class="card"><div class="account-card">${accountAvatar(u,'☺')}<div><h3>${escapeHTML(u?.name||'')}</h3><p>${formatPhone(u?.phone||'')}${u?.email?`・${escapeHTML(u.email)}`:''}</p></div></div></section>
    ${profilePhotoSection(u,'☺')}
    ${identityMembershipCard()}
    <section class="card"><div class="card-head"><h3>目前身分</h3></div><div class="meta">組織：${escapeHTML(currentOrg()?.name||'-')}<br>角色：${ROLE_LABELS[m?.role]||m?.role||'-'}<br>組織身分：${MEMBERSHIP_STATUS_LABELS[Identity.membershipStatus(m)]||Identity.membershipStatus(m)||'-'}</div></section>
    ${systemReportAccountCard()}${appVersionNote()}
    <button type="button" class="btn danger block account-logout-btn">登出目前帳號</button>`;
}
function accountView(){ return role()==='driver'?driverAccount():role()==='requester'?requesterAccount():genericAccount(); }

function bookingSchedulingRows(date=selectedTripDate){
  const actorUserId=Identity.currentUser()?.id;
  return [...Booking.pending(orgId(),date,actorUserId)].sort((a,b)=>String(a.pickupDate+a.pickupTime).localeCompare(String(b.pickupDate+b.pickupTime)));
}
function renderSchedulingWorkspace(date=selectedTripDate,rows=null){
  const actorUserId=Identity.currentUser()?.id,schedulingRows=rows||bookingSchedulingRows(date),syncDetails=store.state.integration.lastSyncDetails||[];
  return `<section class="card"><div class="card-head"><div><h3>待排預約</h3><p>目前公司已承接、尚待完成排車的預約。</p></div><span class="pill blue">${schedulingRows.length} 筆</span></div>
    <div class="meta">營運日：${escapeHTML(date)}・最後同步：${store.state.integration.lastSyncAt?formatDateTime(store.state.integration.lastSyncAt):'尚未同步'}<br>同步狀態：${escapeHTML(store.state.integration.lastSyncStatus)}</div>
    ${syncDetails.length?`<div class="feasibility-box blocked" style="margin-top:10px"><div class="feasibility-title">最近同步需處理</div>${syncDetails.slice(0,6).map(x=>`• ${escapeHTML(x)}`).join('<br>')}</div>`:''}
  </section>${renderOptimizer(date,schedulingRows.length)}<div class="list">${schedulingRows.map(b=>{const state=Booking.stateOf(b),view=Booking.dispatchView(b);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(b.name)}｜${escapeHTML(view?.pickupDate||b.pickupDate)} ${escapeHTML(view?.pickupTime||b.pickupTime)}</h4><p>${formatPhone(b.phone)}・${escapeHTML(view?.activeLegLabel||bookingNextLegLabel(b))}<br>${escapeHTML(view?.pickupAddress||b.pickupAddress)} → ${escapeHTML(view?.destination||b.destination)}</p></div>${bookingStatusPill(b.status)}</div><div class="address" style="margin-top:10px">${bookingLegSummary(b)}<br>有效需求：${escapeHTML(Booking.needsText(b))}</div>${['claimed','partially_scheduled'].includes(state)?renderRecommendation(view):''}<div class="item-actions">${['claimed','partially_scheduled'].includes(state)&&Identity.can('booking.schedule')?`<button type="button" class="btn primary sm booking-create-trip-btn" data-booking="${b.id}">建立${escapeHTML(bookingNextLegLabel(b))}行程</button>`:''}${state==='claimed'&&Identity.can('booking.release')?`<button type="button" class="btn warning sm booking-release-btn" data-booking="${b.id}">退回公開池</button>`:''}${state==='claimed'&&Identity.can('booking.reject')?`<button type="button" class="btn outline sm booking-reject-btn" data-booking="${b.id}">不受理</button>`:''}${bookingLegOrganizationAssignmentControl(b)}${Booking.canReadEvents(b.id,actorUserId)?`<button type="button" class="btn outline sm booking-history-btn" data-booking="${b.id}">異動歷史</button>`:''}</div></div>`;}).join('')||'<div class="empty">這一天沒有待排預約。若尚未接案，請到「需求接案」先承接公開需求。</div>'}</div>`;
}
function dispatchHome(){
  const operationDate=selectedTripDate||preferredOperationalDate(),bookings=bookingSchedulingRows(operationDate),trips=Trip.list(orgId(),operationDate),issues=Trip.issues(orgId()).filter(i=>i.status!=='resolved'&&Trip.get(i.tripId)?.date===operationDate),k=Analytics.fleetDaily(orgId(),operationDate);
  return `<div class="page-head"><div><h2>調度台</h2><p>先處理待排預約，再確認正式行程與未結異常。</p></div><div class="page-actions"><input class="inline-date" id="operationDateInput" type="date" value="${operationDate}">${Identity.can('booking.sync_google')?'<button type="button" class="btn primary" id="syncCustomerBookingsBtn">↻ 重新同步資料</button>':''}</div></div>
  <div class="metric-grid"><div class="metric"><span>待排預約</span><strong>${bookings.length}</strong><small>${operationDate}</small></div><div class="metric"><span>營運日行程</span><strong>${trips.length}</strong><small>已建立正式行程</small></div><div class="metric"><span>進行中</span><strong>${trips.filter(t=>t.status==='in_progress').length}</strong><small>司機執行中</small></div><div class="metric"><span>未結異常</span><strong>${issues.length}</strong><small>此營運日</small></div></div>
  ${renderSchedulingWorkspace(operationDate,bookings)}
  <section class="card"><div class="card-head"><div><h3>${operationDate} 行程摘要</h3><p>正式行程建立後集中到「派車／行程」管理</p></div><button type="button" class="btn outline sm" id="goTripsBtn">查看派車／行程</button></div>${renderCompactTrips(trips)}</section>
  <section class="card"><div class="card-head"><div><h3>車隊關鍵績效指標</h3><p>${operationDate} 唯讀營運統計</p></div></div>${renderKpiCards(k)}${renderDriverKpiTable(operationDate)}</section>`;
}
function renderCompactTrips(rows){ if(!rows.length)return '<div class="empty">這一天尚無正式行程</div>'; return `<div class="list">${rows.slice(0,8).map(t=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(t.code)}｜${escapeHTML(t.passengerSummary)}</h4><p>${formatTime(t.steps[0].scheduledAt)}・${escapeHTML(Organization.driver(t.driverId)?.name||'未指派')}・${escapeHTML(Organization.vehicle(t.vehicleId)?.plate||'未派車')}</p></div>${statusPill(t.status)}</div></div>`).join('')}</div>`; }
function renderRecommendation(b){
  const ranked=Dispatch.recommendDrivers(b,orgId(),Identity.currentUser()?.id),best=ranked.find(x=>x.feasible),pool=Dispatch.poolCandidates(b,orgId(),Identity.currentUser()?.id).slice(0,3);
  if(!best) return `<div class="smart-assign" style="border-color:#f1c4c4;background:#fff3f3"><div class="smart-assign-head"><span class="smart-assign-title" style="color:#a32626">⛔ 目前不可執行</span><span class="efficiency-score" style="background:#ba2d2d">禁止排車</span></div><div class="smart-reasons">${ranked[0]?.reasons?.map(r=>`• ${escapeHTML(r)}`).join('<br>')||'目前沒有可用司機'}</div></div>`;
  return `<div class="smart-assign"><div class="smart-assign-head"><span class="smart-assign-title">✦ 調度建議司機</span><span class="efficiency-score">效率 ${best.score}/100</span></div><div class="smart-assign-main">${escapeHTML(best.driver.name)}｜建議車輛 ${escapeHTML(best.vehicle?.plate||'無可派車')}</div><div class="smart-reasons">${best.reasons.map(r=>`• ${escapeHTML(r)}`).join('<br>')}</div>${pool.length?`<div class="pool-candidate-list">${pool.map(p=>`<div class="pool-candidate-row"><strong>可共乘｜${escapeHTML(p.booking.name)}</strong><br>案家間估算 ${p.pickupDrive} 分・時間差 ${p.timeGap} 分・最大繞路 ${p.maxDetour} 分</div>`).join('')}</div>`:''}</div>`;
}
function renderOptimizer(date=selectedTripDate,pendingCount=null){
  const actorUserId=Identity.currentUser()?.id,canSchedule=Identity.can('booking.schedule'),plan=Dispatch.latestDraft(date,orgId()),pending=pendingCount??Booking.pending(orgId(),date,actorUserId).length,routing=Dispatch.routing.status(),affected=canSchedule?Dispatch.detectAffectedScheduledTrips(date,orgId()).length:0;
  const profiles=Object.entries(Dispatch.objectiveProfiles||{}).map(([key,p])=>`<option value="${key}" ${optimizerObjectiveProfile===key?'selected':''}>${escapeHTML(p.label)}</option>`).join('');
  return `<section class="card optimizer-card"><div class="card-head"><div><h3>智慧排車建議</h3><p>${escapeHTML(date)}・先檢查時間、車輛、輪椅需求與排班限制，再提出可執行方案</p></div><span class="pill blue">${pending} 筆待排</span></div>${canSchedule?`<div class="optimizer-actions"><select class="inline-select" id="optimizerObjectiveProfile" aria-label="最佳化目標">${profiles}</select><button type="button" class="btn primary" id="runFleetOptimizerBtn">產生排車建議</button>${affected?`<button type="button" class="btn warning" id="repairAffectedTripsBtn">修復 ${affected} 趟異常排程</button>`:''}</div><div class="smart-modal-hint" style="margin-top:8px">先套法規與硬性限制，再枚舉合法停靠點順序；路線計算：${escapeHTML(routing.provider)}${routing.external?'（外部服務提供者）':'（啟發式備援）'}・快取 ${routing.cacheEntries} 筆。局部修復會依事件分流：資源失效只重派 司機／車輛；預約異動則重建停靠點／路線。兩者都只處理尚未開始的 待執行行程。</div>`:'<div class="smart-modal-hint">目前身分只有預約讀取權，沒有排車權限。</div>'}${plan?renderPlan(plan):'<div class="optimizer-empty" style="margin-top:10px">尚未產生這一天的調度方案</div>'}</section>`;
}
function renderPlan(plan){
  const s=plan.summary,c=plan.comparison;
  const timeline=(item)=>item.loadTimeline?.length?`<div class="plan-route"><strong>載客變化：</strong>${item.loadTimeline.map(x=>`${x.type==='pickup'?'接':'送'} ${escapeHTML(x.name)} → ${x.passengers}人${x.wheelchairs?`／輪椅${x.wheelchairs}`:''}`).join(' ｜ ')}</div>`:'';
  const comparison=c?`<div class="smart-modal-hint" style="margin:10px 0"><strong>最佳化前後關鍵績效（前＝每單單乘基準）</strong><div class="optimizer-summary"><div><strong>${c.before.trips} → ${c.after.trips}</strong><span>趟次 ${c.tripsReduced>0?`↓ ${c.tripsReduced}`:'—'}</span></div><div><strong>${c.before.emptyKm} → ${c.after.emptyKm} km</strong><span>空車 ${c.emptyKmSaved>=0?`↓ ${c.emptyKmSaved} km (${c.emptyKmSavedRate}%)`:`↑ ${Math.abs(c.emptyKmSaved)} km`}</span></div><div><strong>${c.before.poolRate}% → ${c.after.poolRate}%</strong><span>共乘率 ${c.poolRateDelta>=0?'↑':'↓'} ${Math.abs(c.poolRateDelta)}%</span></div><div><strong>${c.before.unassigned} → ${c.after.unassigned}</strong><span>未排成功</span></div></div></div>`:'';
  return `<div class="smart-modal-hint" style="margin-bottom:10px">方案修訂版 ${plan.revision||1}・${escapeHTML(plan.objectiveLabel||'平衡最佳化')}・路線計算：${escapeHTML(plan.routingStatus?.provider==='google'?'谷歌路線服務':'系統估算')}${plan.staleReason?`<br><strong style="color:#a32626">⚠ ${escapeHTML(plan.staleReason)}</strong>`:''}</div>${comparison}<div class="optimizer-summary"><div><strong>${s.bookings}</strong><span>待排預約</span></div><div><strong>${s.trips}${s.proposedTrips!==undefined&&s.proposedTrips!==s.trips?` / ${s.proposedTrips}`:''}</strong><span>${s.proposedTrips!==undefined&&s.proposedTrips!==s.trips?'可執行／候選趟次':'建議趟次'}</span></div><div><strong>${s.poolGroups}</strong><span>共乘趟次</span></div><div><strong>${s.savedTrips}</strong><span>減少趟次</span></div><div><strong>${s.emptyKm} 公里</strong><span>估算空車</span></div><div><strong>${s.loadedKm} 公里</strong><span>估算載客</span></div></div><div>${plan.items.map((item,i)=>{const route=item.poolValidation?.route,sequenceLabel=route?.sequenceMode==='interleaved'?'交錯上下車':'先接後送',evaluated=route?.sequenceEvaluatedCount;return `<div class="plan-item"><div class="list-item-head"><div><h4>${String(i+1).padStart(2,'0')}｜${item.pickups.map(p=>escapeHTML(p.name)).join('＋')}</h4><p>${formatTime(item.startAt)} → ${formatTime(item.endAt)}・可行司機 ${item.scarcity?.feasibleDrivers??'—'} 位${item.isPooled?`・${sequenceLabel}${evaluated?`（比較 ${evaluated} 種合法順序）`:''}`:''}</p></div><span class="${item.feasible?(item.isPooled?'plan-badge':'pill green'):'plan-warning'}">${item.feasible?(item.isPooled?`${item.bookingIds.length} 人共乘`:'可執行'):'不可執行'}</span></div><div class="plan-route">停靠順序：${(item.stops||[...item.pickups.map(p=>({...p,type:'pickup'})),...item.dropoffs.map(p=>({...p,type:'dropoff'}))]).map(s=>`${s.type==='pickup'?'接':'送'} ${escapeHTML(s.name)}`).join(' → ')}<br>司機：${escapeHTML(Organization.driver(item.driverId)?.name||'無')}・最佳化分數 ${item.score}<br>${escapeHTML(item.reason)}</div>${timeline(item)}</div>`;}).join('')}</div>${Identity.can('booking.schedule')&&plan.items.every(i=>i.feasible&&i.driverId)?`<div class="item-actions"><button type="button" class="btn success block" id="applyOptimizationBtn" data-plan="${plan.id}">確認方案並建立行程</button></div>`:''}`;
}
function monthLabel(month){const [y,m]=month.split('-').map(Number);return `${y} 年 ${m} 月`;}
function shiftMonth(month,delta){const [y,m]=month.split('-').map(Number),d=new Date(y,m-1+delta,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}
function calendarCells(month){const [y,m]=month.split('-').map(Number),first=new Date(y,m-1,1),start=new Date(y,m-1,1-first.getDay());return Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});}
function operationStatsForDate(date){
  const trips=Trip.list(orgId(),date),issues=Trip.issues(orgId()).filter(i=>Trip.get(i.tripId)?.date===date),pending=bookingSchedulingRows(date);
  return {pending:pending.length,trips:trips.length,completed:trips.filter(t=>t.status==='completed').length,cancelled:trips.filter(t=>t.status==='cancelled').length,activeDrivers:new Set(trips.map(t=>t.driverId).filter(Boolean)).size,issues:issues.length};
}
function renderTripCalendar(){
  const cells=calendarCells(selectedCalendarMonth);return `<section class="card calendar-shell"><div class="calendar-toolbar"><button type="button" class="btn outline sm" id="prevCalendarMonth">‹</button><div class="calendar-title">${monthLabel(selectedCalendarMonth)}</div><button type="button" class="btn outline sm" id="nextCalendarMonth">›</button></div><div class="calendar-weekdays">${['日','一','二','三','四','五','六'].map(x=>`<div>${x}</div>`).join('')}</div><div class="calendar-grid">${cells.map(d=>{const key=dateKey(d),st=operationStatsForDate(key),inMonth=key.slice(0,7)===selectedCalendarMonth;return `<button type="button" class="calendar-day ${inMonth?'':'muted'} ${key===selectedTripDate?'selected':''} ${key===dateKey()?'today':''}" data-date="${key}"><span class="day-number">${d.getDate()}</span><div class="day-count">${st.pending?`待排 <strong>${st.pending}</strong><br>`:''}${st.trips?`行程 <strong>${st.trips}</strong>`:''}</div></button>`;}).join('')}</div></section>`;
}
function dispatchTripOpenIssue(tripId){return Trip.issues(orgId()).some(i=>i.tripId===tripId&&i.status!=='resolved');}
function dispatchTripNextPendingAt(t){const step=(t?.steps||[]).find(s=>!s.actualAt)||null;return step?.scheduledAt?new Date(step.scheduledAt):null;}
function dispatchTripMatchesQuick(t,quick){
  if(quick==='unassigned')return !t.driverId||!t.vehicleId;
  if(quick==='in_progress')return t.status==='in_progress';
  if(quick==='soon'){if(isTripTerminalStatus(t.status))return false;const at=dispatchTripNextPendingAt(t);return !!at&&at.getTime()<=Date.now()+30*60*1000;}
  if(quick==='issues')return t.status==='interrupted'||dispatchTripOpenIssue(t.id);
  if(quick==='completed')return t.status==='completed';
  return true;
}
function applyDispatchTripFilters(rows){
  const f=dispatchTripFilters||{},q=String(f.query||'').trim().toLowerCase();
  return rows.filter(t=>dispatchTripMatchesQuick(t,f.quick||'all')).filter(t=>f.driver==='all'||(f.driver==='unassigned'?!t.driverId:t.driverId===f.driver)).filter(t=>f.vehicle==='all'||(f.vehicle==='unassigned'?!t.vehicleId:t.vehicleId===f.vehicle)).filter(t=>!q||[t.code,t.passengerSummary,t.pickupAddress,t.dropoffAddress,t.needs,Organization.driver(t.driverId)?.name,Organization.vehicle(t.vehicleId)?.plate].some(v=>String(v||'').toLowerCase().includes(q)));
}
function renderDispatchTripFilters(rows){
  const quicks=[['all','全部'],['unassigned','未派車'],['in_progress','進行中'],['soon','即將逾時'],['issues','有異常'],['completed','已完成']];
  const chipHtml=quicks.map(([key,label])=>{const count=rows.filter(t=>dispatchTripMatchesQuick(t,key)).length;return `<button class="dispatch-filter-chip ${dispatchTripFilters.quick===key?'active':''}" data-trip-filter="${key}" type="button" aria-pressed="${dispatchTripFilters.quick===key?'true':'false'}">${label} <span>${count}</span></button>`;}).join('');
  const drivers=Organization.drivers(orgId()),vehicles=Organization.vehicles(orgId());
  const driverOptions=`<option value="all">全部司機</option><option value="unassigned" ${dispatchTripFilters.driver==='unassigned'?'selected':''}>未指派司機</option>`+drivers.map(d=>`<option value="${escapeHTML(d.id)}" ${dispatchTripFilters.driver===d.id?'selected':''}>${escapeHTML(d.name)}</option>`).join('');
  const vehicleOptions=`<option value="all">全部車輛</option><option value="unassigned" ${dispatchTripFilters.vehicle==='unassigned'?'selected':''}>未派車</option>`+vehicles.map(v=>`<option value="${escapeHTML(v.id)}" ${dispatchTripFilters.vehicle===v.id?'selected':''}>${escapeHTML(v.plate)}・${escapeHTML(v.model||'')}</option>`).join('');
  const filtered=applyDispatchTripFilters(rows);
  return `<div class="dispatch-filter-shell"><div class="dispatch-filter-row"><div class="dispatch-filter-chips" aria-label="快速篩選">${chipHtml}</div></div><div class="dispatch-filter-controls"><input class="search" id="tripSearch" value="${escapeHTML(dispatchTripFilters.query||'')}" placeholder="搜尋乘客、地址、車牌、司機或行程編號" aria-label="搜尋行程"><select class="inline-select" id="tripDriverFilter" aria-label="依司機篩選">${driverOptions}</select><select class="inline-select" id="tripVehicleFilter" aria-label="依車輛篩選">${vehicleOptions}</select><button class="btn outline sm" id="clearTripFiltersBtn" type="button">清除篩選</button></div><div class="dispatch-filter-summary" id="dispatchFilterSummary">顯示 ${filtered.length} / ${rows.length} 筆行程</div></div>`;
}
function renderDispatchTripRows(rows){return rows.map(t=>{const segments=Trip.resourceSegments(t),canFormalCorrection=Identity.can('trip.manage')&&t.status==='completed';return `<tr><td><strong>${formatTime(t.steps[0].scheduledAt)}｜${escapeHTML(t.code)}</strong><br><span class="muted small">${formatTime(t.steps[t.steps.length-1].scheduledAt)} 預計送達・資源區段 ${segments.length}</span></td><td><strong>${escapeHTML(t.passengerSummary)}</strong><div class="address">${escapeHTML(t.pickupAddress)} → ${escapeHTML(t.dropoffAddress)}<br>${escapeHTML(t.needs)}${t.status==='interrupted'?`<br><strong>中斷：</strong>${escapeHTML(t.interruptReason||'待處理')}`:''}</div></td><td>${escapeHTML(Organization.driver(t.driverId)?.name||'未指派')}</td><td>${escapeHTML(Organization.vehicle(t.vehicleId)?.plate||'未派車')}</td><td>${statusPill(t.status)}</td><td>${canAssignTripResources()&&t.status==='scheduled'?`<button type="button" class="btn outline sm assign-btn" data-trip="${t.id}">改派司機／車輛</button> `:''}${canAssignTripResources()&&t.status==='interrupted'?`<button type="button" class="btn warning sm handover-trip-btn" data-trip="${t.id}">換司機／換車</button> <button type="button" class="btn success sm resume-trip-btn" data-trip="${t.id}">恢復行程</button> <button type="button" class="btn danger sm abort-trip-btn" data-trip="${t.id}">終止行程</button> `:''}${canFormalCorrection?`<button type="button" class="btn warning sm formal-trip-correction-btn" data-trip="${t.id}" data-revision="${t.revision}">正式修正</button> `:''}<button type="button" class="btn outline sm trip-history-btn" data-trip="${t.id}">執行歷史</button></td></tr>`;}).join('')||'<tr><td colspan="6"><div class="empty">當天沒有行程</div></td></tr>'; }
function dispatchTrips(){
  const rows=Trip.list(orgId(),selectedTripDate).sort((a,b)=>new Date(a.steps[0].scheduledAt)-new Date(b.steps[0].scheduledAt)),st=operationStatsForDate(selectedTripDate);
  const filteredRows=applyDispatchTripFilters(rows);
  return `<div class="page-head"><div><h2>派車／行程管理</h2><p>恢復早期版本的日曆與每日營運摘要；這裡只管理已建立的行程，不再和待排預約重複。</p></div><div class="page-actions"><input class="inline-date" id="tripDateInput" type="date" value="${selectedTripDate}">${canAssignTripResources()?'<button type="button" class="btn primary" id="openCreateTripBtn">＋ 手動行程</button>':''}</div></div>${renderTripCalendar()}<section class="card"><div class="card-head"><div><h3>${selectedTripDate} 行程紀錄</h3><p>先用狀態快速篩選，再用司機、車輛或關鍵字縮小範圍</p></div></div><div class="daily-summary"><div class="mini-stat"><strong>${st.pending}</strong><span>待排預約</span></div><div class="mini-stat"><strong>${st.trips}</strong><span>正式行程</span></div><div class="mini-stat"><strong>${st.completed}</strong><span>已完成</span></div><div class="mini-stat"><strong>${st.cancelled}</strong><span>已取消</span></div><div class="mini-stat"><strong>${st.activeDrivers}</strong><span>出勤司機</span></div><div class="mini-stat"><strong>${st.issues}</strong><span>異常</span></div></div>${renderDispatchTripFilters(rows)}<div class="table-wrap"><table class="data-table"><thead><tr><th>時間／行程</th><th>乘客與路線</th><th>司機</th><th>車輛</th><th>狀態</th><th>操作</th></tr></thead><tbody id="dispatchTripRows">${renderDispatchTripRows(filteredRows)}</tbody></table></div></section>`;
}
function dispatchIssues(){ const now=Date.now(),rows=Trip.issues(orgId()).filter(i=>{const created=new Date(i.createdAt||0).getTime();return !Number.isFinite(created)||created<=now;}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); return `<div class="page-head"><div><h2>異常中心</h2><p>異常狀態：待接手 → 已接手 → 處理中 → 已結案；重大異常可連動行程中斷與資源交接。</p></div></div><div class="list">${rows.map(i=>{ const t=Trip.get(i.tripId),d=Organization.driver(i.driverId),canManage=Identity.can('issue.manage'),tripManage=Identity.can('trip.manage'); return `<div class="list-item issue-card ${i.status==='resolved'?'resolved':''}"><div class="list-item-head"><div><h4>${escapeHTML(i.type)}</h4><p>${formatDateTime(i.createdAt)}・${escapeHTML(d?.name||'未知司機')}<br>${escapeHTML(t?.code||'無行程')}｜${escapeHTML(i.note||'無補充')}<br><span class="muted small">${i.acknowledgedAt?`接手 ${formatDateTime(i.acknowledgedAt)}・`:''}${i.handlingAt?`處理 ${formatDateTime(i.handlingAt)}・`:''}${i.resolvedAt?`結案 ${formatDateTime(i.resolvedAt)}`:''}<br>${(()=>{const s=Trip.issueSlaState(i);return `接手服務時限：${escapeHTML(s.label)}・期限 ${i.ackDueAt?formatDateTime(i.ackDueAt):'—'}`;})()}</span>${i.resolutionNote?`<br><strong>結案：</strong>${escapeHTML(i.resolutionNote)}`:''}</p></div><div style="display:grid;gap:6px;justify-items:end"><span class="pill ${Trip.issueStatusClass(i.status)}">${escapeHTML(Trip.issueStatusLabel(i.status))}</span><span class="pill ${Trip.issueSeverityClass(i.severity)}">${escapeHTML(Trip.issueSeverityLabel(i.severity))}</span></div></div><div class="item-actions">${canManage&&i.status==='open'?`<button type="button" class="btn primary sm acknowledge-issue-btn" data-id="${i.id}">接手異常</button>`:''}${canManage&&i.status==='acknowledged'?`<button type="button" class="btn warning sm handling-issue-btn" data-id="${i.id}">開始處理</button>`:''}${tripManage&&i.status==='handling'&&t?.status==='in_progress'?`<button type="button" class="btn danger sm interrupt-trip-btn" data-trip="${t.id}" data-issue="${i.id}" data-revision="${t.revision}">中斷行程</button>`:''}${tripManage&&i.status==='handling'&&t?.status==='interrupted'?`<button type="button" class="btn warning sm handover-trip-btn" data-trip="${t.id}" data-issue="${i.id}">換司機／換車</button><button type="button" class="btn success sm resume-trip-btn" data-trip="${t.id}" data-issue="${i.id}">恢復行程</button><button type="button" class="btn danger sm abort-trip-btn" data-trip="${t.id}" data-issue="${i.id}">終止行程</button>`:''}${canManage&&i.status==='handling'&&t?.status!=='interrupted'?`<button type="button" class="btn success sm resolve-trip-issue-btn" data-id="${i.id}">異常結案</button>`:''}<button type="button" class="btn outline sm trip-history-btn" data-trip="${i.tripId}">行程歷史</button></div></div>`; }).join('')||'<div class="empty">目前沒有異常</div>'}</div>`; }

function platformHome(){
  const orgs=Organization.list(),active=orgs.filter(o=>o.active!==false),members=store.state.memberships.filter(m=>Identity.membershipStatus(m)==='active'),openReports=SystemReport.listAll().filter(r=>r.status==='open');
  const statusRows=active.map(o=>{
    const isRequesterHub=o.id===APP_CONFIG.requesterOrganizationId||o.type==='requester_hub';
    const ownerMembership=isRequesterHub?null:store.state.memberships.find(m=>m.organizationId===o.id&&m.role==='owner'&&Identity.membershipStatus(m)!=='revoked');
    const ownerUser=ownerMembership?store.state.users.find(u=>u.id===ownerMembership.userId):null;
    const employeeCount=store.state.memberships.filter(m=>m.organizationId===o.id&&['driver','dispatcher'].includes(m.role)&&Identity.membershipStatus(m)==='active').length;
    const vehicles=Organization.vehicles(o.id).length,pending=Booking.pending(o.id,null,Identity.currentUser()?.id).length,todayTrips=Trip.list(o.id,dateKey()).length,reports=SystemReport.listAll().filter(r=>r.organizationId===o.id&&r.status==='open').length;
    return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(o.name)}</h4><p>${isRequesterHub?`需求者 ${store.state.memberships.filter(m=>m.organizationId===o.id&&m.role==='requester'&&Identity.membershipStatus(m)==='active').length} 人・帳號集中管理`:`負責人：${escapeHTML(ownerUser?.name||'尚未指定')}・員工 ${employeeCount} 人・車輛 ${vehicles} 台<br>待處理預約 ${pending}・今日行程 ${todayTrips}・系統問題 ${reports}`}</p></div><span class="pill ${isRequesterHub?'purple':ownerMembership?'green':'yellow'}">${isRequesterHub?'需求者組織':ownerMembership?'已有負責人':'待指定負責人'}</span></div><div class="item-actions"><button type="button" class="btn outline sm platform-enter-org-btn" data-org="${o.id}">查看組織</button></div></div>`;
  }).join('');
  return `<div class="page-head"><div><h2>平台總覽</h2><p>超級管理者是平台／程式開發方，不隸屬任何組織，可查看所有組織狀況。</p></div><div class="page-actions">${Identity.can('booking.sync_google')?'<button type="button" class="btn primary" id="syncCustomerBookingsBtn">↻ 重新同步資料</button>':''}</div></div><div class="metric-grid"><div class="metric"><span>有效組織</span><strong>${active.length}</strong><small>平台客戶／合作機構</small></div><div class="metric"><span>有效組織身分</span><strong>${members.length}</strong><small>只統計組織成員</small></div><div class="metric"><span>待處理問題</span><strong>${openReports.length}</strong><small>系統問題回報</small></div><div class="metric"><span>目前查看</span><strong style="font-size:15px">${escapeHTML(currentOrg()?.name||'-')}</strong><small>只是查看範圍，不代表隸屬</small></div></div><section class="card"><div class="card-head"><div><h3>所有組織狀況</h3><p>跨組織唯讀營運摘要</p></div></div><div class="list">${statusRows||'<div class="empty">目前沒有有效組織</div>'}</div></section><section class="card"><div class="card-head"><div><h3>平台責任邊界</h3><p>平台帳號與公司組織身分完全分離</p></div></div><div class="meta">✓ 新增／移除組織<br>✓ 每個組織指定唯一一位負責人<br>✓ 調整各組織身分與角色<br>✓ 跨組織查看營運摘要<br>✓ 處理系統問題回報<br><br>不提供：公司車輛維護、派車、行程執行。</div></section>`;
}
function platformOrganizations(){
  const rows=Organization.list();
  return `<div class="page-head"><div><h2>組織管理</h2><p>平台超級管理者可修改公司名稱、聯絡電話、統一編號與唯一負責人；「需求者組織」維持系統固定管理。</p></div><div class="page-actions"><button type="button" class="btn primary" id="openAddOrganizationBtn">＋ 新增組織</button></div></div><div class="list">${rows.map(o=>{const isRequesterHub=o.id===APP_CONFIG.requesterOrganizationId||o.type==='requester_hub',memberCount=store.state.memberships.filter(m=>m.organizationId===o.id&&Identity.membershipStatus(m)==='active').length,ownerM=isRequesterHub?null:store.state.memberships.find(m=>m.organizationId===o.id&&m.role==='owner'&&Identity.membershipStatus(m)!=='revoked'),ownerU=ownerM?store.state.users.find(u=>u.id===ownerM.userId):null;return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(o.name)}</h4><p>${isRequesterHub?'系統需求者組織・不可手動新增公司角色':o.type==='transport_provider'?'交通／車隊公司':o.type==='care_facility'?'長照／日照機構':'其他合作組織'}${!isRequesterHub?(o.taxId?`・統編 ${escapeHTML(o.taxId)}`:'・統編未填'):''}<br>${isRequesterHub?`有效需求者：${memberCount} 人`:`聯絡電話：${escapeHTML(o.contactPhone||'未填')}<br>負責人：${escapeHTML(ownerU?.name||'尚未指定')}・有效成員：${memberCount} 人`}</p></div><span class="pill ${isRequesterHub?'purple':o.active!==false?'green':'gray'}">${isRequesterHub?'系統組織':o.active!==false?'有效':'已移除'}</span></div><div class="item-actions">${isRequesterHub?`<button type="button" class="btn outline sm platform-enter-org-btn" data-org="${o.id}">查看需求者</button>`:`<button type="button" class="btn outline sm platform-edit-org-btn" data-org="${o.id}">編輯名稱／聯絡／負責人</button>${o.active!==false?`<button type="button" class="btn outline sm platform-enter-org-btn" data-org="${o.id}">管理成員</button><button type="button" class="btn warning sm platform-org-active-btn" data-org="${o.id}" data-active="false">停用組織</button>`:`<button type="button" class="btn success sm platform-org-active-btn" data-org="${o.id}" data-active="true">重新啟用</button>`}`}</div></div>`;}).join('')}</div>`;
}

function platformMembers(){
  const org=currentOrg(),memberships=store.state.memberships.filter(m=>m.organizationId===orgId());
  const isRequesterHub=org?.id===APP_CONFIG.requesterOrganizationId||org?.type==='requester_hub';
  const statusClass={active:'green',suspended:'gray',revoked:'gray'};
  if(isRequesterHub){
    return `<div class="page-head"><div><h2>需求者成員</h2><p>需求者可自行透過新增帳號、谷歌、蘋果或臉書登入加入；平台超級管理者也可以替既有公司成員額外新增「需求者」身分。</p></div></div><section class="card"><div class="card-head"><div><h3>需求者組織規則</h3><p>角色固定為需求者。平台超級管理者可查看或調整組織身分狀態；公司工作者也可以在同一個使用者上同時擁有需求者組織身分。</p></div><span class="pill purple">${memberships.filter(m=>Identity.membershipStatus(m)==='active').length} 人</span></div></section><section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>姓名</th><th>角色</th><th>手機</th><th>Membership</th><th>帳號</th><th>操作</th></tr></thead><tbody>${memberships.map(m=>{const u=store.state.users.find(x=>x.id===m.userId),status=Identity.membershipStatus(m);return `<tr><td><strong>${escapeHTML(u?.name||'未知使用者')}</strong><br><span class="muted small">${escapeHTML(u?.email||'')}</span></td><td><span class="pill purple">需求者</span></td><td>${formatPhone(u?.phone||'')}</td><td><select class="inline-select membership-status-select" data-membership="${m.id}">${membershipStatusOptions(m)}</select><div style="margin-top:5px"><span class="pill ${statusClass[status]||'gray'}">${MEMBERSHIP_STATUS_LABELS[status]||status}</span></div></td><td><span class="pill ${u?.active?'green':'gray'}">${u?.active?'帳號啟用':'帳號停用'}</span></td><td><button type="button" class="btn outline sm membership-history-btn" data-membership="${m.id}">異動歷史</button> <button type="button" class="btn outline sm platform-edit-member-btn" data-membership="${m.id}">編輯姓名／手機</button></td></tr>`;}).join('')||'<tr><td colspan="6"><div class="empty">目前還沒有需求者</div></td></tr>'}</tbody></table></div></section>`;
  }
  const ownerMembership=memberships.find(m=>m.role==='owner'&&Identity.membershipStatus(m)!=='revoked');
  return `<div class="page-head"><div><h2>組織成員</h2><p>${escapeHTML(org?.name||'-')}・公司組織身分只包含負責人、司機、調度員。公司停權＝撤銷該公司工作帳號；平台超級管理者可查看歷史、恢復組織身分，或讓該使用者加入其他公司。</p></div><div class="page-actions"><button type="button" class="btn primary" id="openAddStaffBtn">＋ 新增組織成員</button></div></div><section class="card"><div class="card-head"><div><h3>負責人規則</h3><p>${ownerMembership?'目前已有負責人；平台超級管理者可在「組織管理」直接指定其他成員接任。':'此組織尚未指定負責人，可在「組織管理」直接指定。'}</p></div><span class="pill ${ownerMembership?'green':'yellow'}">${ownerMembership?'1 / 1':'0 / 1'}</span></div></section><section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>姓名</th><th>角色</th><th>手機</th><th>需求者</th><th>Membership</th><th>帳號</th><th>操作</th></tr></thead><tbody>${memberships.map(m=>{const u=store.state.users.find(x=>x.id===m.userId),status=Identity.membershipStatus(m),isRequester=!!u&&Identity.hasRequesterIdentity(u.id);return `<tr><td><strong>${escapeHTML(u?.name||'未知使用者')}</strong></td><td><select class="inline-select membership-role-select" data-membership="${m.id}"><option value="owner" ${m.role==='owner'?'selected':''}>負責人</option><option value="dispatcher" ${m.role==='dispatcher'?'selected':''}>調度人員</option><option value="driver" ${m.role==='driver'?'selected':''}>司機</option></select></td><td>${formatPhone(u?.phone||'')}</td><td><span class="pill ${isRequester?'purple':'gray'}">${isRequester?'是':'否'}</span><div style="margin-top:6px"><button type="button" class="btn ${isRequester?'danger':'outline'} sm platform-requester-toggle-btn" data-user="${u?.id||''}" data-enabled="${isRequester?'false':'true'}">${isRequester?'移除需求者':'＋需求者身分'}</button></div></td><td><select class="inline-select membership-status-select" data-membership="${m.id}">${membershipStatusOptions(m)}</select><div style="margin-top:5px"><span class="pill ${statusClass[status]||'gray'}">${MEMBERSHIP_STATUS_LABELS[status]||status}</span></div></td><td><span class="pill ${status==='revoked'?'gray':'green'}">${status==='revoked'?'工作帳號已撤銷':'工作帳號有效'}</span></td><td><button type="button" class="btn outline sm membership-history-btn" data-membership="${m.id}">異動歷史</button> <button type="button" class="btn outline sm platform-edit-member-btn" data-membership="${m.id}">編輯成員</button></td></tr>`;}).join('')||'<tr><td colspan="7"><div class="empty">此組織目前沒有成員</div></td></tr>'}</tbody></table></div></section>`;
}

function platformReports(){
  const rows=SystemReport.listAll().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return `<div class="page-head"><div><h2>問題回報</h2><p>公司人員與需求者回報的應用程式／後台系統問題；與行程異常分開。</p></div><div class="page-actions"><button type="button" class="btn outline" id="openSystemReportBtn">＋ 建立問題回報</button></div></div><div class="list">${rows.map(r=>{const org=Organization.get(r.organizationId),u=store.state.users.find(x=>x.id===r.userId);return `<div class="list-item issue-card ${r.status==='resolved'?'resolved':''}"><div class="list-item-head"><div><h4>${escapeHTML(r.title)}</h4><p>${formatDateTime(r.createdAt)}・${escapeHTML(org?.name||'平台')}・${escapeHTML(u?.name||'未知使用者')}（${ROLE_LABELS[r.role]||r.role||'-'}）<br>${escapeHTML(r.category)}｜${escapeHTML(r.detail)}</p></div><span class="pill ${r.status==='resolved'?'green':'red'}">${r.status==='resolved'?'已處理':'待處理'}</span></div>${r.status==='open'?`<div class="item-actions"><button type="button" class="btn success sm resolve-system-report-btn" data-id="${r.id}">標記已處理</button></div>`:''}</div>`;}).join('')||'<div class="empty">目前沒有系統問題回報</div>'}</div>`;
}
function ownerHome(){
  const operationDate=selectedTripDate||preferredOperationalDate(),k=Analytics.fleetDaily(orgId(),operationDate),pending=bookingSchedulingRows(operationDate),trips=Trip.list(orgId(),operationDate);
  return `<div class="page-head"><div><h2>公司總覽</h2><p>${escapeHTML(currentOrg()?.name||'')}・負責人可管理公司、待排預約 與正式行程</p></div><div class="page-actions"><input class="inline-date" id="operationDateInput" type="date" value="${operationDate}">${Identity.can('booking.sync_google')?'<button type="button" class="btn primary" id="syncCustomerBookingsBtn">↻ 重新同步資料</button>':''}</div></div><div class="metric-grid"><div class="metric"><span>公司司機</span><strong>${Organization.drivers(orgId()).length}</strong></div><div class="metric"><span>調度人員</span><strong>${store.state.memberships.filter(m=>m.organizationId===orgId()&&m.role==='dispatcher'&&Identity.membershipStatus(m)==='active').length}</strong></div><div class="metric"><span>待排預約</span><strong>${pending.length}</strong><small>${operationDate}</small></div><div class="metric"><span>正式行程</span><strong>${trips.length}</strong><small>${operationDate}</small></div></div>${renderSchedulingWorkspace(operationDate,pending)}<section class="card"><div class="card-head"><div><h3>每日關鍵績效</h3><p>${operationDate} 公司營運概況</p></div></div>${renderKpiCards(k)}</section><section class="card"><div class="card-head"><div><h3>司機關鍵績效</h3></div></div>${renderDriverKpiTable(operationDate)}</section>`;
}
function ownerUsers(){
  const memberships=store.state.memberships.filter(m=>m.organizationId===orgId()&&['driver','dispatcher'].includes(m.role));
  const statusClass={active:'green',suspended:'gray',revoked:'gray'};
  return `<div class="page-head"><div><h2>公司人員</h2><p>負責人可新增司機或調度員、授予需求者身分，並可撤銷本公司的工作帳號。公司停權＝撤銷；已撤銷後只有 平台超級管理者可以恢復或安排到其他公司。</p></div><div class="page-actions"><button type="button" class="btn primary" id="openAddStaffBtn">＋ 新增人員</button></div></div><div class="metric-grid"><div class="metric"><span>司機</span><strong>${memberships.filter(m=>m.role==='driver'&&Identity.membershipStatus(m)==='active').length}</strong></div><div class="metric"><span>調度人員</span><strong>${memberships.filter(m=>m.role==='dispatcher'&&Identity.membershipStatus(m)==='active').length}</strong></div><div class="metric"><span>同時為需求者</span><strong>${memberships.filter(m=>{const u=store.state.users.find(x=>x.id===m.userId);return !!u&&Identity.hasRequesterIdentity(u.id);}).length}</strong></div><div class="metric"><span>目前公司</span><strong style="font-size:15px">${escapeHTML(currentOrg()?.name||'-')}</strong></div></div><section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>姓名</th><th>角色</th><th>手機</th><th>需求者</th><th>Membership</th><th>帳號</th></tr></thead><tbody>${memberships.map(m=>{const u=store.state.users.find(x=>x.id===m.userId),status=Identity.membershipStatus(m),isRequester=!!u&&Identity.hasRequesterIdentity(u.id);return `<tr><td><strong>${escapeHTML(u?.name||'未知使用者')}</strong></td><td><span class="pill ${m.role==='dispatcher'?'blue':'green'}">${ROLE_LABELS[m.role]}</span></td><td>${formatPhone(u?.phone||'')}</td><td><span class="pill ${isRequester?'purple':'gray'}">${isRequester?'是':'否'}</span><div style="margin-top:6px"><button type="button" class="btn ${isRequester?'danger':'outline'} sm owner-requester-toggle-btn" data-user="${u?.id||''}" data-enabled="${isRequester?'false':'true'}">${isRequester?'移除需求者':'＋需求者身分'}</button></div></td><td><span class="pill ${status==='revoked'?'gray':'green'}">${status==='revoked'?'已撤銷':'有效'}</span></td><td><span class="pill ${status==='revoked'?'gray':'green'}">${status==='revoked'?'工作帳號已撤銷':'工作帳號有效'}</span><div style="margin-top:6px">${status==='active'?`<button type="button" class="btn danger sm revoke-membership-btn" data-membership="${m.id}">撤銷帳號</button>`:''} <button type="button" class="btn outline sm membership-history-btn" data-membership="${m.id}">異動歷史</button></div></td></tr>`;}).join('')||'<tr><td colspan="6"><div class="empty">目前沒有公司員工</div></td></tr>'}</tbody></table></div></section>`;
}
function ownerVehicles(){
  const vehicles=Organization.vehicles(orgId());
  const statusClass={available:'green',maintenance:'yellow',retired:'red'};
  return `<div class="page-head"><div><h2>車輛管理</h2><p>共享車池不永久綁定司機。從未有行程的誤建車輛可真正刪除；只要曾有行程紀錄就只能退役並保留歷史。</p></div><div class="page-actions"><button type="button" class="btn primary" id="openAddVehicleBtn">＋ 新增車輛</button></div></div>
  <div class="metric-grid"><div class="metric"><span>車輛總數</span><strong>${vehicles.length}</strong></div><div class="metric"><span>可派車</span><strong>${vehicles.filter(v=>v.status==='available').length}</strong></div><div class="metric"><span>維修／保養中</span><strong>${vehicles.filter(v=>v.status==='maintenance').length}</strong></div><div class="metric"><span>已退役</span><strong>${vehicles.filter(v=>v.status==='retired').length}</strong></div></div>
  <section class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>車牌</th><th>車型</th><th>容量／設備</th><th>目前狀態</th><th>使用紀錄</th><th>操作</th></tr></thead><tbody>${vehicles.map(v=>{
    const usage=Organization.vehicleUsage(v.id);
    const usageText=usage.tripCount
      ?`${usage.tripCount} 趟歷史${usage.incompleteTripCount?`<br><span class="pill yellow">未完成 ${usage.incompleteTripCount}</span>`:''}`
      :(usage.draftPlanCount?`<span class="pill yellow">派車草案 ${usage.draftPlanCount}</span>`:'<span class="pill gray">從未使用</span>');
    const lifecycleAction=usage.tripCount===0
      ?(usage.draftPlanCount===0
        ?`<button type="button" class="btn danger sm vehicle-lifecycle-btn" data-vehicle="${v.id}" data-action="delete">刪除</button>`
        :'<button type="button" class="btn danger sm" disabled>先清除派車草案</button>')
      :(v.status!=='retired'?`<button type="button" class="btn danger sm vehicle-lifecycle-btn" data-vehicle="${v.id}" data-action="retire" ${usage.incompleteTripCount?'disabled':''}>退役</button>`:'<span class="pill gray">保留歷史</span>');
    return `<tr><td><strong>${escapeHTML(v.plate)}</strong></td><td>${escapeHTML(v.model)}</td><td>${v.capacity} 人<br><span class="muted small">輪椅位 ${v.wheelchairSlots}・無障礙 ${v.accessible?'有':'無'}</span></td><td><span class="pill ${statusClass[v.status]||'gray'}">${escapeHTML(Organization.vehicleStatusLabel(v.status))}</span>${v.status==='retired'&&v.retiredAt?`<div class="small muted" style="margin-top:5px">退役 ${formatDateTime(v.retiredAt)}</div>`:''}</td><td>${usageText}</td><td><div class="item-actions" style="margin-top:0"><button type="button" class="btn outline sm edit-vehicle-btn" data-vehicle="${v.id}">編輯</button>${lifecycleAction}</div></td></tr>`;
  }).join('')||'<tr><td colspan="6"><div class="empty">尚無車輛</div></td></tr>'}</tbody></table></div></section>`;
}


{
const BENEFIT_P2_SCHEMA_VERSION=2;
function p2ParseCsv(text){
  let src=String(text||'');
  if(src.charCodeAt(0)===0xFEFF)src=src.slice(1);
  const rows=[];let row=[],cur='',quoted=false;
  const pushField=()=>{row.push(cur);cur='';};
  const pushRow=()=>{if(row.some(v=>String(v).trim()!=='')){rows.push(row);}row=[];};
  for(let i=0;i<src.length;i++){
    const c=src[i];
    if(c==='"'){
      if(quoted&&src[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    }else if(c===','&&!quoted){pushField();}
    else if((c==='\n'||c==='\r')&&!quoted){
      if(c==='\r'&&src[i+1]==='\n')i++;
      pushField();pushRow();
    }else cur+=c;
  }
  if(quoted)throw new Error('CSV quoted 欄位未正確關閉');
  if(cur!==''||row.length){pushField();pushRow();}
  if(rows.length<2)return [];
  const headers=rows[0].map((h,i)=>{
    let k=String(h??'').trim();if(i===0&&k.charCodeAt(0)===0xFEFF)k=k.slice(1);return k;
  });
  if(headers.some(h=>!h))throw new Error('CSV header 不可為空白');
  const seen=new Set();for(const h of headers){if(seen.has(h))throw new Error(`CSV header 重複：${h}`);seen.add(h);}
  return rows.slice(1).map(values=>{const o={};headers.forEach((k,i)=>o[k]=values[i]??'');return o;});
}
function p2CsvToRuleset(row){return {code:row.code,version:row.version,name:row.name,serviceType:row.serviceType||'transportation',jurisdiction:{country:row.country||'TW',city:row.city||null},effectiveFrom:row.effectiveFrom,effectiveTo:row.effectiveTo||null,source:{agency:row.sourceAgency,title:row.sourceTitle,url:row.sourceUrl,publishedAt:row.sourcePublishedAt,checkedAt:row.sourceCheckedAt},conditions:{cmsLevels:row.cmsLevels,requireApprovedCarePlan:row.requireApprovedCarePlan,requireTransportationApproved:row.requireTransportationApproved,identityCategories:row.identityCategories,residenceCities:row.residenceCities},calculation:{mode:row.calculationMode||'none',currency:row.currency||'TWD',amount:row.amount,percentage:row.percentage,maxAmount:row.maxAmount}};}
function p2Stable(value){if(Array.isArray(value))return value.map(p2Stable);if(value&&typeof value==='object'){return Object.keys(value).sort().reduce((o,k)=>(o[k]=p2Stable(value[k]),o),{});}return value;}
function p2Flatten(obj,prefix='',out={}){if(obj&&typeof obj==='object'&&!Array.isArray(obj)){Object.keys(obj).sort().forEach(k=>p2Flatten(obj[k],prefix?`${prefix}.${k}`:k,out));}else out[prefix]=Array.isArray(obj)?JSON.stringify(obj):obj;return out;}
function p2DaysUntil(date){if(!date)return null;const a=new Date(date+'T00:00:00'),b=new Date(dateKey()+'T00:00:00');return Number.isNaN(a.getTime())?null:Math.ceil((a-b)/86400000);}
function p2AppendRun(db,row){db.benefitP2Runs=Array.isArray(db.benefitP2Runs)?db.benefitP2Runs:[];db.benefitP2Runs.unshift({id:uid('bp2run'),schemaVersion:BENEFIT_P2_SCHEMA_VERSION,createdAt:nowISO(),...row});if(db.benefitP2Runs.length>200)db.benefitP2Runs.length=200;}
Benefit.adapters={
  json:{parse(payload){const data=JSON.parse(String(payload||''));return Array.isArray(data)?data:(Array.isArray(data.rulesets)?data.rulesets:[data]);}},
  csv:{parse(payload){return p2ParseCsv(payload).map(p2CsvToRuleset);}}
};
Benefit.importRulesets=function({format='json',payload='',actorUserId=null}={}){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有 平台超級管理者可以匯入 補助規則集'};const adapter=this.adapters[format];if(!adapter)return {ok:false,error:'不支援的 Adapter 格式'};let rows;try{rows=adapter.parse(payload);}catch(e){const error=`解析失敗：${e.message||e}`;store.mutate(db=>p2AppendRun(db,{runType:'import',format,actorUserId,createdCount:0,errorCount:1,errors:[error],status:'failed_parse'}));Audit.log('benefit.p2.import_failed',`補助規則集 import parse 失敗：${error}`,{actorUserId});return {ok:false,error};}if(!rows.length){const error='沒有可匯入的 Ruleset';store.mutate(db=>p2AppendRun(db,{runType:'import',format,actorUserId,createdCount:0,errorCount:0,errors:[],status:'empty'}));Audit.log('benefit.p2.import_empty',`補助規則集 import empty：${format}`,{actorUserId});return {ok:false,error,status:'empty'};}const created=[],errors=[];for(const [i,row] of rows.entries()){const r=this.createRuleset(row,actorUserId);if(r.ok)created.push(r.ruleset);else errors.push(`第 ${i+1} 筆：${r.error}`);}store.mutate(db=>p2AppendRun(db,{runType:'import',format,actorUserId,createdCount:created.length,errorCount:errors.length,errors:[...errors],status:errors.length?(created.length?'partial':'failed'):'success'}));Audit.log('benefit.p2.import',`補助規則集 import：${created.length} created / ${errors.length} errors`,{actorUserId});return {ok:created.length>0,created,errors};};
Benefit.diffRulesets=function(fromId,toId){const a=this.ruleset(fromId),b=this.ruleset(toId);if(!a||!b)return {ok:false,error:'找不到要比較的 Ruleset'};const ignore=new Set(['id','createdAt','createdByUserId','updatedAt','updatedByUserId','publishedAt','publishedByUserId','retiredAt','retiredByUserId','schemaVersion','status']);const fa=p2Flatten(p2Stable(a)),fb=p2Flatten(p2Stable(b)),keys=[...new Set([...Object.keys(fa),...Object.keys(fb)])].filter(k=>!ignore.has(k.split('.')[0])).sort(),changes=keys.filter(k=>JSON.stringify(fa[k]??null)!==JSON.stringify(fb[k]??null)).map(k=>({field:k,from:fa[k]??null,to:fb[k]??null}));return {ok:true,from:a,to:b,changes,changed:changes.length};};
Benefit.alerts=function({actorUserId=null,organizationId=null,days=null}={}){const rows=[],today=dateKey(),configured=store.state.benefitAutomationSettings?.alertDays,windowDays=Math.max(0,Number(days??configured??30)||0);for(const r of this.rulesets({includeDraft:true,includeRetired:false,actorUserId})){if(r.status!=='published'||!r.effectiveTo)continue;const d=p2DaysUntil(r.effectiveTo);if(d!==null&&d>=-windowDays&&d<=windowDays)rows.push({type:d<0?'ruleset_expired':'ruleset_expiring',severity:d<0?'danger':'warning',date:r.effectiveTo,days:d,title:`Ruleset ${r.version} ${d<0?'已到期':'即將到期'}`,detail:`${r.name||r.code}・${r.effectiveTo}`,referenceId:r.id});}
  for(const a of this.authorizations({actorUserId,organizationId,includeRevoked:false})){if(!a.validTo)continue;const d=p2DaysUntil(a.validTo);if(d!==null&&d>=-windowDays&&d<=windowDays)rows.push({type:d<0?'authorization_expired':'authorization_expiring',severity:d<0?'danger':'warning',date:a.validTo,days:d,title:`正式核定 ${d<0?'已到期':'即將到期'}`,detail:`${CareRecipient.displayName(CareRecipient.get(a.recipientId))||a.recipientId}・${a.referenceNo||a.id}`,referenceId:a.id});}
  const latestByRecipient=new Map();for(const a of [...(store.state.benefitAssessments||[])].sort((x,y)=>new Date(y.createdAt||0)-new Date(x.createdAt||0))){if(!latestByRecipient.has(a.recipientId))latestByRecipient.set(a.recipientId,a);}for(const a of latestByRecipient.values()){if(actorUserId&&!this.canReadAssessment(a,actorUserId,organizationId))continue;if(a.status==='insufficient_data'&&a.missingFields?.includes('cmsLevel'))rows.push({type:'cms_review_required',severity:'warning',date:today,days:0,title:'CMS 資料待補／待確認',detail:`${CareRecipient.displayName(CareRecipient.get(a.recipientId))||a.recipientId}・最新 Assessment 缺少 CMS 等級`,referenceId:a.id});}
  return rows.sort((x,y)=>(x.days??999)-(y.days??999));};
Benefit.getAutomationSettings=function(){const raw=store.state.benefitAutomationSettings||{};return {schemaVersion:Number(raw.schemaVersion||2),alertDays:Math.max(0,Number(raw.alertDays??30)||0),remoteAutoPublish:false,updatedAt:raw.updatedAt||null};};
Benefit.updateAutomationSettings=function(patch={},actorUserId=null){if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有 平台超級管理者可以修改 Benefit 自動化設定'};const alertDays=Math.max(0,Math.min(365,Number(patch.alertDays??this.getAutomationSettings().alertDays)||0));store.mutate(db=>{db.benefitAutomationSettings={...(db.benefitAutomationSettings||{}),schemaVersion:2,alertDays,remoteAutoPublish:false,updatedAt:nowISO(),updatedByUserId:actorUserId};});Audit.log('benefit.p2.settings_updated',`Benefit P2 alertDays=${alertDays}`,{actorUserId});return {ok:true,settings:this.getAutomationSettings()};};
function p2RestoreState(snapshot){store.mutate(db=>{for(const k of Object.keys(db))delete db[k];Object.assign(db,deepClone(snapshot));});}
function p2RegressionDomainLifecycle(actorUserId){
  const snapshot=deepClone(store.state),stamp=Date.now().toString(36),recipientId=`reg_rec_${stamp}`,bookingId=`reg_bkg_${stamp}`,tripId=`reg_trip_${stamp}`,authorizationId=`reg_auth_${stamp}`,commercialSnapshotId=`reg_snap_${stamp}`,programCode='REGRESSION_TRANSPORT',serviceDate=dateKey(),approved=1000,amount=300;
  const expect=(label,r,s,a)=>{const b=Benefit.getBalance(authorizationId);if(b.reserved!==r||b.settled!==s||b.available!==a)throw new Error(`${label}: expected ${r}/${s}/${a}, got ${b.reserved}/${b.settled}/${b.available}`);};
  try{
    store.mutate(db=>{
      db.careRecipients=Array.isArray(db.careRecipients)?db.careRecipients:[];
      db.bookings=Array.isArray(db.bookings)?db.bookings:[];
      db.trips=Array.isArray(db.trips)?db.trips:[];
      db.benefitAuthorizations=Array.isArray(db.benefitAuthorizations)?db.benefitAuthorizations:[];
      db.benefitLedger=Array.isArray(db.benefitLedger)?db.benefitLedger:[];
      db.careRecipients.push({id:recipientId,schemaVersion:4,scope:'platform',status:'active',identity:{displayName:'Regression Fixture',birthDate:null,gender:'unspecified'},contacts:{primaryPhone:'',emergencyContacts:[]},addresses:{entries:[],primaryAddressId:null,defaultPickupAddressId:null},mobility:{walkingAbility:'unknown',wheelchairType:'none',requiresAccessibleVehicle:false,requiresEscort:false,transferAssistance:'unknown',defaultAidNeed:'',defaultSpecialNeeds:''},servicePreferences:{defaultCompanions:0,commonDestinations:[],notes:''},governance:{createdByUserId:actorUserId,source:'regression_fixture',sourceOrganizationId:null,createdAt:nowISO(),updatedAt:nowISO(),archivedAt:null,mergedIntoRecipientId:null,mergedAt:null,potentialDuplicateRecipientIds:[]}});
      db.bookings.push({id:bookingId,recipientId,pickupDate:serviceDate,state:'scheduled',status:'scheduled',version:1,commercialSnapshots:[{id:commercialSnapshotId,schemaVersion:1,bookingId,bookingVersion:1,reason:'regression_fixture',quote:{schemaVersion:1,status:'test',currency:'TWD',estimatedFare:amount,capturedAt:nowISO()},benefit:{schemaVersion:2,status:'eligible_estimate',programCode,requestedService:'transportation',serviceDate,estimatedSubsidy:amount,estimatedCopay:0,currency:'TWD',rulesetId:'reg_rule',rulesetVersion:'regression-v1',sourceAssessmentId:'reg_assessment',capturedAt:nowISO()},capturedByUserId:actorUserId,capturedAt:nowISO()}],activeCommercialSnapshotId:commercialSnapshotId,createdAt:nowISO(),updatedAt:nowISO()});
      db.trips.push({id:tripId,status:'completed',bookingIds:[bookingId],steps:[],currentStepIndex:0,createdAt:nowISO(),updatedAt:nowISO()});
      db.benefitAuthorizations.push({id:authorizationId,schemaVersion:1,organizationId:null,recipientId,programCode,validFrom:serviceDate,validTo:serviceDate,approved:true,status:'active',approvedAmount:approved,approvedUnits:null,currency:'TWD',source:'regression_fixture',referenceNo:`REG-${stamp}`,createdByUserId:actorUserId,createdAt:nowISO(),updatedAt:nowISO()});
    });
    expect('initial',0,0,1000);
    let r=Benefit.reserveForBooking(bookingId,{actorUserId,reason:'regression_reserve'});if(!r.ok||r.duplicate||r.reservedAmount!==amount)throw new Error(`reserve API 失敗: ${r.error||'unexpected result'}`);expect('reserve',300,0,700);
    r=Benefit.releaseForBooking(bookingId,{actorUserId,reason:'regression_release'});if(!r.ok||r.releasedAmount!==amount)throw new Error(`release API 失敗: ${r.error||'unexpected result'}`);expect('release',0,0,1000);
    r=Benefit.reserveForBooking(bookingId,{actorUserId,reason:'regression_reserve_again'});if(!r.ok||r.reservedAmount!==amount)throw new Error(`reserve-again API 失敗: ${r.error||'unexpected result'}`);expect('reserve_again',300,0,700);
    r=Benefit.settleFromTrip(tripId,{actorUserId,reason:'regression_settle'});if(!r.ok||r.settledAmount!==amount)throw new Error(`settle API 失敗: ${r.error||'unexpected result'}`);expect('settle',0,300,700);
    r=Benefit.reopenSettlementForTrip(tripId,{actorUserId,reason:'regression_correction'});if(!r.ok||r.reopenedAmount!==amount)throw new Error(`reopen API 失敗: ${r.error||'unexpected result'}`);expect('correction_reopen',300,0,700);
    r=Benefit.settleFromTrip(tripId,{actorUserId,reason:'regression_resettle'});if(!r.ok||r.settledAmount!==amount)throw new Error(`resettle API 失敗: ${r.error||'unexpected result'}`);expect('resettle',0,300,700);
    return true;
  }finally{p2RestoreState(snapshot);}
}
Benefit.runRegressionTests=function({actorUserId=null,organizationId=null}={}){
  if(!this.canManageRulesets(actorUserId))return {ok:false,error:'只有 平台超級管理者可以執行 Benefit Regression',tests:[],passed:0,failed:0};
  const tests=[];const test=(name,fn)=>{try{const r=fn();tests.push({name,ok:r===true,detail:r===true?'PASS':String(r||'FAIL')});}catch(e){tests.push({name,ok:false,detail:e.message||String(e)});}};
  test('已發布規則集 不可直接 updateDraft',()=>{const r=(store.state.benefitRulesets||[]).find(x=>x.status==='published');if(!r)return true;const x=this.updateDraftRuleset(r.id,{name:'__regression_should_not_apply__'},actorUserId);return !x.ok;});
  test('Ruleset version 唯一性',()=>{const seen=new Set();for(const r of store.state.benefitRulesets||[]){const k=`${r.code}::${r.version}`;if(seen.has(k))return `duplicate ${k}`;seen.add(k);}return true;});
  test('Ledger 不可超出核定額度',()=>{for(const a of store.state.benefitAuthorizations||[]){const b=this.getBalance(a.id);if(b.reserved+b.settled>b.approved+b.adjustment+0.0001)return `overdraw ${a.id}`;}return true;});
  test('Domain API lifecycle：Reserve→Release→Settle→Correction→Re-settle',()=>p2RegressionDomainLifecycle(actorUserId));
  test('Booking Benefit Snapshot 保留 rulesetVersion',()=>{for(const b of store.state.bookings||[]){const snap=Booking?.commercialSnapshot?.(b.id)?.benefit;if(snap?.rulesetId&&!snap.rulesetVersion)return `booking ${b.id}`;}return true;});
  test('Assessment append-only history 存在',()=>{const ids=new Set((store.state.benefitAssessmentEvents||[]).map(e=>e.assessmentId));for(const a of store.state.benefitAssessments||[])if(!ids.has(a.id))return `assessment ${a.id}`;return true;});
  test('Authorization referenceNo 必填 invariant',()=>{for(const a of store.state.benefitAuthorizations||[])if(!String(a.referenceNo||'').trim())return `authorization ${a.id}`;return true;});
  const 失敗=tests.filter(x=>!x.ok);store.mutate(db=>p2AppendRun(db,{runType:'regression',actorUserId,passed:tests.length-failed.length,failed:failed.length,tests:deepClone(tests)}));Audit.log('benefit.p2.regression',`Benefit Regression：${tests.length-failed.length} passed / ${failed.length} 失敗`,{actorUserId});return {ok:!failed.length,tests,passed:tests.length-failed.length,failed:failed.length};};
Benefit.p2Runs=function(){return [...(store.state.benefitP2Runs||[])].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));};
Benefit.migrateP2=function(){let changed=0;store.mutate(db=>{if(!Array.isArray(db.benefitP2Runs)){db.benefitP2Runs=[];changed++;}if(!db.benefitAutomationSettings){db.benefitAutomationSettings={schemaVersion:2,alertDays:30,remoteAutoPublish:false,updatedAt:nowISO()};changed++;}else{const current=Math.max(0,Math.min(365,Number(db.benefitAutomationSettings.alertDays??30)||0));if(db.benefitAutomationSettings.schemaVersion!==2||db.benefitAutomationSettings.alertDays!==current||db.benefitAutomationSettings.remoteAutoPublish!==false){db.benefitAutomationSettings={...db.benefitAutomationSettings,schemaVersion:2,alertDays:current,remoteAutoPublish:false,updatedAt:nowISO()};changed++;}}});return {ok:true,changed};};
const p2BaseInitialize=Benefit.initialize.bind(Benefit);Benefit.initialize=function(){const base=p2BaseInitialize(),p2=this.migrateP2();return {ok:base.ok!==false&&p2.ok,base,p2,validation:this.validate()};};
}

function benefitAccessibleRecipients(){
  const userId=Identity.currentUser()?.id||'',r=role();
  if(Identity.isSuperAdmin())return CareRecipient.list({includeArchived:false});
  if(r==='requester')return CareRecipient.listForUser(userId,{includeArchived:false});
  if(['owner','dispatcher'].includes(r))return CareRecipient.listServedByOrganization(orgId(),{includeArchived:false,actorUserId:userId});
  return [];
}
function benefitStatusClass(status){return status==='eligible_estimate'?'green':status==='not_eligible'?'red':status==='insufficient_data'?'yellow':'gray';}
function benefitRulesetStatusClass(status){return status==='published'?'green':status==='draft'?'yellow':'gray';}
function benefitMoney(value,currency='TWD'){return value===null||value===undefined?'—':`${currency==='TWD'?'NT$ ':currency+' '}${Number(value).toLocaleString('zh-TW')}`;}
function benefitAdvancedDashboard(){
  const actorUserId=Identity.currentUser()?.id,canManage=Benefit.canManageRulesets(actorUserId),validation=Benefit.validate(),rules=Benefit.rulesets({includeDraft:canManage,includeRetired:canManage,actorUserId}),assessments=Benefit.list(null,{actorUserId}),recipients=benefitAccessibleRecipients();
  const published=(store.state.benefitRulesets||[]).filter(r=>r.status==='published').length,drafts=canManage?(store.state.benefitRulesets||[]).filter(r=>r.status==='draft').length:0;
  return `<div class="page-head"><div><h2>補助規則與資格</h2><p>第一階段規則／資格＋第二階段正式核定與帳本＋第三階段資料匯入、版本差異、到期提醒與回歸測試。</p></div><div class="page-actions">${canManage?'<button type="button" class="btn primary" id="openBenefitRulesetBtn">＋ 規則集</button><button type="button" class="btn outline" id="openBenefitImportBtn">匯入</button><button type="button" class="btn outline" id="openBenefitDiffBtn">版本差異</button><button type="button" class="btn warning" id="runBenefitRegressionBtn">回歸測試</button>':''}${recipients.length?'<button type="button" class="btn outline" id="openBenefitAssessmentBtn">新增資格試算</button>':''}${recipients.some(r=>Benefit.canManageAuthorization(actorUserId,r.id,Identity.isSuperAdmin()?orgId():orgId()))?'<button type="button" class="btn success" id="openBenefitAuthorizationBtn">＋ 正式核定</button>':''}</div></div>
  <div class="metric-grid"><div class="metric"><span>已發布規則集</span><strong>${published}</strong></div><div class="metric"><span>草稿規則集</span><strong>${drafts}</strong></div><div class="metric"><span>可查看資格試算</span><strong>${assessments.length}</strong></div><div class="metric"><span>第三階段驗證</span><strong style="font-size:18px">${validation.ok?'PASS':'CHECK'}</strong><small>${validation.errors.length} errors・${validation.warnings.length} warnings</small></div></div>
  ${validation.errors.length?`<section class="card issue-card"><div class="card-head"><div><h3>補助資料驗證失敗</h3><p>先修正以下 補助資料一致性規則，再視為可營運。</p></div><span class="pill red">${validation.errors.length}</span></div><div class="meta">${validation.errors.slice(0,20).map(escapeHTML).join('<br>')}</div></section>`:''}
  <section class="card"><div class="card-head"><div><h3>補助規則集</h3><p>已發布規則不可直接改內容；變更必須新增版本。</p></div><span class="pill blue">${rules.length} 筆</span></div><div class="list">${rules.map(rule=>{const rv=Benefit.validateRuleset(rule,{forPublish:rule.status==='published'}),src=rule.source||{},calc=rule.calculation||{};return `<div class="list-item benefit-rule-card ${rule.status}"><div class="list-item-head"><div><h4>${escapeHTML(rule.name||rule.code)}｜${escapeHTML(rule.version||'未填版本')}</h4><p>${escapeHTML(rule.serviceType==='transportation'?'交通接送':'其他服務')}・${escapeHTML(rule.jurisdiction?.city||'不限縣市')}<br>${escapeHTML(rule.effectiveFrom||'未設定')} → ${escapeHTML(rule.effectiveTo||'持續有效')}<br>計算：${escapeHTML(({none:'只判斷資格',fixed_amount:'固定金額',percentage:'比例'})[calc.mode]||'只判斷資格')}${calc.mode==='fixed_amount'?`・${benefitMoney(calc.amount,calc.currency)}`:calc.mode==='percentage'?`・${calc.percentage??'—'}%${calc.maxAmount!==null&&calc.maxAmount!==undefined?`・上限 ${benefitMoney(calc.maxAmount,calc.currency)}`:''}`:'・只判斷資格'}<br><span class="benefit-source">來源：${escapeHTML(src.agency||'未填')}・${escapeHTML(src.title||'未填')}${src.url?`・<a href="${escapeHTML(src.url)}" target="_blank" rel="noopener">官方來源</a>`:''}</span></p></div><span class="pill ${benefitRulesetStatusClass(rule.status)}">${escapeHTML(({draft:'草稿',published:'已發布',retired:'已退役'})[rule.status]||'未知')}</span></div>${rv.errors.length?`<div class="benefit-result bad">${rv.errors.map(escapeHTML).join('；')}</div>`:rv.warnings.length?`<div class="benefit-result warn">${rv.warnings.map(escapeHTML).join('；')}</div>`:''}<div class="item-actions">${canManage&&rule.status==='draft'?`<button type="button" class="btn outline sm benefit-edit-ruleset-btn" data-rule="${rule.id}">編輯草稿</button><button type="button" class="btn success sm benefit-publish-ruleset-btn" data-rule="${rule.id}">驗證並發布</button>`:''}${canManage&&rule.status==='published'?`<button type="button" class="btn permanent sm benefit-retire-ruleset-btn" data-rule="${rule.id}">退役</button>`:''}</div></div>`;}).join('')||'<div class="empty">目前沒有 補助規則集。系統不會自行假造政府補助規則。</div>'}</div></section>
  <section class="card"><div class="card-head"><div><h3>正式核定與額度餘額</h3><p>正式核定與 資格預估 分離。可用額度＝核定＋調整－已預留－已結算。</p></div><span class="pill green">${Benefit.authorizations({actorUserId,organizationId:orgId(),includeRevoked:true}).length} 筆</span></div><div class="list">${Benefit.authorizations({actorUserId,organizationId:orgId(),includeRevoked:true}).map(a=>{const r=CareRecipient.get(a.recipientId),bal=Benefit.getBalance(a.id);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(CareRecipient.displayName(r)||a.recipientId)}｜${escapeHTML(a.programCode==='transportation_primary'||a.programCode==='transportation'?'交通接送':'其他補助方案')}</h4><p>${escapeHTML(a.validFrom||'—')} → ${escapeHTML(a.validTo||'持續有效')}・${escapeHTML(a.referenceNo||'無核定文號')}<br>核定 ${benefitMoney(bal.approved,a.currency)}${bal.adjustment?`・調整 ${benefitMoney(bal.adjustment,a.currency)}`:''}・已預留 ${benefitMoney(bal.reserved,a.currency)}・已結算 ${benefitMoney(bal.settled,a.currency)}<br><strong>可用額度 ${benefitMoney(bal.available,a.currency)}</strong></p></div><span class="pill ${a.status==='active'?'green':'gray'}">${escapeHTML(({active:'有效',revoked:'已撤銷',expired:'已到期'})[a.status]||'未知')}</span></div><div class="item-actions">${Benefit.canManageAuthorization(actorUserId,a.recipientId,a.organizationId)?`<button type="button" class="btn warning sm benefit-adjust-btn" data-auth="${a.id}">額度調整</button>${a.status==='active'?`<button type="button" class="btn danger sm benefit-revoke-auth-btn" data-auth="${a.id}">撤銷核定</button>`:''}`:''}</div></div>`;}).join('')||'<div class="empty">目前沒有正式核定資料；系統不會把試算結果自動視為政府核定。</div>'}</div></section>
  <section class="card"><div class="card-head"><div><h3>補助帳本／對帳</h3><p>預留、釋放、結算、修正回轉與額度調整全部採僅追加紀錄。</p></div><span class="pill blue">${Benefit.getLedger({actorUserId,organizationId:orgId()}).length} 筆</span></div>${(()=>{const x=Benefit.reconciliation({actorUserId,organizationId:orgId()});return `<div class="daily-summary"><div class="mini-stat"><strong>${benefitMoney(x.totalApproved)}</strong><span>核定＋調整</span></div><div class="mini-stat"><strong>${benefitMoney(x.totalReserved)}</strong><span>已預留</span></div><div class="mini-stat"><strong>${benefitMoney(x.totalSettled)}</strong><span>已結算</span></div><div class="mini-stat"><strong>${benefitMoney(x.totalAvailable)}</strong><span>可用額度</span></div></div>`;})()}<div class="table-wrap"><table class="data-table"><thead><tr><th>時間</th><th>類型</th><th>服務對象</th><th>Booking / Trip</th><th>金額</th><th>變動</th><th>原因</th></tr></thead><tbody>${Benefit.getLedger({actorUserId,organizationId:orgId()}).slice(0,120).map(e=>`<tr><td>${formatDateTime(e.createdAt)}</td><td><strong>${escapeHTML(e.entryType)}</strong></td><td>${escapeHTML(CareRecipient.displayName(CareRecipient.get(e.recipientId))||e.recipientId||'—')}</td><td>${escapeHTML(e.bookingId||'—')}<br>${escapeHTML(e.tripId||'')}</td><td>${benefitMoney(e.amount,e.currency)}</td><td><span class="small">R ${Number(e.reservedDelta||0)>=0?'+':''}${e.reservedDelta||0}<br>S ${Number(e.settledDelta||0)>=0?'+':''}${e.settledDelta||0}<br>A ${Number(e.authorizationDelta||0)>=0?'+':''}${e.authorizationDelta||0}</span></td><td>${escapeHTML(e.reason||'—')}</td></tr>`).join('')||'<tr><td colspan="7"><div class="empty">尚無帳本紀錄</div></td></tr>'}</tbody></table></div></section>
  <section class="card"><div class="card-head"><div><h3>第三階段提醒／到期監看</h3><p>規則、正式核定到期與 長照需要等級資料待確認。提醒窗口依 自動化設定（目前 ${Benefit.getAutomationSettings().alertDays} 天），僅提示、不會自動變更資格或額度。</p></div><span class="pill yellow">${Benefit.alerts({actorUserId,organizationId:orgId()}).length} 項</span></div><div class="list">${Benefit.alerts({actorUserId,organizationId:orgId()}).slice(0,40).map(x=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(x.title)}</h4><p>${escapeHTML(x.detail)}${x.date?`・日期 ${escapeHTML(x.date)}`:''}</p></div><span class="pill ${x.severity==='danger'?'red':'yellow'}">${x.days<0?'已逾期':x.days===0?'今日':`${x.days} 天`}</span></div></div>`).join('')||'<div class="empty">未發現目前提醒窗口內到期或待補長照需要等級項目。</div>'}</div></section>
  <section class="card"><div class="card-head"><div><h3>第三階段自動化／回歸測試紀錄</h3><p>匯入與回歸測試每次執行都留下本機執行紀錄，方便驗證與追查。</p></div><span class="pill blue">${Benefit.p2Runs().length} 次執行</span></div><div class="list">${Benefit.p2Runs().slice(0,20).map(r=>`<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(({regression:'回歸測試',import:'匯入',automation:'自動化'})[r.runType]||'執行紀錄')}｜${formatDateTime(r.createdAt)}</h4><p>${r.runType==='regression'?`${r.passed||0} 通過・${r.failed||0} 失敗`:`${r.createdCount||0} imported・${r.errorCount||0} errors`}</p></div><span class="pill ${(r.failed||r.errorCount)?'red':'green'}">${(r.failed||r.errorCount)?'CHECK':'PASS'}</span></div></div>`).join('')||'<div class="empty">尚無第三階段執行紀錄。</div>'}</div></section>
  <section class="card"><div class="card-head"><div><h3>補助資格試算歷史</h3><p>僅追加：每次重算都新增一筆，舊結果與 規則集來源快照 不覆蓋。</p></div><span class="pill purple">${assessments.length} 筆</span></div><div class="list">${assessments.slice(0,80).map(a=>{const r=CareRecipient.get(a.recipientId),reasons=a.reasons||[],warnings=a.warnings||[];return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(CareRecipient.displayName(r)||a.recipientId)}｜${escapeHTML(Benefit.statusLabel(a.status))}</h4><p>${escapeHTML(a.serviceDate||'—')}・方案：${escapeHTML(a.programCode==='transportation_primary'||a.programCode==='transportation'?'交通接送':'其他補助方案')}・長照需要等級：${escapeHTML(String(a.facts?.cmsLevel??'未填'))}<br>預估補助：${benefitMoney(a.estimatedSubsidy,a.currency)}・預估自付：${benefitMoney(a.estimatedCopay,a.currency)}<br>規則集：${escapeHTML(a.rulesetVersion||'未套用')}・試算紀錄 ${escapeHTML(a.id)}</p></div><span class="pill ${benefitStatusClass(a.status)}">${escapeHTML(Benefit.statusLabel(a.status))}</span></div>${reasons.length?`<div class="benefit-result ${a.status==='eligible_estimate'?'ok':a.status==='not_eligible'?'bad':'warn'}"><strong>判斷依據</strong><br>${reasons.map(escapeHTML).join('<br>')}</div>`:''}${warnings.length?`<div class="benefit-result warn"><strong>注意</strong><br>${warnings.map(escapeHTML).join('<br>')}</div>`:''}<div class="small muted" style="margin-top:8px">建立：${formatDateTime(a.createdAt)}・事件 ${Benefit.assessmentEvents(a.id,{actorUserId,organizationId:orgId()}).length} 筆${a.rulesetSource?.url?`・<a href="${escapeHTML(a.rulesetSource.url)}" target="_blank" rel="noopener">規則來源快照</a>`:''}</div></div>`;}).join('')||'<div class="empty">目前沒有可查看的補助資格試算。</div>'}</div></section>`;
}

const BENEFIT_LATEST_OFFICIAL_SOURCES=Object.freeze([
  {id:'1966',title:'衛福部 1966 長照專區｜申請長照服務',url:'https://1966.gov.tw/LTC/cp-6533-70777-207.html'},
  {id:'mohw_rules',title:'衛福部｜長期照顧服務申請及給付辦法附表',url:'https://www.mohw.gov.tw/dl-97629-9ca5aed2-743b-46ed-8659-4e45d9996257.html'}
]);
const BENEFIT_TRANSPORT_REMOTE_READER='https://r.jina.ai/';
const BENEFIT_CURRENT_TRANSPORT_POLICY=Object.freeze({
  policyDate:'2026-08-27',
  cmsMin:2,
  monthlyAmountByZone:{1:1680,2:1840,3:2000,4:2400},
  copayByZone:{
    1:{low_income:0,middle_low_income:10,general:30},
    2:{low_income:0,middle_low_income:9,general:27},
    3:{low_income:0,middle_low_income:8,general:25},
    4:{low_income:0,middle_low_income:7,general:21}
  }
});
const BENEFIT_ZONE_1_CITIES=['臺北市','台北市','基隆市','嘉義市','新竹市'];
const BENEFIT_ZONE_2_CITIES=['新北市','桃園市','彰化縣','雲林縣','新竹縣','苗栗縣','嘉義縣','宜蘭縣','臺南市','台南市','臺中市','台中市'];
const BENEFIT_ZONE_3_CITIES=['屏東縣','高雄市','南投縣'];
const BENEFIT_ZONE_4_CITIES=['臺東縣','台東縣','花蓮縣','澎湖縣','金門縣','連江縣'];
const BENEFIT_ZONE_4_REMOTE=[
  '新北市烏來區','新北市石碇區','新北市坪林區','新北市平溪區','新北市雙溪區','新北市貢寮區',
  '桃園市復興區','臺南市楠西區','臺南市南化區','臺南市左鎮區','臺南市龍崎區',
  '新竹縣五峰鄉','新竹縣尖石鄉','新竹縣關西鎮','新竹縣峨眉鄉',
  '苗栗縣泰安鄉','苗栗縣南庄鄉','苗栗縣獅潭鄉','苗栗縣三灣鄉','臺中市和平區',
  '南投縣仁愛鄉','南投縣信義鄉','南投縣魚池鄉','南投縣中寮鄉','南投縣國姓鄉','南投縣鹿谷鄉',
  '嘉義縣阿里山鄉','嘉義縣番路鄉','嘉義縣大埔鄉',
  '高雄市那瑪夏區','高雄市桃源區','高雄市茂林區','高雄市田寮區','高雄市六龜區','高雄市甲仙區','高雄市杉林區',
  '屏東縣三地門鄉','屏東縣霧臺鄉','屏東縣瑪家鄉','屏東縣泰武鄉','屏東縣來義鄉','屏東縣春日鄉','屏東縣獅子鄉','屏東縣牡丹鄉','屏東縣滿州鄉','屏東縣琉球鄉',
  '宜蘭縣大同鄉','宜蘭縣南澳鄉'
];
const benefitQuickUiState={recipientId:'',cmsLevel:'',identityCategory:'general',result:null,refreshing:false,lastAutoAttemptAt:0};

function benefitRecipientResidence(recipient){
  const a=recipient?.addresses||{},entries=Array.isArray(a.entries)?a.entries:[];
  const row=entries.find(x=>x.id===a.primaryAddressId)||entries.find(x=>x.type==='home')||entries[0];
  return String(row?.address||row?.addressText||CareRecipient?.primaryAddress?.(recipient)||'').trim();
}
function benefitTransportZone(address=''){
  const normalized=String(address||'').replace(/台/g,'臺').replace(/\s+/g,'');
  if(BENEFIT_ZONE_4_REMOTE.some(x=>normalized.includes(x.replace(/台/g,'臺'))))return 4;
  if(BENEFIT_ZONE_4_CITIES.some(x=>normalized.includes(x.replace(/台/g,'臺'))))return 4;
  if(BENEFIT_ZONE_1_CITIES.some(x=>normalized.includes(x.replace(/台/g,'臺'))))return 1;
  if(BENEFIT_ZONE_2_CITIES.some(x=>normalized.includes(x.replace(/台/g,'臺'))))return 2;
  if(BENEFIT_ZONE_3_CITIES.some(x=>normalized.includes(x.replace(/台/g,'臺'))))return 3;
  return null;
}
function benefitLatestDefaultInfo(){
  return {
    schemaVersion:1,
    status:'bundled_official_snapshot',
    fetchedAt:null,
    checkedAt:BENEFIT_CURRENT_TRANSPORT_POLICY.policyDate,
    sourceMode:'內建官方規則快照',
    cmsMin:BENEFIT_CURRENT_TRANSPORT_POLICY.cmsMin,
    monthlyAmountByZone:deepClone(BENEFIT_CURRENT_TRANSPORT_POLICY.monthlyAmountByZone),
    copayByZone:deepClone(BENEFIT_CURRENT_TRANSPORT_POLICY.copayByZone),
    sources:deepClone(BENEFIT_LATEST_OFFICIAL_SOURCES),
    note:'若即時連線失敗，使用最近一次已驗證的官方規則快照；不會改寫正式核定。'
  };
}
function benefitLatestInfo(){
  return store.state.benefitLatestInfo||benefitLatestDefaultInfo();
}
async function benefitFetchOfficialText(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
  try{
    const direct=await fetch(url,{cache:'no-store',signal:controller.signal,credentials:'omit'});
    if(direct.ok)return {ok:true,text:await direct.text(),mode:'官方網站直接連線'};
  }catch(e){}
  finally{clearTimeout(timer);}
  try{
    const relayUrl=`${BENEFIT_TRANSPORT_REMOTE_READER}${url}`;
    const relay=await fetch(relayUrl,{cache:'no-store',credentials:'omit'});
    if(relay.ok)return {ok:true,text:await relay.text(),mode:'官方頁面文字轉接'};
  }catch(e){}
  return {ok:false,text:'',mode:'最近成功快取'};
}
function benefitExtractTransportPolicy(textValue,base){
  let raw=String(textValue||'');
  try{
    if(/<html|<table|<body/i.test(raw)) raw=new DOMParser().parseFromString(raw,'text/html').body?.innerText||raw;
  }catch(e){}
  const source=raw.replace(/,/g,'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ');
  const amount=(fallback)=>{
    const m=source.match(new RegExp(`${fallback}\\s*元`));
    return m?Number(fallback):fallback;
  };
  const info=deepClone(base);
  info.monthlyAmountByZone={1:amount(1680),2:amount(1840),3:amount(2000),4:amount(2400)};
  const cmsMatch=source.match(/長照需要等級\s*([2-8])\s*級以上/);
  if(cmsMatch)info.cmsMin=Number(cmsMatch[1]);

  // 附表五排列：B/C 三類後，依序是交通第1~4區各三類（第一類/第二類/第三類）。
  // 官方分類對應本 UI：第一類=低收入戶、第二類=中低收入戶、第三類=一般戶。
  const compact=source.replace(/\s+/g,' ');
  const rateMatch=compact.match(/第二級[\s\S]{0,1200}?0\s+5\s+16\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})/);
  if(rateMatch){
    const v=rateMatch.slice(1).map(Number);
    const valid=v.length===12&&v.every(n=>Number.isFinite(n)&&n>=0&&n<=100);
    if(valid){
      info.copayByZone={
        1:{low_income:v[0],middle_low_income:v[1],general:v[2]},
        2:{low_income:v[3],middle_low_income:v[4],general:v[5]},
        3:{low_income:v[6],middle_low_income:v[7],general:v[8]},
        4:{low_income:v[9],middle_low_income:v[10],general:v[11]}
      };
      info.copayParsedFromOfficial=true;
    }
  }
  return info;
}
const BenefitLatestInfo={
  initialize(){
    store.mutate(db=>{
      if(!db.benefitLatestInfo)db.benefitLatestInfo=benefitLatestDefaultInfo();
      db.benefitLatestEstimateRuns=Array.isArray(db.benefitLatestEstimateRuns)?db.benefitLatestEstimateRuns:[];
    });
    return {ok:true};
  },
  info:benefitLatestInfo,
  isStale(maxHours=24){
    const info=benefitLatestInfo(),at=info.fetchedAt||info.checkedAt;
    const ms=at?Date.now()-new Date(at).getTime():Infinity;
    return !Number.isFinite(ms)||ms>maxHours*3600000;
  },
  async refresh({manual=false}={}){
    if(benefitQuickUiState.refreshing)return {ok:false,error:'正在更新'};
    benefitQuickUiState.refreshing=true;
    try{
      const results=await Promise.all(BENEFIT_LATEST_OFFICIAL_SOURCES.map(async s=>({...s,...await benefitFetchOfficialText(s.url)})));
      const successful=results.filter(x=>x.ok);
      if(!successful.length){
        const cached=benefitLatestInfo();
        return {ok:false,error:'目前無法連線官方來源，已保留最近成功資料。',info:cached};
      }
      let merged=benefitLatestDefaultInfo();
      successful.forEach(x=>{merged=benefitExtractTransportPolicy(x.text,merged);});
      merged.status='fresh_official';
      merged.fetchedAt=nowISO();
      merged.checkedAt=dateKey();
      merged.sourceMode=successful.some(x=>x.mode==='官方網站直接連線')?'官方網站即時更新':'官方頁面文字轉接';
      merged.sources=results.map(x=>({id:x.id,title:x.title,url:x.url,ok:x.ok,mode:x.mode}));
      merged.note='自動更新只用於預估；政府正式核定仍以照管中心／主管機關資料為準。';
      store.mutate(db=>{db.benefitLatestInfo=merged;});
      Audit.log('benefit.latest_info.refreshed',`更新長照交通補助公開資訊：${merged.sourceMode}`,{actorUserId:Identity.currentUser()?.id||null});
      return {ok:true,info:merged};
    }finally{
      benefitQuickUiState.refreshing=false;
    }
  },
  estimate({recipientId,cmsLevel,identityCategory='general'}={}){
    const recipient=CareRecipient.get(recipientId);
    if(!recipient)return {ok:false,error:'請先選擇服務對象'};
    const cms=Number(cmsLevel);
    if(!Number.isInteger(cms)||cms<1||cms>8)return {ok:false,error:'請輸入 1～8 的長照需要等級'};
    const address=benefitRecipientResidence(recipient),zone=benefitTransportZone(address),info=benefitLatestInfo();
    if(!zone)return {ok:false,error:'無法從服務對象居住地址判斷交通補助分區，請先補完整居住縣市／行政區。'};
    if(cms<Number(info.cmsMin||2)){
      return {ok:true,eligible:false,recipientId,cmsLevel:cms,address,zone,reason:`目前官方公開資格基礎為長照需要等級 ${info.cmsMin||2} 以上。`,source:info};
    }
    const category=['low_income','middle_low_income','general'].includes(identityCategory)?identityCategory:'general';
    const monthly=Number(info.monthlyAmountByZone?.[zone]||0);
    const copayRate=Number(info.copayByZone?.[zone]?.[category]??0);
    const estimatedGov=Math.floor(monthly*(100-copayRate)/100);
    const estimatedCopay=Math.floor(monthly*copayRate/100);
    const result={ok:true,eligible:true,recipientId,cmsLevel:cms,address,zone,identityCategory:category,monthlyLimit:monthly,copayRate,estimatedGovernmentShare:estimatedGov,estimatedUserShare:estimatedCopay,source:deepClone(info),createdAt:nowISO()};
    store.mutate(db=>{
      db.benefitLatestEstimateRuns=Array.isArray(db.benefitLatestEstimateRuns)?db.benefitLatestEstimateRuns:[];
      db.benefitLatestEstimateRuns.unshift({...deepClone(result),id:uid('bquick')});
      if(db.benefitLatestEstimateRuns.length>100)db.benefitLatestEstimateRuns.length=100;
    });
    return result;
  },
  async refreshAndEstimate(input){
    await this.refresh({manual:true});
    return this.estimate(input);
  },
  async ensureFresh(){
    const now=Date.now();
    if(!this.isStale(24)||benefitQuickUiState.refreshing||now-benefitQuickUiState.lastAutoAttemptAt<60000)return;
    benefitQuickUiState.lastAutoAttemptAt=now;
    const result=await this.refresh();
    if(result?.ok&&currentView==='benefits')render();
  }
};

function benefitSimpleResultHtml(result){
  if(!result)return '<div class="empty">選好服務對象、長照等級與身分類別後，按「更新最新資訊並試算」。</div>';
  if(!result.ok)return `<div class="benefit-quick-result bad"><h3>目前無法完成試算</h3><p>${escapeHTML(result.error||'資料不足')}</p></div>`;
  if(!result.eligible)return `<div class="benefit-quick-result warn"><h3>目前可能不符合交通接送補助資格</h3><p>${escapeHTML(result.reason||'資格資料不足')}</p><p class="small">這是預估結果，正式資格仍以照管中心核定為準。</p></div>`;
  const categoryLabel={general:'一般戶',middle_low_income:'中低收入戶',low_income:'低收入戶'}[result.identityCategory]||'一般戶';
  return `<div class="benefit-quick-result">
    <h3>交通接送補助快速試算</h3>
    <div class="amount">${benefitMoney(result.monthlyLimit)}</div>
    <p><strong>每月交通接送給付額度</strong>・第 ${result.zone} 區</p>
    <p>${escapeHTML(categoryLabel)}部分負擔約 <strong>${result.copayRate}%</strong>；若整月額度全數使用，預估個人負擔約 <strong>${benefitMoney(result.estimatedUserShare)}</strong>，政府給付部分約 <strong>${benefitMoney(result.estimatedGovernmentShare)}</strong>。</p>
    <p class="small">居住地址：${escapeHTML(result.address||'—')}<br>長照需要等級：${escapeHTML(String(result.cmsLevel))}・資料更新：${escapeHTML(result.source?.fetchedAt?formatDateTime(result.source.fetchedAt):(result.source?.checkedAt||'官方快照'))}</p>
    <p class="small"><strong>注意：</strong>實際每趟費用、剩餘額度、照顧計畫與地方主管機關核定仍可能影響最後金額。</p>
  </div>`;
}

function benefitDashboard(){
  const actorUserId=Identity.currentUser()?.id,canManage=Benefit.canManageRulesets(actorUserId),recipients=benefitAccessibleRecipients();
  if(!benefitQuickUiState.recipientId||!recipients.some(r=>r.id===benefitQuickUiState.recipientId))benefitQuickUiState.recipientId=recipients[0]?.id||'';
  const selected=CareRecipient.get(benefitQuickUiState.recipientId);
  const latestAssessment=Benefit.list(null,{actorUserId,recipientId:benefitQuickUiState.recipientId})[0]||null;
  if(!benefitQuickUiState.cmsLevel&&latestAssessment?.facts?.cmsLevel)benefitQuickUiState.cmsLevel=String(latestAssessment.facts.cmsLevel);
  const info=BenefitLatestInfo.info();
  setTimeout(()=>BenefitLatestInfo.ensureFresh(),0);
  const sourceText=info.fetchedAt?`${info.sourceMode}・${formatDateTime(info.fetchedAt)}`:`${info.sourceMode}・${info.checkedAt||'尚未更新'}`;
  const history=(store.state.benefitLatestEstimateRuns||[]).filter(x=>Benefit.canReadAssessment({recipientId:x.recipientId,organizationId:null},actorUserId,orgId())).slice(0,5);
  return `<div class="page-head"><div><h2>長照補助試算</h2><p>不用看規則代碼：系統會自動更新官方公開資訊，再用服務對象資料做交通接送補助預估。</p></div></div>
  <section class="card benefit-simple-hero"><h2>一鍵更新＋試算</h2><p>選擇服務對象後，只需要確認長照需要等級與身分類別。試算結果是預估，不會取代政府正式核定。</p></section>
  <section class="card">
    <div class="benefit-source-status">
      <div class="main"><strong>最新長照資訊</strong><span>${escapeHTML(sourceText)}<br>${escapeHTML(info.note||'')}</span></div>
      <span class="pill ${info.status==='fresh_official'?'green':'yellow'}">${info.status==='fresh_official'?'已更新':'快照'}</span>
    </div>
    <div class="benefit-quick-form" style="margin-top:13px">
      <div class="form-field"><label for="benefitQuickRecipient">服務對象</label><select id="benefitQuickRecipient">${recipients.map(r=>`<option value="${r.id}" ${r.id===benefitQuickUiState.recipientId?'selected':''}>${escapeHTML(CareRecipient.displayName(r)||r.id)}</option>`).join('')}</select></div>
      <div class="form-field"><label for="benefitQuickCms">長照需要等級</label><input id="benefitQuickCms" type="number" min="1" max="8" value="${escapeHTML(benefitQuickUiState.cmsLevel||'')}" placeholder="2～8" /></div>
      <div class="form-field"><label for="benefitQuickIdentity">身分類別</label><select id="benefitQuickIdentity">
        <option value="general" ${benefitQuickUiState.identityCategory==='general'?'selected':''}>一般戶</option>
        <option value="middle_low_income" ${benefitQuickUiState.identityCategory==='middle_low_income'?'selected':''}>中低收入戶</option>
        <option value="low_income" ${benefitQuickUiState.identityCategory==='low_income'?'selected':''}>低收入戶</option>
      </select></div>
    </div>
    <button class="btn primary block" id="benefitQuickRunBtn" type="button" style="margin-top:12px">${benefitQuickUiState.refreshing?'更新中…':'更新最新資訊並試算'}</button>
    <div style="margin-top:12px">${benefitSimpleResultHtml(benefitQuickUiState.result)}</div>
  </section>
  <section class="card">
    <div class="card-head"><div><h3>目前官方公開規則摘要</h3><p>系統抓取失敗時，會退回最近一次成功資料，不會亂猜金額。</p></div></div>
    <div class="benefit-simple-grid">
      <div class="benefit-simple-stat"><span>第 1 區</span><strong>${benefitMoney(info.monthlyAmountByZone?.[1])}</strong></div>
      <div class="benefit-simple-stat"><span>第 2 區</span><strong>${benefitMoney(info.monthlyAmountByZone?.[2])}</strong></div>
      <div class="benefit-simple-stat"><span>第 3 區</span><strong>${benefitMoney(info.monthlyAmountByZone?.[3])}</strong></div>
      <div class="benefit-simple-stat"><span>第 4 區／偏遠地區</span><strong>${benefitMoney(info.monthlyAmountByZone?.[4])}</strong></div>
      <div class="benefit-simple-stat"><span>資格基礎</span><strong>CMS ${escapeHTML(String(info.cmsMin||2))}+</strong></div>
      <div class="benefit-simple-stat"><span>服務類型</span><strong style="font-size:18px">交通接送</strong></div>
    </div>
    <div class="small muted" style="margin-top:12px">來源：${BENEFIT_LATEST_OFFICIAL_SOURCES.map(s=>`<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener">${escapeHTML(s.title)}</a>`).join('・')}</div>
  </section>
  ${history.length?`<section class="card"><div class="card-head"><div><h3>最近試算</h3><p>只顯示最近 5 筆，避免畫面太複雜。</p></div></div><div class="list">${history.map(x=>`<div class="list-item"><strong>${escapeHTML(CareRecipient.displayName(CareRecipient.get(x.recipientId))||'服務對象')}｜第 ${x.zone||'—'} 區</strong><p>${escapeHTML(String(x.cmsLevel||'—'))} 級・每月額度 ${benefitMoney(x.monthlyLimit)}・部分負擔 ${x.copayRate??'—'}%・${formatDateTime(x.createdAt)}</p></div>`).join('')}</div></section>`:''}
  ${canManage?`<details class="benefit-advanced"><summary>進階管理（規則、核定、帳本、匯入、測試）</summary><div class="benefit-advanced-body">${benefitAdvancedDashboard()}</div></details>`:''}`;
}

function benefitRulesetFormValue(selectId,value){const el=$(selectId);if(el)el.value=value===true?'true':value===false?'false':'';}
function openBenefitRulesetEditor(ruleId=''){
  if(!Benefit.canManageRulesets(Identity.currentUser()?.id)){showToast('只有 平台超級管理者可以管理 補助規則集');return;}const r=ruleId?Benefit.ruleset(ruleId):null;if(r&&r.status!=='draft'){showToast('只有草稿可以編輯');return;}$('benefitRulesetId').value=r?.id||'';$('benefitRulesetModalTitle').textContent=r?'編輯補助草稿':'新增 補助規則集';$('benefitRuleCode').value=r?.code||Benefit.constants.defaultProgramCode;$('benefitRuleVersion').value=r?.version||'';$('benefitRuleName').value=r?.name||'';$('benefitRuleCity').value=r?.jurisdiction?.city||'';$('benefitRuleEffectiveFrom').value=r?.effectiveFrom||dateKey();$('benefitRuleEffectiveTo').value=r?.effectiveTo||'';$('benefitRuleCmsLevels').value=(r?.conditions?.cmsLevels||[]).join(',');$('benefitRuleIdentityCategories').value=(r?.conditions?.identityCategories||[]).join(',');benefitRulesetFormValue('benefitRuleRequireCarePlan',r?.conditions?.requireApprovedCarePlan);benefitRulesetFormValue('benefitRuleRequireTransport',r?.conditions?.requireTransportationApproved);$('benefitRuleCalculationMode').value=r?.calculation?.mode||'none';$('benefitRuleAmount').value=r?.calculation?.amount??'';$('benefitRulePercentage').value=r?.calculation?.percentage??'';$('benefitRuleMaxAmount').value=r?.calculation?.maxAmount??'';$('benefitRuleSourceAgency').value=r?.source?.agency||'';$('benefitRuleSourceTitle').value=r?.source?.title||'';$('benefitRuleSourceUrl').value=r?.source?.url||'';$('benefitRuleSourcePublishedAt').value=r?.source?.publishedAt||'';$('benefitRuleSourceCheckedAt').value=r?.source?.checkedAt||dateKey();openModal('benefitRulesetModal');
}
function benefitRulesetInput(){return {code:$('benefitRuleCode').value,version:$('benefitRuleVersion').value,name:$('benefitRuleName').value,serviceType:'transportation',jurisdiction:{country:'TW',city:$('benefitRuleCity').value},effectiveFrom:$('benefitRuleEffectiveFrom').value,effectiveTo:$('benefitRuleEffectiveTo').value,source:{agency:$('benefitRuleSourceAgency').value,title:$('benefitRuleSourceTitle').value,url:$('benefitRuleSourceUrl').value,publishedAt:$('benefitRuleSourcePublishedAt').value,checkedAt:$('benefitRuleSourceCheckedAt').value},conditions:{cmsLevels:$('benefitRuleCmsLevels').value,requireApprovedCarePlan:$('benefitRuleRequireCarePlan').value,requireTransportationApproved:$('benefitRuleRequireTransport').value,identityCategories:$('benefitRuleIdentityCategories').value},calculation:{mode:$('benefitRuleCalculationMode').value,currency:'TWD',amount:$('benefitRuleAmount').value,percentage:$('benefitRulePercentage').value,maxAmount:$('benefitRuleMaxAmount').value}};}
function saveBenefitRuleset(){const actor=Identity.currentUser()?.id,id=$('benefitRulesetId').value,input=benefitRulesetInput(),r=id?Benefit.updateDraftRuleset(id,input,actor):Benefit.createRuleset(input,actor);if(!r.ok){showToast(r.error);return;}closeModal('benefitRulesetModal');render();showToast('補助規則草稿已儲存');}
function publishBenefitRuleset(ruleId){const r=Benefit.publishRuleset(ruleId,Identity.currentUser()?.id);if(!r.ok){showToast(`無法發布：${r.error}`);return;}render();showToast(`規則集 ${r.ruleset.version} 已發布；既有資格試算不會被覆蓋`);}
function retireBenefitRuleset(ruleId){if(!confirm('確定永久退役這個已發布規則集？退役後不再用於新的資格判斷；既有資格試算、預約快照與歷史版本仍會完整保留。'))return;const r=Benefit.retireRuleset(ruleId,Identity.currentUser()?.id);if(!r.ok){showToast(r.error);return;}render();showToast('規則集已退役');}
function updateBenefitAssessmentRecipientCity(){const r=CareRecipient.get($('benefitAssessmentRecipient')?.value);if(r)$('benefitAssessmentResidenceCity').value=locationCity(CareRecipient.primaryAddress(r)||'')||'';}
function openBenefitAssessment(){const recipients=benefitAccessibleRecipients(),actor=Identity.currentUser()?.id;if(!recipients.length){showToast('目前沒有可建立補助試算的服務對象');return;}const published=Benefit.rulesets({actorUserId:actor}).filter(r=>r.status==='published'),codes=[...new Set(published.map(r=>r.code))];$('benefitAssessmentRecipient').innerHTML=recipients.map(r=>`<option value="${r.id}">${escapeHTML(CareRecipient.displayName(r))}</option>`).join('');$('benefitAssessmentProgramCode').innerHTML=(codes.length?codes:[Benefit.constants.defaultProgramCode]).map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}${codes.length?'':'（尚無 已發布規則集）'}</option>`).join('');$('benefitAssessmentServiceDate').value=dateKey();$('benefitAssessmentCmsLevel').value='';$('benefitAssessmentApprovedCarePlan').value='';$('benefitAssessmentTransportationApproved').value='';$('benefitAssessmentIdentityCategory').value='';$('benefitAssessmentEligibleCost').value='';updateBenefitAssessmentRecipientCity();openModal('benefitAssessmentModal');}
function saveBenefitAssessment(){const recipientId=$('benefitAssessmentRecipient').value,actor=Identity.currentUser()?.id,organizationId=Identity.isSuperAdmin()?orgId():(role()==='requester'?APP_CONFIG.requesterOrganizationId:orgId()),result=Benefit.assess({organizationId,recipientId,programCode:$('benefitAssessmentProgramCode').value,requestedService:'transportation',serviceDate:$('benefitAssessmentServiceDate').value,facts:{cmsLevel:$('benefitAssessmentCmsLevel').value,residenceCity:$('benefitAssessmentResidenceCity').value,approvedCarePlan:$('benefitAssessmentApprovedCarePlan').value,transportationApproved:$('benefitAssessmentTransportationApproved').value,identityCategory:$('benefitAssessmentIdentityCategory').value,eligibleCost:$('benefitAssessmentEligibleCost').value},actorUserId:actor});if(!result.ok){showToast(result.error);return;}closeModal('benefitAssessmentModal');render();showToast(`補助試算已建立：${Benefit.statusLabel(result.assessment.status)}`);}


function openBenefitAuthorization(){const actor=Identity.currentUser()?.id,recipients=benefitAccessibleRecipients().filter(r=>Benefit.canManageAuthorization(actor,r.id,orgId()));if(!recipients.length){showToast('目前沒有可管理正式核定的服務對象');return;}$('benefitAuthorizationRecipient').innerHTML=recipients.map(r=>`<option value="${r.id}">${escapeHTML(CareRecipient.displayName(r))}</option>`).join('');$('benefitAuthorizationProgram').value=Benefit.constants.defaultProgramCode;$('benefitAuthorizationValidFrom').value=dateKey();$('benefitAuthorizationValidTo').value='';$('benefitAuthorizationAmount').value='';$('benefitAuthorizationUnits').value='';$('benefitAuthorizationReference').value='';$('benefitAuthorizationSource').value='manual';openModal('benefitAuthorizationModal');}
function saveBenefitAuthorization(){const actor=Identity.currentUser()?.id,r=Benefit.saveAuthorization({organizationId:Identity.isSuperAdmin()?orgId():orgId(),recipientId:$('benefitAuthorizationRecipient').value,programCode:$('benefitAuthorizationProgram').value,validFrom:$('benefitAuthorizationValidFrom').value,validTo:$('benefitAuthorizationValidTo').value,approvedAmount:$('benefitAuthorizationAmount').value,approvedUnits:$('benefitAuthorizationUnits').value,referenceNo:$('benefitAuthorizationReference').value,source:$('benefitAuthorizationSource').value},actor);if(!r.ok){showToast(r.error);return;}closeModal('benefitAuthorizationModal');render();showToast('正式核定已建立；既有資格試算不會被改寫');}
function openBenefitAdjustment(id){const a=Benefit.getAuthorization(id);if(!a){showToast('找不到正式核定');return;}$('benefitAdjustmentAuthorizationId').value=id;$('benefitAdjustmentAmount').value='';$('benefitAdjustmentReason').value='';openModal('benefitAdjustmentModal');}
function saveBenefitAdjustment(){const r=Benefit.adjust($('benefitAdjustmentAuthorizationId').value,$('benefitAdjustmentAmount').value,$('benefitAdjustmentReason').value,Identity.currentUser()?.id);if(!r.ok){showToast(r.error);return;}closeModal('benefitAdjustmentModal');render();showToast('補助額度調整已寫入僅追加帳本');}
function revokeBenefitAuthorization(id){if(!confirm('確定撤銷此正式核定？已結算歷史仍會保留。'))return;const r=Benefit.revokeAuthorization(id,Identity.currentUser()?.id,'管理者撤銷正式核定');if(!r.ok){showToast(r.error);return;}render();showToast('正式核定已撤銷');}


function openBenefitImport(){if(!Benefit.canManageRulesets(Identity.currentUser()?.id)){showToast('只有平台超級管理者可以匯入規則集');return;}$('benefitImportFormat').value='json';$('benefitImportPayload').value='';openModal('benefitImportModal');}
function runBenefitImport(){const r=Benefit.importRulesets({format:$('benefitImportFormat').value,payload:$('benefitImportPayload').value,actorUserId:Identity.currentUser()?.id});if(!r.ok){showToast(r.error||`匯入失敗：${(r.errors||[]).join('；')}`);return;}closeModal('benefitImportModal');render();showToast(`已匯入 ${r.created.length} 個草稿${r.errors.length?`，${r.errors.length} 筆失敗`:''}`);}
function openBenefitDiff(){const rows=(store.state.benefitRulesets||[]);if(rows.length<2){showToast('至少需要兩個規則集才能比較');return;}const options=rows.map(r=>`<option value="${r.id}">${escapeHTML(r.code)}｜${escapeHTML(r.version||'未填')}｜${escapeHTML(({draft:'草稿',published:'已發布',retired:'已退役'})[r.status]||'未知')}</option>`).join('');$('benefitDiffFrom').innerHTML=options;$('benefitDiffTo').innerHTML=options;$('benefitDiffFrom').selectedIndex=Math.min(1,rows.length-1);$('benefitDiffTo').selectedIndex=0;runBenefitDiff();openModal('benefitDiffModal');}
function runBenefitDiff(){const r=Benefit.diffRulesets($('benefitDiffFrom').value,$('benefitDiffTo').value),box=$('benefitDiffResult');if(!r.ok){box.innerHTML=`<div class="empty">${escapeHTML(r.error)}</div>`;return;}box.innerHTML=`<div class="smart-modal-hint"><strong>${escapeHTML(r.from.version||'—')} → ${escapeHTML(r.to.version||'—')}</strong>：${r.changed} 個欄位變更</div>${r.changes.map(c=>`<div class="list-item"><h4>${escapeHTML(c.field)}</h4><p><strong>變更前：</strong>${escapeHTML(String(c.from??'—'))}<br><strong>變更後：</strong>${escapeHTML(String(c.to??'—'))}</p></div>`).join('')||'<div class="empty">兩個版本的業務規則內容相同。</div>'}`;}
function runBenefitRegression(){const r=Benefit.runRegressionTests({actorUserId:Identity.currentUser()?.id,organizationId:orgId()});render();showToast(r.ok?`補助回歸測試通過：${r.passed}/${r.tests.length}`:`補助回歸測試待檢查：${r.failed} 失敗`);}

const VIEW_RENDERERS={'requester-home':requesterHome,'requester-new':requesterNew,'requester-bookings':requesterBookings,'benefits':benefitDashboard,'care-recipients':careRecipientsView,'demand-market':demandMarket,'driver-home':driverHome,'driver-trips':driverTrips,'driver-kpi':driverKpi,'dispatch-home':dispatchHome,'dispatch-trips':dispatchTrips,'dispatch-issues':dispatchIssues,'owner-home':ownerHome,'owner-users':ownerUsers,'owner-vehicles':ownerVehicles,'platform-home':platformHome,'platform-organizations':platformOrganizations,'platform-members':platformMembers,'platform-reports':platformReports,'account':accountView};

async function syncBookings(event){
  if(!Identity.can('booking.sync_google')){showToast('你沒有資料同步權限');return;}
  const btn=event?.currentTarget||$('syncCustomerBookingsBtn'),oldText=btn?.textContent||'重新同步資料';
  if(btn){btn.disabled=true;btn.setAttribute('aria-busy','true');btn.textContent='同步資料中…';}
  showToast('正在同步最新正式資料…');
  try{
    const result=await AppStateDatabase.loadAll();
    if(result.ok){
      try{Benefit.migrate();}catch(error){console.warn('[StateLoad] Benefit normalization warning',error);}
      try{Trip.migrateRuntimeModel?.();Trip.migrateEventHistory?.();Trip.migratePassengerRuntimeHistory?.();Trip.migrateIssueStateModel?.();}catch(error){console.warn('[StateLoad] Trip normalization warning',error);}
      Identity.init();
      if(Identity.currentUser()){applyIdentityContext();renderNav();render();}
    }
    showToast(result.ok?result.message:`同步失敗：${result.error}`);
  }catch(error){
    showToast(`同步失敗：${error?.message||'請稍後再試'}`);
  }finally{
    if(btn&&document.contains(btn)){btn.disabled=false;btn.removeAttribute('aria-busy');btn.textContent=oldText;}
  }
}
function openBookingAsTrip(id){
  if(!Identity.can('booking.schedule')){showToast('你沒有建立預約行程的權限');return;}
  const raw=Booking.get(id),b=Booking.dispatchView(raw),pickupAt=Booking.dateTime(b);if(!raw||!b?.activeLegId||!pickupAt){showToast('此預約沒有可排車的去程／回程時間');return;}
  const best=Dispatch.recommendDrivers(b,orgId(),Identity.currentUser()?.id).find(x=>x.feasible); if(!best){showToast('目前沒有可執行的司機＋車輛組合');return;}
  selectedBookingId=id;selectedBookingLegId=b.activeLegId;selectedCreateTripMutationKey=uid('tripcreate'); $('newPassenger').value=raw.name||''; $('newPhone').value=raw.phone||''; $('newPickup').value=b.pickupAddress||''; $('newDropoff').value=b.destination||''; $('newPickupAt').value=toLocalInput(pickupAt); $('newNeed').value=Booking.needsText(raw)==='一般接送需求'?'':Booking.needsText(raw); $('newDriver').innerHTML=driverOptions(best.driver.id); $('newVehicle').innerHTML=vehicleOptions(best.vehicle?.id||''); $('driverRecommendHint').innerHTML=`<strong>${escapeHTML(b.activeLegLabel)}｜調度建議：${escapeHTML(best.driver.name)}＋${escapeHTML(best.vehicle?.plate||'無可派車')}｜效率 ${best.score}/100</strong><br>${best.reasons.map(escapeHTML).join('・')}${b.pickupAccessNote?`<br>上車注意：${escapeHTML(b.pickupAccessNote)}`:''}${b.destinationAccessNote?`<br>目的地注意：${escapeHTML(b.destinationAccessNote)}`:''}`; openModal('createTripModal');
}
function driverOptions(selected=''){ return `<option value="">未指派</option>${Organization.drivers(orgId()).map(d=>`<option value="${d.id}" ${d.id===selected?'selected':''}>${escapeHTML(d.name)}｜${d.status==='on_duty'?'執勤中':'目前非執勤'}</option>`).join('')}`; }
function vehicleOptions(selected=''){ return `<option value="">未指派</option>${Organization.dispatchableVehicles(orgId()).map(v=>`<option value="${v.id}" ${v.id===selected?'selected':''}>${escapeHTML(v.plate)}｜${escapeHTML(v.model)}｜${v.capacity}人／輪椅${v.wheelchairSlots}</option>`).join('')}`; }
function canAssignTripResources(){ return Identity.can('trip.manage'); }
function canManageVehicles(){ return Identity.can('vehicle.manage'); }
function openManualTrip(){ if(!canAssignTripResources()){showToast('只有調度員或負責人可以建立派車行程');return;} selectedBookingId=''; selectedBookingLegId='';selectedCreateTripMutationKey=uid('tripcreate'); $('newPassenger').value=''; $('newPhone').value='0900000110'; $('newPickup').value=''; $('newDropoff').value=''; $('newPickupAt').value=toLocalInput(addMinutes(new Date(),60)); $('newNeed').value=''; $('newDriver').innerHTML=driverOptions(); $('newVehicle').innerHTML=vehicleOptions(); $('driverRecommendHint').textContent='共享車池：請分別指定本趟司機與車輛；不會建立永久綁定。'; openModal('createTripModal'); }
function saveNewTrip(){
  if(!canAssignTripResources()){showToast('只有調度員或負責人可以派車');return;}
  const scope=$('createTripModal');if(!validateFieldRules(scope,[{id:'newPassenger',message:'請輸入乘客姓名'},{id:'newPhone',message:'請輸入有效聯絡電話',test:f=>f.value.replace(/\D/g,'').length>=9},{id:'newPickup',message:'請輸入上車地址'},{id:'newDropoff',message:'請輸入目的地'},{id:'newPickupAt',message:'請選擇預定接送時間'},{id:'newDriver',message:'請指定司機'},{id:'newVehicle',message:'請指定車輛'}]))return;
  const selectedView=selectedBookingId?Booking.dispatchView(Booking.get(selectedBookingId)):null,btn=$('saveTripBtn');if(btn)btn.disabled=true;
  const input={name:$('newPassenger').value.trim(),phone:$('newPhone').value.replace(/\D/g,''),pickupAddress:$('newPickup').value.trim(),destination:$('newDropoff').value.trim(),pickupAt:$('newPickupAt').value,driverId:$('newDriver').value,vehicleId:$('newVehicle').value,needs:$('newNeed').value.trim()||'一般乘客',bookingId:selectedBookingId||null,bookingLegId:selectedBookingLegId||null,pickupAccessNote:selectedView?.pickupAccessNote||'',destinationAccessNote:selectedView?.destinationAccessNote||'',clientMutationKey:selectedCreateTripMutationKey||uid('tripcreate')};
  const result=Trip.createManual(input,orgId(),Identity.currentUser()?.id); if(!result.ok){routeFieldError(result.error,[['乘客','newPassenger'],['電話','newPhone'],['上車','newPickup'],['目的地','newDropoff'],['時間','newPickupAt'],['司機','newDriver'],['車輛','newVehicle']]);if(btn)btn.disabled=false;return;} selectedBookingId='';selectedBookingLegId=''; closeModal('createTripModal'); render(); showToast(result.duplicate?'相同建立行程 操作已處理，重複點擊已忽略':'行程已建立並完成司機＋車輛指派');
}
function openAssign(tripId){ if(!canAssignTripResources()){showToast('只有調度員或負責人可以改派');return;} selectedAssignTripId=tripId; const t=Trip.get(tripId);selectedAssignTripRevision=t?.revision??0; $('assignTripText').textContent=`${t.code}｜${t.passengerSummary}｜修訂版 ${selectedAssignTripRevision}`; $('assignDriver').innerHTML=driverOptions(t.driverId); $('assignVehicle').innerHTML=vehicleOptions(t.vehicleId); openModal('assignModal'); }
async function saveAssign(){ if(!canAssignTripResources()){showToast('只有調度員或負責人可以改派');return;}if(!validateFieldRules($('assignModal'),[{id:'assignDriver',message:'請選擇司機'},{id:'assignVehicle',message:'請選擇車輛'}]))return;const tripId=selectedAssignTripId,driverId=$('assignDriver').value,vehicleId=$('assignVehicle').value,expectedRevision=Number(selectedAssignTripRevision??0),key=Trip.mutationKey('assign',tripId,`${driverId}:${vehicleId}`,expectedRevision),btn=$('saveAssignBtn');if(btn)btn.disabled=true;try{const result=await Trip.withMutationLock(tripId,()=>Trip.assign(tripId,driverId,vehicleId,Identity.currentUser()?.id,{expectedRevision,idempotencyKey:key}));if(!result.ok){routeFieldError(result.error,[['司機','assignDriver'],['車輛','assignVehicle']]);return;}closeModal('assignModal');render();showToast(result.duplicate?'相同改派已處理，重複操作已忽略':'司機與車輛指派已更新');}finally{if(btn)btn.disabled=false;} }
function findOpenIssueForTrip(tripId){return Trip.issues(orgId()).find(i=>i.tripId===tripId&&i.status!=='resolved')||null;}
function openHandoverTrip(tripId,issueId=''){if(!canAssignTripResources()){showToast('只有調度員或負責人可以處理中途交接');return;}const t=Trip.get(tripId);if(!t||t.status!=='interrupted'){showToast('只有已中斷行程可以換司機／換車');return;}selectedHandoverTripId=tripId;selectedHandoverIssueId=issueId||findOpenIssueForTrip(tripId)?.id||'';selectedHandoverTripRevision=t.revision;if($('saveHandoverBtn'))$('saveHandoverBtn').disabled=false;$('handoverTripText').textContent=`${t.code}｜目前 ${Organization.driver(t.driverId)?.name||'未指派'}／${Organization.vehicle(t.vehicleId)?.plate||'未派車'}｜修訂版 ${t.revision}`;$('handoverDriver').innerHTML=driverOptions(t.driverId);$('handoverVehicle').innerHTML=vehicleOptions(t.vehicleId);$('handoverNote').value=t.interruptReason||'現場異常資源交接';openModal('handoverTripModal');}
async function saveHandoverTrip(){const t=Trip.get(selectedHandoverTripId);if(!t){showToast('找不到行程');return;}const expectedRevision=Number(selectedHandoverTripRevision??t.revision),driverId=$('handoverDriver').value,vehicleId=$('handoverVehicle').value,note=$('handoverNote').value.trim()||'資源交接',key=Trip.mutationKey('handover',t.id,`${driverId}:${vehicleId}`,expectedRevision),btn=$('saveHandoverBtn');if(btn)btn.disabled=true;try{const r=await Trip.withMutationLock(t.id,()=>Trip.handoverResources(t.id,{driverId,vehicleId,issueId:selectedHandoverIssueId||null,note},Identity.currentUser()?.id,{expectedRevision,idempotencyKey:key}));if(!r.ok){showToast(r.error);return;}closeModal('handoverTripModal');render();showToast(r.duplicate?'相同交接已處理，重複操作已忽略':'資源交接完成；行程仍維持中斷，請確認後恢復行程');}finally{if(btn)btn.disabled=false;}}
async function interruptTripFromIssue(tripId,issueId,expectedRevision){const issue=Trip.issues(orgId()).find(i=>i.id===issueId),reason=issue?`${issue.type}${issue.note?`：${issue.note}`:''}`:'現場異常';const revision=Number(expectedRevision??Trip.get(tripId)?.revision??0),key=Trip.mutationKey('interrupt',tripId,issueId||'manual',revision),r=await Trip.withMutationLock(tripId,()=>Trip.interrupt(tripId,Identity.currentUser()?.id,{issueId:issueId||null,reason,expectedRevision:revision,idempotencyKey:key}));render();showToast(r.ok?(r.duplicate?'相同中斷操作已忽略':'行程已中斷；停靠點執行已鎖定，可進行換車／換司機'):r.error);}
async function resumeInterruptedTrip(tripId,issueId=''){const t=Trip.get(tripId);if(!t){showToast('找不到行程');return;}const key=Trip.mutationKey('resume',tripId,t.currentStepIndex,t.revision),r=await Trip.withMutationLock(tripId,()=>Trip.resume(tripId,Identity.currentUser()?.id,{issueId:issueId||findOpenIssueForTrip(tripId)?.id||null,reason:'調度確認資源／現場狀況可繼續',expectedRevision:t.revision,idempotencyKey:key}));render();showToast(r.ok?(r.duplicate?'相同恢復操作已忽略':'行程已恢復，新指派司機可繼續目前 Stop'):r.error);}
async function abortInterruptedTrip(tripId,issueId=''){const t=Trip.get(tripId);if(!t){showToast('找不到行程');return;}const reason=prompt('請輸入終止行程原因：',t.interruptReason||'中途異常無法繼續');if(reason===null)return;const text=String(reason).trim();if(!text){showToast('請輸入終止原因');return;}const linkedIssue=issueId?Trip.issues(orgId()).find(i=>i.id===issueId):findOpenIssueForTrip(tripId),reasonCode=Trip.inferReasonCode(`${linkedIssue?.type||''} ${text}`),key=Trip.mutationKey('abort',tripId,issueId||'manual',t.revision),r=await Trip.withMutationLock(tripId,()=>Trip.abort(tripId,Identity.currentUser()?.id,{issueId:issueId||linkedIssue?.id||null,reason:text,reasonCode,expectedRevision:t.revision,idempotencyKey:key}));render();showToast(r.ok?(r.duplicate?'相同終止操作已忽略':'行程已正式終止，未完成停靠點 與乘客狀態保留'):r.error);}
function openFormalTripCorrection(tripId){const t=Trip.get(tripId);if(!t){showToast('找不到行程');return;}if(!Identity.can('trip.manage')){showToast('只有調度員或負責人可以執行正式修正');return;}if(t.status!=='completed'){showToast('正式修正 只適用於已完成 Trip');return;}selectedFormalCorrectionTripId=t.id;selectedFormalCorrectionTripRevision=t.revision;$('formalTripCorrectionText').textContent=`${t.code}｜${t.passengerSummary}｜完成 ${formatDateTime(t.completedAt)}｜修訂版 ${t.revision}`;$('formalTripCorrectionReason').value='';if($('confirmFormalTripCorrectionBtn'))$('confirmFormalTripCorrectionBtn').disabled=false;openModal('formalTripCorrectionModal');}
async function confirmFormalTripCorrection(){const t=Trip.get(selectedFormalCorrectionTripId),reason=$('formalTripCorrectionReason').value.trim(),btn=$('confirmFormalTripCorrectionBtn');if(!t){showToast('找不到行程');return;}if(reason.length<4){showToast('請填寫至少 4 個字的修正原因');return;}const expectedRevision=Number(selectedFormalCorrectionTripRevision??t.revision),index=Math.max(0,Math.min(t.currentStepIndex-1,t.steps.length-1)),step=t.steps[index];if(!step?.id){showToast('沒有可修正的最後完成停靠點');return;}const key=Trip.mutationKey('formal_correction',t.id,step.id,expectedRevision);if(btn)btn.disabled=true;try{const r=await Trip.withMutationLock(t.id,()=>Trip.undoLastStep(t.id,Identity.currentUser()?.id,{formalCorrection:true,correctionReason:reason,expectedRevision,expectedStepId:step.id,idempotencyKey:key}));if(!r.ok){showToast(r.error);render();return;}closeModal('formalTripCorrectionModal');render();showToast(r.duplicate?'相同正式修正已處理，重複操作已忽略':r.supersededProofIds?.length?`正式修正已建立；${r.supersededProofIds.length} 份舊服務證明已標記為被修正，請重新完成最後一站並建立新服務證明`:'正式修正已建立；Trip 已返回最後一站，原始歷史完整保留');}finally{if(btn)btn.disabled=false;}}

function openResolveTripIssue(issueId){const issue=Trip.issues(orgId()).find(i=>i.id===issueId);if(!issue){showToast('找不到異常');return;}if(issue.status!=='handling'){showToast('Issue 必須先進入處理中才能結案');return;}selectedResolveIssueId=issueId;$('resolveTripIssueText').textContent=`${issue.type}｜${Trip.issueSeverityLabel(issue.severity)}｜${Trip.get(issue.tripId)?.code||issue.tripId}`;$('issueResolutionCode').value=Trip.get(issue.tripId)?.status==='aborted'?'trip_aborted':Trip.resourceSegments(issue.tripId).length>1?'resource_handover':'continued_trip';$('issueResolutionNote').value='';openModal('resolveTripIssueModal');}
function confirmResolveTripIssue(){const note=$('issueResolutionNote').value.trim();const r=Trip.resolveIssue(selectedResolveIssueId,Identity.currentUser()?.id,{resolutionCode:$('issueResolutionCode').value,resolutionNote:note});if(!r.ok){showToast(r.error);return;}closeModal('resolveTripIssueModal');render();showToast('異常已結案，完整處理歷史已寫入行程事件歷史');}
function openAddStaff(){
  const isPlatform=Identity.can('platform.membership.manage'),isCompany=Identity.can('company.staff.manage');
  if(!isPlatform&&!isCompany){showToast('你沒有新增公司人員權限');return;}
  if(orgId()===APP_CONFIG.requesterOrganizationId||currentOrg()?.type==='requester_hub'){showToast('需求者可自行註冊／社群登入；平台超級管理者若要替既有公司成員加需求者身分，請在該公司的成員資料中勾選');return;}
  $('staffNameInput').value='';$('staffPhoneInput').value='';if($('staffInitialPasswordInput'))$('staffInitialPasswordInput').value='';$('staffAlsoRequesterInput').checked=false;
  $('staffRequesterField').classList.remove('hidden');
  $('addStaffModalTitle').textContent=isPlatform?'新增組織成員':'新增人員';
  $('addStaffModalDescription').textContent=isPlatform?'平台超級管理者可替目前公司建立負責人、司機或調度員。新使用者的初始密碼由伺服器保存雜湊；既有使用者只新增組織身分。':'負責人可新增司機或調度員；新使用者需設定初始密碼，帳號會直接寫入正式資料庫。';
  const hasOwner=store.state.memberships.some(m=>m.organizationId===orgId()&&m.role==='owner'&&Identity.membershipStatus(m)!=='revoked');
  $('staffRoleInput').innerHTML=isPlatform?`${hasOwner?'':'<option value="owner">負責人</option>'}<option value="driver">司機</option><option value="dispatcher">調度人員</option>`:'<option value="driver">司機</option><option value="dispatcher">調度人員</option>';
  openModal('addStaffModal');
}
async function saveStaff(){
  const alsoRequester=Identity.canAny(['platform.membership.manage','company.staff.manage'])&&!!$('staffAlsoRequesterInput')?.checked;
  const name=$('staffNameInput').value.trim(),phone=$('staffPhoneInput').value.replace(/\D/g,''),password=$('staffInitialPasswordInput')?.value||'',staffRole=$('staffRoleInput').value;
  if(!name){showToast('請輸入姓名');return;}if(!/^09\d{8}$/.test(phone)){showToast('請輸入 09 開頭共 10 位手機號碼');return;}if(password.length<8){showToast('新帳號初始密碼至少需要 8 碼');return;}
  const btn=$('saveStaffBtn');setButtonBusy(btn,true,'建立中…');
  try{
    {
      const result=await CloudIdentity.createStaff({organizationId:orgId(),name,phone,password,role:staffRole,alsoRequester});
      const sync=await AppStateDatabase.loadAll({silent:true});if(!sync.ok)throw new Error(`帳號已送出，但資料庫重新同步失敗：${sync.error}`);
      if(!result.membership?.membershipId&&!result.membershipId)console.warn('[createStaff] backend response missing membership id',result);
    }
    $('staffInitialPasswordInput').value='';closeModal('addStaffModal');render();
    showToast(`${ROLE_LABELS[staffRole]||staffRole}${alsoRequester?'＋需求者':''} 帳號已建立`);
  }catch(error){showToast(error?.message||'建立帳號失敗');}
  finally{setButtonBusy(btn,false);}
}
async function requestResetOtp(){
  const phone=digitsOnly($('forgotPhoneInput').value),btn=$('requestResetOtpBtn');if(!/^09\d{8}$/.test(phone)){showToast('請輸入有效的 10 碼手機號碼');return;}setButtonBusy(btn,true,'發送中…');
  try{
    {await CloudIdentity.requestPasswordReset({phone});const hint=$('resetOtpHint');hint.classList.remove('hidden');hint.textContent='若此手機為有效帳號，6 位數驗證碼已透過正式簡訊服務送出，5 分鐘內有效。';}
  }catch(error){showToast(error?.message||'驗證碼發送失敗');}
  finally{setButtonBusy(btn,false);}
}
async function confirmResetPassword(){
  const phone=digitsOnly($('forgotPhoneInput').value),otp=$('resetOtpInput').value.trim(),newPassword=$('newPasswordInput').value,btn=$('confirmResetPasswordBtn');if(newPassword.length<8){showToast('新密碼至少需要 8 碼');return;}setButtonBusy(btn,true,'更新中…');
  try{
    let userPhone=phone;
    await CloudIdentity.confirmPasswordReset({phone,otp,newPassword});
    LoginSecurity.clear(userPhone);CloudIdentity.clearSessionToken();closeModal('forgotPasswordModal');$('loginPhone').value=userPhone;$('loginPassword').value='';$('loginCaptchaInput').value='';renderLoginSecurityState();showToast('密碼已由伺服器更新，舊登入工作階段已失效；請使用新密碼重新登入');
  }catch(error){showToast(error?.message||'密碼重設失敗');}
  finally{setButtonBusy(btn,false);}
}
function openAddVehicle(){
  clearFieldErrors($('addVehicleModal'));
  if(!canManageVehicles()){showToast('只有公司負責人可以管理車輛');return;}
  $('vehicleEditIdInput').value='';$('vehicleModalTitle').textContent='新增車輛';$('saveVehicleBtn').textContent='新增車輛';$('vehiclePlateInput').value='';$('vehicleModelInput').value='';$('vehicleCapacityInput').value=4;$('vehicleWheelchairInput').value=1;$('vehicleAccessibleInput').value='true';$('vehicleStatusInput').disabled=false;$('vehicleStatusInput').value='available';openModal('addVehicleModal');
}
function openEditVehicle(vehicleId){
  clearFieldErrors($('addVehicleModal'));
  if(!canManageVehicles()){showToast('只有公司負責人可以管理車輛');return;}
  const vehicle=Organization.vehicle(vehicleId);if(!vehicle){showToast('找不到車輛');return;}
  $('vehicleEditIdInput').value=vehicle.id;$('vehicleModalTitle').textContent='編輯車輛';$('saveVehicleBtn').textContent='儲存車輛';$('vehiclePlateInput').value=vehicle.plate||'';$('vehicleModelInput').value=vehicle.model||'';$('vehicleCapacityInput').value=vehicle.capacity||1;$('vehicleWheelchairInput').value=vehicle.wheelchairSlots||0;$('vehicleAccessibleInput').value=vehicle.accessible?'true':'false';$('vehicleStatusInput').value=vehicle.status==='inactive'?'maintenance':(vehicle.status||'available');$('vehicleStatusInput').disabled=vehicle.status==='retired';openModal('addVehicleModal');
}
function saveVehicle(){
  if(!canManageVehicles()){showToast('只有公司負責人可以管理車輛');return;}
  if(!validateFieldRules($('addVehicleModal'),[{id:'vehiclePlateInput',message:'請輸入車牌'},{id:'vehicleModelInput',message:'請輸入車型'},{id:'vehicleCapacityInput',message:'載客量需為 1–20 人',test:f=>Number(f.value)>=1&&Number(f.value)<=20},{id:'vehicleWheelchairInput',message:'輪椅位需為 0–6',test:f=>Number(f.value)>=0&&Number(f.value)<=6}]))return;
  const editId=$('vehicleEditIdInput').value,input={plate:$('vehiclePlateInput').value,model:$('vehicleModelInput').value,capacity:Number($('vehicleCapacityInput').value),wheelchairSlots:Number($('vehicleWheelchairInput').value),accessible:$('vehicleAccessibleInput').value==='true',status:$('vehicleStatusInput').value};
  const result=editId?Organization.updateVehicle(editId,input,Identity.currentUser()?.id):Organization.addVehicle(input,orgId(),Identity.currentUser()?.id);
  if(!result.ok){routeFieldError(result.error,[['車牌','vehiclePlateInput'],['車型','vehicleModelInput'],['載客','vehicleCapacityInput'],['輪椅','vehicleWheelchairInput'],['狀態','vehicleStatusInput']]);return;} closeModal('addVehicleModal'); render(); showToast(editId?'車輛資料已更新':'車輛已新增');
}
function openVehicleLifecycle(vehicleId,action){
  if(!canManageVehicles()){showToast('只有公司負責人可以管理車輛生命週期');return;}
  const vehicle=Organization.vehicle(vehicleId);if(!vehicle){showToast('找不到車輛');return;}
  const usage=Organization.vehicleUsage(vehicleId);
  $('vehicleLifecycleIdInput').value=vehicle.id;$('vehicleLifecycleActionInput').value=action;
  const deleting=action==='delete';
  $('vehicleLifecycleTitle').textContent=deleting?'刪除未使用車輛':'將車輛退役';
  $('vehicleLifecycleText').textContent=deleting?`確定永久刪除 ${vehicle.plate}｜${vehicle.model}？`:`確定將 ${vehicle.plate}｜${vehicle.model} 設為已退役？`;
  $('vehicleLifecycleHint').textContent=deleting
    ?'只有從未建立任何 Trip、也未被待套用派車方案引用的誤建車輛才能真正刪除。刪除後不保留車輛主檔。'
    :`此車已有 ${usage.tripCount} 筆 Trip 歷史。退役後永久不可派車，也不能恢復成可派車／維修中；歷史 Trip 仍保留此 Vehicle。`;
  $('vehicleLifecycleReasonInput').value='';$('vehicleLifecycleTokenInput').value='';$('vehicleLifecycleTokenHint').textContent=`請輸入車牌「${vehicle.plate}」完成確認。`;const confirm=$('confirmVehicleLifecycleBtn');confirm.textContent=deleting?'確認永久刪除':'確認退役';confirm.className='btn permanent';openModal('vehicleLifecycleModal');
}
function confirmVehicleLifecycle(){
  const vehicleId=$('vehicleLifecycleIdInput').value,action=$('vehicleLifecycleActionInput').value,actorUserId=Identity.currentUser()?.id,vehicle=Organization.vehicle(vehicleId),reason=$('vehicleLifecycleReasonInput').value.trim(),token=$('vehicleLifecycleTokenInput').value.trim();
  if(!reason){showToast('請先輸入操作原因');$('vehicleLifecycleReasonInput').focus();return;}
  if(!vehicle||token!==String(vehicle.plate||'').trim()){showToast('請輸入正確車牌以確認');$('vehicleLifecycleTokenInput').focus();return;}
  const result=action==='retire'?Organization.retireVehicle(vehicleId,actorUserId):Organization.deleteVehicle(vehicleId,actorUserId);
  if(!result.ok){showToast(result.error);return;}
  Audit.log('organization.vehicle_lifecycle_confirmed',`${action==='retire'?'退役':'刪除'}車輛二次確認：${vehicle.plate}`,{actorUserId,vehicleId,reason,action});
  closeModal('vehicleLifecycleModal');render();showToast(action==='retire'?'車輛已退役並保留所有歷史':'未使用車輛已永久刪除');
}
function openAddOrganization(){ if(!Identity.can('platform.organization.manage')){showToast('只有超級管理者可以新增組織');return;} $('organizationNameInput').value='';$('organizationTypeInput').value='transport_provider';$('organizationTaxIdInput').value='';$('organizationContactPhoneInput').value='';openModal('addOrganizationModal'); }
function openOrganizationStatusConfirm(organizationId,active){
  const organization=Organization.get(organizationId);
  if(!organization){ showToast('找不到組織'); return; }
  pendingOrganizationStatusChange={organizationId,active:!!active};
  const removing=!active;
  $('organizationStatusTitle').textContent=removing?'停用組織':'重新啟用組織';
  $('organizationStatusDescription').textContent=removing
    ?`確定暫停「${organization.name}」的營運權限？該組織成員將暫時無法以這個組織身分登入，但資料與歷史紀錄都會保留。`
    :`確定重新啟用「${organization.name}」？`;
  const incomplete=removing?Organization.incompleteTrips(organizationId):[];
  $('organizationStatusHint').textContent=removing
    ?(incomplete.length?`目前仍有 ${incomplete.length} 筆待執行／進行中行程，必須先完成或改派，否則不能停用公司。`:'這是保留歷史的停用：既有預約、行程、成員、車輛與歷史紀錄都會保留，之後可重新啟用。')
    :'重新啟用後，原本仍為有效組織身分 的成員可再次使用此組織身分。';
  const dangerFields=$('organizationDangerFields');dangerFields?.classList.toggle('hidden',!removing);$('organizationStatusReasonInput').value='';$('organizationStatusTokenInput').value='';if(removing)$('organizationStatusTokenHint').textContent=`請輸入完整組織名稱「${organization.name}」完成確認。`;
  const button=$('confirmOrganizationStatusBtn');
  button.textContent=removing?'確認停用':'確認重新啟用';
  button.className=`btn ${removing?'warning':'success'}`;
  button.disabled=!!(removing&&incomplete.length);
  openModal('organizationStatusModal');
}

function applyOrganizationStatusChange(){
  const pending=pendingOrganizationStatusChange;
  if(!pending){ closeModal('organizationStatusModal'); return; }
  const {organizationId,active}=pending,organization=Organization.get(organizationId),actorUserId=Identity.currentUser()?.id;
  if(!active){const reason=$('organizationStatusReasonInput').value.trim(),token=$('organizationStatusTokenInput').value.trim();if(!reason){showToast('請先輸入停用原因');$('organizationStatusReasonInput').focus();return;}if(token!==String(organization?.name||'').trim()){showToast('請輸入完整組織名稱以確認');$('organizationStatusTokenInput').focus();return;}Audit.log('organization.deactivation_confirmed',`停用組織二次確認：${organization?.name||organizationId}`,{actorUserId,organizationId,reason});}
  const result=Organization.setOrganizationActive(organizationId,active,actorUserId);
  if(!result.ok){ showToast(result.error); return; }
  pendingOrganizationStatusChange=null;
  closeModal('organizationStatusModal');
  if(!active&&organizationId===orgId()){
    const fallback=Identity.availableOrganizations().find(x=>x.organization.id!==organizationId);
    if(fallback) Identity.switchOrganization(fallback.organization.id);
  }
  applyIdentityContext();
  renderNav();
  render();
  showToast(active?'組織已重新啟用':'組織已移除');
}

function saveOrganization(){ if(!validateFieldRules($('addOrganizationModal'),[{id:'organizationNameInput',message:'請輸入組織名稱'}]))return;const result=Organization.addOrganization({name:$('organizationNameInput').value,type:$('organizationTypeInput').value,taxId:$('organizationTaxIdInput').value,contactPhone:$('organizationContactPhoneInput').value},Identity.currentUser()?.id); if(!result.ok){routeFieldError(result.error,[['組織名稱','organizationNameInput'],['名稱','organizationNameInput'],['統一編號','organizationTaxIdInput'],['統編','organizationTaxIdInput'],['聯絡電話','organizationContactPhoneInput'],['電話','organizationContactPhoneInput']]);return;} if(Identity.isSuperAdmin()) Identity.switchOrganization(result.organization.id); closeModal('addOrganizationModal'); renderOrganizationSwitcher();renderMobileIdentityContext(); render(); showToast(`已建立 ${result.organization.name}，請指定唯一負責人`); }
function openEditOrganization(organizationId){
  clearFieldErrors($('editOrganizationModal'));
  if(!Identity.can('platform.organization.manage')){showToast('只有 平台超級管理者可以編輯組織');return;}
  const o=Organization.get(organizationId);if(!o){showToast('找不到組織');return;}if(o.systemManaged){showToast('需求者組織為系統管理組織');return;}
  const memberships=store.state.memberships.filter(m=>m.organizationId===organizationId&&Identity.membershipStatus(m)!=='revoked'&&['owner','driver','dispatcher'].includes(m.role));
  const currentOwner=memberships.find(m=>m.role==='owner');
  $('editOrganizationIdInput').value=o.id;$('editOrganizationNameText').textContent=`${o.name}｜修改組織基本資料與負責人`;
  $('editOrganizationDisplayNameInput').value=o.name||'';$('editOrganizationTaxIdInput').value=o.taxId||'';$('editOrganizationContactPhoneInput').value=o.contactPhone||'';
  $('editOrganizationOwnerInput').innerHTML=memberships.map(m=>{const u=store.state.users.find(x=>x.id===m.userId);return `<option value="${m.id}" ${m.id===currentOwner?.id?'selected':''}>${escapeHTML(u?.name||'未知使用者')}｜${ROLE_LABELS[m.role]||m.role}</option>`;}).join('')||'<option value="">尚無可指定成員</option>';
  openModal('editOrganizationModal');
}
function saveOrganizationDetails(){
  if(!Identity.can('platform.organization.manage')){showToast('只有 平台超級管理者可以編輯組織');return;}
  if(!validateFieldRules($('editOrganizationModal'),[{id:'editOrganizationDisplayNameInput',message:'請輸入組織名稱'}]))return;
  const organizationId=$('editOrganizationIdInput').value;
  const result=Organization.updateOrganizationDetails(organizationId,{name:$('editOrganizationDisplayNameInput').value,taxId:$('editOrganizationTaxIdInput').value,contactPhone:$('editOrganizationContactPhoneInput').value},Identity.currentUser()?.id);
  if(!result.ok){routeFieldError(result.error,[['組織名稱','editOrganizationDisplayNameInput'],['名稱','editOrganizationDisplayNameInput'],['統一編號','editOrganizationTaxIdInput'],['統編','editOrganizationTaxIdInput'],['聯絡電話','editOrganizationContactPhoneInput'],['電話','editOrganizationContactPhoneInput']]);return;}
  const ownerMembershipId=$('editOrganizationOwnerInput').value;
  if(ownerMembershipId){const ownerResult=Identity.setOrganizationOwner(organizationId,ownerMembershipId);if(!ownerResult.ok){routeFieldError(ownerResult.error,[['負責人','editOrganizationOwnerInput']]);return;}}
  closeModal('editOrganizationModal');renderOrganizationSwitcher();applyIdentityContext();render();showToast('組織名稱、聯絡資料與負責人已更新');
}
function openEditMember(membershipId){
  if(!Identity.can('platform.membership.manage')){showToast('只有 平台超級管理者可以編輯成員');return;}
  const m=store.state.memberships.find(x=>x.id===membershipId),u=m?store.state.users.find(x=>x.id===m.userId):null;if(!m||!u){showToast('找不到成員');return;}
  $('editMemberMembershipIdInput').value=m.id;$('editMemberNameInput').value=u.name||'';$('editMemberPhoneInput').value=u.phone||'';
  const isRequesterHub=m.organizationId===APP_CONFIG.requesterOrganizationId||currentOrg()?.type==='requester_hub';
  $('editMemberRequesterField').classList.toggle('hidden',isRequesterHub);
  $('editMemberRequesterInput').checked=isRequesterHub||Identity.hasRequesterIdentity(u.id);
  $('editMemberContextText').textContent=`${currentOrg()?.name||'組織'}｜${ROLE_LABELS[m.role]||m.role}${isRequesterHub?'':'｜可同步調整需求者身分'}`;openModal('editMemberModal');
}
let pendingRevokeMembershipId=null;
function membershipEventText(event){
  if(event.eventType==='created')return `建立組織身分｜${event.toRole?ROLE_LABELS[event.toRole]||event.toRole:''}`;
  if(event.eventType==='revoked')return '撤銷公司工作帳號';
  if(event.eventType==='reactivated')return '恢復公司工作帳號';
  if(event.eventType==='role_changed')return `角色：${ROLE_LABELS[event.fromRole]||event.fromRole||'-'} → ${ROLE_LABELS[event.toRole]||event.toRole||'-'}`;
  if(event.eventType==='migrated')return '建立歷史基準';
  return event.note||'組織身分異動';
}
function openMembershipHistory(membershipId){
  if(!Identity.canViewMembershipHistory(membershipId)){showToast('你沒有查看此組織身分歷史的權限');return;}
  const m=store.state.memberships.find(x=>x.id===membershipId),u=m?store.state.users.find(x=>x.id===m.userId):null,org=m?Organization.get(m.organizationId):null;
  $('membershipHistoryContext').textContent=`${u?.name||'未知使用者'}｜${org?.name||'-'}｜${ROLE_LABELS[m?.role]||m?.role||'-'}`;
  const rows=Identity.membershipHistory(membershipId);
  $('membershipHistoryList').innerHTML=rows.map(e=>{const actor=store.state.users.find(u=>u.id===e.actorUserId);return `<div class="list-item"><div class="list-item-head"><div><h4>${escapeHTML(membershipEventText(e))}</h4><p>${formatDateTime(e.createdAt)}・操作者：${escapeHTML(actor?.name||'系統')}<br>${escapeHTML(e.note||'')}</p></div><span class="pill ${e.toStatus==='revoked'?'gray':'blue'}">${MEMBERSHIP_STATUS_LABELS[e.toStatus]||e.toStatus||'紀錄'}</span></div></div>`;}).join('')||'<div class="empty">目前沒有異動紀錄</div>';
  openModal('membershipHistoryModal');
}
function tripEventLabel(event){
  const labels={trip_created:'建立行程',trip_state_transitioned:'行程狀態轉換',trip_step_completed:'完成停靠點',trip_stop_milestone:'停靠點執行事件',trip_event_corrected:'修正／返回上一步',trip_resource_assigned:'司機／車輛指派',trip_resource_handed_over:'中途資源交接',trip_issue_reported:'異常回報',trip_issue_state_transitioned:'Issue 狀態轉換',trip_issue_resolved:'異常已處理（舊版）',trip_history_migrated:'建立行程 歷史基準',trip_state_migrated:'建立狀態基準',trip_stop_runtime_migrated:'建立停靠點執行基準',trip_passenger_state_changed:'乘客狀態更新',trip_passenger_runtime_migrated:'建立乘客執行基準',trip_execution_snapshot_captured:'行程執行快照',trip_actual_distance_recorded:'實際里程回寫',trip_proof_of_service_captured:'服務證明',trip_proof_of_service_superseded:'服務證明已被修正',trip_route_deviation_detected:'Route Deviation',trip_route_deviation_cleared:'路線偏離已恢復'};
  return labels[event?.eventType]||event?.eventType||'Trip Event';
}
function tripEventDetail(event){
  const m=event?.metadata||{};
  if(event.eventType==='trip_state_transitioned')return `${m.from||'—'} → ${m.to||'—'}${m.correction?'（correction）':''}${event.reason?`・${event.reason}`:''}`;
  if(event.eventType==='trip_step_completed')return `${event.reason||'完成'}${m.timing?`・${m.timing}`:''}`;
  if(event.eventType==='trip_stop_milestone')return `${m.milestone||event.reason||'milestone'}`;
  if(event.eventType==='trip_passenger_state_changed')return `${m.name||'乘客'}：${tripPassengerStatusLabelGlobal(m.from)} → ${tripPassengerStatusLabelGlobal(m.to)}`;
  if(event.eventType==='trip_passenger_runtime_migrated')return `${(m.passengers||[]).length} 位乘客執行狀態基準`;
  if(event.eventType==='trip_event_corrected')return `${m.correctionMode==='manager_formal'?'正式修正':'撤銷／修正'} ${event.targetEventIds?.length||0} 筆原始事件；原事件仍保留${m.correctionReason?`・原因：${m.correctionReason}`:''}`;
  if(event.eventType==='trip_resource_assigned')return `${m.from?.driverId||'—'} / ${m.from?.vehicleId||'—'} → ${m.to?.driverId||'—'} / ${m.to?.vehicleId||'—'}`;
  if(event.eventType==='trip_resource_handed_over')return `${m.from?.driverId||'—'} / ${m.from?.vehicleId||'—'} → ${m.to?.driverId||'—'} / ${m.to?.vehicleId||'—'}${event.reason?`・${event.reason}`:''}`;
  if(event.eventType==='trip_issue_reported')return `${event.reason||'異常'}${m.note?`・${m.note}`:''}${m.severity?`・${m.severity}`:''}`;
  if(event.eventType==='trip_issue_state_transitioned')return `Issue ${m.issueId||''}：${m.from||'—'} → ${m.to||'—'}${m.resolutionNote?`・${m.resolutionNote}`:''}`;
  if(event.eventType==='trip_issue_resolved')return `Issue ${m.issueId||''} 已處理（舊版事件）`;
  if(event.eventType==='trip_execution_snapshot_captured')return `Snapshot #${m.sequence||'—'}・${m.source||event.reason||'snapshot'}・Trip Revision ${m.tripRevision??'—'}`;
  if(event.eventType==='trip_actual_distance_recorded')return `空車 ${m.emptyKm??'—'} km・載客 ${m.loadedKm??'—'} km・來源 ${m.source||event.reason||'actual'}`;
  if(event.eventType==='trip_proof_of_service_captured')return `Proof #${m.sequence||'—'}・${m.receiverName||'確認人'}・${m.receiverRole||'other'}${m.hasGps?'・GPS':''}${m.hasPhoto?'・照片':''}`;
  if(event.eventType==='trip_proof_of_service_superseded')return `因返回送達站上一步，將 ${m.proofIds?.length||0} 份舊服務證明 標記為已被修正；原始服務證明 與照片仍保留`;
  if(event.eventType==='trip_route_deviation_detected')return `${m.level||event.reason||'warning'}・偏離約 ${m.deviationKm??'—'} km・ETA ${m.etaAt?formatTime(m.etaAt):'—'}`;
  if(event.eventType==='trip_route_deviation_cleared')return `已回到估算路線走廊・偏離 ${m.deviationKm??'—'} km`;
  return event.reason||'';
}
function geolocationOnce(){return new Promise((resolve,reject)=>{if(!navigator?.geolocation){reject(new Error('此裝置／瀏覽器不支援定位'));return;}navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude,accuracyMeters:p.coords.accuracy,speedMps:p.coords.speed,heading:p.coords.heading,capturedAt:new Date(p.timestamp||Date.now()).toISOString()}),e=>reject(new Error(e?.message||'無法取得定位')),{enableHighAccuracy:true,timeout:10000,maximumAge:15000});});}
function proofDropoffOptions(trip){return (trip?.steps||[]).filter(s=>s.type==='dropoff'&&(s.completedAt||s.passengerDroppedOffAt));}
function openProofService(tripId){const trip=Trip.get(tripId);if(!trip){showToast('找不到行程');return;}const access=Trip.executionAccess(trip,Identity.currentUser()?.id);if(!access.ok){showToast(access.error);return;}const steps=proofDropoffOptions(trip);if(!steps.length){showToast('目前沒有已完成送達 Stop 可建立服務證明');return;}const proofs=Trip.activeServiceProofs(trip),requirements=Trip.proofRequirements(trip),firstMissing=steps.find(s=>requirements.some(r=>r.stepId===s.id&&!r.satisfied))||steps[steps.length-1];$('proofTripId').value=trip.id;$('proofTripRevision').value=String(trip.revision);$('proofStepSelect').innerHTML=steps.map(s=>`<option value="${s.id}" ${s.id===firstMissing.id?'selected':''}>${escapeHTML(s.title)}・既有 ${proofs.filter(p=>p.stepId===s.id).length} 份</option>`).join('');$('proofReceiverName').value=firstMissing.name||'';$('proofReceiverRole').value='passenger';$('proofNote').value='';$('proofPhotoInput').value='';pendingProofLocation=null;pendingProofPhoto=null;$('proofLocationStatus').textContent='定位：尚未取得。可離線取得裝置定位；若瀏覽器拒絕定位仍可儲存其他證明。';openModal('proofServiceModal');}
async function compressProofPhoto(file){if(!file)return null;if(!String(file.type||'').startsWith('image/'))throw new Error('服務證明照片必須是圖片');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('照片讀取失敗'));r.readAsDataURL(file);});const img=await new Promise((resolve,reject)=>{const x=new Image();x.onload=()=>resolve(x);x.onerror=()=>reject(new Error('照片解析失敗'));x.src=data;});const max=900,scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.68));if(!blob)throw new Error('照片壓縮失敗');if(blob.size>650000)throw new Error('照片壓縮後仍過大，請改用較小照片');return {name:file.name||'proof.jpg',type:'image/jpeg',size:blob.size,blob};}
async function captureProofGps(){const btn=$('captureProofGpsBtn');btn.disabled=true;$('proofLocationStatus').textContent='定位：定位中…';try{pendingProofLocation=await geolocationOnce();$('proofLocationStatus').textContent=`定位：${pendingProofLocation.lat.toFixed(5)}, ${pendingProofLocation.lng.toFixed(5)}・精度約 ${Math.round(pendingProofLocation.accuracyMeters||0)} 公尺`;}catch(e){pendingProofLocation=null;$('proofLocationStatus').textContent=`GPS：${e.message}`;}finally{btn.disabled=false;}}
async function saveProofService(){const tripId=$('proofTripId').value,trip=Trip.get(tripId);if(!trip){showToast('找不到行程');return;}const btn=$('saveProofServiceBtn');btn.disabled=true;let createdProofObjectKey=null;try{const file=$('proofPhotoInput').files?.[0]||null;if(file){const compressed=await compressProofPhoto(file),proofObjectId=uid('proofblob');pendingProofPhoto=await Trip.storeProofBlob({proofId:proofObjectId,tripId,blob:compressed.blob,metadata:{name:compressed.name,type:compressed.type,size:compressed.size}});if(!pendingProofPhoto)throw new Error('照片無法寫入瀏覽器資料庫，請確認瀏覽器儲存空間');createdProofObjectKey=pendingProofPhoto.objectKey;}const expectedRevision=Number($('proofTripRevision').value),stepId=$('proofStepSelect').value,receiverName=$('proofReceiverName').value.trim(),key=Trip.mutationKey('proof_service',tripId,`${stepId}:${receiverName}`,expectedRevision),r=await Trip.withMutationLock(tripId,()=>Trip.captureProof(tripId,stepId,{receiverName,receiverRole:$('proofReceiverRole').value,note:$('proofNote').value,gps:pendingProofLocation,photo:pendingProofPhoto},Identity.currentUser()?.id,{expectedRevision,idempotencyKey:key}));if(!r.ok||r.duplicate){if(createdProofObjectKey)await Trip.deleteProofBlob(createdProofObjectKey);createdProofObjectKey=null;showToast(r.duplicate?'相同服務證明操作已忽略':r.error);return;}createdProofObjectKey=null;closeModal('proofServiceModal');render();showToast(r.completedByThisProof?'服務證明已保存，所有完成條件已滿足，行程已完成':'服務證明已保存於行程歷史');}catch(e){if(createdProofObjectKey)await Trip.deleteProofBlob(createdProofObjectKey);showToast(e.message||'服務證明儲存失敗');}finally{pendingProofPhoto=null;btn.disabled=false;}}
async function refreshTripEta(tripId){const btn=$('refreshTripEtaBtn');if(btn)btn.disabled=true;try{const p=await geolocationOnce(),r=await Trip.refreshNavigation(tripId,{lat:p.lat,lng:p.lng,accuracyMeters:p.accuracyMeters,speedMps:p.speedMps,heading:p.heading,at:p.capturedAt},Identity.currentUser()?.id);if(!r.ok){showToast(r.error);return;}render();const n=r.navigation;showToast(n?.deviationLevel==='critical'?`偵測到嚴重偏離：約 ${n.deviationKm} km`:n?.deviationLevel==='warning'?`可能偏離路線：約 ${n.deviationKm} km`:`預估抵達時間已更新${n?.source==='schedule'?'（缺少座標，使用排程）':''}`);}catch(e){showToast(e.message||'定位更新失敗');}finally{if(btn)btn.disabled=false;}}

let currentProofPhotoObjectUrl=null;
async function openProofPhoto(tripId,proofId){const trip=Trip.get(tripId);if(!trip){showToast('找不到行程');return;}const proof=Trip.serviceProofs(trip).find(p=>p.id===proofId);if(!proof?.photo){showToast('此 Proof 沒有照片');return;}if(currentProofPhotoObjectUrl){try{URL.revokeObjectURL(currentProofPhotoObjectUrl);}catch(e){}currentProofPhotoObjectUrl=null;}const r=await Trip.proofPhoto(trip,proofId);if(!r.ok){showToast(r.error);return;}if(r.revoke)currentProofPhotoObjectUrl=r.url;$('proofPhotoImage').src=r.url;$('proofPhotoMeta').textContent=`${proof.receiverName||'確認人'}・${formatDateTime(proof.capturedAt)}・${r.metadata?.name||'proof.jpg'}${r.metadata?.size?`・${Math.round(r.metadata.size/1024)} KB`:''}`;openModal('proofPhotoModal');}
const TRIP_UI_POLICY=Object.freeze(Trip.uiPolicy());
const tripHistoryUiState={tripId:null,eventPage:1,proofPage:1,pageSize:TRIP_UI_POLICY.eventUiPageSize,proofPageSize:TRIP_UI_POLICY.proofUiPageSize,query:''};
let tripHistorySearchTimer=null;
function tripHistorySearchHaystack(event){
  const actor=store.state.users.find(u=>u.id===event.actorUserId);
  return [event.eventType,tripEventLabel(event),tripEventDetail(event),actor?.name,event.stepId,event.reason,JSON.stringify(event.metadata||{})].filter(Boolean).join(' ').toLowerCase();
}
function renderTripHistoryModalContent(){
  const trip=Trip.get(tripHistoryUiState.tripId);if(!trip)return;
  const allRows=Trip.eventHistory(trip.id,{includeCorrected:true}),query=String(tripHistoryUiState.query||'').trim().toLowerCase();
  const rows=query?allRows.filter(e=>tripHistorySearchHaystack(e).includes(query)):allRows;
  const correctedTargets=new Set(allRows.filter(e=>e.isCorrection).flatMap(e=>e.targetEventIds||[]));
  const pageSize=Math.max(10,Number(tripHistoryUiState.pageSize)||TRIP_UI_POLICY.eventUiPageSize),pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  tripHistoryUiState.eventPage=Math.min(Math.max(1,tripHistoryUiState.eventPage),pageCount);
  const newest=rows.slice().reverse(),pageRows=newest.slice((tripHistoryUiState.eventPage-1)*pageSize,tripHistoryUiState.eventPage*pageSize);
  const snap=Trip.activeExecutionSnapshot(trip),metrics=Trip.actualMetrics(trip),snapshotCount=Trip.executionSnapshots(trip).length,allProofs=Trip.serviceProofs(trip),distanceText=metrics?.distanceSource==='unavailable'?'尚未回寫 定位／里程表實績':`空車 ${metrics?.actualEmptyKm??'—'} km・載客 ${metrics?.actualLoadedKm??'—'} km`;
  const filteredProofs=query?allProofs.filter(p=>[p.receiverName,p.receiverRole,p.note,p.stepId,p.capturedAt].filter(Boolean).join(' ').toLowerCase().includes(query)):allProofs;
  const proofPageSize=Math.max(1,Number(tripHistoryUiState.proofPageSize)||10),proofPageCount=Math.max(1,Math.ceil(filteredProofs.length/proofPageSize));
  tripHistoryUiState.proofPage=Math.min(Math.max(1,tripHistoryUiState.proofPage),proofPageCount);
  const proofRows=filteredProofs.slice().reverse().slice((tripHistoryUiState.proofPage-1)*proofPageSize,tripHistoryUiState.proofPage*proofPageSize);
  $('tripHistoryContext').textContent=`${trip.code}｜${trip.passengerSummary}｜修訂版 ${trip.revision}｜${snapshotCount} 份 Snapshot｜${allProofs.length} 份 Proof｜${allRows.length} 筆 append-only event${query?`・搜尋命中 ${rows.length} 筆`:''}`;
  const snapshotHtml=snap?`<div class="list-item"><div class="list-item-head"><div><h4>目前行程執行快照 #${snap.sequence}</h4><p>${formatDateTime(snap.capturedAt)}・來源：${escapeHTML(({snapshot:'系統快照',trip_started:'行程開始',correction:'修正',handover:'資源交接'})[snap.source]||'系統快照')}<br>預約：${escapeHTML((snap.passengers||[]).map(p=>`${p.name} 版本 ${p.bookingVersion??'—'}`).join('、')||'手動乘客')}<br>當下資源：${escapeHTML(snap.resources?.driver?.name||'—')}／${escapeHTML(snap.resources?.vehicle?.plate||'—')}<br>實際關鍵績效指標：準時率 ${metrics?.onTimeRate??'—'}${metrics?.onTimeRate!==null?'%':''}・乘客等待 ${metrics?.avgPassengerWaitMinutes??'—'} 分・司機等候 ${metrics?.avgDriverWaitMinutes??'—'} 分・實際行程 ${metrics?.actualDurationMinutes??'—'} 分<br>里程：${escapeHTML(distanceText)}</p></div><span class="pill purple">不可變更</span></div></div>`:'';
  const eventHtml=`<div class="list-item"><div class="list-item-head"><div><h4>行程事件</h4><p>${query?`搜尋結果 ${rows.length} 筆`:`共 ${allRows.length} 筆`}・目前顯示 ${pageRows.length} 筆</p></div><span class="pill blue">頁 ${tripHistoryUiState.eventPage}/${pageCount}</span></div></div>`+(pageRows.map(e=>{const actor=store.state.users.find(u=>u.id===e.actorUserId),corrected=correctedTargets.has(e.id);return `<div class="list-item ${corrected?'issue-card resolved':''}"><div class="list-item-head"><div><h4>${escapeHTML(tripEventLabel(e))}</h4><p>#${e.sequence}・${formatDateTime(e.at)}・操作者：${escapeHTML(actor?.name||'系統')}<br>${escapeHTML(tripEventDetail(e))}${e.stepId?`<br>Stop：${escapeHTML(e.stepId)}`:''}</p></div><span class="pill ${e.isCorrection?'purple':corrected?'gray':'blue'}">${e.isCorrection?'Correction':corrected?'已被修正':'有效'}</span></div></div>`;}).join('')||'<div class="empty">沒有符合條件的行程事件</div>');
  const proofHtml=allProofs.length?`<div class="list-item"><div class="list-item-head"><div><h4>服務證明</h4><div class="list">${proofRows.map(p=>`<div><p>#${p.sequence} ${escapeHTML(p.receiverName)}（${escapeHTML(({passenger:'乘客本人',family:'家屬',care_staff:'機構／照護人員',medical_staff:'醫療院所人員',other:'其他'})[p.receiverRole]||'其他')}）・${formatDateTime(p.capturedAt)}・<span class="pill ${p.status==='superseded'?'gray':'green'}">${p.status==='superseded'?'已被修正':'有效'}</span>${p.supersededAt?`・修正 ${formatDateTime(p.supersededAt)}`:''}${p.gps?`・定位 ${Number(p.gps.lat).toFixed(5)}, ${Number(p.gps.lng).toFixed(5)}`:''}</p>${p.photo?`<button class="btn outline sm proof-photo-view-btn" data-trip="${trip.id}" data-proof="${p.id}" type="button">查看照片</button>`:''}</div>`).join('')||'<div class="small muted">此搜尋條件沒有服務證明</div>'}</div>${allProofs.some(p=>p.photo)?`<div class="small muted" style="margin-top:6px">照片使用二進位物件／物件參照儲存；仍被行程引用且尚未遠端備份的本機二進位物件不會被保留政策自動刪除。</div>`:''}</div><span class="pill green">append-only</span></div></div>`:'';
  $('tripHistoryList').innerHTML=snapshotHtml+proofHtml+eventHtml;
  $('tripHistoryPrevBtn').disabled=tripHistoryUiState.eventPage<=1;$('tripHistoryNextBtn').disabled=tripHistoryUiState.eventPage>=pageCount;$('tripHistoryPageInfo').textContent=`事件 ${tripHistoryUiState.eventPage} / ${pageCount}・${rows.length} 筆`;
  const proofPager=$('tripHistoryProofPager');if(proofPager){proofPager.style.display=filteredProofs.length>proofPageSize?'flex':'none';$('tripProofPrevBtn').disabled=tripHistoryUiState.proofPage<=1;$('tripProofNextBtn').disabled=tripHistoryUiState.proofPage>=proofPageCount;$('tripProofPageInfo').textContent=`服務證明 ${tripHistoryUiState.proofPage} / ${proofPageCount}・${filteredProofs.length} 份`;}
  document.querySelectorAll('#tripHistoryModal .proof-photo-view-btn').forEach(btn=>btn.addEventListener('click',()=>openProofPhoto(btn.dataset.trip,btn.dataset.proof)));
}
function openTripHistory(tripId){
  const trip=Trip.get(tripId);if(!trip){showToast('找不到行程');return;}
  tripHistoryUiState.tripId=tripId;tripHistoryUiState.eventPage=1;tripHistoryUiState.proofPage=1;tripHistoryUiState.query='';tripHistoryUiState.pageSize=Number($('tripHistoryPageSize')?.value)||TRIP_UI_POLICY.eventUiPageSize;
  if($('tripHistorySearch'))$('tripHistorySearch').value='';
  renderTripHistoryModalContent();
  openModal('tripHistoryModal');
}
function openRevokeMembership(membershipId){
  const m=store.state.memberships.find(x=>x.id===membershipId),u=m?store.state.users.find(x=>x.id===m.userId):null;if(!m||!u){showToast('找不到成員');return;}
  const driverTrips=m.role==='driver'?Organization.incompleteTripsForDriverUser(m.userId,m.organizationId):[];
  pendingRevokeMembershipId=membershipId;
  $('revokeMembershipText').textContent=driverTrips.length
    ?`${u.name} 仍有 ${driverTrips.length} 筆未完成 Trip，請先由調度員／負責人改派後才能撤銷工作帳號。`
    :`確定撤銷 ${u.name} 在「${Organization.get(m.organizationId)?.name||'目前公司'}」的工作帳號嗎？`;
  $('revokeMembershipReasonInput').value='';$('revokeMembershipTokenInput').value='';$('revokeMembershipTokenHint').textContent=`請輸入成員姓名「${u.name}」完成確認。`;$('confirmRevokeMembershipBtn').disabled=driverTrips.length>0;
  openModal('revokeMembershipModal');
}
function confirmRevokeMembership(){
  if(!pendingRevokeMembershipId)return;const m=store.state.memberships.find(x=>x.id===pendingRevokeMembershipId),u=m?store.state.users.find(x=>x.id===m.userId):null,reason=$('revokeMembershipReasonInput').value.trim(),token=$('revokeMembershipTokenInput').value.trim();if(!reason){showToast('請先輸入撤銷原因');$('revokeMembershipReasonInput').focus();return;}if(token!==String(u?.name||'').trim()){showToast('請輸入正確成員姓名以確認');$('revokeMembershipTokenInput').focus();return;}const result=Identity.setMembershipStatus(pendingRevokeMembershipId,'revoked');if(!result.ok){showToast(result.error);return;}Audit.log('identity.membership_revoke_confirmed',`撤銷公司工作帳號二次確認：${u?.name||''}`,{actorUserId:Identity.currentUser()?.id,membershipId:pendingRevokeMembershipId,reason});pendingRevokeMembershipId=null;closeModal('revokeMembershipModal');applyIdentityContext();renderNav();render();showToast('公司工作帳號已撤銷');
}
function saveMemberProfile(){
  const membershipId=$('editMemberMembershipIdInput').value,m=store.state.memberships.find(x=>x.id===membershipId);
  const result=Identity.updateMemberProfile(membershipId,{name:$('editMemberNameInput').value,phone:$('editMemberPhoneInput').value});
  if(!result.ok){showToast(result.error);return;}
  if(m&&m.organizationId!==APP_CONFIG.requesterOrganizationId){
    const requesterResult=Identity.setRequesterIdentity(m.userId,!!$('editMemberRequesterInput').checked);
    if(!requesterResult.ok){showToast(requesterResult.error);return;}
  }
  closeModal('editMemberModal');render();showToast('成員資料與需求者身分已更新');
}
function openSystemReport(){ if(!Identity.canAny(['system_report.create','platform.report.manage'])){showToast('你沒有問題回報權限');return;} $('systemReportCategory').value='介面／操作';$('systemReportTitle').value='';$('systemReportDetail').value='';openModal('systemReportModal'); }
function saveSystemReport(){ const result=SystemReport.create({organizationId:orgId(),userId:Identity.currentUser()?.id,role:role(),category:$('systemReportCategory').value,title:$('systemReportTitle').value,detail:$('systemReportDetail').value});if(!result.ok){showToast(result.error);return;}closeModal('systemReportModal');if(currentView==='platform-reports')render();showToast('問題已送給平台超級管理者'); }

function requesterWizardValidateStep(step){
  if(step===2){
    const pickup=$('rqPickup')?.value.trim(),destination=$('rqDestination')?.value.trim();
    if(!pickup){showToast('請先填寫上車地址');$('rqPickup')?.focus();return false;}
    if(!destination){showToast('請先填寫目的地');$('rqDestination')?.focus();return false;}
  }
  if(step===3){
    const date=$('rqDate')?.value,time=$('rqTime')?.value;
    if(!date||!time){showToast('請先選擇去程日期與時間');return false;}
    if($('rqTripType')?.value==='來回'&&(!$('rqReturnDate')?.value||!$('rqReturnTime')?.value)){showToast('來回行程請填寫回程日期與時間');return false;}
  }
  return true;
}
function refreshRequesterWizardReview(){
  const route=$('wizardReviewRoute'),time=$('wizardReviewTime');
  if(route)route.textContent=`${$('rqPickup')?.value.trim()||'尚未填上車地址'} → ${$('rqDestination')?.value.trim()||'尚未填目的地'}`;
  if(time){const type=$('rqTripType')?.value||'單程',out=`${$('rqDate')?.value||'—'} ${$('rqTime')?.value||'—'}`,ret=type==='來回'?`；回程 ${$('rqReturnDate')?.value||'—'} ${$('rqReturnTime')?.value||'—'}`:'';time.textContent=`${out}・${type}${ret}`;}
}
function goRequesterWizardStep(next){
  const target=Math.max(1,Math.min(4,Number(next)||1));
  if(target>requesterWizardStep&& !requesterWizardValidateStep(requesterWizardStep))return;
  requesterWizardStep=target;
  if(!editingRequesterBookingId)saveRequesterDraftFromDom({markDirty:true});
  document.querySelectorAll('[data-wizard-panel]').forEach(panel=>panel.classList.toggle('active',Number(panel.dataset.wizardPanel)===target));
  document.querySelectorAll('[data-wizard-go]').forEach(btn=>{const n=Number(btn.dataset.wizardGo);btn.classList.toggle('active',n===target);btn.classList.toggle('done',n<target);btn.disabled=n>target+1;btn.setAttribute('aria-disabled',btn.disabled?'true':'false');const num=btn.querySelector('.num');if(num)num.textContent=n<target?'✓':String(n);});
  if(target===4)refreshRequesterWizardReview();
  document.querySelector('.booking-wizard')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function bindRequesterWizardEvents(){
  document.querySelectorAll('.wizard-next-btn').forEach(btn=>btn.addEventListener('click',()=>goRequesterWizardStep(btn.dataset.next)));
  document.querySelectorAll('.wizard-prev-btn').forEach(btn=>btn.addEventListener('click',()=>goRequesterWizardStep(btn.dataset.prev)));
  document.querySelectorAll('[data-wizard-go]').forEach(btn=>btn.addEventListener('click',()=>{const n=Number(btn.dataset.wizardGo);if(n<=requesterWizardStep||n===requesterWizardStep+1)goRequesterWizardStep(n);}));
  refreshRequesterWizardReview();
  bindRequesterDraftAutosave();
}
if(typeof window!=='undefined')window.addEventListener('beforeunload',e=>{if(currentView!=='requester-new'||editingRequesterBookingId||!requesterHasUnsavedDraftOnPage())return;saveRequesterDraftFromDom({markDirty:false});e.preventDefault();e.returnValue='';});

function enhanceStaticAccessibility(){
  document.querySelectorAll('.icon-btn[data-close]').forEach(btn=>{if(!btn.getAttribute('aria-label'))btn.setAttribute('aria-label','關閉視窗');});
  document.querySelectorAll('button').forEach(btn=>{if(!btn.getAttribute('aria-label')&&!btn.textContent.trim())btn.setAttribute('aria-label','操作按鈕');});
  document.querySelectorAll('.modal').forEach(modal=>{modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');});
}
function bindViewEvents(){
  $('benefitQuickRecipient')?.addEventListener('change',e=>{benefitQuickUiState.recipientId=e.target.value||'';benefitQuickUiState.result=null;benefitQuickUiState.cmsLevel='';render();});
  $('benefitQuickCms')?.addEventListener('input',e=>{benefitQuickUiState.cmsLevel=e.target.value||'';});
  $('benefitQuickIdentity')?.addEventListener('change',e=>{benefitQuickUiState.identityCategory=e.target.value||'general';});
  $('benefitQuickRunBtn')?.addEventListener('click',async e=>{
    if(benefitQuickUiState.refreshing)return;
    benefitQuickUiState.cmsLevel=$('benefitQuickCms')?.value||benefitQuickUiState.cmsLevel||'';
    benefitQuickUiState.identityCategory=$('benefitQuickIdentity')?.value||benefitQuickUiState.identityCategory||'general';
    e.currentTarget.disabled=true;e.currentTarget.textContent='更新官方資訊中…';
    const refresh=await BenefitLatestInfo.refresh({manual:true});
    benefitQuickUiState.result=BenefitLatestInfo.estimate({recipientId:benefitQuickUiState.recipientId,cmsLevel:benefitQuickUiState.cmsLevel,identityCategory:benefitQuickUiState.identityCategory});
    render();
    if(!refresh.ok)showToast('官方來源暫時無法連線，已使用最近成功資料試算');
    else showToast('已更新官方長照資訊並完成試算');
  });
  $('openBenefitRulesetBtn')?.addEventListener('click',()=>openBenefitRulesetEditor());
  $('openBenefitAssessmentBtn')?.addEventListener('click',openBenefitAssessment);
  $('openBenefitAuthorizationBtn')?.addEventListener('click',openBenefitAuthorization);
  $('openBenefitImportBtn')?.addEventListener('click',openBenefitImport);
  $('openBenefitDiffBtn')?.addEventListener('click',openBenefitDiff);
  $('runBenefitRegressionBtn')?.addEventListener('click',runBenefitRegression);
  document.querySelectorAll('.benefit-adjust-btn').forEach(btn=>btn.addEventListener('click',()=>openBenefitAdjustment(btn.dataset.auth)));
  document.querySelectorAll('.benefit-revoke-auth-btn').forEach(btn=>btn.addEventListener('click',()=>revokeBenefitAuthorization(btn.dataset.auth)));
  document.querySelectorAll('.benefit-edit-ruleset-btn').forEach(btn=>btn.addEventListener('click',()=>openBenefitRulesetEditor(btn.dataset.rule)));
  document.querySelectorAll('.benefit-publish-ruleset-btn').forEach(btn=>btn.addEventListener('click',()=>publishBenefitRuleset(btn.dataset.rule)));
  document.querySelectorAll('.benefit-retire-ruleset-btn').forEach(btn=>btn.addEventListener('click',()=>retireBenefitRuleset(btn.dataset.rule)));
  $('openAddCareRecipientBtn')?.addEventListener('click',()=>openCareRecipientEditor(''));
  document.querySelectorAll('.care-recipient-detail-btn').forEach(btn=>btn.addEventListener('click',()=>openCareRecipientDetail(btn.dataset.recipient)));
  document.querySelectorAll('.care-recipient-edit-btn').forEach(btn=>btn.addEventListener('click',()=>openCareRecipientEditor(btn.dataset.recipient)));
  document.querySelectorAll('.care-recipient-archive-btn').forEach(btn=>btn.addEventListener('click',()=>{if(!confirm('確定封存這位服務對象？歷史資料會保留，但不能再用於新預約。'))return;const result=CareRecipient.archive(btn.dataset.recipient,{actorUserId:Identity.currentUser()?.id});if(!result.ok){showToast(result.error);return;}render();showToast('服務對象已封存');}));
  document.querySelectorAll('.care-recipient-restore-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=CareRecipient.restore(btn.dataset.recipient,{actorUserId:Identity.currentUser()?.id});if(!result.ok){showToast(result.error);return;}render();showToast('服務對象已恢復');}));
  $('editRequesterSelfProfileBtn')?.addEventListener('click',e=>openCareRecipientEditor(e.currentTarget.dataset.recipient));
  $('demandMarketDateInput')?.addEventListener('change',e=>{demandMarketDate=e.target.value||'';render();});
  $('clearDemandDateBtn')?.addEventListener('click',()=>{demandMarketDate='';render();});
  document.querySelectorAll('.demand-claim-btn').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!Identity.can('booking.market.claim')){showToast('目前身分不能接案');return;}
    if(btn.disabled)return;
    btn.disabled=true;
    const organizationId=Identity.membershipOrganizationId(),expectedVersion=Number(btn.dataset.version);
    const result=await Booking.claim(btn.dataset.booking,organizationId,Identity.currentUser()?.id,expectedVersion);
    // 成功或失敗都重新載入：失敗時需求可能已被別人接走，畫面要反映後端現況。
    const cloudRefresh=await AppStateDatabase.loadAll({silent:true});
    if(!result.ok){render();showToast(result.error);return;}
    if(!cloudRefresh?.ok){render();showToast(`接案已完成，但完整履約資訊重新載入失敗：${cloudRefresh?.error||'請重新整理'}`);return;}
    render();showToast(`已由 ${result.organization.name} 接案，完整履約資訊已解鎖`);
  }));
  $('requesterResumeDraftBtn')?.addEventListener('click',()=>{const d=loadRequesterDraft();editingRequesterBookingId='';requesterWizardStep=Math.max(1,Math.min(4,Number(d?.step)||1));requesterDraftDirty=false;currentView='requester-new';renderNav();render();});
  $('requesterDiscardDraftHomeBtn')?.addEventListener('click',()=>{if(!confirm('確定捨棄這筆尚未送出的預約草稿？'))return;clearRequesterDraft();render();showToast('預約草稿已捨棄');});
  $('requesterDiscardDraftBtn')?.addEventListener('click',()=>{if(!confirm('確定捨棄這筆尚未送出的預約草稿？'))return;clearRequesterDraft();requesterWizardStep=1;render();showToast('預約草稿已捨棄');});
  $('requesterQuickBookBtn')?.addEventListener('click',()=>{editingRequesterBookingId='';currentView='requester-new';requesterWizardStep=1;renderNav();render();});
  $('requesterQuickBookCard')?.addEventListener('click',()=>{editingRequesterBookingId='';currentView='requester-new';requesterWizardStep=1;renderNav();render();});
  $('requesterEmptyBookBtn')?.addEventListener('click',()=>{editingRequesterBookingId='';currentView='requester-new';requesterWizardStep=1;renderNav();render();});
  $('requesterNewBookingBtn')?.addEventListener('click',()=>{editingRequesterBookingId='';currentView='requester-new';requesterWizardStep=1;renderNav();render();});
  $('requesterAllBookingsBtn')?.addEventListener('click',()=>{currentView='requester-bookings';renderNav();render();});$('requesterEmptyNewBookingBtn')?.addEventListener('click',()=>{currentView='requester-new';requesterWizardStep=1;renderNav();render();});
  $('submitRequesterBookingBtn')?.addEventListener('click',submitRequesterBooking);
  $('cancelRequesterEditBtn')?.addEventListener('click',()=>{editingRequesterBookingId='';currentView='requester-bookings';renderNav();render();});
  document.querySelectorAll('.requester-edit-booking-btn').forEach(btn=>btn.addEventListener('click',()=>{const allowed=Booking.canEditOwn(btn.dataset.booking,Identity.currentUser()?.id);if(!allowed.ok){showToast(allowed.error);render();return;}editingRequesterBookingId=btn.dataset.booking;currentView='requester-new';requesterWizardStep=1;renderNav();render();}));
  $('rqTripType')?.addEventListener('change',e=>{$('rqReturnFields')?.classList.toggle('hidden',e.currentTarget.value!=='來回');});
  $('rqDate')?.addEventListener('change',e=>{const r=$('rqReturnDate');if(r&&$('rqTripType')?.value==='來回'&&(!r.value||r.value<e.currentTarget.value))r.value=e.currentTarget.value;});
  document.querySelectorAll('.requester-cancel-booking-btn').forEach(btn=>btn.addEventListener('click',()=>{
    if(!Identity.can('booking.cancel_own')){showToast('你沒有取消預約權限');return;}
    const allowed=Booking.canCancelOwn(btn.dataset.booking,Identity.currentUser()?.id);if(!allowed.ok){showToast(allowed.error);render();return;}
    openBookingAction('cancel',btn.dataset.booking);
  }));
  document.querySelectorAll('.booking-history-btn').forEach(btn=>btn.addEventListener('click',()=>openBookingHistory(btn.dataset.booking)));
  document.querySelectorAll('.trip-history-btn').forEach(btn=>btn.addEventListener('click',()=>openTripHistory(btn.dataset.trip)));
  document.querySelectorAll('.proof-service-btn').forEach(btn=>btn.addEventListener('click',()=>openProofService(btn.dataset.trip)));
  $('refreshTripEtaBtn')?.addEventListener('click',e=>refreshTripEta(e.currentTarget.dataset.trip));
  document.querySelectorAll('.driver-self-status-btn').forEach(btn=>btn.addEventListener('click',()=>{ const d=currentDriver(); if(!d){showToast('找不到司機資料');return;} const result=Organization.setDriverDuty(d.id,btn.dataset.status,Identity.currentUser()?.id); if(!result.ok){showToast(result.error);return;} render(); showToast(`司機狀態已更新為 ${Organization.driverStatusLabel(result.driver?.status)}`); }));
  document.querySelectorAll('.driver-manager-status-btn').forEach(btn=>btn.addEventListener('click',()=>{ const result=Organization.setDriverDuty(btn.dataset.driver,btn.dataset.status,Identity.currentUser()?.id); if(!result.ok){showToast(result.error);return;} render(); showToast(`司機狀態已更新為 ${Organization.driverStatusLabel(result.driver?.status)}`); }));
  $('navBtn')?.addEventListener('click',()=>{ const t=Trip.nextForDriver(currentDriver()?.id,driverOperationalDate()),s=Trip.currentStep(t); if(!s)return; currentDestination=s.destination; $('mapDestinationText').textContent=`目的地：${currentDestination}`; openModal('mapModal'); });
  $('contactBtn')?.addEventListener('click',()=>{ const s=Trip.currentStep(Trip.nextForDriver(currentDriver()?.id,driverOperationalDate())),contacts=s?.contacts||[]; if(!contacts.length){showToast('沒有聯絡人');return;} if(contacts.length===1){{const href=telHref(contacts[0].phone);if(!href){showToast('聯絡人電話格式不正確');return;}location.href=href;}return;} $('contactOptions').innerHTML=contacts.map(c=>(telHref(c.phone)?`<a class="btn primary" href="${escapeHTML(telHref(c.phone))}">${escapeHTML(c.name)}｜${escapeHTML(formatPhone(c.phone))}</a>`:`<span class="btn secondary" aria-disabled="true">${escapeHTML(c.name)}｜電話格式不正確</span>`)).join('');openModal('contactModal'); });
  $('completeStepBtn')?.addEventListener('click',async e=>{if(!Identity.can('trip.execute')){showToast('你沒有行程執行權限');return;}const btn=e.currentTarget,tripId=btn.dataset.trip,stepId=btn.dataset.step,expectedRevision=Number(btn.dataset.revision),stepName=Trip.currentStep(Trip.get(tripId))?.name||'目前步驟';btn.disabled=true;const idempotencyKey=Trip.mutationKey('complete_step',tripId,stepId,expectedRevision),r=await Trip.withMutationLock(tripId,()=>Trip.completeCurrentStep(tripId,Identity.currentUser().id,{expectedRevision,expectedStepId:stepId,idempotencyKey}));if(!r.ok){showToast(r.error);render();return;}if(r.duplicate){showToast('已處理相同操作，重複點擊已忽略');render();return;}render();showToast(r.final?'完整趟次 +1':r.pendingCompletion?'停靠點已完成，請補齊服務證明／重大異常後才會完成整趟':r.timing?.label||'已完成');offerCompletedStepUndo(tripId,stepId,stepName);});
  const handleTripUndo=async btn=>{const tripId=btn.dataset.trip,expectedRevision=Number(btn.dataset.revision),rows=Trip.forDriver(currentDriver()?.id,driverOperationalDate()),t=Trip.get(tripId)||rows.find(x=>x.id===tripId)||[...rows].reverse().find(x=>x.status!=='cancelled'&&x.steps?.some(s=>s.actualAt));if(!t){showToast('沒有可返回步驟');return;}const index=Math.max(0,Math.min(t.currentStepIndex-1,t.steps.length-1)),undoStep=t.steps[index];if(!undoStep){showToast('沒有可返回步驟');return;}btn.disabled=true;const idempotencyKey=Trip.mutationKey('undo_step',t.id,undoStep.id,expectedRevision),r=await Trip.withMutationLock(t.id,()=>Trip.undoLastStep(t.id,Identity.currentUser().id,{expectedRevision,expectedStepId:undoStep.id,idempotencyKey}));if(!r.ok){showToast(r.error);render();return;}if(r.duplicate){showToast('相同返回操作已處理，重複操作已忽略');render();return;}render();showToast(r.supersededProofIds?.length?`已返回上一步；${r.supersededProofIds.length} 份舊服務證明已標記為已被修正，重新送達後需建立新服務證明`:'已返回上一步；乘客狀態同步回復，原始事件仍保留於行程歷史');};
  $('undoBtn')?.addEventListener('click',e=>handleTripUndo(e.currentTarget));
  document.querySelectorAll('.completed-trip-correction-btn').forEach(btn=>btn.addEventListener('click',()=>handleTripUndo(btn)));
  $('issueBtn')?.addEventListener('click',()=>{ if(!Identity.can('issue.create')){showToast('你沒有異常回報權限');return;} $('issueNote').value='';$('issueCustomType').value='';openModal('issueModal'); });
  document.querySelectorAll('.map-trip-btn').forEach(btn=>btn.addEventListener('click',()=>{ const t=Trip.get(btn.dataset.trip),s=Trip.currentStep(t)||t.steps[t.steps.length-1];currentDestination=s.destination;$('mapDestinationText').textContent=`目的地：${currentDestination}`;openModal('mapModal'); }));
  $('syncCustomerBookingsBtn')?.addEventListener('click',syncBookings);
  $('optimizerObjectiveProfile')?.addEventListener('change',e=>{optimizerObjectiveProfile=e.target.value||'balanced';});
  $('runFleetOptimizerBtn')?.addEventListener('click',async e=>{
    if(!Identity.can('booking.schedule')){showToast('你沒有預約排車權限');return;}
    optimizerObjectiveProfile=$('optimizerObjectiveProfile')?.value||optimizerObjectiveProfile||'balanced';
    const btn=e.currentTarget,oldText=btn.textContent;btn.disabled=true;btn.setAttribute('aria-busy','true');btn.textContent='計算排車建議中…';
    try{
      const plan=await Dispatch.optimizeWithRouting(selectedTripDate,orgId(),Identity.currentUser()?.id,optimizerObjectiveProfile);
      if(!plan){btn.disabled=false;btn.removeAttribute('aria-busy');btn.textContent=oldText;showToast('你沒有查看／最佳化承接預約的權限');return;}
      render();showToast(`已產生 ${plan.objectiveLabel||'最佳化'} 調度方案，尚未建立行程`);
    }catch(error){btn.disabled=false;btn.removeAttribute('aria-busy');btn.textContent=oldText;showToast(`排車計算失敗：${error?.message||'請稍後再試'}`);}
  });
  $('repairAffectedTripsBtn')?.addEventListener('click',()=>{if(!Identity.can('booking.schedule')){showToast('你沒有局部重新派車權限');return;}const r=Dispatch.repairAffectedTrips({date:selectedTripDate,organizationId:orgId(),actorUserId:Identity.currentUser()?.id,objectiveName:optimizerObjectiveProfile,reason:'系統偵測到司機／車輛資源失效',changeType:'resource_change'});render();showToast(r.ok?(r.changed?`已局部重排 ${r.changed} 趟行程`:(r.message||'沒有需要重排的行程')):r.error);});
  $('applyOptimizationBtn')?.addEventListener('click',e=>{if(!Identity.can('booking.schedule')){showToast('你沒有預約排車權限');return;}const r=Dispatch.confirm(e.currentTarget.dataset.plan,Identity.currentUser()?.id);if(!r.ok){showToast(r.error);return;}const created=Trip.createFromDispatch(r.plan,Identity.currentUser()?.id);render();if(created?.ok===false||created?.error){showToast(created.error||'調度方案套用失敗，請重新最佳化');return;}showToast(`已建立 ${created.length} 趟行程`);});
  document.querySelectorAll('.booking-create-trip-btn').forEach(btn=>btn.addEventListener('click',()=>openBookingAsTrip(btn.dataset.booking)));
  document.querySelectorAll('.booking-release-btn').forEach(btn=>btn.addEventListener('click',()=>openBookingAction('release',btn.dataset.booking)));
  document.querySelectorAll('.booking-reject-btn').forEach(btn=>btn.addEventListener('click',()=>openBookingAction('reject',btn.dataset.booking)));
  $('operationDateInput')?.addEventListener('change',e=>{selectedTripDate=e.target.value||preferredOperationalDate();selectedCalendarMonth=selectedTripDate.slice(0,7);optimizerDate=selectedTripDate;kpiDate=selectedTripDate;render();});
  $('driverOperationDateInput')?.addEventListener('change',e=>{selectedTripDate=e.target.value||preferredOperationalDate();kpiDate=selectedTripDate;render();});
  $('goTripsBtn')?.addEventListener('click',()=>{currentView='dispatch-trips';renderNav();render();});
  $('tripDateInput')?.addEventListener('change',e=>{selectedTripDate=e.target.value||preferredOperationalDate();selectedCalendarMonth=selectedTripDate.slice(0,7);optimizerDate=selectedTripDate;kpiDate=selectedTripDate;render();});
  $('prevCalendarMonth')?.addEventListener('click',()=>{selectedCalendarMonth=shiftMonth(selectedCalendarMonth,-1);render();});
  $('nextCalendarMonth')?.addEventListener('click',()=>{selectedCalendarMonth=shiftMonth(selectedCalendarMonth,1);render();});
  document.querySelectorAll('.calendar-day').forEach(btn=>btn.addEventListener('click',()=>{selectedTripDate=btn.dataset.date;selectedCalendarMonth=selectedTripDate.slice(0,7);optimizerDate=selectedTripDate;kpiDate=selectedTripDate;render();}));
  document.querySelectorAll('.dispatch-filter-chip').forEach(btn=>btn.addEventListener('click',()=>{dispatchTripFilters.quick=btn.dataset.tripFilter||'all';render();}));
  $('tripDriverFilter')?.addEventListener('change',e=>{dispatchTripFilters.driver=e.target.value||'all';render();});
  $('tripVehicleFilter')?.addEventListener('change',e=>{dispatchTripFilters.vehicle=e.target.value||'all';render();});
  $('clearTripFiltersBtn')?.addEventListener('click',()=>{dispatchTripFilters={quick:'all',driver:'all',vehicle:'all',query:''};render();});
  $('tripSearch')?.addEventListener('input',e=>{dispatchTripFilters.query=String(e.target.value||'');const rows=Trip.list(orgId(),selectedTripDate).sort((a,b)=>new Date(a.steps[0].scheduledAt)-new Date(b.steps[0].scheduledAt)),filtered=applyDispatchTripFilters(rows),tbody=$('dispatchTripRows'),summary=$('dispatchFilterSummary');if(tbody)tbody.innerHTML=renderDispatchTripRows(filtered);if(summary)summary.textContent=`顯示 ${filtered.length} / ${rows.length} 筆行程`;});
  $('openCreateTripBtn')?.addEventListener('click',openManualTrip);
  document.querySelectorAll('.assign-btn').forEach(btn=>btn.addEventListener('click',()=>openAssign(btn.dataset.trip)));
  document.querySelectorAll('.formal-trip-correction-btn').forEach(btn=>btn.addEventListener('click',()=>openFormalTripCorrection(btn.dataset.trip)));
  document.querySelectorAll('.acknowledge-issue-btn').forEach(btn=>btn.addEventListener('click',()=>{const r=Trip.acknowledgeIssue(btn.dataset.id,Identity.currentUser().id);render();showToast(r.ok?'已接手異常':r.error);}));
  document.querySelectorAll('.handling-issue-btn').forEach(btn=>btn.addEventListener('click',()=>{const r=Trip.startIssueHandling(btn.dataset.id,Identity.currentUser().id);render();showToast(r.ok?'異常已進入處理中':r.error);}));
  document.querySelectorAll('.interrupt-trip-btn').forEach(btn=>btn.addEventListener('click',()=>interruptTripFromIssue(btn.dataset.trip,btn.dataset.issue,Number(btn.dataset.revision))));
  document.querySelectorAll('.handover-trip-btn').forEach(btn=>btn.addEventListener('click',()=>openHandoverTrip(btn.dataset.trip,btn.dataset.issue||'')));
  document.querySelectorAll('.resume-trip-btn').forEach(btn=>btn.addEventListener('click',()=>resumeInterruptedTrip(btn.dataset.trip,btn.dataset.issue||'')));
  document.querySelectorAll('.abort-trip-btn').forEach(btn=>btn.addEventListener('click',()=>abortInterruptedTrip(btn.dataset.trip,btn.dataset.issue||'')));
  document.querySelectorAll('.resolve-trip-issue-btn').forEach(btn=>btn.addEventListener('click',()=>openResolveTripIssue(btn.dataset.id)));
  $('kpiDateInput')?.addEventListener('change',e=>{kpiDate=e.target.value||preferredOperationalDate();render();});
  document.querySelector('.account-logout-btn')?.addEventListener('click',logout);
  $('saveSuperAdminAccountBtn')?.addEventListener('click',updateCurrentSuperAdminAccount);
  $('profilePhotoInput')?.addEventListener('change',e=>saveProfilePhoto(e.target.files?.[0]));
  $('removeProfilePhotoBtn')?.addEventListener('click',removeProfilePhoto);
  document.querySelectorAll('.care-recipient-merge-btn').forEach(btn=>btn.addEventListener('click',()=>{
    if(!Identity.isSuperAdmin()){showToast('只有 平台超級管理者可以執行服務對象合併');return;}
    const primary=CareRecipient.get(btn.dataset.primary),duplicate=CareRecipient.get(btn.dataset.duplicate);
    if(!primary||!duplicate){showToast('找不到合併資料');return;}
    if(!confirm(`確認「${CareRecipient.displayName(primary)}」與「${CareRecipient.displayName(duplicate)}」是同一位服務對象？合併後所有 預約／通知／補助關聯都會改指向保留主檔。`))return;
    const result=CareRecipient.merge(primary.id,duplicate.id,{actorUserId:Identity.currentUser()?.id,reason:'平台超級管理者於資料治理頁人工確認'});
    render();showToast(result.ok?`已合併，重新指向 ${result.reassigned.bookings} 筆預約`:result.error);
  }));
  $('openAddStaffBtn')?.addEventListener('click',openAddStaff);
  $('openAddOrganizationBtn')?.addEventListener('click',openAddOrganization);
  document.querySelectorAll('.booking-leg-org-select').forEach(select=>select.addEventListener('change',e=>{const target=e.currentTarget.value;if(!target)return;const result=Booking.assignPendingLegOrganization(e.currentTarget.dataset.booking,e.currentTarget.dataset.leg,target,Identity.currentUser()?.id);if(!result.ok){showToast(result.error);render();return;}render();showToast(`已將 ${result.leg?.label||'此行程段'} 指定給 ${Organization.get(target)?.name||'目標組織'}`);}));
  document.querySelectorAll('.platform-edit-org-btn').forEach(btn=>btn.addEventListener('click',()=>openEditOrganization(btn.dataset.org)));
  document.querySelectorAll('.platform-requester-toggle-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const enabled=btn.dataset.enabled==='true',result=Identity.setRequesterIdentity(btn.dataset.user,enabled);
    if(!result.ok){showToast(result.error);return;}
    render();
    showToast(enabled?'已新增需求者身分':'已移除需求者身分');
  }));
  document.querySelectorAll('.owner-requester-toggle-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const enabled=btn.dataset.enabled==='true',result=Identity.setRequesterIdentity(btn.dataset.user,enabled);
    if(!result.ok){showToast(result.error);return;}
    render();
    showToast(enabled?'已替公司員工新增需求者身分':'已移除該員工的需求者身分');
  }));
  document.querySelectorAll('.platform-edit-member-btn').forEach(btn=>btn.addEventListener('click',()=>openEditMember(btn.dataset.membership)));
  document.querySelectorAll('.membership-history-btn').forEach(btn=>btn.addEventListener('click',()=>openMembershipHistory(btn.dataset.membership)));
  document.querySelectorAll('.revoke-membership-btn').forEach(btn=>btn.addEventListener('click',()=>openRevokeMembership(btn.dataset.membership)));
  $('openSystemReportBtn')?.addEventListener('click',openSystemReport);
  document.querySelectorAll('.identity-switch-btn').forEach(btn=>btn.addEventListener('click',()=>switchOrganization(btn.dataset.org)));
  document.querySelectorAll('.platform-enter-org-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=Identity.switchOrganization(btn.dataset.org);if(!result.ok){showToast(result.error);return;}currentView='platform-members';applyIdentityContext();renderNav();render();showToast(`正在管理 ${result.organization?.name||'組織'} 成員`);}));
  document.querySelectorAll('.platform-org-active-btn').forEach(btn=>btn.addEventListener('click',()=>openOrganizationStatusConfirm(btn.dataset.org,btn.dataset.active==='true')));
  document.querySelectorAll('.resolve-system-report-btn').forEach(btn=>btn.addEventListener('click',()=>{const result=SystemReport.resolve(btn.dataset.id,Identity.currentUser()?.id);if(!result.ok){showToast(result.error);return;}render();showToast('問題已標記處理');}));
  document.querySelectorAll('.membership-role-select').forEach(select=>select.addEventListener('change',e=>{const result=Identity.setMembershipRole(e.currentTarget.dataset.membership,e.currentTarget.value);if(!result.ok){showToast(result.error);render();return;}render();showToast(`角色已調整為 ${ROLE_LABELS[e.currentTarget.value]||e.currentTarget.value}`);}));
  document.querySelectorAll('.membership-status-select').forEach(select=>select.addEventListener('change',e=>{
    if(!Identity.canAny(['platform.membership.manage','company.staff.manage'])){ showToast('你沒有成員管理權限'); render(); return; }
    const result=Identity.setMembershipStatus(e.currentTarget.dataset.membership,e.currentTarget.value,Identity.currentUser()?.id);
    if(!result.ok){ showToast(result.error); render(); return; }
    if(!Identity.currentUser()){
      $('appShell').classList.add('hidden'); $('loginScreen').classList.remove('hidden'); showToast('目前組織身分已失效，請重新登入'); return;
    }
    applyIdentityContext(); renderNav(); render(); showToast(`組織身分已改為 ${MEMBERSHIP_STATUS_LABELS[e.currentTarget.value]||e.currentTarget.value}`);
  }));
  $('openAddVehicleBtn')?.addEventListener('click',openAddVehicle);
  document.querySelectorAll('.edit-vehicle-btn').forEach(btn=>btn.addEventListener('click',()=>openEditVehicle(btn.dataset.vehicle)));
  document.querySelectorAll('.vehicle-lifecycle-btn').forEach(btn=>btn.addEventListener('click',()=>openVehicleLifecycle(btn.dataset.vehicle,btn.dataset.action)));
}
function updateDriverClock(){ const now=new Date(),clock=$('driverNowClock');if(clock)clock.innerHTML=`${now.toLocaleTimeString('zh-TW',{hour12:false})}<small>現在時間</small>`;const t=Trip.nextForDriver(currentDriver()?.id,driverOperationalDate()),s=Trip.currentStep(t),count=$('driverCountdown'),label=$('driverCountdownLabel');if(count&&s){const diff=new Date(s.scheduledAt)-now;count.textContent=formatDuration(diff);label.textContent=diff>=0?`距預定${PHASE_LABELS[s.type]}`:`已超過預定${PHASE_LABELS[s.type]}`;}}

$('loginBtn')?.addEventListener('click',login);$('logoutBtn')?.addEventListener('click',logout);
$('loginPhone')?.addEventListener('input',renderLoginSecurityState);$('loginPassword')?.addEventListener('keydown',e=>{if(e.key==='Enter')login();});$('loginCaptchaInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
$('refreshLoginCaptchaBtn')?.addEventListener('click',()=>{$('loginCaptchaCode').textContent=LoginSecurity.refreshCaptcha($('loginPhone').value);$('loginCaptchaInput').value='';});
$('openRegisterBtn')?.addEventListener('click',()=>{
  try{
    openRegisterRequester();
  }catch(error){
    console.error('[Identity] open register failed',error);
    showToast(`新增帳號無法開啟：${runtimeErrorMessage_(error)}`);
  }
});
$('confirmRegisterBtn')?.addEventListener('click',()=>{
  Promise.resolve(confirmRegisterRequester()).catch(error=>{
    console.error('[Identity] register submit failed',error);
    showToast(`建立帳號失敗：${runtimeErrorMessage_(error)}`);
  });
});
$('forgotPasswordBtn')?.addEventListener('click',openForgotPassword);
$('requestResetOtpBtn')?.addEventListener('click',requestResetOtp); $('confirmResetPasswordBtn')?.addEventListener('click',confirmResetPassword);
$('saveStaffBtn')?.addEventListener('click',saveStaff);
$('saveOrganizationBtn')?.addEventListener('click',saveOrganization);
$('saveOrganizationDetailsBtn')?.addEventListener('click',saveOrganizationDetails);
$('saveMemberProfileBtn')?.addEventListener('click',saveMemberProfile);
$('saveSystemReportBtn')?.addEventListener('click',saveSystemReport);
$('saveBenefitRulesetBtn')?.addEventListener('click',saveBenefitRuleset);
$('saveBenefitAssessmentBtn')?.addEventListener('click',saveBenefitAssessment);
$('saveBenefitAuthorizationBtn')?.addEventListener('click',saveBenefitAuthorization);
$('runBenefitImportBtn')?.addEventListener('click',runBenefitImport);
$('runBenefitDiffBtn')?.addEventListener('click',runBenefitDiff);
$('saveBenefitAdjustmentBtn')?.addEventListener('click',saveBenefitAdjustment);
$('benefitAssessmentRecipient')?.addEventListener('change',updateBenefitAssessmentRecipientCity);
$('organizationSwitcher')?.addEventListener('change',e=>switchOrganization(e.target.value));
$('mobileIdentityContextBtn')?.addEventListener('click',openMobileIdentityContext);$('undoSnackbarAction')?.addEventListener('click',runUndoSnackbar);
$('confirmOrganizationStatusBtn')?.addEventListener('click',applyOrganizationStatusChange);
$('confirmRevokeMembershipBtn')?.addEventListener('click',confirmRevokeMembership);
$('confirmBookingActionBtn')?.addEventListener('click',confirmBookingAction);
document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.dataset.close;closeModal(id);if(id==='proofPhotoModal'&&currentProofPhotoObjectUrl){try{URL.revokeObjectURL(currentProofPhotoObjectUrl);}catch(e){}currentProofPhotoObjectUrl=null;$('proofPhotoImage').removeAttribute('src');}}));
document.querySelectorAll('.modal').forEach(modal=>modal.addEventListener('click',e=>{if(e.target===modal)closeModal(modal.id);}));
function openNavigationUrl_(url){
  try{
    const popup=window.open(url,'_blank','noopener,noreferrer');
    if(!popup)window.location.assign(url);
  }catch(error){
    window.location.href=url;
  }
}
$('googleMapBtn')?.addEventListener('click',()=>{
  const destination=String(currentDestination||'').trim();
  if(!destination){showToast('目前沒有可導航的目的地');return;}
  openNavigationUrl_(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`);
  closeModal('mapModal');
});
$('appleMapBtn')?.addEventListener('click',()=>{
  const destination=String(currentDestination||'').trim();
  if(!destination){showToast('目前沒有可導航的目的地');return;}
  openNavigationUrl_(`https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=d`);
  closeModal('mapModal');
});
$('captureProofGpsBtn')?.addEventListener('click',captureProofGps);
$('saveProofServiceBtn')?.addEventListener('click',saveProofService);
$('tripHistorySearch')?.addEventListener('input',e=>{const value=e.target.value||'';clearTimeout(tripHistorySearchTimer);tripHistorySearchTimer=setTimeout(()=>{tripHistoryUiState.query=value;tripHistoryUiState.eventPage=1;tripHistoryUiState.proofPage=1;renderTripHistoryModalContent();},140);});
$('tripHistoryPageSize')?.addEventListener('change',e=>{tripHistoryUiState.pageSize=Number(e.target.value)||TRIP_UI_POLICY.eventUiPageSize;tripHistoryUiState.eventPage=1;renderTripHistoryModalContent();});
$('tripHistoryPrevBtn')?.addEventListener('click',()=>{tripHistoryUiState.eventPage=Math.max(1,tripHistoryUiState.eventPage-1);renderTripHistoryModalContent();});
$('tripHistoryNextBtn')?.addEventListener('click',()=>{tripHistoryUiState.eventPage+=1;renderTripHistoryModalContent();});
$('tripProofPrevBtn')?.addEventListener('click',()=>{tripHistoryUiState.proofPage=Math.max(1,tripHistoryUiState.proofPage-1);renderTripHistoryModalContent();});
$('tripProofNextBtn')?.addEventListener('click',()=>{tripHistoryUiState.proofPage+=1;renderTripHistoryModalContent();});
document.querySelectorAll('.issue-option').forEach(btn=>btn.addEventListener('click',()=>{const t=Trip.nextForDriver(currentDriver()?.id,driverOperationalDate());if(!t){showToast('此營運日沒有執行中行程');return;}const result=Trip.reportIssue({tripId:t.id,driverId:currentDriver().id,type:btn.dataset.type,note:$('issueNote').value.trim(),actorUserId:Identity.currentUser()?.id});if(!result.ok){showToast(result.error);return;}closeModal('issueModal');render();showToast('異常已送至調度');}));
$('submitCustomIssueBtn')?.addEventListener('click',()=>{const type=$('issueCustomType').value.trim(),t=Trip.nextForDriver(currentDriver()?.id,driverOperationalDate());if(!type){showToast('請輸入異常名稱');return;}if(!t){showToast('此營運日沒有執行中行程');return;}const result=Trip.reportIssue({tripId:t.id,driverId:currentDriver().id,type:`其他：${type}`,note:$('issueNote').value.trim(),actorUserId:Identity.currentUser()?.id});if(!result.ok){showToast(result.error);return;}closeModal('issueModal');render();showToast('異常已送至調度');});
$('saveTripBtn')?.addEventListener('click',saveNewTrip); $('saveAssignBtn')?.addEventListener('click',saveAssign); $('saveHandoverBtn')?.addEventListener('click',saveHandoverTrip); $('confirmFormalTripCorrectionBtn')?.addEventListener('click',confirmFormalTripCorrection); $('confirmResolveTripIssueBtn')?.addEventListener('click',confirmResolveTripIssue); $('saveVehicleBtn')?.addEventListener('click',saveVehicle); $('confirmVehicleLifecycleBtn')?.addEventListener('click',confirmVehicleLifecycle); $('saveCareRecipientBtn')?.addEventListener('click',saveCareRecipient); $('saveCareRecipientRelationBtn')?.addEventListener('click',saveCareRecipientRelation);
window.addEventListener('online',async()=>{const r=await Trip?.syncOfflineQueue?.();updateSyncUI();if(r?.synced)showToast(`網路已恢復，${r.synced} 筆離線行程操作已由同步轉接器處理（${r.mode||'備援'}）`);if(currentView==='driver-home'||currentView==='driver-trips')render();});window.addEventListener('offline',()=>{updateSyncUI();if(currentView==='driver-home'||currentView==='driver-trips')render();});


(() => {
  const previewTouchBridge=window.location.protocol==='file:'&&('ontouchstart' in window||Number(navigator.maxTouchPoints||0)>0);
  if(!previewTouchBridge)return;
  let startX=0,startY=0,startTarget=null;
  let syntheticTarget=null,syntheticAt=0;
  const interactiveSelector='button:not(:disabled),a[href],[role="button"]';
  const sameInteractive=(a,b)=>a&&b&&(a===b||a.contains(b)||b.contains(a));

  document.addEventListener('touchstart',e=>{
    if(e.touches.length!==1) return;
    const t=e.touches[0]; startX=t.clientX;startY=t.clientY;
    startTarget=e.target.closest?.(interactiveSelector)||null;
  },{passive:true,capture:true});

  document.addEventListener('touchend',e=>{
    if(!startTarget) return;
    const t=e.changedTouches?.[0];
    const target=e.target.closest?.(interactiveSelector)||null;
    const moved=t?Math.hypot(t.clientX-startX,t.clientY-startY):0;
    const valid=sameInteractive(startTarget,target)&&moved<12&&!startTarget.disabled;
    startTarget=null;
    if(!valid) return;
    syntheticTarget=target;syntheticAt=Date.now();
    target.click();
  },{passive:true,capture:true});

  document.addEventListener('click',e=>{
    if(!e.isTrusted||!syntheticTarget) return;
    if(Date.now()-syntheticAt>800){syntheticTarget=null;return;}
    const target=e.target.closest?.(interactiveSelector)||null;
    if(sameInteractive(syntheticTarget,target)){
      e.preventDefault();
      e.stopImmediatePropagation();
      syntheticTarget=null;
    }
  },true);
})();

async function bootstrapApplication(){
  // Production boot is fail-closed for identity and data: nothing is
  // rendered from local state until the server has authenticated the session.
  {
    Identity.init();
    if(Identity.currentUser()||CloudIdentity.token()){
      try{
        if(!CloudIdentity.token())throw window.backendApiError('找不到伺服器登入工作階段','SESSION_REQUIRED');
        const cloud=await CloudIdentity.resumeSession();
        const resumed=Identity.startBackendSession({user:cloud.user,memberships:cloud.memberships||[],organizations:cloud.organizations||[],provider:'session'});
        if(!resumed.ok)throw window.backendApiError(resumed.error,'SESSION_FAILED');
      }catch(error){console.warn('[Bootstrap] production session resume rejected',error);Identity.logout();clearProductionSensitiveCache_();}
    }
  }
  const benefitInit=Benefit.initialize();
  const benefitLatestInit=BenefitLatestInfo.initialize();
  if(!benefitInit?.ok)console.warn('[Bootstrap] Benefit P0 validation completed with errors',benefitInit?.validation?.errors||benefitInit);
  renderLoginSecurityState();
  setInterval(()=>{const screen=$('loginScreen');if(screen&&!screen.classList.contains('hidden'))renderLoginSecurityState();},1000);
  if(Identity.currentUser()){$('loginScreen').classList.add('hidden');$('appShell').classList.remove('hidden');setupApp();}

  // Core UI/identity boot succeeded. Background sync errors after this point are non-fatal.
  careRideBootCompleted=true;
  clearRuntimeErrorBanner_();

  // Hydrate Trip/IndexedDB after first paint. Restricted preview environments automatically fall back.
  setTimeout(async()=>{
    try{
      const tripInit=await Promise.race([
        Trip.initialize(),
        new Promise(resolve=>setTimeout(()=>resolve({ok:false,previewFallback:true,error:'Trip initialization timeout; using preview-safe fallback'}),2600))
      ]);
      if(!tripInit?.ok)console.warn('[Bootstrap] Trip initialization completed with fallback/error',tripInit?.error||tripInit);
      if(Identity.currentUser()&&typeof render==='function')render();
    }catch(error){console.warn('[Bootstrap] deferred Trip initialization failed; continuing with fallback',error);}
  },30);

  // Authenticated refresh only. Anonymous production visitors never receive Google Database rows.
  setTimeout(async()=>{
    try{
      if(typeof AppStateDatabase==='undefined'||typeof navigator==='undefined'||navigator.onLine===false||!Identity.currentUser())return;
      const lastSyncAt=store.state?.integration?.googleDatabaseLastSyncAt||store.state?.integration?.lastSyncAt||null;
      const lastSyncMs=lastSyncAt?Date.now()-new Date(lastSyncAt).getTime():Infinity;
      if(Number.isFinite(lastSyncMs)&&lastSyncMs>=0&&lastSyncMs<120000)return;
      const result=await AppStateDatabase.loadAll({silent:true});
      if(!result?.ok){console.warn('[Bootstrap] authenticated Google database refresh failed',result?.error||result);return;}
      try{Benefit.migrate();}catch(error){console.warn('[Bootstrap] Benefit cloud normalization warning',error);}
      try{Trip.migrateRuntimeModel?.();Trip.migrateEventHistory?.();Trip.migratePassengerRuntimeHistory?.();Trip.migrateIssueStateModel?.();}catch(error){console.warn('[Bootstrap] Trip cloud normalization warning',error);}
      if(Identity.currentUser()){applyIdentityContext();renderNav();render();}
    }catch(error){console.warn('[Bootstrap] authenticated Google database refresh failed',error);}
  },650);
  return {ok:true,benefitInit,benefitLatestInit};
}
document.addEventListener('input',e=>{const field=e.target.closest?.('.form-field.has-error');if(field){field.classList.remove('has-error');const input=e.target;if(input?.removeAttribute){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}field.querySelector('.field-error-message')?.remove();}});
document.addEventListener('change',e=>{const field=e.target.closest?.('.form-field.has-error');if(field){field.classList.remove('has-error');const input=e.target;if(input?.removeAttribute){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}field.querySelector('.field-error-message')?.remove();}});

bootstrapApplication().catch(error=>{
  console.error('[Bootstrap] fatal initialization error',error);
  careRideBootCompleted=false;
  showPreviewRuntimeError(error,{phase:'bootstrap',fatal:true});
});

})();
