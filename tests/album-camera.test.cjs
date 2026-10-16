const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album-camera.js','utf8');
const tick=()=>new Promise(setImmediate);
function harness(getMedia,mobile={}){
 const nodes={},tracks=[],captures=[],recorders=[],draws=[],canvases=[];let context;let landscape=false;const events={},intervals=[],cleared=[];
 const make=()=>({getBoundingClientRect:()=>({width:360,height:480}),style:{},hidden:false,attributes:{},classList:{remove(){},add(){}},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]||null;},pause(){},open:false,disabled:false,textContent:'',srcObject:null,videoWidth:1920,videoHeight:1080,listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},async play(){},value:'',files:[],click(){this.clicked=true;}});
 const stream=(audio=true)=>{const own=(audio?['video','audio']:['video']).map(kind=>({kind,stopped:false,stop(){this.stopped=true;}}));tracks.push(...own);return {getTracks:()=>own,getVideoTracks:()=>own.filter(t=>t.kind==='video'),getAudioTracks:()=>own.filter(t=>t.kind==='audio'),addTrack(t){own.push(t);}};};
 class Recorder{static isTypeSupported(m){return m==='video/mp4';}constructor(stream,options){this.input=stream;this.options=options;this.state='inactive';this.mimeType='video/mp4';recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['camera-video'])});this.onstop?.();}}
 const document={hidden:false,getElementById(id){return nodes[id]??=make();},addEventListener(event,fn){this[event]=fn;},createElement(){const canvas={captureStream(fps){const output=stream(false);output.canvas=canvas;output.fps=fps;return output;},getContext:()=>({fillRect(){},drawImage(...args){draws.push(args);canvases.push([canvas.width,canvas.height]);}}),toBlob(fn){fn(new Blob(['jpeg-camera-frame'],{type:'image/jpeg'}));}};return canvas;}};
 context={window:{matchMedia:()=>({matches:landscape}),MediaRecorder:Recorder,addEventListener(n,fn){events[n]=fn;}},MediaRecorder:Recorder,document,navigator:{...mobile,mediaDevices:{getUserMedia:constraints=>getMedia?getMedia(constraints,stream):Promise.resolve(stream())}},Blob,File:class extends Blob{constructor(parts,name,opts){super(parts,opts);this.name=name;}},setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(id){cleared.push(id);},Date,Error};vm.runInNewContext(source,context);
 return {api:context.window.TemuAlbumCamera,nodes,tracks,captures,recorders,document,stream,draws,canvases,intervals,cleared,context,rotate(value){landscape=value;events.resize();}};
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
test('Android, iPhone and iPad record inline with audio and portrait constraints, without a file picker',async()=>{
 for(const mobile of [{userAgent:'Android'},{userAgent:'iPhone'},{platform:'MacIntel',maxTouchPoints:5}]){
  let constraints;const h=harness((value,stream)=>{constraints=value;return Promise.resolve(stream());},mobile);
  h.api.open('video',f=>h.captures.push(f));await tick();assert.equal(h.api.isActive(),true);assert.equal(constraints.audio,true);
  assert.equal(constraints.video.width.ideal,1080);assert.equal(constraints.video.height.ideal,1920);assert.equal(constraints.video.resizeMode,'none');assert.equal(constraints.video.aspectRatio,undefined);
  h.nodes['camera-shutter'].onclick();assert.equal(h.api.isRecording(),true);assert.equal(h.nodes['camera-switch'].disabled,true);
  h.nodes['camera-shutter'].onclick();assert.equal(h.api.isRecording(),false);assert.equal(h.captures[0].type,'video/mp4');assert.ok(h.tracks.every(t=>t.stopped));
 }
 assert.doesNotMatch(fs.readFileSync('dist/album.html','utf8'),/type="file"|native-video/);
});
test('inline recording stops at 60 seconds and notifies the album when recording starts and stops',async()=>{
 const h=harness();let changes=0;h.rotate(true);h.api.open('video',f=>h.captures.push(f),()=>changes++);await tick();const before=changes;
 h.nodes['camera-shutter'].onclick();assert.equal(changes,before+1);
 for(let second=0;second<60;second++)h.intervals.at(-1)();
 assert.equal(h.captures.length,1);assert.equal(h.api.isActive(),false);assert.equal(h.api.isRecording(),false);assert.ok(changes>before+1);
});
test('unsupported video recording gives guidance and does not open a native camera',async()=>{
 const h=harness(()=>assert.fail('No stream needed without recorder support'),{userAgent:'iPhone'});h.context.window.MediaRecorder=null;
 h.api.open('video',()=>assert.fail('No capture'));await tick();assert.equal(h.api.isActive(),false);assert.match(h.nodes['camera-status'].textContent,/belum didukung/);
});

test('photo preview and capture stay 9:16 in both phone orientations and fit the stage',async()=>{
 const h=harness();h.api.open('photo',f=>h.captures.push(f));await tick();
 assert.equal(h.api.frame().width/h.api.frame().height,9/16);assert.equal(h.nodes['viewfinder'].style.width,'270px');assert.equal(h.nodes['viewfinder'].style.height,'480px');
 await h.nodes['camera-shutter'].onclick();assert.equal(h.canvases[0][0]/h.canvases[0][1],9/16);assert.equal(h.draws[0].length,9);
 h.api.open('photo',f=>h.captures.push(f));await tick();h.rotate(true);assert.equal(h.api.frame().width/h.api.frame().height,9/16);
 await h.nodes['camera-shutter'].onclick();assert.equal(h.canvases[1][0]/h.canvases[1][1],9/16);assert.equal(h.captures.length,2);
});

test('late stop or error from a discarded recording cannot interrupt its replacement',async()=>{
 const h=harness();h.api.open('video',f=>h.captures.push(f));await tick();h.nodes['camera-shutter'].onclick();
 const old=h.recorders[0];old.stop=function(){this.state='inactive';};h.api.close();
 h.api.open('video',f=>h.captures.push(f));await tick();h.nodes['camera-shutter'].onclick();const cleared=h.cleared.length;
 old.onstop();old.onerror();assert.equal(h.api.isRecording(),true);assert.equal(h.api.isActive(),true);assert.equal(h.cleared.length,cleared);assert.equal(h.captures.length,0);
 h.nodes['camera-shutter'].onclick();assert.equal(h.captures.length,1);
});

test('landscape video keeps its entire camera view inside 9:16 with audio and no enlargement',async()=>{
 const h=harness();h.api.open('video',f=>h.captures.push(f));await tick();
 const frame=h.api.frame();assert.equal(frame.width/frame.height,9/16);
 assert.equal(h.nodes['viewfinder'].style.aspectRatio,String(9/16));
 h.nodes['camera-shutter'].onclick();const input=h.recorders[0].input;
 assert.equal(input.canvas.width/input.canvas.height,9/16);assert.equal(input.fps,30);assert.equal(input.getAudioTracks().length,1);
 assert.deepEqual(h.draws[0].slice(1,5),[0,0,1920,1080]);assert.ok(h.draws[0][6]>0);assert.ok(h.draws[0][7]<=1920);assert.ok(h.draws[0][8]<=1080);
 h.rotate(true);assert.equal(h.api.frame().width/h.api.frame().height,9/16);
 const paint=h.intervals[0];paint();assert.deepEqual(h.draws[1].slice(1,5),[0,0,1920,1080]);
 h.nodes['camera-shutter'].onclick();assert.ok(h.tracks.every(t=>t.stopped));assert.ok(h.cleared.includes(1));assert.equal(h.captures.length,1);
});
test('portrait camera streams record directly without adding a canvas conversion',async()=>{
 const h=harness();h.nodes['camera-live'].videoWidth=720;h.nodes['camera-live'].videoHeight=1280;
 h.api.open('video',f=>h.captures.push(f));await tick();h.nodes['camera-shutter'].onclick();
 assert.equal(h.recorders[0].input,h.nodes['camera-live'].srcObject);assert.equal(h.draws.length,0);h.nodes['camera-shutter'].onclick();assert.equal(h.captures.length,1);
});
test('rotating before or during video recording keeps preview and output at 9:16',async()=>{
 const h=harness();h.api.open('video',f=>h.captures.push(f));await tick();h.rotate(true);assert.equal(h.api.frame().width/h.api.frame().height,9/16);
 h.nodes['camera-shutter'].onclick();assert.equal(h.recorders[0].input.canvas.width/h.recorders[0].input.canvas.height,9/16);h.rotate(false);assert.equal(h.api.frame().width/h.api.frame().height,9/16);
 h.nodes['camera-shutter'].onclick();assert.equal(h.captures.length,1);
});

test('failed crop recorder setup releases its generated track without losing the live camera',async()=>{
 const h=harness();h.api.open('video',()=>assert.fail('No capture on encoder failure'));await tick();
 h.context.MediaRecorder=class {static isTypeSupported(m){return m==='video/mp4';}constructor(){throw Error('Encoder unavailable');}};
 h.nodes['camera-shutter'].onclick();assert.match(h.nodes['camera-status'].textContent,/Encoder unavailable/);assert.equal(h.api.isRecording(),false);
 assert.equal(h.tracks[2].stopped,true);assert.equal(h.tracks[0].stopped,false);assert.equal(h.tracks[1].stopped,false);h.api.close();assert.ok(h.tracks.every(t=>t.stopped));
});
test('canceling a cropped recording stops both its canvas and microphone and discards the clip',async()=>{
 const h=harness();h.api.open('video',()=>assert.fail('Canceled capture must not be received'));await tick();h.nodes['camera-shutter'].onclick();
 h.nodes['close-camera'].onclick();assert.equal(h.api.isRecording(),false);assert.equal(h.api.isActive(),false);assert.ok(h.tracks.every(t=>t.stopped));
});

test('native camera requests avoid ratio cropping while both capture modes keep a 9:16 output',async()=>{
 for(const kind of ['photo','video']){
  let requested;const h=harness((constraints,stream)=>{requested=constraints;return Promise.resolve(stream());});h.rotate(true);
  h.api.open(kind,f=>h.captures.push(f));await tick();assert.equal(requested.video.width.ideal,kind==='photo'?3840:1920);assert.equal(requested.video.height.ideal,kind==='photo'?2160:1080);assert.equal(requested.video.resizeMode,'none');assert.equal(requested.video.aspectRatio,undefined);assert.equal(requested.video.zoom,undefined);
  assert.equal(h.nodes['viewfinder'].style.aspectRatio,String(9/16));const crop=h.api.frame();assert.equal(crop.width/crop.height,9/16);
  await h.nodes['camera-shutter'].onclick();const dimensions=kind==='photo'?h.canvases[0]:[h.recorders[0].input.canvas.width,h.recorders[0].input.canvas.height];
  assert.equal(dimensions[0]/dimensions[1],9/16);assert.ok(dimensions[0]<=crop.width);assert.ok(dimensions[1]<=crop.height);
  if(kind==='video')h.nodes['camera-shutter'].onclick();assert.ok(h.tracks.every(t=>t.stopped));
 }
});

test('photo capture preserves all source corners for portrait, square and landscape cameras',async()=>{
 for(const [width,height] of [[1440,1920],[1080,1920],[1920,1080],[1920,1920]]){
  const h=harness(),live=h.nodes['camera-live'];live.videoWidth=width;live.videoHeight=height;
  h.api.open('photo',f=>h.captures.push(f));await tick();await h.nodes['camera-shutter'].onclick();
  const draw=h.draws[0],[outputWidth,outputHeight]=h.canvases[0];assert.deepEqual(draw.slice(1,5),[0,0,width,height]);
  assert.equal(outputWidth/outputHeight,9/16);assert.ok(draw[7]<=width);assert.ok(draw[8]<=height);
  assert.ok(draw[5]>=0&&draw[6]>=0);assert.ok(draw[5]+draw[7]<=outputWidth);assert.ok(draw[6]+draw[8]<=outputHeight);
  assert.ok(Math.abs(draw[7]/draw[8]-width/height)<1e-10);assert.equal(h.captures.length,1);
 }
});
test('preview uses contain so CSS cannot introduce a zoom that the saved photo does not have',()=>{
 const css=fs.readFileSync('dist/album.css','utf8');assert.match(css,/#camera-live\{object-fit:contain\}/);assert.doesNotMatch(css,/#camera-live\{[^}]*object-fit:cover/);
});
