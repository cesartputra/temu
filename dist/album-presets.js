'use strict';
(function(root){
 let catalog,loading;
 const tables=new Map(),cache=new Map();
 const base='/album-presets/';
 async function load(){
  if(catalog)return catalog.presets;
  if(!loading)loading=(async()=>{
   const response=await root.fetch(base+'catalog.json?v=20261017-1',{cache:'force-cache',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Koleksi filter belum dapat dimuat. Coba lagi.');
   const data=await response.json();
   if(data.size!==17||!Array.isArray(data.presets)||data.presets.length>200||data.presets.some(p=>!/^lr-[a-z0-9-]+$/.test(p.id)||!/^lr-[a-z0-9-]+-[a-f0-9]{10}\.lut$/.test(p.lut)||typeof p.name!=='string'||p.name.length>80||typeof p.family!=='string'||!Number.isFinite(p.grain)||!Number.isFinite(p.vignette)||!Array.isArray(p.swatch)||p.swatch.length!==2||p.swatch.some(c=>!/^#[0-9a-f]{6}$/.test(c))))throw Error('Koleksi filter tidak valid.');
   catalog=data;for(const preset of data.presets)tables.set(preset.id,preset);
   return data.presets;
  })().catch(error=>{loading=null;throw error;});
  return loading;
 }
 function has(id){return tables.has(id);}
 function get(id){return tables.get(id);}
 async function table(id){
  await load();const preset=tables.get(id);if(!preset)throw Error('Filter tidak tersedia. Pilih filter lain.');
  if(!cache.has(id)){
   const pending=(async()=>{
    const response=await root.fetch(base+preset.lut,{cache:'force-cache',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Filter belum dapat dimuat. Coba lagi.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length!==17**3*3)throw Error('Data filter tidak lengkap. Coba lagi.');
    return bytes;
   })().catch(error=>{cache.delete(id);throw error;});
   cache.set(id,pending);
   // Keep only a few tiny LUTs when guests browse a large collection.
   while(cache.size>4)cache.delete(cache.keys().next().value);
  }
  return cache.get(id);
 }
 const positions=new Uint16Array(256),fractions=new Float32Array(256);
 for(let value=0;value<256;value++){const position=value*16/255;positions[value]=Math.min(15,Math.floor(position));fractions[value]=position-positions[value];}
 async function apply(ctx,width,height,id){
  const lut=await table(id),preset=get(id),pixels=ctx.getImageData(0,0,width,height),data=pixels.data;
  const grain=Math.max(0,Math.min(100,preset.grain))*.3,vignette=Math.max(-100,Math.min(100,preset.vignette))/100;
  let seed=20261121;
  for(let start=0;start<data.length;start+=1048576){
   const end=Math.min(data.length,start+1048576);
   for(let i=start;i<end;i+=4){
    const r=data[i],g=data[i+1],b=data[i+2],fr=fractions[r],fg=fractions[g],fb=fractions[b];
    const p=(positions[r]+positions[g]*17+positions[b]*289)*3;
    let first,second,high,middle,low;
    // Tetrahedral interpolation needs four RGB samples and avoids colour bands.
    if(fr>=fg){
     if(fg>=fb){first=3;second=51;high=fr;middle=fg;low=fb;}
     else if(fr>=fb){first=3;second=867;high=fr;middle=fb;low=fg;}
     else{first=867;second=3;high=fb;middle=fr;low=fg;}
    }else{
     if(fr>=fb){first=51;second=3;high=fg;middle=fr;low=fb;}
     else if(fg>=fb){first=51;second=867;high=fg;middle=fb;low=fr;}
     else{first=867;second=51;high=fb;middle=fg;low=fr;}
    }
    let noise=0,shade=1;
    if(grain){seed=(Math.imul(seed,1664525)+1013904223)>>>0;noise=((seed>>>24)/255-.5)*grain;}
    if(vignette){const pixel=i/4,x=pixel%width,y=Math.floor(pixel/width),edge=Math.min(1,((x/width-.5)**2+(y/height-.5)**2)*2);shade=1+vignette*edge*.55;}
    for(let c=0;c<3;c++)data[i+c]=(lut[p+c]*(1-high)+lut[p+first+c]*(high-middle)+lut[p+first+second+c]*(middle-low)+lut[p+921+c]*low+noise)*shade;
   }
   // Full-resolution Story exports yield between chunks so the UI stays usable.
   if(end<data.length)await new Promise(resolve=>setTimeout(resolve,0));
  }
  ctx.putImageData(pixels,0,0);
 }
 const api={load,has,get,apply};if(typeof module==='object'&&module.exports)module.exports=api;else root.TemuAlbumPresets=api;
})(typeof window==='object'?window:globalThis);
