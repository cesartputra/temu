/* Files stay on this device until storage confirms them; one transfer per tab. */
(function(root){
'use strict';
function create({indexedDB=root.indexedDB,name='temu-album-outbox',send,onChange=()=>{},onSaved=()=>{}}){
 let database,running=false;
 function db(){
  return database??=new Promise((resolve,reject)=>{
   if(!indexedDB){reject(Error('Browser tidak mendukung antrean foto. Gunakan Safari atau Chrome terbaru.'));return;}
   const request=indexedDB.open(name,1);
   request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'id'});
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>{database=null;reject(Error('Antrean tidak dapat disimpan di HP ini. Periksa ruang penyimpanan browser.'));};
  });
 }
 async function transaction(mode,action){
  const store=await db();return new Promise((resolve,reject)=>{
   const tx=store.transaction('files',mode);let value;
   tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error||Error('Antrean belum tersimpan. Coba lagi dan jangan hapus fotonya.'));
   action(tx.objectStore('files'),result=>value=result,tx);
  });
 }
 const get=id=>transaction('readonly',(store,done)=>{const r=store.get(id);r.onsuccess=()=>done(r.result);});
 const put=job=>transaction('readwrite',(store,done)=>{store.put(job);done(job);});
 const remove=id=>transaction('readwrite',store=>store.delete(id));
 async function list(){return transaction('readonly',(store,done)=>{
  const rows=[],request=store.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor){done(rows.sort((a,b)=>a.created-b.created));return;}
   const {blob,ticket,...row}=cursor.value;rows.push(row);cursor.continue();};
 });}
 async function changed(){onChange(await list());}
 async function enqueue(job){
  let full=false;
  await transaction('readwrite',(store,done,tx)=>{
   let count=0,bytes=0;const request=store.openCursor();request.onsuccess=()=>{
    const cursor=request.result;if(cursor){count++;bytes+=cursor.value.blob.size;cursor.continue();return;}
    if(count>=8||bytes+job.blob.size>200*1024*1024){full=true;tx.abort();return;}
    store.add({...job,state:'queued',created:Date.now(),error:''});
   };
  }).catch(error=>{if(full)throw Error('Antrean penuh (maksimal 8 momen / 200 MB). Tunggu beberapa unggahan selesai sebelum membagikan lagi.');throw error;});
  await changed();void pump();
 }
 async function pump(){
  if(running||root.navigator?.onLine===false)return;running=true;
  try{
   for(;;){
    const row=(await list()).find(job=>job.state!=='failed');if(!row)break;
    let job=await get(row.id);if(!job)continue;
    const save=async patch=>{job={...job,...patch};await put(job);await changed();};
    try{
     await save({state:'uploading',progress:0,error:''});
     const result=await send(job,save,progress=>onChange([{...job,progress},...(lastRows.filter(x=>x.id!==job.id))]));
     await remove(job.id);await changed();onSaved(result);
    }catch(error){await save({state:'failed',error:error.message||'Unggahan belum selesai. Coba lagi.'});}
   }
  }catch(error){onChange([],error);}finally{running=false;}
 }
 let lastRows=[];const notify=onChange;onChange=(rows,error)=>{lastRows=rows;notify(rows,error);};
 async function retry(id){const job=await get(id);if(job?.state==='failed'){await put({...job,state:'queued',error:''});await changed();void pump();}}
 async function discard(id){const job=await get(id);if(job?.state==='failed'){await remove(id);await changed();}}
 async function resume(){await changed();void pump();}
 return {enqueue,list,retry,discard,resume,pump};
}
const api={create};if(typeof module!=='undefined')module.exports=api;else root.TemuAlbumQueue=api;
})(typeof window==='undefined'?globalThis:window);
