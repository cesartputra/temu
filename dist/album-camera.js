'use strict';
window.TemuAlbumCamera=(()=>{
  const el=id=>document.getElementById(id);
  let stream,recorder,timer,version=0,mode='photo',facing='environment',receive,changed=()=>{},discard=false,active=false;
  function stop(){version++;clearInterval(timer);if(recorder&&recorder.state!=='inactive'){discard=true;recorder.stop();}stream?.getTracks().forEach(t=>t.stop());stream=null;el('camera-live').srcObject=null;}
  function close(){
    active=false;stop();el('camera-status').textContent='';el('camera-live').hidden=true;el('camera-controls').hidden=true;el('camera-actions').hidden=false;
    const photo=!!el('photo-preview').getAttribute('src'),video=!!el('video-preview').getAttribute('src');
    el('photo-preview').hidden=!photo;el('video-preview').hidden=!video;el('placeholder').hidden=photo||video;
    const preview=photo?el('photo-preview'):video?el('video-preview'):null;
    el('viewfinder').style.aspectRatio=preview?(photo?preview.naturalWidth+'/'+preview.naturalHeight:preview.videoWidth+'/'+preview.videoHeight):'';
    el('photo-overlay').hidden=true;changed();
  }
  function errorText(e){return e.name==='NotAllowedError'?'Akses kamera ditolak. Izinkan kamera di pengaturan browser, lalu coba lagi.':e.name==='NotFoundError'?'Kamera tidak ditemukan pada perangkat ini.':'Kamera belum tersedia. Tutup aplikasi lain yang memakai kamera, lalu coba lagi.';}
  async function start(){
    stop();const current=version;el('camera-shutter').disabled=true;el('camera-switch').disabled=true;el('camera-status').textContent='Menyiapkan kamera…';
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Kamera langsung memerlukan HTTPS dan browser yang mendukung kamera. Buka tautan di Safari atau Chrome.');
      if(mode==='video'&&!window.MediaRecorder)throw Error('Rekam video belum didukung browser ini. Gunakan foto atau buka Safari/Chrome terbaru.');
      const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:mode==='photo'?1440:1280},height:{ideal:mode==='photo'?1920:720}},audio:mode==='video'});
      if(current!==version||!active){next.getTracks().forEach(t=>t.stop());return;}
      stream=next;el('camera-live').srcObject=stream;await el('camera-live').play();
      if(current!==version)return;
      el('camera-shutter').setAttribute('aria-label',mode==='photo'?'Ambil foto':'Mulai rekam video');el('camera-shutter').classList.remove('recording');el('camera-shutter').disabled=false;el('camera-switch').disabled=false;el('camera-status').textContent=mode==='photo'?'Bingkai momenmu, lalu tekan tombol bulat untuk memotret.':'Rekam hingga 60 detik. Tekan selesai untuk menyimpan pratinjau.';el('viewfinder').style.aspectRatio=el('camera-live').videoWidth+'/'+el('camera-live').videoHeight;changed();
    }catch(e){if(current!==version)return;close();el('camera-status').textContent=e.name==='Error'?e.message:errorText(e);}
  }
  async function snap(){
    const video=el('camera-live');if(!video.videoWidth)return;
    el('camera-shutter').disabled=true;
    const current=version,canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
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
      recording.onerror=()=>{discard=true;close();el('camera-status').textContent='Rekaman terputus. Tutup kamera lalu coba lagi.';};
      recording.onstop=()=>{clearInterval(timer);if(discard||current!==version||!active)return;const type=recording.mimeType.split(';')[0],blob=new Blob(chunks,{type});if(!blob.size){close();el('camera-status').textContent='Video belum berhasil direkam. Tutup kamera lalu coba lagi.';return;}const captured=new File([blob],'video-'+Date.now()+(type==='video/mp4'?'.mp4':'.webm'),{type});close();receive(captured);};
      recording.start(1000);el('camera-switch').disabled=true;el('camera-shutter').setAttribute('aria-label','Selesai rekam');el('camera-shutter').classList.add('recording');el('camera-status').textContent='Merekam · 00:00 / 01:00';
      timer=setInterval(()=>{seconds++;el('camera-status').textContent='Merekam · 00:'+String(seconds).padStart(2,'0')+' / 01:00';if(seconds>=60&&recording.state==='recording'){el('camera-shutter').disabled=true;recording.stop();}},1000);
    }catch(e){el('camera-status').textContent=e.message;}
  }
  el('camera-shutter').onclick=()=>mode==='photo'?snap():record();
  el('camera-switch').onclick=()=>{facing=facing==='environment'?'user':'environment';start();};
  el('close-camera').onclick=close;
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)close();});window.addEventListener('pagehide',close);
  function nativeCamera(){return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'')||navigator.userAgentData?.mobile===true||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);}
  const input=el('native-video');
  input.onchange=()=>{const captured=input.files?.[0];if(captured)receive?.(captured);input.value='';};
  return {close,get mode(){return mode;},isActive:()=>active,open(kind,onCapture,onState=()=>{}){
    close();mode=kind;receive=onCapture;changed=onState;
    // Keep the phone's native recorder for video; photos use the inline studio.
    if(kind==='video'&&nativeCamera()){input.value='';input.click();return;}
    active=true;el('camera-controls').hidden=false;el('camera-actions').hidden=true;el('camera-live').hidden=false;
    for(const id of ['placeholder','photo-preview','video-preview','photo-overlay'])el(id).hidden=true;
    el('video-preview').pause();el('viewfinder').style.aspectRatio='';changed();start();
  }};
})();
