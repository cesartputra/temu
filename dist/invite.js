'use strict';
const $=selector=>document.querySelector(selector);
const music=$('#music'),musicToggle=$('#music-toggle'),musicLabel=$('#music-label');
let personal=null;
function safeText(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function setMusicState(){const playing=!music.paused;musicToggle.setAttribute('aria-pressed',String(playing));musicToggle.setAttribute('aria-label',playing?'Jeda musik':'Putar musik');musicLabel.textContent=playing?'Jeda musik':'Putar musik';}
async function playMusic(){try{await music.play();}catch{}setMusicState();}
musicToggle.addEventListener('click',async()=>{if(music.paused)await playMusic();else{music.pause();setMusicState();}});
music.addEventListener('play',setMusicState);music.addEventListener('pause',setMusicState);
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#music-toggle')&&music.paused)playMusic();},{once:true});
document.addEventListener('keydown',()=>{if(document.activeElement!==musicToggle&&music.paused)playMusic();},{once:true});
function safeMap(value){try{const url=new URL(value);return url.protocol==='https:'&&['maps.app.goo.gl','www.google.com','google.com','maps.google.com'].includes(url.hostname)?url.href:null;}catch{return null;}}
function dateText(raw,options){if(!/^\d{4}-\d{2}-\d{2}$/.test(raw||''))return 'Tanggal akan diinformasikan';return new Date(raw+'T12:00:00').toLocaleDateString('id-ID',options);}
let countdownTimer;
function countdown(raw){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw||''))return;
  clearInterval(countdownTimer);
  const target=new Date(raw+'T00:00:00+07:00').getTime();
  function render(){
    const remaining=Math.max(0,target-Date.now());
    const totalMinutes=Math.ceil(remaining/60000);
    const days=Math.floor(totalMinutes/1440);
    const hours=Math.floor(totalMinutes%1440/60);
    const minutes=totalMinutes%60;
    $('#hero-days').textContent=String(days);
    $('#hero-hours').textContent=String(hours).padStart(2,'0');
    $('#hero-minutes').textContent=String(minutes).padStart(2,'0');
    $('#countdown').textContent=remaining>0?days+' hari menuju hari bahagia':'Hari bahagia telah tiba';
    if(!remaining)clearInterval(countdownTimer);
  }
  render();
  if(target>Date.now())countdownTimer=setInterval(render,15000);
}
async function invitePost(path,payload){const response=await fetch('/api/invite/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Temu-Invite':'1'},body:JSON.stringify(payload),cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok)throw Error(data.error||'Permintaan belum berhasil.');return data;}
function recipient(guest){return guest.name+(guest.quota===2?' & Pasangan':guest.quota>2?' & Keluarga':'');}
function showPersonal(info){
  $('#cover-recipient').textContent=recipient(info.guest);
  $('#guest-cover').hidden=false;
  $('#invitation').hidden=true;
  $('#rsvp-form').hidden=false;
  $('#wish-form').hidden=false;
  $('#rsvp-intro').textContent='Konfirmasi untuk '+info.guest.name+'. Undangan berlaku hingga '+info.guest.quota+' orang.';
  const countSelect=$('#rsvp-count');
  countSelect.replaceChildren();
  for(let count=1;count<=info.guest.quota;count++)countSelect.add(new Option(String(count),String(count)));
  countSelect.value=String(info.guest.quota);
  if(info.rsvp){
    const choice=$('#rsvp-form input[value="'+info.rsvp.status+'"]');
    if(choice)choice.checked=true;
    if(info.rsvp.status==='attending')countSelect.value=String(info.rsvp.count);
    $('#rsvp-count-wrap').hidden=info.rsvp.status!=='attending';
    $('#rsvp-status').textContent=info.rsvp.status==='attending'?'Tersimpan: hadir '+info.rsvp.count+' orang.':'Tersimpan: belum bisa hadir.';
  }
  if(info.wish)$('#wish-message').value=info.wish.message;
}
$('#open-personal').addEventListener('click',()=>{$('#guest-cover').hidden=true;$('#invitation').hidden=false;window.scrollTo(0,0);$('#hero-video').play().catch(()=>{});if(music.paused)playMusic();});
document.querySelectorAll('a[href^="#"]').forEach(anchor=>anchor.addEventListener('click',event=>{if(!personal)return;const target=document.querySelector(anchor.getAttribute('href'));if(target){event.preventDefault();target.scrollIntoView({behavior:'smooth'});}}));
$('#rsvp-form').addEventListener('change',()=>{$('#rsvp-count-wrap').hidden=$('#rsvp-form input[name="status"]:checked')?.value!=='attending';});
$('#rsvp-form').addEventListener('submit',async event=>{event.preventDefault();if(!personal)return;const status=$('#rsvp-form input[name="status"]:checked')?.value,count=status==='attending'?Number($('#rsvp-count').value):0,button=$('#rsvp-form button[type=submit]');button.disabled=true;try{const info=await invitePost('rsvp',{...personal,status,count});$('#rsvp-status').textContent=info.rsvp.status==='attending'?'Terima kasih! Kehadiran '+info.rsvp.count+' orang sudah dikonfirmasi.':'Konfirmasi belum bisa hadir telah tersimpan. Terima kasih sudah memberi kabar.';}catch(error){$('#rsvp-status').textContent=error.message;}finally{button.disabled=false;}});
$('#wish-form').addEventListener('submit',async event=>{event.preventDefault();if(!personal)return;const button=$('#wish-form button[type=submit]');button.disabled=true;try{await invitePost('wish',{...personal,message:$('#wish-message').value});$('#wish-status').textContent='Doa Anda tersimpan. Terima kasih.';await loadWishes();}catch(error){$('#wish-status').textContent=error.message;}finally{button.disabled=false;}});
async function loadWishes(){try{const response=await fetch('/api/invite/wishes',{cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Doa belum dapat dimuat.');$('#wish-list').innerHTML=data.wishes.length?data.wishes.map(wish=>'<article class="wish-card"><strong>'+safeText(wish.name)+'</strong><time>'+safeText(new Date(wish.updated).toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'}))+'</time><p>'+safeText(wish.message)+'</p></article>').join(''):'<p>Belum ada doa. Jadilah yang pertama mengirimkan ucapan hangat.</p>';}catch(error){$('#wish-list').textContent=error.message;}}
async function loadInvitation(){try{const response=await fetch('/api/invite/public',{cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok||!data.event)throw Error(data.error||'Undangan belum tersedia.');const event=data.event,w=event.wedding||{};const first=w.firstName||'Cesar',second=w.secondName||'Revalina';$('#first-name').textContent=first;$('#second-name').textContent=second;$('#signature').textContent=first+' & '+second;$('#closing-names').textContent=first+' & '+second;$('#cover-date').textContent=dateText(event.date,{day:'numeric',month:'long',year:'numeric'});$('#event-date').textContent=dateText(event.date,{weekday:'long',day:'numeric',month:'long',year:'numeric'});$('#cover-venue').textContent=w.venue||'Tempat akan diinformasikan';$('#venue').textContent=w.venue||'Tempat akan diinformasikan';$('#address').textContent=w.address||'Bandung, Jawa Barat';$('#ceremony-time').textContent=w.ceremonyTime||'Waktu akan diinformasikan';$('#reception-time').textContent=w.receptionTime||'Waktu akan diinformasikan';const map=safeMap(w.mapsURL);$('#maps-link').hidden=!map;if(map)$('#maps-link').href=map;countdown(event.date);document.title=first+' & '+second+' — Undangan Pernikahan';$('#load-error').hidden=true;const video=$('#hero-video');video.src='/api/invite/public-media/film.mp4';const params=new URLSearchParams(location.hash.slice(1)),guest=params.get('g'),key=params.get('k');if(guest||key){if(!guest||!key)throw Error('Tautan tamu tidak lengkap.');personal={guest,key};const info=await invitePost('guest',personal);showPersonal(info);}else{$('#invitation').hidden=false;video.play().catch(()=>{});$('#rsvp-intro').textContent='Buka tautan unik yang dikirimkan kepada Anda untuk mengonfirmasi kehadiran.';$('#wish-status').textContent='Kirim doa tersedia melalui tautan unik tamu.';}playMusic();loadWishes();}catch(error){$('#invitation').hidden=true;$('#guest-cover').hidden=true;$('#error-message').textContent=error.message||'Periksa koneksi dan coba lagi.';$('#load-error').hidden=false;}}
$('#retry').addEventListener('click',loadInvitation);loadInvitation();
