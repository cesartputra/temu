/* Originals stay in IndexedDB; expiring claims recover interrupted browser uploads. */
(function(root){
'use strict';
function create({indexedDB=root.indexedDB,name='temu-album-outbox',send,onChange=()=>{},onSaved=()=>{},now=Date.now}){
 let database,running=false,paused=false,active=null,lastRows=[];
 const leaseMs=90000,stallMs=60000;
 const abort=(message,requeue=false)=>Object.assign(Error(message),{name:'AbortError',requeue,recoverable:true});
 function db(){
  return database??=new Promise((resolve,reject)=>{
   if(!indexedDB){reject(Error('Browser tidak mendukung antrean foto. Gunakan Safari atau Chrome terbaru.'));return;}
   const request=indexedDB.open(name,1);let expired=false;
   const timer=setTimeout(()=>{expired=true;database=null;reject(Error('Penyimpanan browser tertahan. Buka kembali album; file antrean tidak dihapus.'));},15000);
   request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'id'});
   request.onsuccess=()=>{clearTimeout(timer);if(expired){request.result.close();return;}request.result.onversionchange=()=>{request.result.close();database=null;};resolve(request.result);};
   request.onerror=()=>{clearTimeout(timer);database=null;reject(Error('Antrean tidak dapat disimpan di HP ini. Periksa ruang penyimpanan browser.'));};
  });
 }
 async function transaction(mode,action){
  const store=await db();return new Promise((resolve,reject)=>{
   const tx=store.transaction('files',mode);let value;
   const timer=setTimeout(()=>{try{tx.abort();}catch{}store.close();database=null;reject(Error('Antrean browser tertahan. Buka kembali album untuk melanjutkan.'));},15000);
   tx.oncomplete=()=>{clearTimeout(timer);resolve(value);};tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error||Error('Antrean belum tersimpan. Coba lagi dan jangan hapus fotonya.'));};
   action(tx.objectStore('files'),result=>value=result,tx);
  });
 }
 const update=(id,change)=>transaction('readwrite',(store,done)=>{const r=store.get(id);r.onsuccess=()=>{const row=r.result;if(!row)return done(false);const next=change(row);if(next===false)return done(false);if(next===null)store.delete(id);else store.put(next);done(true);};});
 async function list(){return transaction('readonly',(store,done)=>{
  const rows=[],request=store.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor){done(rows.sort((a,b)=>a.created-b.created));return;}
   const {blob,ticket,...row}=cursor.value;if(row.state==='uploading'&&(!row.attempt||row.leaseUntil<=now()))row.state='queued';
   if(row.state==='uploading'&&row.attempt===active?.attempt&&row.phase==='uploading')row.progress=active.progress||0;
   rows.push(row);cursor.continue();};
 });}
 function notify(rows,error){lastRows=rows;onChange(rows,error);}
 async function changed(){notify(await list());}
 function claim(){return transaction('readwrite',(store,done)=>{
  const rows=[],request=store.openCursor();request.onsuccess=()=>{
   const cursor=request.result;if(cursor){const {blob,ticket,...row}=cursor.value;rows.push(row);cursor.continue();return;}
   if(rows.some(row=>row.state==='uploading'&&row.attempt&&row.leaseUntil>now()))return done(null);
   const row=rows.filter(row=>row.state!=='failed').sort((a,b)=>a.created-b.created)[0];if(!row)return done(null);
   const item=store.get(row.id);item.onsuccess=()=>{const job={...item.result,state:'uploading',phase:'recovering',progress:0,error:'',attempt:root.crypto?.randomUUID?.()||now()+'-'+Math.random(),leaseUntil:now()+leaseMs};store.put(job);done(job);};
  };
 });}
 async function enqueue(job){
  let full=false;
  await transaction('readwrite',(store,done,tx)=>{
   let count=0,bytes=0;const request=store.openCursor();request.onsuccess=()=>{
    const cursor=request.result;if(cursor){count++;bytes+=cursor.value.blob.size;cursor.continue();return;}
    if(count>=8||bytes+job.blob.size>200*1024*1024){full=true;tx.abort();return;}
    store.add({...job,state:'queued',created:now(),error:''});
   };
  }).catch(error=>{if(full)throw Error('Antrean penuh (maksimal 8 momen / 200 MB). Tunggu beberapa unggahan selesai sebelum membagikan lagi.');throw error;});
  await changed();void pump();
 }
 async function pump(){
  if(running||paused||root.navigator?.onLine===false||root.document?.hidden)return;running=true;
  try{
   while(!paused&&root.navigator?.onLine!==false&&!root.document?.hidden){
    const job=await claim();if(!job)break;
    const context={id:job.id,attempt:job.attempt,last:now(),renewed:now(),controller:new AbortController()};active=context;
    const signal=context.controller.signal;
    const owned=change=>update(job.id,row=>row.attempt===job.attempt?change(row):false);
    const save=async patch=>{if(signal.aborted)throw signal.reason;if(patch.phase==='uploading')context.progress=0;const saved=await owned(row=>signal.aborted?false:{...row,...patch,leaseUntil:now()+leaseMs});if(!saved)throw abort('Unggahan dilanjutkan di tab lain.');context.last=context.renewed=now();await changed();};
    let stopped;const interrupted=new Promise((resolve,reject)=>{stopped=()=>reject(signal.reason);if(signal.aborted)stopped();else signal.addEventListener('abort',stopped,{once:true});});interrupted.catch(()=>{});
    try{
     await changed();
     if(signal.aborted)throw signal.reason;
     if(paused||root.navigator?.onLine===false||root.document?.hidden)throw abort('Unggahan dijeda; file tetap tersimpan di HP.',true);
     const progress=value=>{if(signal.aborted)return;context.last=now();context.progress=value;notify(lastRows.map(row=>row.id===job.id?{...row,phase:'uploading',progress:value}:row));};
     const result=await Promise.race([send(job,save,progress,{signal}),interrupted]);
     if(signal.aborted)throw signal.reason;
     if(await owned(()=>null)){await changed();onSaved(result);}
    }catch(error){
     const failure=signal.aborted?signal.reason:error;
     await owned(row=>({...row,state:failure.requeue?'queued':'failed',attempt:null,leaseUntil:0,recoverable:!!failure.recoverable||[0,429,502,503,504].includes(failure.status),error:failure.message||'Unggahan belum selesai. Coba lagi.'}));await changed();
    }finally{signal.removeEventListener('abort',stopped);if(active===context)active=null;}
   }
  }catch(error){notify(lastRows,error);}finally{running=false;}
 }
 async function retry(id){
  if(active?.id===id){active.controller.abort(abort('Menghubungkan ulang unggahan…',true));return;}
  let locked=false;await update(id,row=>{if(row.state==='uploading'&&row.attempt&&row.leaseUntil>now()){locked=true;return false;}return {...row,state:'queued',attempt:null,leaseUntil:0,error:''};});
  if(locked)throw Error('Momen sedang diunggah di tab lain.');
  await changed();void pump();
 }
 async function discard(id){await update(id,row=>row.state==='failed'?null:false);await changed();}
 function pause(cancel=false){paused=true;if(cancel)active?.controller.abort(abort('Koneksi terputus; file tetap tersimpan di HP.',true));}
 async function check(restart=false){
  if(active&&!active.controller.signal.aborted){
   if(now()-active.last>=stallMs)active.controller.abort(abort('Unggahan tidak bergerak selama satu menit. File tetap tersimpan; ketuk Coba lagi.',restart));
   else if(now()-active.renewed>=20000){const current=active;current.renewed=now();if(!await update(current.id,row=>row.attempt===current.attempt?{...row,leaseUntil:now()+leaseMs}:false))current.controller.abort(abort('Unggahan dilanjutkan di tab lain.'));}
  }
 }
 async function resume(){
  // Let suspended network callbacks run before treating camera time as a stall.
  if(paused&&active)active.last=now();paused=false;await check(true);
  for(const row of await list())if(row.state==='failed'&&(row.recoverable||row.result))await update(row.id,current=>current.state==='failed'&&(current.recoverable||current.result)?{...current,state:'queued',error:''}:false);await changed();void pump();
 }
 const timer=setInterval(()=>{if(!paused&&!root.document?.hidden)check().then(()=>pump()).catch(error=>notify(lastRows,error));},10000);timer.unref?.();
 return {enqueue,list,retry,discard,resume,pump,pause};
}
const api={create};if(typeof module!=='undefined')module.exports=api;else root.TemuAlbumQueue=api;
})(typeof window==='undefined'?globalThis:window);
