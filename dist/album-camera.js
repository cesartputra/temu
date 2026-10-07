'use strict';
window.TemuAlbumCamera=(()=>{
  const el=id=>document.getElementById(id);
  let stream,recorder,timer,version=0,mode='photo',facing='environment',receive,discard=false;
  function stop(){version++;clearInterval(timer);if(recorder&&recorder.state!=='inactive'){discard=true;recorder.stop();}stream?.getTracks().forEach(t=>t.stop());stream=null;el('camera-live').srcObject=null;}
  function errorText(e){return e.name==='NotAllowedError'?'Akses kamera ditolak. Izinkan kamera di pengaturan browser, lalu coba lagi.':e.name==='NotFoundError'?'Kamera tidak ditemukan pada perangkat ini.':'Kamera belum tersedia. Tutup aplikasi lain yang memakai kamera, lalu coba lagi.';}
  async function start(){
    stop();const current=version;el('camera-shutter').disabled=true;el('camera-switch').disabled=true;el('camera-status').textContent='Menyiapkan kamera…';
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Kamera langsung memerlukan HTTPS dan browser yang mendukung kamera. Buka tautan di Safari atau Chrome.');
      if(mode==='video'&&!window.MediaRecorder)throw Error('Rekam video belum didukung browser ini. Gunakan foto atau buka Safari/Chrome terbaru.');
      const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:mode==='photo'?1920:1280},height:{ideal:mode==='photo'?1440:720}},audio:mode==='video'});
      if(current!==version||!el('camera-dialog').open){next.getTracks().forEach(t=>t.stop());return;}
      stream=next;el('camera-live').srcObject=stream;await el('camera-live').play();
      if(current!==version)return;
      el('camera-shutter').textContent=mode==='photo'?'◎ Ambil foto':'● Mulai rekam';el('camera-shutter').disabled=false;el('camera-switch').disabled=false;el('camera-status').textContent=mode==='photo'?'Bingkai momenmu, lalu ambil foto.':'Rekam hingga 60 detik. Tekan selesai untuk menyimpan pratinjau.';
    }catch(e){if(current!==version)return;stop();el('camera-status').textContent=e.name==='Error'?e.message:errorText(e);}
  }
  async function snap(){
    const video=el('camera-live');if(!video.videoWidth)return;
    el('camera-shutter').disabled=true;
    const current=version,canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.98));
    if(current!==version||!el('camera-dialog').open)return;
    if(!blob){el('camera-status').textContent='Foto belum berhasil diambil. Coba lagi.';el('camera-shutter').disabled=false;return;}
    receive(new File([blob],'foto-'+Date.now()+'.jpg',{type:'image/jpeg'}));el('camera-dialog').close();
  }
  function record(){
    if(recorder?.state==='recording'){el('camera-shutter').disabled=true;recorder.stop();return;}
    try{
      const mime=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'].find(x=>MediaRecorder.isTypeSupported(x));
      if(!mime)throw Error('Format rekam video belum didukung. Ambil foto atau gunakan browser lain.');
      const chunks=[];let bytes=0,seconds=0;const current=version;discard=false;
      const active=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6000000});recorder=active;
      active.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>95*1024*1024&&active.state==='recording')active.stop();}};
      active.onerror=()=>{discard=true;stop();el('camera-status').textContent='Rekaman terputus. Tutup kamera lalu coba lagi.';};
      active.onstop=()=>{clearInterval(timer);if(discard||current!==version||!el('camera-dialog').open)return;const type=active.mimeType.split(';')[0],blob=new Blob(chunks,{type});if(!blob.size){stop();el('camera-status').textContent='Video belum berhasil direkam. Tutup kamera lalu coba lagi.';return;}receive(new File([blob],'video-'+Date.now()+(type==='video/mp4'?'.mp4':'.webm'),{type}));el('camera-dialog').close();};
      active.start(1000);el('camera-switch').disabled=true;el('camera-shutter').textContent='■ Selesai rekam';el('camera-status').textContent='Merekam · 00:00 / 01:00';
      timer=setInterval(()=>{seconds++;el('camera-status').textContent='Merekam · 00:'+String(seconds).padStart(2,'0')+' / 01:00';if(seconds>=60&&active.state==='recording'){el('camera-shutter').disabled=true;active.stop();}},1000);
    }catch(e){el('camera-status').textContent=e.message;}
  }
  el('camera-shutter').onclick=()=>mode==='photo'?snap():record();
  el('camera-switch').onclick=()=>{facing=facing==='environment'?'user':'environment';start();};
  el('close-camera').onclick=()=>el('camera-dialog').close();el('camera-dialog').addEventListener('close',stop);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&el('camera-dialog').open)el('camera-dialog').close();});window.addEventListener('pagehide',stop);
  return {open(kind,onCapture){mode=kind;receive=onCapture;el('camera-title').textContent=kind==='photo'?'Abadikan momenmu.':'Rekam cerita kecilmu.';el('camera-dialog').showModal();start();}};
})();
