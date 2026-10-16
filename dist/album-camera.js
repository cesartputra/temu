'use strict';
window.TemuAlbumCamera=(()=>{
  const el=id=>document.getElementById(id);
  let stream,recorder,timer,version=0,mode='photo',facing='environment',receive,changed=()=>{},discard=false,active=false;
  function stop(){version++;clearInterval(timer);if(recorder&&recorder.state!=='inactive'){discard=true;recorder.stop();}stream?.getTracks().forEach(t=>t.stop());stream=null;el('camera-live').srcObject=null;}
  function frame(){
    const video=el('camera-live'),width=video.videoWidth||1440,height=video.videoHeight||1920;
    const ratio=mode==='video'?width/height:window.matchMedia('(orientation: landscape)').matches?4/3:3/4;
    const w=Math.min(width,height*ratio),h=w/ratio;
    return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};
  }
  function layout(){
    const box=el('camera-stage').getBoundingClientRect(),photo=el('photo-preview'),video=el('video-preview');
    const ratio=active?frame().width/frame().height:!photo.hidden&&photo.naturalWidth?photo.naturalWidth/photo.naturalHeight:!video.hidden&&video.videoWidth?video.videoWidth/video.videoHeight:window.matchMedia('(orientation: landscape)').matches?4/3:3/4;
    const view=el('viewfinder');view.style.aspectRatio=String(ratio);
    if(box.width&&box.height){const width=Math.min(box.width,box.height*ratio);view.style.width=width+'px';view.style.height=width/ratio+'px';}
  }
  function close(){
    active=false;stop();el('camera-status').textContent='';el('camera-live').hidden=true;el('camera-controls').hidden=true;
    const photo=!!el('photo-preview').getAttribute('src'),video=!!el('video-preview').getAttribute('src');
    el('photo-preview').hidden=!photo;el('video-preview').hidden=!video;el('placeholder').hidden=photo||video;
    el('photo-overlay').hidden=true;layout();changed();
  }
  function errorText(e){return e.name==='NotAllowedError'?(mode==='video'?'Akses kamera atau mikrofon ditolak. Izinkan keduanya di pengaturan browser, lalu coba lagi.':'Akses kamera ditolak. Izinkan kamera di pengaturan browser, lalu coba lagi.'):e.name==='NotFoundError'?'Kamera tidak ditemukan pada perangkat ini.':'Kamera belum tersedia. Tutup aplikasi lain yang memakai kamera, lalu coba lagi.';}
  async function start(){
    stop();const current=version;el('camera-shutter').disabled=true;el('camera-switch').disabled=true;el('camera-status').textContent='Menyiapkan kamera…';
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Kamera langsung memerlukan HTTPS dan browser yang mendukung kamera. Buka tautan di Safari atau Chrome.');
      if(mode==='video'&&!window.MediaRecorder)throw Error('Rekam video belum didukung browser ini. Gunakan foto atau buka Safari/Chrome terbaru.');
      const landscape=window.matchMedia('(orientation: landscape)').matches,wide=mode==='photo'?1920:1280,short=mode==='photo'?1440:720;
      const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:landscape?wide:short},height:{ideal:landscape?short:wide}},audio:mode==='video'});
      if(current!==version||!active){next.getTracks().forEach(t=>t.stop());return;}
      stream=next;el('camera-live').srcObject=stream;await el('camera-live').play();
      if(current!==version)return;
      el('camera-shutter').setAttribute('aria-label',mode==='photo'?'Ambil foto':'Mulai rekam video');el('camera-shutter').classList.remove('recording');el('camera-shutter').disabled=false;el('camera-switch').disabled=false;el('camera-status').textContent=mode==='photo'?'Bingkai momenmu, lalu tekan tombol bulat untuk memotret.':'Rekam hingga 60 detik. Tekan selesai untuk menyimpan pratinjau.';layout();changed();
    }catch(e){if(current!==version)return;close();el('camera-status').textContent=e.name==='Error'?e.message:errorText(e);}
  }
  async function snap(){
    const video=el('camera-live');if(!video.videoWidth)return;
    el('camera-shutter').disabled=true;
    const current=version,box=frame(),canvas=document.createElement('canvas');canvas.width=Math.round(box.width);canvas.height=Math.round(box.height);canvas.getContext('2d').drawImage(video,box.x,box.y,box.width,box.height,0,0,canvas.width,canvas.height);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.98));
    if(current!==version||!active)return;
    if(!blob){el('camera-status').textContent='Foto belum berhasil diambil. Coba lagi.';el('camera-shutter').disabled=false;return;}
    canvas.width=canvas.height=0;close();receive(new File([blob],'foto-'+Date.now()+'.jpg',{type:'image/jpeg'}));
  }
  function record(){
    if(recorder?.state==='recording'){el('camera-shutter').disabled=true;recorder.stop();return;}
    try{
      const mime=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));
      if(!mime)throw Error('Format rekam video belum didukung. Ambil foto atau gunakan browser lain.');
      const chunks=[];let bytes=0,seconds=0;const current=version;discard=false;
      const recording=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6000000});recorder=recording;
      recording.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>95*1024*1024&&recording.state==='recording')recording.stop();}};
      recording.onerror=()=>{if(current!==version)return;discard=true;close();el('camera-status').textContent='Rekaman terputus. Tutup kamera lalu coba lagi.';};
      recording.onstop=()=>{if(discard||current!==version||!active)return;clearInterval(timer);const type=recording.mimeType.split(';')[0],blob=new Blob(chunks,{type});if(!blob.size){close();el('camera-status').textContent='Video belum berhasil direkam. Tutup kamera lalu coba lagi.';return;}const captured=new File([blob],'video-'+Date.now()+(type==='video/mp4'?'.mp4':'.webm'),{type});close();receive(captured);};
      recording.start(1000);el('camera-switch').disabled=true;el('camera-shutter').setAttribute('aria-label','Selesai rekam');el('camera-shutter').classList.add('recording');el('camera-status').textContent='Merekam · 00:00 / 01:00';
      changed();timer=setInterval(()=>{seconds++;el('camera-status').textContent='Merekam · 00:'+String(seconds).padStart(2,'0')+' / 01:00';if(seconds>=60&&recording.state==='recording'){el('camera-shutter').disabled=true;recording.stop();}},1000);
    }catch(e){el('camera-status').textContent=e.message;}
  }
  el('camera-shutter').onclick=()=>mode==='photo'?snap():record();
  el('camera-switch').onclick=()=>{facing=facing==='environment'?'user':'environment';start();};
  el('close-camera').onclick=close;
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)close();});window.addEventListener('pagehide',close);window.addEventListener('resize',()=>{layout();changed();});el('camera-live').addEventListener('resize',()=>{layout();changed();});
  return {close,layout,frame,get mode(){return mode;},isActive:()=>active,isRecording:()=>recorder?.state==='recording',open(kind,onCapture,onState=()=>{}){
    close();mode=kind;receive=onCapture;changed=onState;
    active=true;el('camera-controls').hidden=false;el('camera-live').hidden=false;
    for(const id of ['placeholder','photo-preview','video-preview','photo-overlay'])el(id).hidden=true;
    el('video-preview').pause();layout();changed();start();
  }};
})();
