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
