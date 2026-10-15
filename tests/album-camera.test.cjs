const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album-camera.js','utf8');
const tick=()=>new Promise(setImmediate);
function harness(getMedia,mobile={}){
 const nodes={},tracks=[],captures=[],recorders=[];let context;
 const make=()=>({style:{},hidden:false,attributes:{},classList:{remove(){},add(){}},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]||null;},pause(){},open:false,disabled:false,textContent:'',srcObject:null,videoWidth:1920,videoHeight:1080,listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},async play(){},value:'',files:[],click(){this.clicked=true;}});
 const stream=()=>{const track={stopped:false,stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track]};};
 class Recorder{static isTypeSupported(m){return m==='video/mp4';}constructor(){this.state='inactive';this.mimeType='video/mp4';recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['camera-video'])});this.onstop?.();}}
 const document={hidden:false,getElementById(id){return nodes[id]??=make();},addEventListener(event,fn){this[event]=fn;},createElement(){return {getContext:()=>({drawImage(){}}),toBlob(fn){fn(new Blob(['jpeg-camera-frame'],{type:'image/jpeg'}));}};}};
 context={window:{MediaRecorder:Recorder,addEventListener(){}},MediaRecorder:Recorder,document,navigator:{...mobile,mediaDevices:{getUserMedia:constraints=>getMedia?getMedia(constraints,stream):Promise.resolve(stream())}},Blob,File:class extends Blob{constructor(parts,name,opts){super(parts,opts);this.name=name;}},setInterval(){return 1;},clearInterval(){},Date,Error};vm.runInNewContext(source,context);
 return {api:context.window.TemuAlbumCamera,nodes,tracks,captures,recorders,document,stream};
}
test('photo comes from camera frame and releases camera after capture',async()=>{
 const h=harness();h.api.open('photo',f=>h.captures.push(f));await tick();await h.nodes['camera-shutter'].onclick();
 assert.equal(h.captures[0].type,'image/jpeg');assert.match(h.captures[0].name,/^foto-/);assert.equal(h.api.isActive(),false);assert.ok(h.tracks.every(t=>t.stopped));
});
test('closing while permission is pending stops the late stream',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));h.api.open('photo',()=>assert.fail('no capture'));h.api.close();resolve(h.stream());await tick();assert.ok(h.tracks.every(t=>t.stopped));assert.equal(h.nodes['camera-live'].srcObject,null);
});
test('denied camera does not expose a gallery fallback',async()=>{
 const h=harness(()=>Promise.reject(Object.assign(new Error(),{name:'NotAllowedError'})));h.api.open('photo',()=>{});await tick();assert.match(h.nodes['camera-status'].textContent,/ditolak/);assert.equal(h.nodes['camera-shutter'].disabled,true);
 assert.doesNotMatch(fs.readFileSync('dist/album.html','utf8'),/choose-file|gallery-file/);
});
test('video requests microphone and produces a recording, closing releases tracks',async()=>{
 let requested;const h=harness((constraints,stream)=>{requested=constraints;return Promise.resolve(stream());});h.api.open('video',f=>h.captures.push(f));await tick();assert.equal(requested.audio,true);h.nodes['camera-shutter'].onclick();assert.equal(h.recorders[0].state,'recording');h.nodes['camera-shutter'].onclick();assert.equal(h.captures[0].type,'video/mp4');assert.ok(h.tracks.every(t=>t.stopped));
});
test('canceling a recording or hiding the page discards video',async()=>{
 const h=harness();h.api.open('video',f=>h.captures.push(f));await tick();h.nodes['camera-shutter'].onclick();h.document.hidden=true;h.document.visibilitychange();assert.equal(h.captures.length,0);assert.ok(h.tracks.every(t=>t.stopped));
});

test('Android and iPhone photos use the inline live camera without a gallery picker',async()=>{
 for(const mobile of [{userAgent:'Android'},{userAgent:'iPhone'}]){
  let constraints;const h=harness((value,stream)=>{constraints=value;return Promise.resolve(stream());},mobile);
  h.api.open('photo',f=>h.captures.push(f));await tick();assert.equal(h.api.isActive(),true);assert.equal(h.nodes['camera-live'].hidden,false);assert.equal(constraints.audio,false);
  await h.nodes['camera-shutter'].onclick();assert.equal(h.captures[0].type,'image/jpeg');assert.ok(h.tracks.every(t=>t.stopped));
 }
});
test('switching cameras releases the old stream; closing preserves the previous capture',async()=>{
 const requested=[],h=harness((value,stream)=>{requested.push(value.video.facingMode.ideal);return Promise.resolve(stream());});
 h.nodes['photo-preview']??=h.document.getElementById('photo-preview');h.nodes['photo-preview'].setAttribute('src','blob:previous');h.nodes['photo-preview'].naturalWidth=1200;h.nodes['photo-preview'].naturalHeight=1600;
 h.api.open('photo',()=>{});await tick();h.nodes['camera-switch'].onclick();await tick();
 assert.deepEqual(requested,['environment','user']);assert.equal(h.tracks[0].stopped,true);h.api.close();assert.ok(h.tracks.every(t=>t.stopped));assert.equal(h.nodes['photo-preview'].hidden,false);assert.equal(h.nodes['photo-preview'].getAttribute('src'),'blob:previous');
});
test('iPhone video and iPad desktop mode use native camera without requesting browser microphone',()=>{
 for(const mobile of [{userAgent:'iPhone'},{platform:'MacIntel',maxTouchPoints:5}]){
  const h=harness(()=>assert.fail('Native capture does not use browser microphone'),mobile);h.api.open('video',f=>h.captures.push(f));assert.equal(h.nodes['native-video'].clicked,true);
  const video=new Blob(['original-mov'],{type:'video/quicktime'});h.nodes['native-video'].files=[video];h.nodes['native-video'].onchange();assert.equal(h.captures[0],video);
 }
});
