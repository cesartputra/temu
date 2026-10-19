const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album.js','utf8'),tick=()=>new Promise(setImmediate);
function harness({lightroom=[]}={}){
 const nodes={},revoked=[],queued=[],timers=[],shared=[],events={},saves=[];let queueOptions;
 const make=()=>({hidden:false,disabled:false,value:'',textContent:'',style:{},attributes:{},childElementCount:0,classList:{toggle(){},add(){},remove(){}},setCustomValidity(v){this.validationMessage=v;},reportValidity(){},getBoundingClientRect:()=>({width:360,height:480}),focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;this.listeners?.close?.();},getAttribute(k){return this[k]??null;},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this[k];},pause(){},click(){this.clicked=true;},addEventListener(name,fn){(this.listeners??={})[name]=fn;},querySelectorAll(){return [];}});
 const document={body:make(),hidden:false,addEventListener:(name,fn)=>events[name]=fn,querySelector:s=>nodes[s]??=make(),querySelectorAll:s=>s==='[data-filter]'?['original','film','warm','mono','dazz'].map(filter=>Object.assign(nodes[filter]??=make(),{dataset:{filter}})):s==='[data-story-overlay]'?['celebration','monogram','none'].map(storyOverlay=>Object.assign(nodes[storyOverlay]??=make(),{dataset:{storyOverlay}})):[]};
 const config={title:'Reva & Cesar',count:0,uploadsOpen:true,revealed:true,filter:'film',storage:'s3'};
 const context={TemuAlbumLoading:require('../dist/album-loading.js'),document,window:{matchMedia:()=>({matches:false}),addEventListener:(name,fn)=>events[name]=fn},navigator:{canShare:()=>true,share:async value=>shared.push(value)},setTimeout(fn,ms){timers.push({fn,ms});},location:{hash:'',pathname:'/album'},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>config,blob:async()=>new Blob(['original bytes'])}),URL:{createObjectURL:()=> 'blob:moment',revokeObjectURL:u=>revoked.push(u)},URLSearchParams,TemuAlbumPresets:{load:async()=>lightroom,has:id=>lightroom.some(p=>p.id===id),get:id=>lightroom.find(p=>p.id===id)},TemuAlbumPhoto:{preview:async()=>new Blob(['filtered preview'],{type:'image/png'}),story:async()=>new Blob(['story'],{type:'image/png'}),thumbnail:async()=>new Blob(['thumbnail'],{type:'image/jpeg'})},TemuAlbumUpload:require('../dist/album-upload.js'),TemuAlbumQueue:{create(options){queueOptions=options;return {pause(){},resume:async()=>{},enqueue:async job=>queued.push(job),retry:async()=>{},discard:async()=>{}};}},crypto:require('node:crypto').webcrypto,AbortController,sessionStorage:{getItem(){return null;},removeItem(){}},setInterval(){},Date,AbortSignal,Blob,confirm:()=>true};
 context.clearTimeout=()=>{};context.intervals=[];context.setInterval=(fn,ms)=>context.intervals.push({fn,ms});
 vm.runInNewContext(source,context);return {nodes,revoked,queued,timers,shared,events,saves,context,config,get queueOptions(){return queueOptions;},run:s=>vm.runInNewContext(s,context)};
}
test('photo and video buttons invoke native capture inputs; canceling retake preserves the previous photo',async()=>{
 const h=harness();await tick();h.nodes['#take-photo'].onclick();assert.equal(h.nodes['#native-photo'].clicked,true);
 h.run('selectFile({name:"original.jpg",type:"image/jpeg",size:1024})');h.nodes['#discard'].onclick();assert.equal(h.run('file.name'),'original.jpg');assert.equal(h.nodes['#caption-dialog'].open,false);
 h.nodes['#native-photo'].onchange({target:{files:[]}});assert.equal(h.run('file.name'),'original.jpg');h.nodes['#take-video'].onclick();assert.equal(h.nodes['#native-video'].clicked,true);
 const html=fs.readFileSync('dist/album.html','utf8');assert.match(html,/id="native-photo"[^>]*accept="image\/\*" capture="environment"/);assert.match(html,/id="native-video"[^>]*accept="video\/\*" capture="environment"/);assert.doesNotMatch(html,/camera-live|album-camera\.js|data-overlay=/);
});
test('capture shows preview first; only the share button opens the optional caption',async()=>{
 const h=harness();await tick();h.run('selectFile({name:"photo.jpg",type:"image/jpeg",size:1024})');
 assert.equal(h.nodes['#photo-preview'].hidden,false);assert.equal(h.nodes['#capture-review'].hidden,false);assert.equal(h.nodes['#review-capture'].hidden,false);assert.notEqual(h.nodes['#caption-dialog'].open,true);assert.equal(h.queued.length,0);
 h.nodes['#review-capture'].onclick();assert.equal(h.nodes['#caption-dialog'].open,true);h.nodes['#close-caption'].onclick();assert.equal(h.run('file.name'),'photo.jpg');
 h.run('selectFile({name:"clip.mp4",type:"video/mp4",size:1024})');assert.notEqual(h.nodes['#caption-dialog'].open,true);assert.equal(h.nodes['#video-preview'].hidden,false);
});
test('enqueue stores original file and selected metadata, closes the dialog and permits the next capture during upload',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.context.document.querySelector('#caption').value='Hello';h.run('selectFile({name:"original.jpg",type:"image/jpeg",size:1024})');const original=h.run('file');
 await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.queued[0].blob,original);assert.equal(h.queued[0].filter,'film');assert.equal(h.queued[0].caption,'Hello');assert.match(h.queued[0].id,/^[a-f0-9]{32}$/);assert.equal(h.run('file'),null);assert.equal(h.nodes['#caption-dialog'].open,false);
 h.queueOptions.onChange([{id:'x',state:'uploading',name:'Bayu',progress:20}]);assert.equal(h.nodes['#take-photo'].disabled,false);h.nodes['#take-photo'].onclick();assert.equal(h.nodes['#native-photo'].clicked,true);
 h.run('selectFile({name:"second.jpg",type:"image/jpeg",size:2048});choosePreset("mono")');assert.equal(h.queued[0].filter,'film');assert.equal(h.run('file.name'),'second.jpg');
});
test('persistence failure retains the captured file and repeated submission is blocked only while enqueue is pending',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.run('selectFile({name:"original.jpg",type:"image/jpeg",size:1024})');
 let reject;h.run('outbox.enqueue=()=>new Promise((resolve,fail)=>globalThis.rejectEnqueue=fail)');const submission=h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.nodes['#take-photo'].disabled,true);await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.queued.length,0);
 h.context.rejectEnqueue(Error('Quota exceeded'));await submission;assert.equal(h.run('file.name'),'original.jpg');assert.equal(h.nodes['#take-photo'].disabled,false);assert.match(h.nodes['#upload-state'].textContent,/Quota exceeded/);
});
test('S3 transfer uses original bytes, frozen filter metadata and only signed PUT headers, then saves thumbnail separately',async()=>{
 const h=harness();await tick();const requests=[],puts=[],patches=[];
 const original=new Blob(['raw original photo bytes'],{type:'image/jpeg'});h.context.original=original;h.context.patches=patches;
 h.context.fetch=async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path.endsWith('/uploads')?{id:'remote',token:'token',url:'https://s3.example/upload',headers:{'Content-Type':'image/jpeg'}}:{id:'remote',thumbnailKey:'thumbnail-token'}};};
 h.context.capturePut=(...args)=>{puts.push(args);return null;};h.run('putFile=async(...args)=>capturePut(...args)');
 const result=await h.run('sendQueued({id:"stable",blob:original,name:"Guest",caption:"hello",filter:"mono"},async patch=>globalThis.patches.push(patch),()=>{})');
 assert.equal(puts[0][2],original);assert.deepEqual(Object.keys(puts[0][1]),['Content-Type']);assert.equal(JSON.parse(requests[0].options.body).filter,'mono');assert.equal(JSON.parse(requests[0].options.body).requestId,'stable');assert.equal(puts.length,1);assert.equal(result.id,'remote');assert.ok(!requests.some(r=>r.path.includes('/thumbnail/')));
});
test('recovered server jobs are polled without PUT, and published originals only need their thumbnail',async()=>{
 const h=harness();await tick();const paths=[];h.context.original=new Blob(['original'],{type:'image/jpeg'});
 h.run('putFile=()=>{throw Error("must not upload twice")}');
 h.context.fetch=async path=>{paths.push(path);return {ok:true,json:async()=>path.endsWith('/uploads')?{id:'same',token:'token',pending:true,state:'running'}:{id:'same',thumbnailKey:'thumb'}};};
 const result=await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film"},async()=>{},()=>{})');
 assert.equal(result.id,'same');assert.ok(paths.includes('/api/album/uploads/same/status'));assert.ok(!paths.includes('/api/album/uploads/same/complete'));assert.ok(!paths.includes('/api/album/thumbnail/same'));
 paths.length=0;await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film",result:{id:"same",thumbnailKey:"thumb"}},async()=>{},()=>{})');
 assert.deepEqual(paths,[]);
});
test('a published photo completes even when the phone cannot decode it for a thumbnail',async()=>{
 const h=harness();await tick();h.context.original=new Blob(['camera original'],{type:'image/jpeg'});h.context.TemuAlbumPhoto.thumbnail=()=>assert.fail('thumbnail must be generated on the server');
 h.context.fetch=async path=>({ok:true,json:async()=>path.endsWith('/uploads')?{id:'saved',token:'token',url:'https://storage/part',headers:{}}:{id:'saved',thumbnailKey:'key'}});h.run('putFile=async()=>{}');
 const result=await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film"},async()=>{},()=>{})');assert.equal(result.id,'saved');
});
test('a direct network failure switches the same ticket and original to the bounded same-origin relay',async()=>{
 const h=harness();await tick();const puts=[],patches=[];h.context.original=new Blob(['unchanged original'],{type:'image/jpeg'});
 h.context.fetch=async path=>({ok:true,json:async()=>path.endsWith('/uploads')?{id:'same',token:'private-ticket',url:'https://storage/part',headers:{'Content-Type':'image/jpeg'}}:{id:'same',thumbnailKey:'thumb'}});
 h.context.upload=async(...args)=>{puts.push(args);if(args[0].startsWith('https:'))throw Object.assign(Error('No progress'),{status:0});};h.context.save=async patch=>patches.push(patch);h.run('putFile=upload');
 const result=await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film"},save,()=>{})');
 assert.equal(result.id,'same');assert.equal(puts.length,2);assert.equal(puts[1][0],'/api/album/uploads/same/part');assert.equal(puts[1][1]['X-Album-Upload-Token'],'private-ticket');assert.equal(puts[1][2],h.context.original);assert.ok(patches.some(p=>p.transport==='relay'));
 puts.length=0;await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film",transport:"relay"},save,()=>{})');assert.equal(puts.length,1);assert.equal(puts[0][0],'/api/album/uploads/same/part');
});
test('direct transfers release a silent connection after 15 seconds and watch advancing bytes rather than repeated zero progress',async()=>{
 const h=harness();await tick();let xhr;h.context.XMLHttpRequest=class{
  constructor(){xhr=this;this.upload={};}open(){assert.equal(typeof this.upload.onprogress,'function');}setRequestHeader(){}send(){}abort(){this.aborted=true;this.onabort?.();}
 };
 const first=h.run('putFile("https://storage/part",{},new Blob(["original"]),()=>{},{direct:true})');const rejected=assert.rejects(first,error=>error.status===0);let timer=h.timers.at(-1);assert.equal(timer.ms,15000);
 xhr.upload.onprogress({lengthComputable:true,loaded:0,total:100});assert.equal(h.timers.at(-1),timer);timer.fn();await rejected;assert.equal(xhr.aborted,true);
 const next=h.run('putFile("https://storage/part",{},new Blob(["original"]),()=>{},{direct:true})');xhr.upload.onprogress({lengthComputable:true,loaded:10,total:100});timer=h.timers.at(-1);assert.equal(timer.ms,30000);xhr.upload.onprogress({lengthComputable:true,loaded:10,total:100});assert.equal(h.timers.at(-1),timer);xhr.status=200;xhr.responseText='';xhr.onload();await next;
});
test('canceling a direct transfer never starts a relay',async()=>{
 const h=harness();await tick();let puts=0;const controller=new AbortController();h.context.signal=controller.signal;h.context.original=new Blob(['original'],{type:'image/jpeg'});
 h.context.fetch=async()=>({ok:true,json:async()=>({id:'same',token:'token',url:'https://storage/part',headers:{}})});
 h.context.stop=()=>{puts++;controller.abort();throw Object.assign(Error('aborted'),{status:0});};h.run('putFile=async()=>stop()');
 await assert.rejects(h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film"},async()=>{},()=>{},{signal})'));assert.equal(puts,1);
});
test('an expired uploaded ticket reuploads the retained original only when the server returns a different ticket',async()=>{
 const h=harness();await tick();const puts=[],patches=[];h.context.original=new Blob(['original'],{type:'image/jpeg'});
 h.context.fetch=async path=>({ok:true,json:async()=>path.endsWith('/uploads')?{id:'renewed',token:'token',url:'https://storage/renewed',headers:{'Content-Type':'image/jpeg'}}:{id:'renewed',thumbnailKey:'thumb'}});
 h.context.recordPut=(...args)=>puts.push(args);h.context.recordPatch=patch=>patches.push(patch);h.run('putFile=async(...args)=>recordPut(...args)');
 await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film",stage:"uploaded",ticket:{id:"expired"}},recordPatch,()=>{})');
 assert.equal(puts.length,1);assert.equal(puts[0][2],h.context.original);assert.ok(patches.some(p=>p.stage===null));assert.ok(patches.some(p=>p.stage==='uploaded'));
});
test('an expired signed PUT URL is reconciled with the same request ID before one fresh transfer attempt',async()=>{
 const h=harness();await tick();const ids=[];let tickets=0,puts=0;h.context.original=new Blob(['original'],{type:'image/jpeg'});
 h.context.fetch=async(path,options)=>{if(path.endsWith('/uploads')){tickets++;ids.push(JSON.parse(options.body).requestId);}return {ok:true,json:async()=>path.endsWith('/uploads')?{id:'ticket'+tickets,token:'token',url:'https://storage/upload',headers:{}}:{id:'ticket2',thumbnailKey:'thumb'}};};
 h.context.transfer=async()=>{if(++puts===1)throw Object.assign(Error('expired'),{status:403});};h.run('putFile=transfer');
 const result=await h.run('sendQueued({id:"stable",blob:original,name:"Guest",filter:"film"},async()=>{},()=>{})');assert.deepEqual(ids,['stable','stable']);assert.equal(puts,2);assert.equal(result.id,'ticket2');
});
test('retry can cancel the real XHR and the underlying metadata fetch',async()=>{
 const h=harness();await tick();const requests=[];
 h.context.XMLHttpRequest=class{constructor(){this.upload={};requests.push(this);}open(){}setRequestHeader(){}send(){}abort(){this.aborted=true;this.onabort?.();}};
 h.context.controller=new AbortController();h.context.original=new Blob(['bytes']);
 const transfer=h.run('putFile("https://storage/part",{},original,()=>{},{signal:controller.signal})');h.context.controller.abort();await assert.rejects(transfer,{name:'AbortError'});assert.equal(requests[0].aborted,true);
 h.context.controller=new AbortController();h.context.fetch=async(path,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));
 const api=h.run('api("uploads",{name:"Guest"},{signal:controller.signal})');h.context.controller.abort();await assert.rejects(api,{name:'AbortError'});
});
test('queue shows waiting versus transfer phases and exposes retry for active moments',async()=>{
 const h=harness();await tick();h.run('renderQueue([{id:"one",name:"Guest",state:"uploading",phase:"ticket",progress:0},{id:"two",name:"Guest",state:"queued"}])');
 assert.match(h.nodes['#queue-items'].innerHTML,/Meminta giliran/);assert.doesNotMatch(h.nodes['#queue-items'].innerHTML,/Mengunggah 0/);assert.match(h.nodes['#queue-items'].innerHTML,/data-retry="one"/);
 h.run('renderQueue([{id:"one",name:"Guest",state:"uploading",phase:"waiting"}])');assert.match(h.nodes['#queue-items'].innerHTML,/Menunggu server/);
 h.run('renderQueue([{id:"one",name:"Guest",state:"uploading",phase:"uploading",progress:42}])');assert.match(h.nodes['#queue-items'].innerHTML,/Mengunggah 42%/);
});
test('camera/background events keep active transfers, while offline cancels them; returning resumes the outbox',async()=>{
 const h=harness();await tick();const paused=[];let resumed=0;h.context.paused=cancel=>paused.push(cancel);h.context.resumed=()=>resumed++;
 h.run('outbox.pause=paused;outbox.resume=async()=>resumed()');
 h.events.pagehide();h.events.offline();h.context.document.hidden=true;h.events.visibilitychange();assert.deepEqual(paused,[undefined,true,undefined]);
 h.context.document.hidden=false;h.events.visibilitychange();await tick();assert.equal(resumed,1);
});
test('finishing or cancelling native capture resumes uploads even without a visibility event',async()=>{
 const h=harness();await tick();let paused=0,resumed=0;h.context.paused=()=>paused++;h.context.resumed=()=>resumed++;
 h.run('outbox.pause=paused;outbox.resume=async()=>resumed()');
 h.nodes['#take-photo'].onclick();h.nodes['#native-photo'].listeners.cancel();
 h.nodes['#take-video'].onclick();h.nodes['#native-video'].onchange({target:{files:[]}});
 h.events.focus();await tick();assert.equal(paused,2);assert.equal(resumed,3);
});
test('capturing the next photo keeps the same live XHR and publishes both originals exactly once',async()=>{
 const h=harness();await tick();const transfers=[],completed=[];let tickets=0;
 const until=async check=>{for(let n=0;n<100;n++){if(await check())return;await tick();}assert.fail('uploads did not settle');};
 h.context.XMLHttpRequest=class{
  constructor(){this.upload={};}open(){}setRequestHeader(){}send(blob){this.blob=blob;transfers.push(this);}
  abort(){this.aborted=true;this.onabort?.();}
 };
 h.context.fetch=async path=>({ok:true,json:async()=>path.endsWith('/uploads')?{id:'remote'+(++tickets),token:'token',url:'https://storage/upload',headers:{}}:{id:path.split('/')[4],thumbnailKey:'thumb'}});
 const queue=require('../dist/album-queue.js').create({indexedDB:new(require('fake-indexeddb').IDBFactory)(),send:h.queueOptions.send,onChange:h.queueOptions.onChange,onSaved:r=>completed.push(r.id)});
 h.context.realQueue=queue;h.run('outbox.enqueue=job=>realQueue.enqueue(job);outbox.pause=cancel=>realQueue.pause(cancel);outbox.resume=()=>realQueue.resume()');
 const first=new Blob(['first original'],{type:'image/jpeg'}),second=new Blob(['second original'],{type:'image/jpeg'});
 h.nodes['#guest-name'].value='Guest';h.context.first=first;h.run('selectFile(first)');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});await until(()=>transfers.length===1);
 transfers[0].upload.onprogress({lengthComputable:true,loaded:6,total:10});h.nodes['#take-photo'].onclick();h.context.document.hidden=true;h.events.visibilitychange();h.events.pagehide();
 h.context.document.hidden=false;h.nodes['#native-photo'].onchange({target:{files:[second]}});h.events.visibilitychange();
 await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(transfers.length,1);assert.notEqual(transfers[0].aborted,true);assert.equal((await queue.list())[0].progress,60);
 transfers[0].status=200;transfers[0].onload();await until(()=>transfers.length===2);
 transfers[1].status=200;transfers[1].onload();await until(()=>completed.length===2);
 assert.deepEqual(completed,['remote1','remote2']);assert.equal(await transfers[0].blob.text(),'first original');assert.equal(await transfers[1].blob.text(),'second original');assert.deepEqual(await queue.list(),[]);
});
test('gallery uses only thumbnails and never requests full photo bytes for a missing thumbnail',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';h.run('items=[{id:"a",name:"Guest <img>",mime:"image/jpeg",filter:"film",thumbnail:true},{id:"b",name:"Other",mime:"image/jpeg",filter:"original",thumbnail:false}];next=null;renderGallery()');
 const html=h.nodes['#grid'].innerHTML;assert.match(html,/\/a\?thumb=1/);assert.doesNotMatch(html,/file\/b/);assert.match(html,/PREVIEW BELUM TERSEDIA/);assert.match(html,/&lt;img&gt;/);
});
test('server thumbnail progress displays a loader and automatically refreshes the visible first page',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';h.run('items=[{id:"saved",name:"Guest",mime:"image/jpeg",filter:"film",thumbnail:false,thumbnailPending:true}];renderGallery()');
 assert.match(h.nodes['#grid'].innerHTML,/album-spinner/);assert.match(h.nodes['#grid'].innerHTML,/PRATINJAU DIPROSES/);assert.doesNotMatch(h.nodes['#grid'].innerHTML,/file\/saved/);
 h.context.refreshes=0;h.run('loadGallery=async()=>{refreshes++};document.hidden=false');h.nodes['#gallery'].hidden=false;const timer=h.context.intervals.find(t=>t.ms===10000);timer.fn();assert.equal(h.context.refreshes,1);
 h.nodes['#gallery'].hidden=true;timer.fn();assert.equal(h.context.refreshes,1);
});
test('gallery recovers from a busy API without clearing existing moments; writes are not implicitly replayed',async()=>{
 const h=harness();await tick();let calls=0;const waits=[];
 h.context.TemuAlbumUpload={...h.context.TemuAlbumUpload,retry:(task,options)=>require('../dist/album-upload.js').retry(task,{...options,random:()=>0,wait:async ms=>waits.push(ms)})};
 h.context.fetch=async()=>++calls===1?{ok:false,status:503,headers:{get:()=> '2'},json:async()=>({error:'busy'})}:{ok:true,json:async()=>({items:[{id:'new'}],next:null})};
 const result=await h.run('api("items?offset=0")');assert.equal(result.items[0].id,'new');assert.equal(calls,2);assert.equal(waits[0],2000);
 calls=0;h.context.fetch=async()=>{calls++;return {ok:false,status:503,json:async()=>({error:'busy'})};};
 await assert.rejects(h.run('api("uploads",{name:"Guest"})'),/busy/);assert.equal(calls,1);
 h.context.fetch=async()=>({ok:false,status:403,json:async()=>({error:'expired'})});
 await assert.rejects(h.run('api("items")'),/expired/);
});
test('timeout after response headers remains retryable and user cancellation is preserved',async()=>{
 const h=harness();await tick();let attempts=0;const waits=[];let timer;
 h.context.AbortSignal={timeout(){timer=new AbortController();return timer.signal;}};
 h.context.TemuAlbumUpload={...h.context.TemuAlbumUpload,retry:(task,options)=>require('../dist/album-upload.js').retry(task,{...options,random:()=>0,wait:async ms=>waits.push(ms)})};
 h.context.fetch=async()=>({ok:true,json:async()=>{
  if(++attempts===1){const error=new DOMException('Body timed out','TimeoutError');timer.abort(error);throw error;}
  return {items:[]};
 }});
 assert.equal((await h.run('api("items?offset=0")')).items.length,0);assert.equal(attempts,2);assert.deepEqual(waits,[1500]);
 const controller=new AbortController();h.context.userSignal=controller.signal;
 h.context.fetch=async()=>({ok:true,json:async()=>{controller.abort(new DOMException('User cancelled','AbortError'));throw controller.signal.reason;}});
 await assert.rejects(h.run('api("uploads",{name:"Guest"},{signal:userSignal})'),{name:'AbortError',message:'User cancelled'});
});
test('detail downloads original file and opens a Story composer with the full original, not the thumbnail',async()=>{
 const h=harness();await tick();h.run('items=[{id:"a",name:"<Guest>",caption:"Line1\\nLine2 <script>",created:"2026-11-21T12:00:00Z",mime:"image/jpeg",filter:"film"}]');
 h.nodes['#grid'].onclick({target:{closest:()=>({dataset:{id:'a'}})}});const html=h.nodes['#moment-detail'].innerHTML;assert.match(html,/file\/a\?download=1/);assert.match(html,/id="open-story"/);assert.match(html,/&lt;script&gt;/);
 let fetched;h.context.fetch=async path=>{fetched=path;return {ok:true,blob:async()=>new Blob(['original'])};};await h.nodes['#open-story'].onclick();assert.equal(fetched,'/api/album/file/a');assert.equal(h.nodes['#story-dialog'].open,true);assert.equal(h.nodes['#moment-dialog'].open,false);assert.equal(h.nodes['#share-story'].disabled,false);
 await h.nodes['#share-story'].onclick();assert.equal(h.shared[0].files[0],h.run('storyFile'));assert.equal(h.shared[0].url,undefined);
});
test('unsupported file sharing keeps a downloadable Story and closing cleans up its object URL',async()=>{
 const h=harness();await tick();h.context.navigator.canShare=()=>false;await h.run('openStory({id:"a",filter:"original"})');assert.equal(h.nodes['#share-story'].disabled,true);assert.equal(h.nodes['#download-story'].hidden,false);assert.match(h.nodes['#story-status'].textContent,/Unduh Story/);
 h.nodes['#close-story'].onclick();assert.ok(h.revoked.includes('blob:moment'));assert.equal(h.run('storySource'),null);
});
test('video preview uses compressed playback but download remains original',async()=>{
 const h=harness();await tick();h.run('items=[{id:"v",name:"Guest",caption:"",created:"2026-11-21T12:00:00Z",mime:"video/mp4",filter:"original"}]');h.nodes['#grid'].onclick({target:{closest:()=>({dataset:{id:'v'}})}});
 assert.match(h.nodes['#moment-detail'].innerHTML,/v\?preview=1/);assert.match(h.nodes['#moment-detail'].innerHTML,/v\?download=1/);assert.doesNotMatch(h.nodes['#moment-detail'].innerHTML,/open-story/);
});
test('name and envelope flows remain separate and do not open a camera automatically',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='  ';h.nodes['#name-form'].onsubmit({preventDefault(){}});assert.ok(h.nodes['#guest-name'].validationMessage);h.nodes['#guest-name'].value='  Bayu  ';h.nodes['#name-form'].onsubmit({preventDefault(){}});assert.equal(h.nodes['#capture'].hidden,false);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.equal(h.nodes['#native-photo'].clicked,undefined);
 h.nodes['#open-cover'].onclick();h.nodes['#open-cover'].onclick();assert.equal(h.timers.length,1);h.timers[0].fn();assert.equal(h.nodes['#album-app'].inert,false);
});
test('close/reload icons stay inside buttons and capture has no overlay choices',()=>{
 const html=fs.readFileSync('dist/album.html','utf8'),css=fs.readFileSync('dist/album.css','utf8');
 for(const id of ['close-caption','close-dialog','close-story','refresh'])assert.match(html,new RegExp('id="'+id+'"[^>]*><svg'));
 const capture=html.slice(html.indexOf('<section id="capture"'),html.indexOf('<section id="gallery"'));assert.doesNotMatch(capture,/overlay|Pilih bingkai/);assert.match(capture,/Pilih filter/);
 for(const [,selectors,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))if(selectors.split(',').some(s=>['button','.tabs button','.icon-button'].includes(s.trim())))assert.doesNotMatch(body,/aspect-ratio/);
});

test('Selfie defaults to mirrored photo, queues the actual mirrored file, and resets only after enqueue succeeds',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Guest';h.nodes['#take-selfie'].onclick();assert.equal(h.nodes['#native-photo'].attributes.capture,'user');
 const original={name:'selfie.jpg',type:'image/jpeg',size:1024},mirrored={name:'selfie.jpg',type:'image/jpeg',size:1024};h.nodes['#native-photo'].onchange({target:{files:[original]}});
 assert.equal(h.run('mirrorPhoto'),true);assert.equal(h.nodes['#photo-preview'].style.transform,'scaleX(-1)');assert.equal(h.nodes['#mirror-photo'].hidden,false);
 h.context.TemuAlbumPhoto.mirror=async source=>{assert.equal(source,original);return mirrored;};await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.queued[0].blob,mirrored);assert.equal(h.run('mirrorPhoto'),false);assert.equal(h.nodes['#photo-preview'].style.transform,'');
});
test('mirror can be corrected when native camera already mirrors, and retake keeps selfie preference',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Guest';h.nodes['#take-selfie'].onclick();h.nodes['#native-photo'].onchange({target:{files:[{name:'selfie.jpg',type:'image/jpeg',size:1024}]}});
 h.nodes['#mirror-photo'].onclick();assert.equal(h.run('mirrorPhoto'),false);h.nodes['#retake-capture'].onclick();assert.equal(h.nodes['#native-photo'].attributes.capture,'user');
 h.context.TemuAlbumPhoto.mirror=()=>assert.fail('Mirror is explicitly off');const original=h.run('file');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.queued[0].blob,original);
 h.nodes['#take-photo'].onclick();assert.equal(h.nodes['#native-photo'].attributes.capture,'environment');h.nodes['#native-photo'].onchange({target:{files:[original]}});assert.equal(h.run('mirrorPhoto'),false);
});
test('mirror processing error retains source and preview for correction or retry',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Guest';h.run('selectFile({name:"selfie.jpg",type:"image/jpeg",size:1024},true)');h.context.TemuAlbumPhoto.mirror=async()=>{throw Error('Mirror unavailable');};
 await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.queued.length,0);assert.equal(h.run('file.name'),'selfie.jpg');assert.equal(h.run('mirrorPhoto'),true);assert.match(h.nodes['#upload-state'].textContent,/Mirror unavailable/);assert.equal(h.nodes['#take-selfie'].disabled,false);
});

test('Lightroom selection queues original bytes and preset ID; video returns to Classic',async()=>{
 const h=harness({lightroom:[{id:'lr-fuji1',name:'Fuji 1',family:'Fuji'}]});await tick();
 h.run('selectFile({name:"photo.jpg",type:"image/jpeg",size:1024});choosePreset("lr-fuji1")');await tick();
 assert.equal(h.nodes['#filter-family'].value,'Fuji');assert.equal(h.nodes['#preview-label'].textContent,'PREVIEW · FUJI 1');
 const original=h.run('file');h.nodes['#guest-name'].value='Guest';await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.queued[0].blob,original);assert.equal(h.queued[0].filter,'lr-fuji1');
 h.run('selectFile({name:"clip.mp4",type:"video/mp4",size:1024});choosePreset("lr-fuji1")');
 assert.equal(h.run('preset'),'original');assert.equal(h.nodes['#filter-family'].value,'Classic');assert.match(h.nodes['#filter-note'].textContent,/tersedia untuk foto/);
});

test('an old asynchronous preset preview never replaces a newer photo or filter',async()=>{
 const h=harness({lightroom:[{id:'lr-fuji1',name:'Fuji 1',family:'Fuji'}]});await tick();let finish;
 h.context.TemuAlbumPhoto.preview=()=>new Promise(resolve=>finish=resolve);
 h.run('selectFile({name:"first.jpg",type:"image/jpeg",size:1024});choosePreset("lr-fuji1")');await tick();
 h.run('selectFile({name:"second.jpg",type:"image/jpeg",size:1024});choosePreset("original")');
 const src=h.nodes['#photo-preview'].src;finish(new Blob(['old filtered image']));await tick();
 assert.equal(h.nodes['#photo-preview'].src,src);assert.equal(h.run('file.name'),'second.jpg');assert.equal(h.run('preset'),'original');
});
