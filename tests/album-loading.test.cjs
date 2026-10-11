const {test}=require('node:test'),assert=require('node:assert/strict');
const {photo,createLoader}=require('../dist/album-loading.js');
const tick=()=>new Promise(setImmediate);
function clock(){
 const timers=new Map();let id=0;
 return {schedule(fn,ms){const key=++id;timers.set(key,{fn,ms});return key;},cancel(key){timers.delete(key);},run(ms){for(const [key,t] of [...timers])if(t.ms===ms){timers.delete(key);t.fn();}},timers};
}
function shell({width=0,decode=async()=>{},detail=false}={}){
 const classes=new Set(['is-loading',detail?'photo-shell-detail':'photo-shell-card']),attributes={'aria-busy':'true'},listeners={},loader={hidden:false},error={hidden:true};
 const image={complete:false,naturalWidth:width,decode,requests:[],attributes:{'data-photo-src':'/api/album/file/photo'},getAttribute(k){return this.attributes[k]??null;},set src(value){this.attributes.src=value;this.requests.push(value);},removeAttribute(k){delete this.attributes[k];this.complete=false;this.naturalWidth=0;},addEventListener:(n,fn)=>listeners[n]=fn,removeEventListener:(n)=>delete listeners[n]};
 const retry={addEventListener:(n,fn)=>listeners['retry-'+n]=fn,removeEventListener:(n)=>delete listeners['retry-'+n]};
 const element={classList:{contains:n=>classes.has(n),toggle:(n,on)=>on?classes.add(n):classes.delete(n)},setAttribute:(n,v)=>attributes[n]=v,querySelector:s=>({'img':image,'.photo-loading':loader,'.photo-error':error,'.photo-retry':detail?retry:null}[s])};
 return {element,image,classes,attributes,loader,error,listeners,async succeed(decode){this.image.naturalWidth=720;this.image.complete=true;if(decode)this.image.decode=decode;await this.listeners.load();}};
}
function setup(count=1,options={}){
 const time=clock(),api=createLoader({Observer:null,schedule:time.schedule,cancel:time.cancel,delay:attempt=>attempt*100,...options}),entries=Array.from({length:count},()=>shell());
 const root={querySelectorAll:()=>entries.map(e=>e.element)};api.watch(root);return {api,entries,root,time};
}
test('seven visible photos never start more than two requests at a time; slots wait for decoding',async()=>{
 const h=setup(7);assert.deepEqual(h.entries.map(e=>e.image.requests.length),[1,1,0,0,0,0,0]);
 let decoded;const pending=h.entries[0].succeed(()=>new Promise(r=>decoded=r));assert.equal(h.entries[2].image.requests.length,0);
 decoded();await pending;assert.equal(h.entries[2].image.requests.length,1);assert.ok(h.entries[0].classes.has('is-ready'));assert.equal(h.entries[0].attributes['aria-busy'],'false');
 for(const e of h.entries.slice(1))await e.succeed();assert.ok(h.entries.every(e=>e.classes.has('is-ready')));assert.equal(h.time.timers.size,0);
});
test('offscreen thumbnails wait for visibility; full photo is prioritized in the same queue',async()=>{
 let notify,disconnected=false;const observed=[];
 class Observer{constructor(fn){notify=fn;}observe(el){observed.push(el);}unobserve(){}disconnect(){disconnected=true;}}
 const h=setup(4,{Observer});assert.ok(h.entries.every(e=>e.image.requests.length===0));
 notify(observed.map(target=>({target,isIntersecting:true})));assert.deepEqual(h.entries.map(e=>e.image.requests.length),[1,1,0,0]);
 const detail=shell({detail:true}),root={querySelectorAll:()=>[detail.element]};h.api.watch(root);assert.equal(detail.image.requests.length,0);
 await h.entries[0].succeed();assert.equal(detail.image.requests.length,1);assert.equal(h.entries[2].image.requests.length,0);
 h.api.stop(h.root);h.api.stop(root);assert.equal(disconnected,true);assert.equal(h.time.timers.size,0);
});
test('temporary errors retry with backoff, release slots and keep the loader visible',async()=>{
 const h=setup(3),first=h.entries[0];first.listeners.error();assert.equal(first.error.hidden,true);assert.equal(first.loader.hidden,false);assert.equal(h.entries[2].image.requests.length,1);
 h.time.run(100);assert.equal(first.image.requests.length,1);await h.entries[1].succeed();assert.equal(first.image.requests.length,2);
 await first.succeed();await h.entries[2].succeed();assert.ok(first.classes.has('is-ready'));assert.equal(h.time.timers.size,0);
});
test('permanent failure stops after three automatic retries and manual retry starts a fresh cycle',async()=>{
 const h=setup(1),e=h.entries[0];
 for(let attempt=1;attempt<=4;attempt++){e.listeners.error();if(attempt<4){assert.equal(e.error.hidden,true);h.time.run(attempt*100);}}
 assert.equal(e.image.requests.length,4);assert.equal(e.error.hidden,false);assert.equal(e.loader.hidden,true);assert.equal(e.attributes['aria-busy'],'false');assert.equal(h.time.timers.size,0);
 // Full-photo retry uses the same bounded queue and prevents bubbling.
 const detail=shell({detail:true}),root={querySelectorAll:()=>[detail.element]};h.api.watch(root);
 for(let attempt=1;attempt<=4;attempt++){detail.listeners.error();h.time.run(attempt*100);}
 let prevented=false,stopped=false;detail.listeners['retry-click']({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
 assert.equal(prevented&&stopped,true);assert.equal(detail.loader.hidden,false);await detail.succeed();assert.ok(detail.classes.has('is-ready'));
});
test('hung images time out, and decoding from a timed-out attempt cannot overwrite a retry',async()=>{
 const h=setup(),e=h.entries[0];let decoded;const pending=e.succeed(()=>new Promise(r=>decoded=r));
 h.time.run(15000);h.time.run(100);decoded();await pending;assert.ok(e.classes.has('is-loading'));assert.equal(e.image.requests.length,2);
 await e.succeed(async()=>{});assert.ok(e.classes.has('is-ready'));assert.equal(h.time.timers.size,0);
});
test('refresh cancels old requests and retries; closing a modal releases a slot without reviving it',async()=>{
 const h=setup(4);h.entries[0].listeners.error();assert.equal(h.entries[2].image.requests.length,1);
 const replacement=[shell(),shell()];h.root.querySelectorAll=()=>replacement.map(e=>e.element);h.api.watch(h.root);
 h.time.run(100);assert.ok(h.entries.every(e=>e.image.getAttribute('src')===null));assert.ok(replacement.every(e=>e.image.requests.length===1));
 h.api.stop(h.root);assert.equal(h.time.timers.size,0);await tick();assert.ok(replacement.every(e=>e.image.getAttribute('src')===null));
});
test('cached images become ready without requiring another load event',async()=>{
 const h=setup(0),e=shell({width:100});e.image.complete=true;h.root.querySelectorAll=()=>[e.element];h.api.watch(h.root);await tick();assert.ok(e.classes.has('is-ready'));assert.equal(e.loader.hidden,true);assert.equal(h.time.timers.size,0);
});
test('markup defers src to the queue and escapes guest text without nesting buttons',()=>{
 const thumb=photo('/image?a=1&b=2','Guest <hello>','moment-photo');assert.match(thumb,/data-photo-src="\/image\?a=1&amp;b=2"/);assert.doesNotMatch(thumb,/\ssrc=/);assert.match(thumb,/Guest &lt;hello&gt;/);assert.doesNotMatch(thumb,/<button/);
 const detail=photo('/image','Guest','detail-media',true);assert.match(detail,/photo-retry/);assert.match(detail,/role="status"/);
});
