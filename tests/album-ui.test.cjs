const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album.js','utf8');
const tick=()=>new Promise(setImmediate);
function harness(){
 const nodes={},revoked=[],requests=[],prepared=[];
 const make=()=>({hidden:false,disabled:false,value:'',textContent:'',style:{},attributes:{},childElementCount:0,classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this[k];},pause(){this.paused=true;},scrollIntoView(){},addEventListener(){}});
 const document={hidden:false,querySelector:s=>nodes[s]??=make(),querySelectorAll:s=>s==='[data-filter]'?['original','film','warm','mono','dazz'].map(p=>{const n=nodes[p]??=make();n.dataset={filter:p};return n;}):[]};
 class XHR{constructor(){this.upload={};requests.push(this);}open(method,url){this.url=url;}setRequestHeader(k,v){(this.headers??={})[k]=v;}send(f){this.sent=f;}abort(){this.onabort();}}
 document.querySelector('#guest-name');
 const config={title:'Reva & Cesar',count:0,uploadsOpen:true,revealed:true,filter:'film'};
 const context={document,window:{addEventListener(){}},location:{hash:'',pathname:'/album'},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>config}),URL:{createObjectURL:()=> 'blob:moment',revokeObjectURL:u=>revoked.push(u)},URLSearchParams,XMLHttpRequest:XHR,TemuAlbumCamera:{open(){}},TemuAlbumPhoto:{overlay:async()=>({src:'/art.png',naturalWidth:3,naturalHeight:1}),placement:()=>({x:0,y:700,width:1000,height:300}),prepare:async(f,filter,overlay,effect)=>{const result={name:'decorated.jpg',type:'image/jpeg',size:2000};prepared.push({f,filter,overlay,effect,result});return result;}},TemuAlbumUpload:require('../dist/album-upload.js'),crypto:require('node:crypto').webcrypto,AbortController,sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},setInterval(){},Date,AbortSignal};
 vm.runInNewContext(source,context);
 return {nodes,revoked,requests,prepared,context,run:s=>vm.runInNewContext(s,context),config};
}
test('discarding a preview stops playback, frees its URL and preserves guest details',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');h.nodes['#discard'].onclick();
 assert.equal(h.nodes['#upload'].disabled,true);assert.equal(h.nodes['#photo-preview'].hidden,true);assert.equal(h.nodes['#video-preview'].src,undefined);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.deepEqual(h.revoked,['blob:moment']);
});
test('upload locks capture and discard; abort keeps the captured file available to retry',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.nodes['#take-photo'].disabled,true);assert.equal(h.nodes['#discard'].disabled,true);await h.run('selectFile({name:"replacement.jpg",type:"image/jpeg",size:12})');assert.equal(h.run('file.name'),'camera.jpg');
 h.nodes['#cancel-upload'].onclick();assert.equal(h.nodes['#upload'].disabled,false);assert.equal(h.nodes['#take-photo'].disabled,false);assert.equal(h.run('file.name'),'camera.jpg');assert.match(h.nodes['#upload-state'].textContent,/dibatalkan/);
});
test('failed upload keeps preview and exposes error next to upload controls',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=503;h.requests[0].responseText=JSON.stringify({error:'Album sementara tidak tersedia.'});await h.requests[0].onload();
 assert.equal(h.nodes['#upload'].disabled,false);assert.equal(h.nodes['#upload-state'].hidden,false);assert.match(h.nodes['#upload-state'].textContent,/sementara/);assert.equal(h.nodes['#photo-preview'].hidden,false);
});
test('successful upload clears media but preserves name and updates album count',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"video.mov",type:"video/quicktime",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=201;h.requests[0].responseText=JSON.stringify({id:'a'});await h.requests[0].onload();
 assert.equal(h.run('file'),null);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.equal(h.nodes['#count'].textContent,1);assert.equal(h.nodes['#take-video'].disabled,false);assert.match(h.nodes['#upload-state'].textContent,/Terima kasih/);
});
test('oversized or unsupported camera result does not replace valid preview',async()=>{
 const h=harness();await tick();await h.run('selectFile({name:"valid.jpg",type:"image/jpeg",size:1024})');await h.run('selectFile({name:"huge.mp4",type:"video/mp4",size:200*1024*1024})');await h.run('selectFile({name:"unsupported.heic",type:"image/heic",size:1024})');
 assert.equal(h.run('file.name'),'valid.jpg');assert.equal(h.revoked.length,0);assert.equal(h.nodes['#photo-preview'].hidden,false);
});
test('gallery escapes guest text and preserves multiline caption',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';h.run('items=[{id:"a",name:"<img onerror=alert(1)>",caption:"first\\nsecond <script>",mime:"image/jpeg",filter:"film",created:"2026-11-21T12:00:00Z"}];next=null;renderGallery()');
 assert.ok(h.nodes['#grid'].innerHTML.includes('&lt;img onerror=alert(1)&gt;'));assert.ok(h.nodes['#grid'].innerHTML.includes('first\nsecond &lt;script&gt;'));assert.equal(h.nodes['#more'].hidden,true);
});

test('photo upload sends decorated bytes and avoids applying the chosen filter a second time',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');
 await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.requests[0].sent,h.prepared[0].result);assert.notEqual(h.requests[0].sent,h.run('file'));assert.match(h.prepared[0].filter,/sepia/);assert.equal(h.requests[0].headers['X-Album-Filter'],'original');
});
test('processing failure never uploads an undecorated photo and keeps capture for retry',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');
 h.context.TemuAlbumPhoto.prepare=async()=>{throw Error('Overlay unavailable');};await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.requests.length,0);assert.equal(h.run('file.name'),'camera.jpg');assert.equal(h.nodes['#upload'].disabled,false);assert.equal(h.nodes['#upload-state'].textContent,'Overlay unavailable');
});
test('photo preparation blocks repeated submission and capture until the result is ready',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');
 let done;h.context.TemuAlbumPhoto.prepare=()=>new Promise(resolve=>done=resolve);const first=h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.nodes['#take-photo'].disabled,true);assert.equal(h.nodes['#discard'].disabled,true);await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.requests.length,0);
 done({type:'image/jpeg'});await first;assert.equal(h.requests.length,1);
});
test('preview overlay follows the full portrait photo and disappears when switching to video',async()=>{
 const h=harness();await tick();await h.run('selectFile({name:"portrait.jpg",type:"image/jpeg",size:1024})');
 h.nodes['#photo-preview'].naturalWidth=1000;h.nodes['#photo-preview'].naturalHeight=1500;h.nodes['#photo-preview'].onload();
 assert.equal(h.nodes['#viewfinder'].style.aspectRatio,'1000/1500');assert.equal(h.nodes['#photo-overlay'].hidden,false);assert.equal(h.nodes['#photo-overlay'].src,'/art.png');
 await h.run('selectFile({name:"video.mov",type:"video/quicktime",size:1024})');assert.equal(h.nodes['#photo-overlay'].hidden,true);assert.equal(h.nodes['#viewfinder'].style.aspectRatio,'');
});

test('guest can choose a monogram or no overlay before upload and filters use English labels',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Reva';await h.run("chooseOverlay('none')");await h.run('selectFile({name:"capture.jpg",type:"image/jpeg",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});assert.equal(h.prepared[0].overlay,'none');
 const labels=fs.readFileSync('dist/album.html','utf8');assert.match(labels,/>Original</);assert.match(labels,/>Warm</);assert.match(labels,/Black &amp; White/);assert.match(labels,/Dazz Cam/);assert.match(labels,/No overlay/);
});
test('direct storage upload sends only signed headers and confirms before counting the moment',async()=>{
 const h=harness();await tick();h.config.storage='s3';h.nodes['#guest-name'].value='Bayu';
 let confirmed=false;h.context.fetch=async(path,options)=>({ok:true,json:async()=>path.endsWith('/uploads')?{id:'ticket',token:'complete-token',url:'https://storage.example/staging?signature=test',headers:{'Content-Type':'video/mp4'}}:(confirmed=true,{id:'ticket'})});
 await h.run('selectFile({name:"clip.mp4",type:"video/mp4",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.requests[0].url,'https://storage.example/staging?signature=test');assert.deepEqual(h.requests[0].headers,{'Content-Type':'video/mp4'});assert.equal(h.config.count,0);assert.equal(confirmed,false);
 h.requests[0].status=200;h.requests[0].responseText='';await h.requests[0].onload();assert.equal(confirmed,true);assert.equal(h.config.count,1);
});
test('failed storage finalization keeps camera capture and does not count unfinished objects',async()=>{
 const h=harness();await tick();h.config.storage='s3';h.nodes['#guest-name'].value='Bayu';h.context.fetch=async(path)=>({ok:path.endsWith('/uploads'),status:path.endsWith('/uploads')?200:415,json:async()=>path.endsWith('/uploads')?{id:'t',token:'x',url:'https://storage.example/u',headers:{'Content-Type':'video/mp4'}}:{error:'File belum lengkap.'}});
 await h.run('selectFile({name:"clip.mp4",type:"video/mp4",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=200;await h.requests[0].onload();assert.equal(h.config.count,0);assert.equal(h.run('file.name'),'clip.mp4');assert.match(h.nodes['#upload-state'].textContent,/belum lengkap/);assert.equal(h.nodes['#upload'].disabled,false);
});
