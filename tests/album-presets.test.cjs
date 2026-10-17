const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync('dist/album-presets.js','utf8'),folder='dist/album-presets';
const catalog=JSON.parse(fs.readFileSync(folder+'/catalog.json'));
function harness({manifest=catalog,asset}={}){
 const requests=[],root={fetch:async url=>{
  requests.push(url);
  return {ok:true,json:async()=>manifest,arrayBuffer:async()=>{
   const bytes=asset?asset():fs.readFileSync(path.join(folder,url.split('/').at(-1)));
   return Uint8Array.from(bytes).buffer;
  }};
 }};
 vm.runInNewContext(source,{window:root,AbortSignal,Uint8Array,Uint16Array,Float32Array,Map,setTimeout});
 return {api:root.TemuAlbumPresets,requests};
}
function pixels(values){const data=new Uint8ClampedArray(values);return {data,ctx:{getImageData:()=>({data}),putImageData(image){assert.equal(image.data,data);}}};}

test('all 93 DNG presets have safe unique IDs, complete LUTs and English collection names',()=>{
 assert.equal(catalog.size,17);assert.equal(catalog.presets.length,93);assert.equal(new Set(catalog.presets.map(p=>p.id)).size,93);
 for(const preset of catalog.presets){
  assert.match(preset.id,/^lr-[a-z0-9-]+$/);assert.equal(fs.statSync(path.join(folder,preset.lut)).size,17**3*3);
  assert.equal(preset.swatch.length,2);assert.ok(['Black','Black & White','Selfie','Dazz','Ricoh','Fuji','Canon G7X','Kodak','Light'].includes(preset.family));
 }
});
test('tetrahedral interpolation preserves an identity LUT across channel orders, endpoints and alpha',async()=>{
 const lut=[];for(let b=0;b<17;b++)for(let g=0;g<17;g++)for(let r=0;r<17;r++)lut.push(Math.round(r/16*255),Math.round(g/16*255),Math.round(b/16*255));
 const manifest={size:17,presets:[{id:'lr-test',name:'Test',family:'Test',lut:'lr-test-1234567890.lut',grain:0,vignette:0,swatch:['#ffffff','#000000']}]};
 const h=harness({manifest,asset:()=>lut});
 const original=[0,0,0,0,255,255,255,255,220,130,60,77,120,200,33,128,40,130,230,99,180,10,90,35,75,90,10,180,80,10,100,255];
 const image=pixels(original);await h.api.apply(image.ctx,8,1,'lr-test');
 image.data.forEach((value,i)=>assert.ok(Math.abs(value-original[i])<=(i%4===3?0:1),`${i}: ${value} vs ${original[i]}`));
 await h.api.apply(image.ctx,8,1,'lr-test');assert.equal(h.requests.filter(url=>url.endsWith('.lut')).length,1);
});
test('actual monochrome and colour presets produce distinct pixels without changing alpha',async()=>{
 const h=harness();await h.api.load();
 const mono=pixels([200,110,30,85]);await h.api.apply(mono.ctx,1,1,'lr-custom-bnw-daylight');
 assert.equal(mono.data[0],mono.data[1]);assert.equal(mono.data[1],mono.data[2]);assert.equal(mono.data[3],85);
 const fuji=pixels([200,110,30,85]);await h.api.apply(fuji.ctx,1,1,'lr-fuji1');assert.notDeepEqual([...fuji.data],[...mono.data]);assert.equal(fuji.data[3],85);
});
test('truncated LUT fails before touching pixels and the next request can retry',async()=>{
 let attempt=0;const preset=catalog.presets[0];const h=harness({asset:()=>++attempt===1?[1,2,3]:fs.readFileSync(path.join(folder,preset.lut))});
 const image=pixels([100,120,140,255]);await assert.rejects(h.api.apply(image.ctx,1,1,preset.id),/tidak lengkap/);assert.deepEqual([...image.data],[100,120,140,255]);
 await h.api.apply(image.ctx,1,1,preset.id);assert.equal(attempt,2);
 await assert.rejects(h.api.apply(image.ctx,1,1,'lr-does-not-exist'),/tidak tersedia/);
});
test('catalog rejects an external or traversing LUT path',async()=>{
 const h=harness({manifest:{size:17,presets:[{...catalog.presets[0],lut:'../private.lut'}]}});
 await assert.rejects(h.api.load(),/tidak valid/);assert.equal(h.requests.length,1);
});
