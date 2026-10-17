'use strict';
window.TemuAlbumPhoto=(()=>{
  const assetURL='/album-overlay-v1.png';
  const artworks={};
  function overlay(style='celebration'){
    if(style==='none')return Promise.resolve(null);
    const url=style==='monogram'?'/album-overlay-monogram.svg':assetURL;
    if(!artworks[style])artworks[style]=new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);
      image.onerror=()=>{delete artworks[style];reject(Error('Hiasan foto belum dapat dimuat. Periksa koneksi, lalu coba lagi.'));};
      image.src=url;
    });
    return artworks[style];
  }
  function placement(width,height,ratio){
    const w=Math.min(width*.88,height*.4*ratio),h=w/ratio;
    return {x:(width-w)/2,y:height-h,width:w,height:h};
  }
  async function decode(source){
    if(typeof createImageBitmap==='function'){
      try{return await createImageBitmap(source,{imageOrientation:'from-image'});}catch{/* Safari can decode supported camera images through an image element. */}
    }
    return new Promise((resolve,reject)=>{
      const image=new Image(),url=URL.createObjectURL(source);
      image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
      image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Foto belum dapat dibaca. Ambil foto JPG lalu coba lagi.'));};
      image.src=url;
    });
  }
  async function mirror(source){
    if(source.type==='image/jpeg'){
      const bytes=new Uint8Array(await source.arrayBuffer()),view=new DataView(bytes.buffer);
      if(bytes[0]===255&&bytes[1]===216){
        let offset=2,hasExif=false;
        while(offset+4<=bytes.length){
          if(bytes[offset]!==255)break;
          const marker=bytes[offset+1];if(marker===218||marker===217)break;
          if(marker===255){offset++;continue;}
          if(marker===1||(marker>=208&&marker<=215)){offset+=2;continue;}
          const length=view.getUint16(offset+2),end=offset+2+length;
          if(length<2||end>bytes.length)break;
          if(marker===225&&length>=16&&[69,120,105,102,0,0].every((value,i)=>bytes[offset+4+i]===value)){
            hasExif=true;const start=offset+10,little=bytes[start]===73&&bytes[start+1]===73;
            if((!little&&!(bytes[start]===77&&bytes[start+1]===77))||start+8>end||view.getUint16(start+2,little)!==42)break;
            const first=view.getUint32(start+4,little),directory=start+first;
            if(first<8||directory+2>end)break;
            const count=view.getUint16(directory,little);if(directory+2+count*12+4>end)break;
            for(let n=0;n<count;n++){
              const entry=directory+2+n*12;
              if(view.getUint16(entry,little)!==274)continue;
              const orientation=view.getUint16(entry+8,little);
              if(view.getUint16(entry+2,little)!==3||view.getUint32(entry+4,little)!==1||orientation<1||orientation>8)break;
              // Flip the displayed image, including rotated EXIF orientations.
              view.setUint16(entry+8,orientation%2?orientation+1:orientation-1,little);
              return new File([bytes],source.name,{type:'image/jpeg'});
            }
            break;
          }
          offset=end;
        }
        if(!hasExif&&offset+1<bytes.length&&(bytes[offset+1]===218||bytes[offset+1]===217)){
          const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,2,0,0,0,0,0,0,0]);
          return new File([bytes.subarray(0,2),exif,bytes.subarray(2)],source.name,{type:'image/jpeg'});
        }
      }
    }
    const photo=await decode(source);let canvas;
    try{
      const width=photo.naturalWidth||photo.width,height=photo.naturalHeight||photo.height;
      if(!width||!height||width*height>40000000||Math.max(width,height)>8192)throw Error('Foto terlalu besar untuk di-mirror tanpa menurunkan resolusi. Matikan Mirror atau ambil ulang.');
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('Mirror belum dapat diproses. Matikan Mirror atau coba lagi.');
      ctx.translate(width,0);ctx.scale(-1,1);ctx.drawImage(photo,0,0,width,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(!blob)throw Error('Mirror belum berhasil diproses. Foto tetap tersedia untuk dicoba lagi.');
      return new File([blob],'selfie-mirror.png',{type:'image/png'});
    }finally{photo.close?.();if(canvas)canvas.width=canvas.height=1;}
  }
  function filterPixels(ctx,width,height,filter){
    // Camera browsers without Canvas filter support still bake the chosen preset.
    const pixels=ctx.getImageData(0,0,width,height),data=pixels.data;
    const steps=[...filter.matchAll(/(sepia|saturate|contrast|brightness|grayscale)\(([^)]+)\)/g)].map(([,name,value])=>[name,Number(value)]);
    const clamp=value=>Math.max(0,Math.min(255,value));
    for(let i=0;i<data.length;i+=4){
      let r=data[i],g=data[i+1],b=data[i+2];
      for(const [name,a] of steps){
        if(name==='brightness'){r*=a;g*=a;b*=a;}
        else if(name==='contrast'){r=(r-127.5)*a+127.5;g=(g-127.5)*a+127.5;b=(b-127.5)*a+127.5;}
        else if(name==='sepia'){const t=Math.min(1,a),nr=r*.393+g*.769+b*.189,ng=r*.349+g*.686+b*.168,nb=r*.272+g*.534+b*.131;r=r*(1-t)+nr*t;g=g*(1-t)+ng*t;b=b*(1-t)+nb*t;}
        else {const t=name==='grayscale'?1-Math.min(1,a):a,l=r*.2126+g*.7152+b*.0722;r=l+(r-l)*t;g=l+(g-l)*t;b=l+(b-l)*t;}
        r=clamp(r);g=clamp(g);b=clamp(b);
      }
      data[i]=r;data[i+1]=g;data[i+2]=b;
    }
    ctx.putImageData(pixels,0,0);
  }
  function dazzEffect(ctx,width,height){
    // Fine film grain, lifted shadows and a subtle corner vignette. This is
    // an original preset inspired by compact film cameras, not a Dazz Cam SDK.
    const pixels=ctx.getImageData(0,0,width,height),data=pixels.data;let seed=20261121;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=(y*width+x)*4;seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const grain=((seed>>>24)/255-.5)*12,edge=Math.min(1,((x/width-.5)**2+(y/height-.5)**2)*2),shade=1-edge*.13;
      for(let c=0;c<3;c++)data[i+c]=Math.max(0,Math.min(255,(data[i+c]*.97+4+grain)*shade));
    }
    ctx.putImageData(pixels,0,0);
  }
  async function thumbnail(source){
    const photo=await decode(source);let canvas;
    try{
      const width=photo.naturalWidth||photo.width,height=photo.naturalHeight||photo.height;
      const scale=Math.min(1,720/Math.max(width,height));
      canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      canvas.getContext('2d').drawImage(photo,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.8));
      if(!blob||blob.size>512*1024)throw Error('Pratinjau foto belum dapat dibuat.');
      return blob;
    }finally{photo.close?.();if(canvas)canvas.width=canvas.height=1;}
  }
  async function story(source,filter='none',style='celebration',effect=''){
    const art=await overlay(style),photo=await decode(source);let canvas;
    try{
      const width=photo.naturalWidth||photo.width,height=photo.naturalHeight||photo.height;
      if(!width||!height)throw Error('Foto belum dapat dibaca. Unduh file asli untuk membagikannya.');
      if(width*height>40000000||Math.max(width,height)>8192)throw Error('Foto terlalu besar untuk membuat Story di HP ini tanpa menurunkan resolusi. Unduh file asli untuk membagikannya melalui Instagram.');
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('Story belum dapat dibuat. Unduh file asli.');
      // Keep the original ratio and dimensions, without padding or cropping.
      const nativeFilter='filter' in ctx;if(nativeFilter)ctx.filter=filter;
      ctx.drawImage(photo,0,0,width,height);
      if(nativeFilter)ctx.filter='none';else if(filter!=='none')filterPixels(ctx,width,height,filter);
      if(effect==='dazz')dazzEffect(ctx,width,height);
      if(art){const box=placement(width,height,art.naturalWidth/art.naturalHeight);ctx.drawImage(art,box.x,box.y,box.width,box.height);}
      // PNG is lossless; original bytes remain untouched in the album.
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(!blob)throw Error('Story terlalu besar untuk diproses di HP ini. Unduh file asli.');
      return new File([blob],'reva-cesar-story.png',{type:'image/png'});
    }finally{photo.close?.();if(canvas)canvas.width=canvas.height=1;}
  }
  return {overlay,placement,story,thumbnail,mirror,assetURL};
})();
