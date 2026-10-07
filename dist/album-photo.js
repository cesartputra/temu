'use strict';
window.TemuAlbumPhoto=(()=>{
  const assetURL='/album-overlay-v1.png';
  let artwork;
  function overlay(){
    if(!artwork)artwork=new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);
      image.onerror=()=>{artwork=null;reject(Error('Hiasan foto belum dapat dimuat. Periksa koneksi, lalu coba lagi.'));};
      image.src=assetURL;
    });
    return artwork;
  }
  function placement(width,height,ratio){
    const w=Math.min(width*.96,height*.28*ratio),h=w/ratio;
    return {x:(width-w)/2,y:height-h-height*.018,width:w,height:h};
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
  async function prepare(source,filter='none'){
    const art=await overlay(),photo=await decode(source);let canvas;
    try{
      const width=photo.naturalWidth||photo.width,height=photo.naturalHeight||photo.height;
      if(!width||!height||width*height>24000000||Math.max(width,height)>8192)throw Error('Foto terlalu besar untuk diproses. Ambil ulang dengan resolusi kamera 12 MP.');
      canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('Foto belum dapat diproses pada perangkat ini. Coba lagi di Safari atau Chrome.');
      const nativeFilter='filter' in ctx;
      if(nativeFilter)ctx.filter=filter;
      ctx.drawImage(photo,0,0,width,height);
      if(nativeFilter)ctx.filter='none';
      else if(filter!=='none')filterPixels(ctx,width,height,filter);
      const box=placement(width,height,art.naturalWidth/art.naturalHeight);
      ctx.drawImage(art,box.x,box.y,box.width,box.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.96));
      if(!blob)throw Error('Foto belum berhasil diproses. Ambil ulang dengan resolusi kamera 12 MP.');
      return new File([blob],source.name.replace(/\.[^.]*$/,'')+'-reva-cesar.jpg',{type:'image/jpeg'});
    }finally{photo.close?.();if(canvas){canvas.width=canvas.height=1;}}
  }
  return {overlay,placement,prepare,assetURL};
})();
