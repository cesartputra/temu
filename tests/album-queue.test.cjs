const {test}=require('node:test'),assert=require('node:assert/strict');
const {IDBFactory}=require('fake-indexeddb');
const {create}=require('../dist/album-queue.js');
const tick=()=>new Promise(setImmediate);
async function until(check){for(let n=0;n<100;n++){if(await check())return;await tick();}assert.fail('queue did not settle');}
const job=id=>({id,blob:new Blob(['original photo bytes'],{type:'image/jpeg'}),name:'Guest',caption:'Hello',filter:'film'});
test('durable enqueue frees capture while one upload runs, preserving original bytes and independent metadata',async()=>{
 const indexedDB=new IDBFactory(),sent=[],finished=[];let release;
 const queue=create({indexedDB,send:async(item,save)=>{sent.push(item);if(sent.length===1)await new Promise(resolve=>release=resolve);return {id:item.id};},onSaved:r=>finished.push(r)});
 await queue.enqueue(job('first'));await until(()=>sent.length===1);
 await queue.enqueue({...job('second'),filter:'mono',name:'Other'});
 assert.equal(sent.length,1);assert.equal((await queue.list()).length,2);assert.equal(await sent[0].blob.text(),'original photo bytes');assert.equal(sent[0].filter,'film');
 release();await until(()=>finished.length===2);assert.equal(sent[1].name,'Other');assert.equal(sent[1].filter,'mono');assert.equal((await queue.list()).length,0);
});
test('reload resumes the same persisted ID, uploaded ticket and saved result without dropping the file',async()=>{
 const indexedDB=new IDBFactory();let calls=0;
 const first=create({indexedDB,send:async(item,save)=>{calls++;await save({ticket:{id:'remote'},stage:'uploaded',result:{id:'remote'}});throw Error('thumbnail offline');}});
 await first.enqueue(job('stable'));await until(async()=>(await first.list())[0]?.state==='failed');
 const recovered=create({indexedDB,send:async item=>{assert.equal(item.id,'stable');assert.equal(item.stage,'uploaded');assert.equal(item.ticket.id,'remote');assert.equal(item.result.id,'remote');assert.equal(await item.blob.text(),'original photo bytes');calls++;return item.result;}});
 await recovered.retry('stable');await until(async()=>(await recovered.list()).length===0);assert.equal(calls,2);
});
test('failed local persistence rejects enqueue and capacity is bounded without removing pending files',async()=>{
 const unavailable=create({indexedDB:null,send:async()=>{}});await assert.rejects(unavailable.enqueue(job('a')),/Browser tidak mendukung/);
 let release;const queue=create({indexedDB:new IDBFactory(),send:()=>new Promise(resolve=>release=resolve)});
 await queue.enqueue(job('0'));await until(()=>!!release);
 for(let n=1;n<8;n++)await queue.enqueue(job(String(n)));
 await assert.rejects(queue.enqueue(job('too-many')),/Antrean penuh/);assert.equal((await queue.list()).length,8);
});
test('rejected jobs stay available for retry or explicit removal while later jobs can finish',async()=>{
 const queue=create({indexedDB:new IDBFactory(),send:async item=>{if(item.id==='bad')throw Error('Invalid media');return {id:item.id};}});
 await queue.enqueue(job('bad'));await queue.enqueue(job('good'));
 await until(async()=>{const rows=await queue.list();return rows.length===1&&rows[0].state==='failed';});
 assert.match((await queue.list())[0].error,/Invalid/);await queue.discard('bad');assert.equal((await queue.list()).length,0);
});
test('returning after hours aborts a hung transfer and resumes original files without accepting stale callbacks',async()=>{
 const indexedDB=new IDBFactory(),sent=[],saved=[];let clock=0,oldSave,oldSignal,finishOld;
 const queue=create({indexedDB,now:()=>clock,onSaved:r=>saved.push(r.id),send:async(item,save,progress,{signal})=>{
  sent.push(item.id);assert.equal(await item.blob.text(),'original photo bytes');
  if(sent.length===1){oldSave=save;oldSignal=signal;return new Promise(resolve=>finishOld=resolve);}
  return {id:item.id};
 }});
 await queue.enqueue(job('first'));await until(()=>!!oldSignal);await queue.enqueue(job('second'));
 clock=3*60*60*1000;await queue.resume();await until(()=>saved.length===2);
 assert.equal(oldSignal.aborted,true);assert.deepEqual(sent,['first','first','second']);assert.deepEqual(saved,['first','second']);
 await assert.rejects(oldSave({stage:'uploaded'}),{name:'AbortError'});finishOld({id:'stale'});await tick();assert.deepEqual(await queue.list(),[]);
});
test('pausing for the native camera cancels network work and keeps the persisted ticket for the next foreground session',async()=>{
 let signal,calls=0;const saved=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>saved.push(r.id),send:async(item,save,progress,options)=>{
  calls++;if(calls===1){await save({ticket:{id:'existing',token:'private'},stage:'uploaded'});signal=options.signal;return new Promise(()=>{});}
  assert.equal(item.ticket.id,'existing');assert.equal(item.stage,'uploaded');return {id:item.id};
 }});
 await queue.enqueue(job('stable'));await until(()=>!!signal);queue.pause();await until(async()=>(await queue.list())[0]?.state==='queued');
 assert.equal(signal.aborted,true);assert.equal(calls,1);await queue.resume();await until(()=>saved.length===1);assert.equal(calls,2);
});
test('expired claims can be recovered by another tab and the old tab cannot overwrite or delete its result',async()=>{
 const indexedDB=new IDBFactory();let clock=0,oldSave,finishOld;const completed=[];
 const first=create({indexedDB,now:()=>clock,send:async(item,save)=>{oldSave=save;return new Promise(resolve=>finishOld=resolve);}});
 const next=create({indexedDB,now:()=>clock,onSaved:r=>completed.push(r.id),send:async item=>({id:item.id})});
 await first.enqueue(job('old'));await until(()=>!!oldSave);clock=1;await next.enqueue(job('new'));await tick();assert.deepEqual(completed,[]);
 clock=91000;await next.resume();await until(()=>completed.length===2);assert.deepEqual(completed,['old','new']);
 await assert.rejects(oldSave({result:{id:'stale'}}),{name:'AbortError'});finishOld({id:'old'});await tick();assert.deepEqual(await next.list(),[]);
});
test('watchdog releases a silent transfer and gives failed files a retry instead of blocking later moments',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let clock=0,signal;const saved=[];
 const queue=create({indexedDB:new IDBFactory(),now:()=>clock,onSaved:r=>saved.push(r.id),send:async(item,save,progress,options)=>{
  if(item.id==='stuck'){signal=options.signal;return new Promise(()=>{});}return {id:item.id};
 }});
 await queue.enqueue(job('stuck'));await until(()=>!!signal);await queue.enqueue(job('later'));clock=61000;t.mock.timers.tick(10000);
 await until(()=>saved.length===1);const rows=await queue.list();assert.equal(signal.aborted,true);assert.equal(rows[0].state,'failed');assert.match(rows[0].error,/satu menit/);assert.deepEqual(saved,['later']);
});
test('retrying an active row aborts its request before starting a fresh attempt',async()=>{
 let calls=0,signal;const completed=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>completed.push(r.id),send:async(item,save,progress,options)=>{calls++;if(calls===1){signal=options.signal;return new Promise(()=>{});}return {id:item.id};}});
 await queue.enqueue(job('same'));await until(()=>!!signal);await queue.retry('same');await until(()=>completed.length===1);assert.equal(signal.aborted,true);assert.equal(calls,2);
});
test('a stalled IndexedDB open times out and can reopen without changing the database or its version',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const factory=new IDBFactory();let requests=0;
 const indexedDB={open(name,version){assert.equal(version,1);return requests++===0?{}:factory.open(name,version);}};
 const queue=create({indexedDB,send:async item=>({id:item.id})});
 const first=queue.resume();await tick();t.mock.timers.tick(15000);await assert.rejects(first,/Penyimpanan browser tertahan/);
 await queue.enqueue(job('preserved'));await until(async()=>(await queue.list()).length===0);assert.ok(requests>=2);
});
test('legacy queue rows with two uploading flags recover in order without changing their original files',async()=>{
 const indexedDB=new IDBFactory();
 await new Promise((resolve,reject)=>{
  const request=indexedDB.open('temu-album-outbox',1);
  request.onupgradeneeded=()=>{const store=request.result.createObjectStore('files',{keyPath:'id'});for(let n=0;n<3;n++)store.add({...job(String(n)),created:n,state:n<2?'uploading':'queued',progress:0});};
  request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve();};
 });
 const completed=[],queue=create({indexedDB,onSaved:r=>completed.push(r.id),send:async item=>{assert.equal(await item.blob.text(),'original photo bytes');return {id:item.id};}});
 assert.deepEqual((await queue.list()).map(row=>row.state),['queued','queued','queued']);
 await queue.resume();await until(()=>completed.length===3);assert.deepEqual(completed,['0','1','2']);assert.deepEqual(await queue.list(),[]);
});
