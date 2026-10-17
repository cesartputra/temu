const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album-photo.js','utf8');
function harness({width=3024,height=4032,failEncode=false,failAsset=false,nativeFilter=true}={}){
 const draws=[],canvases=[],closed=[];
 class Artwork{constructor(){this.naturalWidth=2172;this.naturalHeight=724;}set src(value){if(value.endsWith('.svg')){this.naturalWidth=1200;this.naturalHeight=240;}this.url=value;queueMicrotask(()=>failAsset?this.onerror():this.onload());}}
 const ctx={filter:'none',fillRect(){},translate:(...args)=>closed.push(['translate',...args]),scale:(...args)=>closed.push(['scale',...args]),drawImage:(image,...box)=>draws.push({image,box,filter:ctx.filter})};
 if(!nativeFilter){delete ctx.filter;ctx.getImageData=()=>({data:new Uint8ClampedArray([120,60,30,255])});ctx.putImageData=p=>ctx.pixels=p.data;}
 const document={createElement(){const c={getContext:()=>ctx,toBlob:(done,type,quality)=>{c.encoded={width:c.width,height:c.height,type,quality};done(failEncode?null:new Blob(['pixels'],{type}));}};canvases.push(c);return c;}};
 const context={window:{},Image:Artwork,document,createImageBitmap:async()=>({width,height,close:()=>closed.push(true)}),File:class extends Blob{constructor(parts,name,options){super(parts,options);this.name=name;}},URL,Blob};vm.runInNewContext(source,context);
 return {photo:context.window.TemuAlbumPhoto,draws,canvases,closed,ctx};
}
test('Story export preserves original dimensions and positions overlay at the bottom center',async()=>{
 for(const [width,height] of [[3024,4032],[4032,3024],[720,1280],[2000,500]]){
  const h=harness({width,height}),result=await h.photo.story(new Blob(['original']),'sepia(.3)','celebration');
  const size=h.canvases[0].encoded;assert.equal(size.width,width);assert.equal(size.height,height);assert.equal(size.type,'image/png');assert.equal(size.quality,undefined);assert.equal(result.type,'image/png');
  assert.deepEqual(h.draws[0].box,[0,0,width,height]);assert.equal(h.draws[0].filter,'sepia(.3)');
  const [x,y,w,hgt]=h.draws[1].box;assert.ok(Math.abs(x+w/2-size.width/2)<1e-8);assert.ok(Math.abs(y+hgt-size.height)<1e-8);assert.ok(hgt<=height*.4+1e-8);assert.equal(h.draws[1].filter,'none');assert.equal(h.closed.length,1);assert.equal(h.canvases[0].width,1);
 }
});
test('monogram and no overlay are available only for Story rendering',async()=>{
 const h=harness();await h.photo.story(new Blob(),'none','monogram');assert.equal(h.draws[1].image.url,'/album-overlay-monogram.svg');
 const clean=harness({failAsset:true});await clean.photo.story(new Blob(),'none','none');assert.equal(clean.draws.length,1);
});
test('thumbnail is separate, bounded to 720 px, and never applies a filter or overlay',async()=>{
 const h=harness(),blob=await h.photo.thumbnail(new Blob(['original']));assert.equal(blob.type,'image/jpeg');assert.equal(h.canvases[0].encoded.width,540);assert.equal(h.canvases[0].encoded.height,720);assert.equal(h.draws.length,1);assert.equal(h.draws[0].filter,'none');assert.equal(h.closed.length,1);
});
test('oversized Story fails explicitly rather than downscaling the original photo',async()=>{
 const h=harness({width:8064,height:6048});await assert.rejects(h.photo.story(new Blob()),/tanpa menurunkan resolusi/);assert.equal(h.canvases.length,0);assert.equal(h.closed.length,1);
});
test('missing art or failed encoding keeps errors visible and releases decoded resources',async()=>{
 const art=harness({failAsset:true});await assert.rejects(art.photo.story(new Blob()),/Hiasan foto/);assert.equal(art.canvases.length,0);
 const encode=harness({failEncode:true});await assert.rejects(encode.photo.story(new Blob()),/Unduh file asli/);assert.equal(encode.closed.length,1);assert.equal(encode.canvases[0].width,1);
});
test('Safari pixel fallback applies monochrome and Dazz grain to Story exports',async()=>{
 const mono=harness({width:1,height:1,nativeFilter:false});await mono.photo.story(new Blob(),'grayscale(1)','none');assert.equal(mono.ctx.pixels[0],mono.ctx.pixels[1]);assert.equal(mono.ctx.pixels[1],mono.ctx.pixels[2]);
 const dazz=harness({width:1,height:1,nativeFilter:false});await dazz.photo.story(new Blob(),'none','none','dazz');assert.notDeepEqual([...dazz.ctx.pixels],[120,60,30,255]);
});

function jpeg(orientation,little=true){
 const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,1,0,0,0,0,0,0,0]);
 const view=new DataView(exif.buffer);exif[10]=exif[11]=little?73:77;view.setUint16(12,42,little);view.setUint32(14,8,little);view.setUint16(18,1,little);view.setUint16(20,274,little);view.setUint16(22,3,little);view.setUint32(24,1,little);view.setUint16(28,orientation,little);
 return new Blob([new Uint8Array([255,216]),exif,new Uint8Array([255,218,0,2,11,22,33,44,255,217])],{type:'image/jpeg'});
}
test('JPEG mirror changes only EXIF orientation, preserving encoded image bytes and all rotations',async()=>{
 const h=harness();for(const little of [true,false])for(let orientation=1;orientation<=8;orientation++){
  const source=jpeg(orientation,little),before=new Uint8Array(await source.arrayBuffer()),result=await h.photo.mirror(source),after=new Uint8Array(await result.arrayBuffer());
  assert.equal(result.type,'image/jpeg');assert.equal(result.size,source.size);assert.equal(new DataView(after.buffer).getUint16(30,little),orientation%2?orientation+1:orientation-1);
  const restored=after.slice();new DataView(restored.buffer).setUint16(30,orientation,little);assert.deepEqual(restored,before);assert.deepEqual(new Uint8Array(await source.arrayBuffer()),before);
 }
 assert.equal(h.canvases.length,0);
});
test('JPEG without EXIF gains only a mirror orientation segment and keeps its compressed scan intact',async()=>{
 const h=harness(),original=new Uint8Array([255,216,255,224,0,4,0,0,255,218,0,2,12,23,34,255,217]);
 const result=await h.photo.mirror(new Blob([original],{type:'image/jpeg'})),bytes=new Uint8Array(await result.arrayBuffer());
 assert.equal(result.size,original.length+36);assert.deepEqual(bytes.slice(38),original.slice(2));assert.equal(new DataView(bytes.buffer).getUint16(30,true),2);assert.equal(h.canvases.length,0);
});
test('PNG/WebP and unsupported EXIF use a full-resolution lossless mirror and release decoded image',async()=>{
 for(const source of [new Blob(['png'],{type:'image/png'}),jpeg(0)]){
  const h=harness(),result=await h.photo.mirror(source);assert.equal(result.type,'image/png');assert.equal(h.canvases[0].encoded.width,3024);assert.equal(h.canvases[0].encoded.height,4032);assert.equal(h.canvases[0].encoded.quality,undefined);
  assert.deepEqual(h.closed[0],['translate',3024,0]);assert.deepEqual(h.closed[1],['scale',-1,1]);assert.equal(h.closed[2],true);assert.equal(h.canvases[0].width,1);
 }
});
