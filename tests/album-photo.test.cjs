const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('dist/album-photo.js','utf8');
function harness({width=3024,height=4032,failEncode=false,failAsset=false,nativeFilter=true}={}){
 const draws=[],canvases=[],closed=[];
 class Artwork{constructor(){this.naturalWidth=2172;this.naturalHeight=724;}set src(value){this.url=value;queueMicrotask(()=>failAsset?this.onerror():this.onload());}}
 const ctx={filter:'none',drawImage:(image,...box)=>draws.push({image,box,filter:ctx.filter})};
 if(!nativeFilter){delete ctx.filter;ctx.getImageData=()=>({data:new Uint8ClampedArray([120,60,30,255])});ctx.putImageData=pixels=>ctx.pixels=pixels.data;}
 const document={createElement(){const c={getContext:()=>ctx,toBlob:(done,type,quality)=>{c.encoded={width:c.width,height:c.height,type,quality};done(failEncode?null:new Blob(['decorated'],{type}));}};canvases.push(c);return c;}};
 const context={window:{},Image:Artwork,document,createImageBitmap:async()=>({width,height,close:()=>closed.push(true)}),File:class extends Blob{constructor(parts,name,options){super(parts,options);this.name=name;}},URL,Blob};
 vm.runInNewContext(source,context);
 return {photo:context.window.TemuAlbumPhoto,draws,canvases,closed,ctx};
}
test('portrait upload keeps camera dimensions and draws selected overlay after the filtered photo',async()=>{
 const h=harness(),result=await h.photo.prepare({name:'camera.png'},'sepia(.3)');
 assert.equal(result.type,'image/jpeg');assert.equal(result.name,'camera-reva-cesar.jpg');assert.equal(h.canvases[0].encoded.width,3024);assert.equal(h.canvases[0].encoded.height,4032);
 assert.equal(h.draws.length,2);assert.equal(h.draws[0].filter,'sepia(.3)');assert.equal(h.draws[1].filter,'none');assert.equal(h.draws[1].image.url,'/album-overlay-v1.png');assert.equal(h.closed.length,1);assert.equal(h.canvases[0].width,1);
});
test('overlay fits portrait and landscape photos without cropping or stretching artwork',()=>{
 const h=harness();for(const [w,hgt] of [[3024,4032],[4032,3024],[4000,1000]]){
  const b=h.photo.placement(w,hgt,3);assert.ok(b.x>=0&&b.y>=0);assert.ok(b.x+b.width<=w&&b.y+b.height<=hgt);assert.ok(b.height<=hgt*.28);assert.equal(b.width/b.height,3);assert.equal(b.x,(w-b.width)/2);
 }
});
test('missing overlay prevents undecorated upload and permits loading again',async()=>{
 const h=harness({failAsset:true});await assert.rejects(h.photo.prepare({name:'camera.jpg'}),/Hiasan foto/);await assert.rejects(h.photo.overlay(),/Hiasan foto/);assert.equal(h.canvases.length,0);
});
test('canvas encoding failure closes decoded image and frees canvas',async()=>{
 const h=harness({failEncode:true});await assert.rejects(h.photo.prepare({name:'camera.jpg'}),/belum berhasil/);assert.equal(h.closed.length,1);assert.equal(h.canvases[0].width,1);
});
test('very large capture fails safely without silently reducing resolution',async()=>{
 const h=harness({width:8000,height:6000});await assert.rejects(h.photo.prepare({name:'camera.jpg'}),/12 MP/);assert.equal(h.canvases.length,0);assert.equal(h.closed.length,1);
});

test('bakes monochrome on camera browsers without native Canvas filter support',async()=>{
 const h=harness({nativeFilter:false,width:1,height:1});await h.photo.prepare({name:'camera.jpg'},'grayscale(1)');
 assert.equal(h.ctx.pixels[0],h.ctx.pixels[1]);assert.equal(h.ctx.pixels[1],h.ctx.pixels[2]);assert.equal(h.ctx.pixels[3],255);assert.equal(h.draws.length,2);
});
