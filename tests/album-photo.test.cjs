const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album-photo.js','utf8');
function harness({width=3024,height=4032,failEncode=false,failAsset=false,nativeFilter=true}={}){
 const draws=[],canvases=[],closed=[];
 class Artwork{constructor(){this.naturalWidth=2172;this.naturalHeight=724;}set src(value){if(value.endsWith('.svg')){this.naturalWidth=1200;this.naturalHeight=240;}this.url=value;queueMicrotask(()=>failAsset?this.onerror():this.onload());}}
 const ctx={filter:'none',fillRect(){},drawImage:(image,...box)=>draws.push({image,box,filter:ctx.filter})};
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
