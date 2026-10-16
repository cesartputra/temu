const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album.js','utf8');
const tick=()=>new Promise(setImmediate);
function harness(){
 const nodes={},revoked=[],requests=[],prepared=[],timers=[];
 const make=()=>({hidden:false,disabled:false,value:'',textContent:'',style:{},attributes:{},childElementCount:0,classList:{toggle(){},add(){},remove(){}},setCustomValidity(v){this.validationMessage=v;},reportValidity(){},getBoundingClientRect:()=>({width:360,height:480}),focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},getAttribute(k){return this[k]??null;},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this[k];},pause(){this.paused=true;},scrollIntoView(){},addEventListener(){},querySelectorAll(){return [];}});
 const document={body:make(),hidden:false,querySelector:s=>nodes[s]??=make(),querySelectorAll:s=>s==='[data-filter]'?['original','film','warm','mono','dazz'].map(p=>{const n=nodes[p]??=make();n.dataset={filter:p};return n;}):[]};
 class XHR{constructor(){this.upload={};requests.push(this);}open(method,url){this.url=url;}setRequestHeader(k,v){(this.headers??={})[k]=v;}send(f){this.sent=f;}abort(){this.onabort();}}
 document.querySelector('#guest-name');
 const config={title:'Reva & Cesar',count:0,uploadsOpen:true,revealed:true,filter:'film'};
 const context={TemuAlbumLoading:require('../dist/album-loading.js'),document,window:{matchMedia(){return {matches:false};},addEventListener(){}},setTimeout(fn,ms){timers.push({fn,ms});},location:{hash:'',pathname:'/album'},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>config}),URL:{createObjectURL:()=> 'blob:moment',revokeObjectURL:u=>revoked.push(u)},URLSearchParams,XMLHttpRequest:XHR,TemuAlbumCamera:{isActive:()=>false,isRecording:()=>false,frame:()=>({width:1080,height:1440}),layout(){},close(){},open(){}},TemuAlbumPhoto:{overlay:async style=>style==='none'?null:({src:'/art.png',naturalWidth:3,naturalHeight:1}),placement:()=>({x:0,y:700,width:1000,height:300}),prepare:async(f,filter,overlay,effect)=>{const result={name:'decorated.jpg',type:'image/jpeg',size:2000};prepared.push({f,filter,overlay,effect,result});return result;}},TemuAlbumUpload:require('../dist/album-upload.js'),crypto:require('node:crypto').webcrypto,AbortController,sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},setInterval(){},Date,AbortSignal};
 vm.runInNewContext(source,context);
 return {nodes,revoked,requests,prepared,timers,context,run:s=>vm.runInNewContext(s,context),config};
}
test('retaking preserves the previous photo until a replacement is captured',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');h.nodes['#discard'].onclick();
 assert.equal(h.run('file.name'),'camera.jpg');assert.equal(h.nodes['#caption-dialog'].open,false);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.deepEqual(h.revoked,[]);
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
 assert.ok(h.nodes['#grid'].innerHTML.includes('&lt;img onerror=alert(1)&gt;'));assert.doesNotMatch(h.nodes['#grid'].innerHTML,/moment-meta|<script>/);assert.equal(h.nodes['#more'].hidden,true);
});

test('video playback requests the compressed preview, retries the original on error and downloads original bytes',async()=>{
 const h=harness();await tick();h.run('items=[{id:"video1",name:"Guest",caption:"",mime:"video/mp4",filter:"original",created:"2026-11-21T12:00:00Z"}]');
 const video=h.context.document.querySelector('#moment-detail video'),listeners={};video.currentTime=3;
 video.addEventListener=(name,fn,options)=>{listeners[name]=fn;assert.equal(options.once,true);};
 h.nodes['#grid'].onclick({target:{closest(){return {dataset:{id:'video1'}};}}});
 const html=h.nodes['#moment-detail'].innerHTML;assert.match(html,/src="\/api\/album\/file\/video1\?preview=1"/);assert.match(html,/href="\/api\/album\/file\/video1\?download=1"/);
 listeners.error();assert.equal(video.src,'/api/album/file/video1');video.currentTime=0;listeners.loadedmetadata();assert.equal(video.currentTime,3);
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
 assert.equal(h.nodes['#photo-preview'].naturalWidth,1000);assert.equal(h.nodes['#photo-overlay'].hidden,false);assert.equal(h.nodes['#photo-overlay'].src,'/art.png');
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

test('album and gallery request loaders stop after success or connection failure',async()=>{
 const h=harness();await tick();let finish;
 h.context.fetch=()=>new Promise(resolve=>finish=resolve);
 const opening=h.run('init()');assert.equal(h.nodes['#album-loading'].hidden,false);
 finish({ok:true,json:async()=>h.config});await opening;assert.equal(h.nodes['#album-loading'].hidden,true);
 h.run('items=[{id:"existing",name:"Bayu"}];next=25');h.context.fetch=()=>new Promise(resolve=>finish=resolve);
 const gallery=h.run('loadGallery(true)');assert.equal(h.nodes['#gallery-loading'].hidden,false);assert.equal(h.nodes['#grid'].attributes['aria-busy'],'true');
 finish({ok:false,status:503,json:async()=>({error:'Album sementara tidak tersedia.'})});await gallery;
 assert.equal(h.nodes['#gallery-loading'].hidden,true);assert.equal(h.nodes['#grid'].attributes['aria-busy'],'false');assert.equal(h.nodes['#refresh'].disabled,false);assert.equal(h.run('items[0].id'),'existing');assert.equal(h.run('next'),25);
});

test('envelope opens once, then enables the page and moves focus without requesting camera access',async()=>{
 const h=harness();await tick();h.context.document.querySelector('#album-app').inert=true;
 h.context.TemuAlbumCamera.open=()=>assert.fail('Opening the album must not request the camera');
 h.nodes['#open-cover'].onclick();h.nodes['#open-cover'].onclick();assert.equal(h.timers.length,1);assert.equal(h.nodes['#album-app'].inert,true);
 h.timers[0].fn();assert.equal(h.nodes['#album-cover'].hidden,true);assert.equal(h.nodes['#album-app'].inert,false);assert.equal(h.nodes['#guest-name'].focused,true);
});
test('reduced motion skips the envelope animation delay',async()=>{
 const h=harness();await tick();h.context.window.matchMedia=()=>({matches:true});h.nodes['#open-cover'].onclick();assert.equal(h.timers[0].ms,0);
});
test('feed is photo-only tiles with details available on tap, including untrusted captions',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';
 h.run('items=[{id:"a",name:"Guest <hello>",caption:"Line1\\nLine2 <script>",mime:"image/jpeg",filter:"original",created:"2026-11-21T12:00:00Z",thumbnail:false}];next=null;renderGallery()');
 assert.match(h.nodes['#grid'].innerHTML,/data-photo-src/);assert.doesNotMatch(h.nodes['#grid'].innerHTML,/moment-meta/);
 h.nodes['#grid'].onclick({target:{closest(){return {dataset:{id:'a'}};}}});
 assert.match(h.nodes['#moment-detail'].innerHTML,/Guest &lt;hello&gt;/);assert.match(h.nodes['#moment-detail'].innerHTML,/Line1\nLine2 &lt;script&gt;/);assert.match(h.nodes['#moment-detail'].innerHTML,/21 November 2026/);assert.match(h.nodes['#moment-detail'].innerHTML,/Unduh file/);
});
test('frame preview tracks the inline live camera and upload stays disabled until capture',async()=>{
 const h=harness();await tick();h.context.TemuAlbumCamera.isActive=()=>true;h.context.TemuAlbumCamera.mode='photo';h.nodes['#camera-live'].videoWidth=1080;h.nodes['#camera-live'].videoHeight=1440;
 await h.run("chooseOverlay('monogram')");assert.equal(h.nodes['#photo-overlay'].hidden,false);assert.equal(h.nodes['#upload'].disabled,true);
 await h.run("chooseOverlay('none')");assert.equal(h.nodes['#photo-overlay'].hidden,true);
});

test('inline camera capture hands its new photo to the album without dropping it during close',async()=>{
 const h=harness();await tick();let stopped=false;
 const d=h.context.document;d.getElementById=id=>d.querySelector('#'+id);d.addEventListener=()=>{};
 d.createElement=()=>({getContext:()=>({drawImage(){}}),toBlob(fn){fn(new Blob(['camera frame'],{type:'image/jpeg'}));}});
 h.context.navigator={mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped=true;}}]})}};
 h.context.clearInterval=()=>{};h.context.Blob=Blob;h.context.File=class extends Blob{constructor(parts,name,opts){super(parts,opts);this.name=name;}};
 const live=h.nodes['#camera-live'];live.videoWidth=900;live.videoHeight=1200;live.readyState=2;live.play=async()=>{};
 h.run(fs.readFileSync('dist/album-camera.js','utf8'));h.context.TemuAlbumCamera=h.context.window.TemuAlbumCamera;
 h.nodes['#take-photo'].onclick();await tick();assert.equal(h.context.TemuAlbumCamera.isActive(),true);assert.equal(h.nodes['#camera-shutter'].disabled,false);
 await h.nodes['#camera-shutter'].onclick();await tick();assert.equal(stopped,true);assert.equal(h.run('file.type'),'image/jpeg');assert.equal(h.nodes['#photo-preview'].hidden,false);assert.equal(h.nodes['#upload'].disabled,false);
});

test('name, camera and gallery are separate pages; blank names cannot start the camera',async()=>{
 const h=harness();await tick();let opened=0;h.context.TemuAlbumCamera.open=()=>opened++;
 assert.equal(h.nodes['#name-step'].hidden,false);assert.equal(h.nodes['#capture'].hidden,true);assert.equal(h.nodes['#album-nav'].hidden,true);assert.equal(h.nodes['#studio-header'].hidden,true);
 h.nodes['#guest-name'].value='   ';h.nodes['#name-form'].onsubmit({preventDefault(){}});assert.equal(opened,0);assert.ok(h.nodes['#guest-name'].validationMessage);
 h.nodes['#guest-name'].value='  Bayu  ';h.nodes['#name-form'].onsubmit({preventDefault(){}});assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.equal(opened,1);assert.equal(h.nodes['#capture'].hidden,false);assert.equal(h.nodes['#name-step'].hidden,true);assert.equal(h.nodes['#album-nav'].hidden,false);assert.equal(h.nodes['#studio-header'].hidden,false);
});
test('capture opens optional message dialog; closing it keeps the photo; success closes it',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';await h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');assert.equal(h.nodes['#caption-dialog'].open,true);
 h.nodes['#close-caption'].onclick();assert.equal(h.run('file.name'),'camera.jpg');h.nodes['#review-capture'].onclick();assert.equal(h.nodes['#caption-dialog'].open,true);
 h.context.document.querySelector('#caption').value='';await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=201;h.requests[0].responseText=JSON.stringify({id:'a'});await h.requests[0].onload();assert.equal(h.nodes['#caption-dialog'].open,false);assert.equal(h.run('file'),null);
});

test('photo aspect ratios never leak into generic buttons or icon/navigation controls',()=>{
 const css=fs.readFileSync('dist/album.css','utf8');
 for(const [,selectors,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  if(selectors.split(',').some(s=>['button','.tabs button','.icon-button'].includes(s.trim())))assert.doesNotMatch(body,/aspect-ratio/);
 }
 const html=fs.readFileSync('dist/album.html','utf8');assert.match(html,/id="refresh"[^>]*aria-label="Perbarui album"[^>]*><svg/);assert.doesNotMatch(html,/Perbarui ↻|Foto baru menggunakan filter dan pilihan overlay kamu/);
 for(const id of ['close-caption','close-dialog','close-camera'])assert.match(html,new RegExp('id="'+id+'"[^>]*><svg'));
});

test('recording locks navigation, filters and mode changes until recording finishes',async()=>{
 const h=harness();await tick();h.context.TemuAlbumCamera.isRecording=()=>true;h.run('captureState()');
 for(const id of ['edit-name','tab-capture','tab-gallery','take-photo','take-video'])assert.equal(h.nodes['#'+id].disabled,true);
 assert.equal(h.nodes.film.disabled,true);h.context.TemuAlbumCamera.isRecording=()=>false;h.run('captureState()');
 for(const id of ['edit-name','tab-capture','tab-gallery','take-photo','take-video'])assert.equal(h.nodes['#'+id].disabled,false);
});
test('retaking a captured video reopens the inline video recorder and keeps the previous clip',async()=>{
 const h=harness();await tick();await h.run('selectFile({name:"clip.mp4",type:"video/mp4",size:1024})');
 let kind;h.context.TemuAlbumCamera.open=value=>kind=value;h.nodes['#discard'].onclick();assert.equal(kind,'video');assert.equal(h.run('file.name'),'clip.mp4');
});
test('shared navigation sits in the top header alongside name, with no bottom navigation space',()=>{
 const html=fs.readFileSync('dist/album.html','utf8'),css=fs.readFileSync('dist/album.css','utf8');
 const header=html.match(/<header id="studio-header"[\s\S]*?<\/header>/)[0];
 for(const id of ['edit-name','album-nav','tab-capture','tab-gallery'])assert.ok(header.includes('id="'+id+'"'));
 assert.doesNotMatch(css,/nav-height/);assert.match(css,/\.studio-header\{[^}]*top:0/);
});
