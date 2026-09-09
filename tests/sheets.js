// In-memory Google Sheet stand-in
const SHEETS={};
function makeSheet(name,headers,rows){
  SHEETS[name]={headers,rows:rows.map(r=>headers.map(h=>r[h]!==undefined?r[h]:''))};
}
global.__SHEETS=SHEETS; global.__makeSheet=makeSheet;
function sheetObj(name){
  const s=SHEETS[name]; if(!s)return null;
  return {
    getLastColumn:()=>s.headers.length,
    getLastRow:()=>s.rows.length+1,
    setFrozenRows(){},
    getDataRange:()=>({getValues:()=>[s.headers.slice(),...s.rows.map(r=>r.slice())]}),
    getRange:(r,c,nr,nc)=>({
      getValues:()=>{const out=[];for(let i=0;i<nr;i++){const src=r+i===1?s.headers:s.rows[r+i-2];out.push((src||[]).slice(c-1,c-1+nc));}return out;},
      setValues:(vals)=>{vals.forEach((row,i)=>{const idx=r+i;if(idx===1){s.headers=row.slice();}else{while(s.rows.length<idx-1)s.rows.push(s.headers.map(()=>''));s.rows[idx-2]=row.slice();}});},
      setValue:(v)=>{const idx=r;if(idx>1){while(s.rows.length<idx-1)s.rows.push(s.headers.map(()=>''));s.rows[idx-2][c-1]=v;}}
    }),
    appendRow:(row)=>{s.rows.push(row.slice());},
    deleteRow:(r)=>{s.rows.splice(r-2,1);}
  };
}
global.getSpreadsheet_=()=>({
  getSheetByName:n=>sheetObj(n),
  insertSheet:n=>{SHEETS[n]={headers:[],rows:[]};return sheetObj(n);}
});
global.readTable_=(name)=>{
  const s=SHEETS[name]; if(!s)return [];
  return s.rows.map(r=>{const o={};s.headers.forEach((h,i)=>o[h]=r[i]);return o;});
};
global.writeAudit_=()=>{};
global.requireConfig_=undefined;
