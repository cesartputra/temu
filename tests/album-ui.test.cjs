const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album.js','utf8');
const tick=()=>new Promise(setImmediate);
function harness(){
 const nodes={},revoked=[],requests=[];
 const make=()=>({hidden:false,disabled:false,value:'',textContent:'',style:{},attributes:{},childElementCount:0,classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this[k];},pause(){this.paused=true;},scrollIntoView(){},addEventListener(){}});
 const document={hidden:false,querySelector:s=>nodes[s]??=make(),querySelectorAll:s=>s==='[data-filter]'?['original','film','warm','mono'].map(p=>{const n=nodes[p]??=make();n.dataset={filter:p};return n;}):[]};
 class XHR{constructor(){this.upload={};requests.push(this);}open(){}setRequestHeader(){}send(f){this.sent=f;}abort(){this.onabort();}}
 document.querySelector('#guest-name');
 const config={title:'Reva & Cesar',count:0,uploadsOpen:true,revealed:true,filter:'film'};
 const context={document,window:{addEventListener(){}},location:{hash:'',pathname:'/album'},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>config}),URL:{createObjectURL:()=> 'blob:moment',revokeObjectURL:u=>revoked.push(u)},URLSearchParams,XMLHttpRequest:XHR,TemuAlbumCamera:{open(){}},setInterval(){},Date,AbortSignal};
 vm.runInNewContext(source,context);
 return {nodes,revoked,requests,run:s=>vm.runInNewContext(s,context),config};
}
test('discarding a preview stops playback, frees its URL and preserves guest details',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');h.nodes['#discard'].onclick();
 assert.equal(h.nodes['#upload'].disabled,true);assert.equal(h.nodes['#photo-preview'].hidden,true);assert.equal(h.nodes['#video-preview'].src,undefined);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.deepEqual(h.revoked,['blob:moment']);
});
test('upload locks capture and discard; abort keeps the captured file available to retry',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});
 assert.equal(h.nodes['#take-photo'].disabled,true);assert.equal(h.nodes['#discard'].disabled,true);h.run('selectFile({name:"replacement.jpg",type:"image/jpeg",size:12})');assert.equal(h.run('file.name'),'camera.jpg');
 h.nodes['#cancel-upload'].onclick();assert.equal(h.nodes['#upload'].disabled,false);assert.equal(h.nodes['#take-photo'].disabled,false);assert.equal(h.run('file.name'),'camera.jpg');assert.match(h.nodes['#upload-state'].textContent,/dibatalkan/);
});
test('failed upload keeps preview and exposes error next to upload controls',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.run('selectFile({name:"camera.jpg",type:"image/jpeg",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=503;h.requests[0].responseText=JSON.stringify({error:'Album sementara tidak tersedia.'});await h.requests[0].onload();
 assert.equal(h.nodes['#upload'].disabled,false);assert.equal(h.nodes['#upload-state'].hidden,false);assert.match(h.nodes['#upload-state'].textContent,/sementara/);assert.equal(h.nodes['#photo-preview'].hidden,false);
});
test('successful upload clears media but preserves name and updates album count',async()=>{
 const h=harness();await tick();h.nodes['#guest-name'].value='Bayu';h.run('selectFile({name:"video.mov",type:"video/quicktime",size:1024})');await h.nodes['#upload-form'].onsubmit({preventDefault(){}});h.requests[0].status=201;h.requests[0].responseText=JSON.stringify({id:'a'});await h.requests[0].onload();
 assert.equal(h.run('file'),null);assert.equal(h.nodes['#guest-name'].value,'Bayu');assert.equal(h.nodes['#count'].textContent,1);assert.equal(h.nodes['#take-video'].disabled,false);assert.match(h.nodes['#upload-state'].textContent,/Terima kasih/);
});
test('oversized or unsupported camera result does not replace valid preview',async()=>{
 const h=harness();await tick();h.run('selectFile({name:"valid.jpg",type:"image/jpeg",size:1024});selectFile({name:"huge.mp4",type:"video/mp4",size:200*1024*1024});selectFile({name:"unsupported.heic",type:"image/heic",size:1024})');
 assert.equal(h.run('file.name'),'valid.jpg');assert.equal(h.revoked.length,0);assert.equal(h.nodes['#photo-preview'].hidden,false);
});
test('gallery escapes guest text and preserves multiline caption',async()=>{
 const h=harness();await tick();h.nodes['#media-type'].value='all';h.run('items=[{id:"a",name:"<img onerror=alert(1)>",caption:"first\\nsecond <script>",mime:"image/jpeg",filter:"film",created:"2026-11-21T12:00:00Z"}];next=null;renderGallery()');
 assert.ok(h.nodes['#grid'].innerHTML.includes('&lt;img onerror=alert(1)&gt;'));assert.ok(h.nodes['#grid'].innerHTML.includes('first\nsecond &lt;script&gt;'));assert.equal(h.nodes['#more'].hidden,true);
});
