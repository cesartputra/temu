const {test}=require('node:test'),assert=require('node:assert/strict');
const {IDBFactory}=require('fake-indexeddb');
const {create}=require('../dist/album-queue.js');
const tick=()=>new Promise(setImmediate);
async function until(check){for(let n=0;n<1000;n++){if(await check())return;await tick();}assert.fail('queue did not settle');}
const job=id=>({id,blob:new Blob(['original photo bytes'],{type:'image/jpeg'}),name:'Guest',caption:'Hello',filter:'film'});
const video=id=>({...job(id),blob:new Blob(['original video bytes'],{type:'video/mp4'})});
test('photos bypass a waiting video and fill three photo slots while one video uploads',async()=>{
 const started=[],held=new Map(),saved=[],counts={photo:0,video:0},peaks={photo:0,video:0};let clock=0;
 const queue=create({indexedDB:new IDBFactory(),now:()=>clock++,onSaved:r=>saved.push(r.id),send:async(item,save,progress)=>{
  const kind=item.blob.type.startsWith('video/')?'video':'photo';started.push(item.id);counts[kind]++;peaks[kind]=Math.max(peaks[kind],counts[kind]);
  await save({phase:'uploading'});progress(item.id==='p2'?42:0);
  await new Promise(resolve=>held.set(item.id,resolve));counts[kind]--;return {id:item.id};
 }});
 queue.pause();for(const item of [video('v1'),video('v2'),job('p1'),job('p2'),job('p3'),job('p4')])await queue.enqueue(item);
 await queue.resume();await until(()=>held.size===4);assert.deepEqual(started,['v1','p1','p2','p3']);
 const rows=await queue.list();assert.deepEqual(rows.map(row=>row.kind),['video','video','photo','photo','photo','photo']);assert.equal(rows.find(row=>row.id==='p2').progress,42);assert.equal(rows.find(row=>row.id==='p1').progress,0);assert.ok(rows.every(row=>!('blob' in row)&&!('ticket' in row)));
 held.get('p1')();await until(()=>held.has('p4'));assert.equal(held.has('v2'),false);
 held.get('v1')();await until(()=>held.has('v2'));
 for(const id of ['p2','p3','p4','v2'])held.get(id)();await until(()=>saved.length===6);
 assert.deepEqual(peaks,{photo:3,video:1});assert.deepEqual(await queue.list(),[]);
});
test('two tabs atomically share three photo slots and one video slot without duplicate claims',async()=>{
 const indexedDB=new IDBFactory(),started=[],held=new Map(),saved=[],counts={photo:0,video:0},peaks={photo:0,video:0};
 const send=async item=>{const kind=item.blob.type.startsWith('video/')?'video':'photo';started.push(item.id);counts[kind]++;peaks[kind]=Math.max(peaks[kind],counts[kind]);await new Promise(resolve=>held.set(item.id,resolve));counts[kind]--;return {id:item.id};};
 const first=create({indexedDB,send,onSaved:r=>saved.push(r.id)}),second=create({indexedDB,send,onSaved:r=>saved.push(r.id)});
 first.pause();second.pause();for(const item of [video('v1'),video('v2'),...Array.from({length:6},(_,n)=>job('p'+n))])await first.enqueue(item);
 await Promise.all([first.resume(),second.resume()]);await until(()=>held.size===4);await Promise.all([first.pump(),second.pump()]);
 const rows=await first.list();assert.equal(rows.filter(row=>row.state==='uploading'&&row.kind==='photo').length,3);assert.equal(rows.filter(row=>row.state==='uploading'&&row.kind==='video').length,1);assert.equal(started.length,4);
 await until(async()=>{for(const release of held.values())release();await Promise.all([first.pump(),second.pump()]);return saved.length===8;});
 assert.equal(new Set(started).size,8);assert.equal(started.length,8);assert.deepEqual(peaks,{photo:3,video:1});assert.deepEqual(await first.list(),[]);
});
test('offline cancels every lane and resumes each original file and ticket',async()=>{
 const calls=new Map(),signals=new Map(),saved=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>saved.push(r.id),send:async(item,save,progress,{signal})=>{
  const count=(calls.get(item.id)||0)+1;calls.set(item.id,count);
  if(count===1){await save({ticket:{id:'remote-'+item.id},stage:'uploaded'});signals.set(item.id,signal);return new Promise(()=>{});}
  assert.equal(item.ticket.id,'remote-'+item.id);assert.equal(item.stage,'uploaded');assert.equal(await item.blob.text(),item.id==='v1'?'original video bytes':'original photo bytes');return {id:item.id};
 }});
 queue.pause();for(const item of [video('v1'),job('p1'),job('p2'),job('p3')])await queue.enqueue(item);await queue.resume();await until(()=>signals.size===4);
 queue.pause(true);await until(async()=>(await queue.list()).every(row=>row.state==='queued'));assert.ok([...signals.values()].every(signal=>signal.aborted));
 await queue.resume();await until(()=>saved.length===4);assert.deepEqual([...calls.values()],[2,2,2,2]);assert.deepEqual(await queue.list(),[]);
});
test('a server 500 failure remains recoverable on foreground resume',async()=>{
 let calls=0;const saved=[],queue=create({indexedDB:new IDBFactory(),onSaved:r=>saved.push(r.id),send:async item=>{if(++calls===1)throw Object.assign(Error('Server unavailable'),{status:500});return {id:item.id};}});
 await queue.enqueue(job('same'));await until(async()=>(await queue.list())[0]?.state==='failed');assert.equal((await queue.list())[0].recoverable,true);
 await queue.resume();await until(()=>saved.length===1);assert.equal(calls,2);assert.deepEqual(await queue.list(),[]);
});
test('three rapid captures retry a connection reset without blocking the other photos',async()=>{
 const transport=require('../dist/album-upload.js'),attempts=[],completed=[],waits=[];let active=0,peak=0,reset=false;
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>completed.push(r.id),send:async(item,save,progress,{signal})=>{
  active++;peak=Math.max(peak,active);
  try{return await transport.retry(async()=>{
   attempts.push(item.id);assert.equal(await item.blob.text(),'original photo bytes');await save({phase:'uploading'});progress(0);
   if(item.id==='second'&&!reset){reset=true;throw Object.assign(Error('Connection reset'),{status:0});}
   progress(100);return {id:item.id};
  },{signal,random:()=>0,wait:async ms=>waits.push(ms),onWait:()=>save({phase:'waiting'})});}
  finally{active--;}
 }});
 queue.pause();for(const id of ['first','second','third'])await queue.enqueue(job(id));await queue.resume();
 await until(()=>completed.length===3);
 assert.deepEqual(attempts,['first','second','third','second']);assert.deepEqual(completed.toSorted(),['first','second','third']);assert.deepEqual(waits,[1500]);assert.ok(peak>1&&peak<=3);assert.deepEqual(await queue.list(),[]);
});
test('resuming a legacy failed thumbnail clears the published row and lets the next originals proceed',async()=>{
 const indexedDB=new IDBFactory(),sent=[];
 const old=create({indexedDB,send:async(item,save)=>{await save({result:{id:'already-saved'}});throw Error('Foto belum dapat dibaca.');}});
 await old.enqueue(job('first'));await until(async()=>(await old.list())[0]?.state==='failed');
 const queue=create({indexedDB,send:async item=>{if(item.result)return item.result;sent.push(item.id);return {id:item.id};}});
 await queue.enqueue(job('second'));await queue.enqueue(job('third'));await queue.resume();await until(async()=>(await queue.list()).length===0);assert.deepEqual(sent,['second','third']);
});
test('durable enqueue starts another photo while the first uploads, preserving independent metadata',async()=>{
 const indexedDB=new IDBFactory(),sent=[],finished=[],held=new Map();
 const queue=create({indexedDB,send:async item=>{sent.push(item);await new Promise(resolve=>held.set(item.id,resolve));return {id:item.id};},onSaved:r=>finished.push(r)});
 await queue.enqueue(job('first'));await until(()=>sent.length===1);
 await queue.enqueue({...job('second'),filter:'mono',name:'Other'});
 await until(()=>held.size===2);assert.equal((await queue.list()).length,2);assert.equal(await sent[0].blob.text(),'original photo bytes');assert.equal(sent[0].filter,'film');
 for(const release of held.values())release();await until(()=>finished.length===2);assert.equal(sent[1].name,'Other');assert.equal(sent[1].filter,'mono');assert.equal((await queue.list()).length,0);
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
test('going offline cancels network work and keeps the persisted ticket for the next foreground session',async()=>{
 let signal,calls=0;const saved=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>saved.push(r.id),send:async(item,save,progress,options)=>{
  calls++;if(calls===1){await save({ticket:{id:'existing',token:'private'},stage:'uploaded'});signal=options.signal;return new Promise(()=>{});}
  assert.equal(item.ticket.id,'existing');assert.equal(item.stage,'uploaded');return {id:item.id};
 }});
 await queue.enqueue(job('stable'));await until(()=>!!signal);queue.pause(true);await until(async()=>(await queue.list())[0]?.state==='queued');
 assert.equal(signal.aborted,true);assert.equal(calls,1);await queue.resume();await until(()=>saved.length===1);assert.equal(calls,2);
});
test('returning from the camera preserves the active request and progress even after a long suspension',async()=>{
 let clock=0,signal,finish;const sent=[],completed=[];
 const queue=create({indexedDB:new IDBFactory(),now:()=>clock,onSaved:r=>completed.push(r.id),send:async(item,save,progress,options)=>{
  sent.push(item.id);if(sent.length===1){await save({phase:'uploading'});progress(60);signal=options.signal;return new Promise(resolve=>finish=resolve);}return {id:item.id};
 }});
 await queue.enqueue(job('first'));await until(()=>!!signal);queue.pause();await queue.enqueue(job('second'));
 clock=3*60*60*1000;await queue.resume();assert.equal(signal.aborted,false);assert.deepEqual(sent,['first']);assert.equal((await queue.list())[0].progress,60);
 finish({id:'first'});await until(()=>completed.length===2);assert.deepEqual(sent,['first','second']);assert.deepEqual(completed,['first','second']);
});
test('an in-flight upload can finish while the camera is open, without starting the next queued photo',async()=>{
 let signal,finish;const sent=[],completed=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>completed.push(r.id),send:async(item,save,progress,options)=>{
  sent.push(item.id);if(sent.length===1){signal=options.signal;return new Promise(resolve=>finish=resolve);}return {id:item.id};
 }});
 await queue.enqueue(job('first'));await until(()=>!!signal);queue.pause();await queue.enqueue(job('second'));finish({id:'first'});
 await until(()=>completed.length===1);assert.equal(signal.aborted,false);assert.deepEqual(sent,['first']);assert.equal((await queue.list())[0].id,'second');
 await queue.resume();await until(()=>completed.length===2);assert.deepEqual(sent,['first','second']);
});
test('a genuine network failure during camera use is retried on return with the original ID and file',async()=>{
 let fail,calls=0;const completed=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>completed.push(r.id),send:async(item,save)=>{
  calls++;if(calls===1){await save({ticket:{id:'remote'},stage:'uploaded'});return new Promise((resolve,reject)=>fail=reject);}
  assert.equal(item.id,'stable');assert.equal(item.ticket.id,'remote');assert.equal(item.stage,'uploaded');assert.equal(await item.blob.text(),'original photo bytes');return {id:item.id};
 }});
 await queue.enqueue(job('stable'));await until(()=>!!fail);queue.pause();fail(Object.assign(Error('Network disconnected'),{status:0}));
 await until(async()=>(await queue.list())[0]?.state==='failed');await queue.resume();await until(()=>completed.length===1);assert.equal(calls,2);assert.deepEqual(completed,['stable']);
});
test('a transfer that remains silent after returning gets foreground time to recover before the watchdog releases it',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let clock=0,signal;const completed=[];
 const queue=create({indexedDB:new IDBFactory(),now:()=>clock,onSaved:r=>completed.push(r.id),send:async(item,save,progress,options)=>{
  if(item.id==='stuck'){signal=options.signal;return new Promise(()=>{});}return {id:item.id};
 }});
 await queue.enqueue(job('stuck'));await until(()=>!!signal);queue.pause();await queue.enqueue(job('next'));clock=180000;await queue.resume();
 clock+=10000;t.mock.timers.tick(10000);await tick();assert.equal(signal.aborted,false);
 clock+=51000;t.mock.timers.tick(10000);await until(()=>completed.length===1);assert.equal(signal.aborted,true);assert.deepEqual(completed,['next']);
 const rows=await queue.list();assert.equal(rows[0].id,'stuck');assert.equal(rows[0].state,'failed');
});
test('expired claims in every lane recover in another tab without accepting old callbacks',async()=>{
 const indexedDB=new IDBFactory();let clock=0;const oldSaves=new Map(),oldFinishes=new Map(),completed=[];
 const first=create({indexedDB,now:()=>clock,send:async(item,save)=>{oldSaves.set(item.id,save);return new Promise(resolve=>oldFinishes.set(item.id,resolve));}});
 const next=create({indexedDB,now:()=>clock,onSaved:r=>completed.push(r.id),send:async item=>({id:item.id})});
 first.pause();for(const item of [video('v1'),job('p1'),job('p2'),job('p3')])await first.enqueue(item);await first.resume();await until(()=>oldSaves.size===4);
 await assert.rejects(next.retry('p1'),/tab lain/);await next.resume();await tick();assert.deepEqual(completed,[]);
 first.pause();clock=91000;await next.resume();await until(()=>completed.length===4);assert.deepEqual(completed.toSorted(),['p1','p2','p3','v1']);
 for(const [id,save] of oldSaves){await assert.rejects(save({result:{id:'stale'}}),{name:'AbortError'});oldFinishes.get(id)({id});}await tick();assert.deepEqual(await next.list(),[]);
});
test('watchdogs renew and abort each active lane independently',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let clock=0;const signals=new Map(),progresses=new Map();
 const queue=create({indexedDB:new IDBFactory(),now:()=>clock,send:async(item,save,progress,{signal})=>{await save({phase:'uploading'});signals.set(item.id,signal);progresses.set(item.id,progress);return new Promise(()=>{});}});
 queue.pause();for(const item of [video('v1'),job('p1'),job('p2'),job('p3')])await queue.enqueue(item);await queue.resume();await until(()=>signals.size===4);
 clock=31000;progresses.get('p1')(45);t.mock.timers.tick(10000);await until(async()=>(await queue.list()).every(row=>row.leaseUntil===121000));
 clock=61000;t.mock.timers.tick(10000);await until(async()=>(await queue.list()).filter(row=>row.state==='failed').length===3);
 assert.equal(signals.get('p1').aborted,false);for(const id of ['v1','p2','p3'])assert.equal(signals.get(id).aborted,true);assert.equal((await queue.list()).find(row=>row.id==='p1').progress,45);
 clock=92000;t.mock.timers.tick(10000);await until(async()=>(await queue.list()).every(row=>row.state==='failed'));assert.equal(signals.get('p1').aborted,true);
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
 let calls=0,signal,otherSignal,finishOther;const completed=[];
 const queue=create({indexedDB:new IDBFactory(),onSaved:r=>completed.push(r.id),send:async(item,save,progress,options)=>{if(item.id==='other'){otherSignal=options.signal;return new Promise(resolve=>finishOther=resolve);}calls++;if(calls===1){signal=options.signal;return new Promise(()=>{});}return {id:item.id};}});
 await queue.enqueue(job('same'));await until(()=>!!signal);await queue.enqueue(video('other'));await until(()=>!!otherSignal);await queue.retry('same');await until(()=>completed.length===1);assert.equal(signal.aborted,true);assert.equal(otherSignal.aborted,false);assert.equal(calls,2);
 finishOther({id:'other'});await until(()=>completed.length===2);
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
