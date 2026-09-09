const crypto=require('crypto');
const props=new Map();
global.PropertiesService={getScriptProperties:()=>({
  getProperty:k=>props.has(k)?props.get(k):null,
  setProperty:(k,v)=>{props.set(k,String(v));},
  deleteProperty:k=>{props.delete(k);}
})};
global.__props=props;
global.Utilities={
  Charset:{UTF_8:'utf8'},
  DigestAlgorithm:{SHA_256:'sha256'},
  getUuid:()=>crypto.randomUUID(),
  newBlob:(s)=>{const buf=Array.isArray(s)?Buffer.from(s.map(b=>b<0?b+256:b)):Buffer.from(String(s),'utf8');
    return {getBytes:()=>Array.from(buf).map(b=>b>127?b-256:b),getDataAsString:()=>buf.toString('utf8')};},
  computeDigest:(alg,val)=>Array.from(crypto.createHash('sha256').update(Buffer.from(String(val),'utf8')).digest()).map(b=>b>127?b-256:b),
  computeHmacSha256Signature:(val,key)=>{
    const tb=x=>Array.isArray(x)?Buffer.from(x.map(b=>b<0?b+256:b)):Buffer.from(String(x),'utf8');
    return Array.from(crypto.createHmac('sha256',tb(key)).update(tb(val)).digest()).map(b=>b>127?b-256:b);
  },
  base64EncodeWebSafe:(s)=>Buffer.from(String(s),'utf8').toString('base64url'),
  base64DecodeWebSafe:(s)=>Array.from(Buffer.from(String(s),'base64url')).map(b=>b>127?b-256:b)
};
global.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};
global.readTable_=()=>[];
global.normalizeTaiwanPhoneForIdentity_=v=>String(v||'').replace(/\D/g,'');
