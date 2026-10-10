const {test}=require('node:test'),assert=require('node:assert/strict');
const loading=require('../dist/album-loading.js');
const tick=()=>new Promise(setImmediate);
function fixture({complete=false,width=0,decode=async()=>{}}={}){
 const classes=new Set(['is-loading']),attributes={'aria-busy':'true'},listeners={},loader={hidden:false},error={hidden:true},retry={addEventListener:(name,fn)=>listeners['retry-'+name]=fn};
 const image={complete,naturalWidth:width,decode,src:'/photo',getAttribute:()=>'/photo',addEventListener:(name,fn)=>listeners[name]=fn};
 const shell={classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)},setAttribute:(name,value)=>attributes[name]=value,querySelector:s=>({'img':image,'.photo-loading':loader,'.photo-error':error,'.photo-retry':retry}[s])};
 loading.watch({querySelectorAll:()=>[shell]});return {image,classes,attributes,loader,error,listeners};
}
test('photo placeholder remains until the browser finishes decoding, then reveals image',async()=>{
 let decoded;const h=fixture({width:100,decode:()=>new Promise(resolve=>decoded=resolve)});
 const pending=h.listeners.load();assert.equal(h.loader.hidden,false);assert.equal(h.attributes['aria-busy'],'true');
 decoded();await pending;assert.equal(h.loader.hidden,true);assert.equal(h.attributes['aria-busy'],'false');assert.ok(h.classes.has('is-ready'));
});
test('cached image completes without waiting for another load event',async()=>{
 const h=fixture({complete:true,width:100});await tick();assert.ok(h.classes.has('is-ready'));assert.equal(h.loader.hidden,true);
});
test('broken cached images and failed decoding show an error instead of an endless spinner',async()=>{
 const cached=fixture({complete:true});assert.equal(cached.error.hidden,false);assert.equal(cached.loader.hidden,true);
 const h=fixture({width:100,decode:async()=>{throw Error('unsupported image');}});await h.listeners.load();assert.equal(h.error.hidden,false);assert.equal(h.loader.hidden,true);assert.equal(h.attributes['aria-busy'],'false');
});
test('retry restarts loading and ignores decoding from the failed attempt',async()=>{
 let decoded;const h=fixture({width:100,decode:()=>new Promise(resolve=>decoded=resolve)});
 const stale=h.listeners.load();h.listeners.error();assert.ok(h.classes.has('is-error'));
 let prevented=false,stopped=false;h.listeners['retry-click']({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
 decoded();await stale;assert.ok(h.classes.has('is-loading'));assert.equal(h.error.hidden,true);assert.equal(h.loader.hidden,false);assert.equal(prevented&&stopped,true);
 h.image.decode=async()=>{};await h.listeners.load();assert.ok(h.classes.has('is-ready'));
});
test('loader markup preserves lazy thumbnails, eager full photos, escaped text and no nested buttons',()=>{
 const thumb=loading.photo('/image?a=1&b=2','Guest <hello>','moment-photo');assert.match(thumb,/loading="lazy"/);assert.match(thumb,/Guest &lt;hello&gt;/);assert.match(thumb,/a=1&amp;b=2/);assert.doesNotMatch(thumb,/<button/);
 const detail=loading.photo('/image','Guest','detail-media',true);assert.doesNotMatch(detail,/loading="lazy"/);assert.match(detail,/photo-retry/);assert.match(detail,/role="status"/);
});
