const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album.js','utf8'),tick=()=>new Promise(setImmediate);
function harness(){
 const nodes={},revoked=[],queued=[],timers=[],shared=[],events={},saves=[];let queueOptions;
 const make=()=>({hidden:false,disabled:false,value:'',textContent:'',style:{},attributes:{},childElementCount:0,classList:{toggle(){},add(){},remove(){}},setCustomValidity(v){this.validationMessage=v;},reportValidity(){},getBoundingClientRect:()=>({width:360,height:480}),focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;this.listeners?.close?.();},getAttribute(k){return this[k]??null;},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this[k];},pause(){},click(){this.clicked=true;},addEventListener(name,fn){(this.listeners??={})[name]=fn;},querySelectorAll(){return [];}});
 const document={body:make(),hidden:false,addEventListener(){},querySelector:s=>nodes[s]??=make(),querySelectorAll:s=>s==='[data-filter]'?['original','film','warm','mono','dazz'].map(filter=>Object.assign(nodes[filter]??=make(),{dataset:{filter}})):s==='[data-story-overlay]'?['celebration','monogram','none'].map(storyOverlay=>Object.assign(nodes[storyOverlay]??=make(),{dataset:{storyOverlay}})):[]};
 const config={title:'Reva & Cesar',count:0,uploadsOpen:true,revealed:true,filter:'film',storage:'s3'};
 const context={TemuAlbumLoading:require('../dist/album-loading.js'),document,window:{matchMedia:()=>({matches:false}),addEventListener:(name,fn)=>events[name]=fn},navigator:{canShare:()=>true,share:async value=>shared.push(value)},setTimeout(fn,ms){timers.push({fn,ms});},location:{hash:'',pathname:'/album'},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>config,blob:async()=>new Blob(['original bytes'])}),URL:{createObjectURL:()=> 'blob:moment',revokeObjectURL:u=>revoked.push(u)},URLSearchParams,TemuAlbumPhoto:{story:async()=>new Blob(['story'],{type:'image/png'}),thumbnail:async()=>new Blob(['thumbnail'],{type:'image/jpeg'})},TemuAlbumUpload:require('../dist/album-upload.js'),TemuAlbumQueue:{create(options){queueOptions=options;return {resume:async()=>{},enqueue:async job=>queued.push(job),retry:async()=>{},discard:async()=>{}};}},crypto:require('node:crypto').webcrypto,AbortController,sessionStorage:{getItem(){return null;},removeItem(){}},setInterval(){},Date,AbortSignal,Blob,confirm:()=>true};
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
 assert.equal(puts[0][2],original);assert.deepEqual(Object.keys(puts[0][1]),['Content-Type']);assert.equal(JSON.parse(requests[0].options.body).filter,'mono');assert.equal(JSON.parse(requests[0].options.body).requestId,'stable');assert.equal(requests.at(-1).path,'/api/album/thumbnail/remote');assert.equal(result.id,'remote');
});
test('gallery uses only thumbnails and never requests full photo bytes for a missing thumbnail',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';h.run('items=[{id:"a",name:"Guest <img>",mime:"image/jpeg",filter:"film",thumbnail:true},{id:"b",name:"Other",mime:"image/jpeg",filter:"original",thumbnail:false}];next=null;renderGallery()');
 const html=h.nodes['#grid'].innerHTML;assert.match(html,/\/a\?thumb=1/);assert.doesNotMatch(html,/file\/b/);assert.match(html,/PREVIEW BELUM TERSEDIA/);assert.match(html,/&lt;img&gt;/);
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
