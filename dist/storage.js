/* A saved UI result is acknowledged only after its IndexedDB transaction commits. */
(function(root){
'use strict';
let connection;const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('temu-db-v2'):null;
function open(){if(connection)return Promise.resolve(connection);return new Promise((resolve,reject)=>{const r=indexedDB.open('temu-database',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>{connection=r.result;connection.onversionchange=()=>{connection.close();connection=null;};resolve(connection);};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Tutup tab Temu lainnya lalu muat ulang.'));});}
async function read(){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('records','readonly'),r=tx.objectStore('records').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction(fn){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');const store=tx.objectStore('records');const r=store.get('current');let value,error;r.onsuccess=()=>{try{value=fn(r.result);store.put(value,'current');}catch(e){error=e;tx.abort();}};tx.oncomplete=()=>{channel?.postMessage('changed');resolve(value);};tx.onerror=()=>reject(error||tx.error);tx.onabort=()=>reject(error||tx.error||Error('Penyimpanan dibatalkan.'));});}
function backup(r){r.backups=r.backups||[];r.backups.push({id:crypto.randomUUID(),at:new Date().toISOString(),state:structuredClone(r.state)});r.backups=r.backups.slice(-20);}
async function init(seed){return transaction(r=>{if(r)return r;const state=seed();return{format:2,state,outbox:[{id:crypto.randomUUID(),kind:'bootstrap',event:state.event.id,state:structuredClone(state)}],conflicts:[],backups:[],lastSync:null,config:{enabled:false,token:''}};});}
async function mutate(change,validate){return transaction(r=>{if(!r)throw Error('Database belum siap.');const next=structuredClone(r.state);change(next);validate(next);if(next.event.id!==r.state.event.id)throw Error('Gunakan pemulihan untuk mengganti acara.');const op=TemuModel.operation(r.state,next);if(op.meta||op.changes.length||op.logs.length){backup(r);r.state=next;r.outbox.push(op);}return r;});}
async function replace(state,validate){validate(state);return transaction(r=>{backup(r);state=structuredClone(state);if(r.state.event.id===state.event.id){
// Keep audit history and deactivate guests missing from the selected snapshot.
for(const g of r.state.guests)if(!state.guests.some(x=>x.id===g.id))state.guests.push({...g,active:false});
const ids=new Set(r.state.logs.map(l=>l.id));state.logs=[...r.state.logs,...state.logs.filter(l=>!ids.has(l.id))];
for(const g of state.guests){const prior=r.state.guests.find(x=>x.id===g.id);if(prior&&prior.arrived!==g.arrived)state.logs.push({id:crypto.randomUUID(),guest:g.id,count:g.arrived-prior.arrived,at:new Date().toISOString(),reason:'Pemulihan cadangan lokal'});}
validate(state);r.outbox.push(TemuModel.operation(r.state,state));
}else{if(r.outbox.length)throw Error('Sinkronkan perubahan sebelum mengganti acara.');r.outbox=[{id:crypto.randomUUID(),kind:'bootstrap',event:state.event.id,state:structuredClone(state)}];r.serverRevision=0;r.lastSync=null;}
r.state=state;return r;});}
async function clearEvent(state,validate){validate(state);return transaction(r=>{r.state=structuredClone(state);r.outbox=[{id:crypto.randomUUID(),kind:'bootstrap',event:state.event.id,state:structuredClone(state)}];r.conflicts=[];r.backups=[];r.lastSync=null;r.serverRevision=0;r.serverBackupAt=null;r.serverBackupError=null;r.config={enabled:false,token:''};return r;});}
root.TemuStore={open,read,transaction,init,mutate,replace,clearEvent,backup,channel};
})(globalThis);
