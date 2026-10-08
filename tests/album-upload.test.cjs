const {test}=require('node:test'),assert=require('node:assert/strict');
const transport=require('../dist/album-upload.js');
test('180 simultaneous clients retry with different backoff without losing their operation',async()=>{
 const delays=[],results=await Promise.all(Array.from({length:180},(_,id)=>{let attempts=0;return transport.retry(async()=>{if(!attempts++){const e=Error('busy');e.status=429;e.retryAfter=6;throw e;}return id;},{random:()=>id/180,wait:async ms=>delays.push(ms)});}));
 assert.equal(results.length,180);assert.equal(new Set(results).size,180);assert.equal(new Set(delays).size,180);assert.ok(Math.min(...delays)>=4800);assert.ok(Math.max(...delays)<=7200);
});
test('queue completion is polled without reuploading bytes or creating another ticket',async()=>{
 const paths=[];let polls=0;const result=await transport.settled({id:'existing',token:'secret'},async(path,body)=>{paths.push(path);assert.equal(body.token,'secret');return path.endsWith('/complete')||polls++===0?{pending:true,retryAfter:6}:{id:'existing'};},{wait:async()=>{},random:()=>.5});
 assert.equal(result.id,'existing');assert.deepEqual(paths,['uploads/existing/complete','uploads/existing/status','uploads/existing/status']);
});
test('quota errors are terminal and waiting can be cancelled',async()=>{
 let calls=0;await assert.rejects(transport.retry(async()=>{calls++;const e=Error('full');e.status=413;throw e;}),/full/);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(transport.retry(async()=>{}, {signal:controller.signal}),{name:'AbortError'});
});
