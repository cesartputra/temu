/* Shared deterministic operations: no clock-based last-write-wins. */
(function(root){
'use strict';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function meta(s){return {event:s.event,pin:s.pin};}
function operation(before,after){
 const changes=[];const old=new Map(before.guests.map(g=>[g.id,g]));
 for(const g of after.guests)if(!same(old.get(g.id)||null,g))changes.push({id:g.id,before:old.get(g.id)||null,after:g});
 for(const g of before.guests)if(!after.guests.some(x=>x.id===g.id))changes.push({id:g.id,before:g,after:null});
 const known=new Set(before.logs.map(l=>l.id));
 return {id:crypto.randomUUID(),kind:'change',event:after.event.id,guestEpoch:before.guestEpoch||0,meta:same(meta(before),meta(after))?null:{before:meta(before),after:meta(after)},changes,logs:after.logs.filter(l=>!known.has(l.id))};
}
function apply(state,op){
 if(op.kind==='bootstrap'){if(state)throw Error('Acara sudah ada di server.');return structuredClone(op.state);}
 if(!state||state.event.id!==op.event)throw Error('Acara tidak cocok.');
 if((op.guestEpoch||0)!==(state.guestEpoch||0))throw Error('Daftar tamu telah dibersihkan. Sinkronkan sebelum mengubahnya.');
 const next=structuredClone(state);
 if(op.meta){if(!same(meta(state),op.meta.before))throw Error('Pengaturan acara berubah di perangkat lain.');next.event=op.meta.after.event;next.pin=op.meta.after.pin;}
 for(const c of op.changes){const current=next.guests.find(g=>g.id===c.id)||null;if(!same(current,c.before))throw Error('Undangan '+(c.after?.name||current?.name||c.id)+' berubah di perangkat lain.');next.guests=next.guests.filter(g=>g.id!==c.id);if(c.after)next.guests.push(structuredClone(c.after));}
 const ids=new Set(next.logs.map(l=>l.id));for(const l of op.logs){if(ids.has(l.id))throw Error('Riwayat sudah ada.');next.logs.push(structuredClone(l));ids.add(l.id);}
 return next;
}
function rebase(state,operations){const conflicts=[];let next=state;const remaining=[];for(const op of operations){try{next=apply(next,op);remaining.push(op);}catch(e){conflicts.push({id:op.id,op,reason:e.message,at:new Date().toISOString()});}}return {state:next,remaining,conflicts};}
const api={operation,apply,rebase};root.TemuModel=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
