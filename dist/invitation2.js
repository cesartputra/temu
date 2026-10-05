'use strict';
const $=selector=>document.querySelector(selector);
const music=$('#music'),musicToggle=$('#music-toggle'),musicLabel=$('#music-label');
let personal=null,accessAllowed=false;
function safeText(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function setMusicState(){const playing=!music.paused;musicToggle.setAttribute('aria-pressed',String(playing));musicToggle.setAttribute('aria-label',playing?'Jeda musik':'Putar musik');musicLabel.textContent=playing?'Jeda musik':'Putar musik';}
async function playMusic(){if(!accessAllowed)return;try{await music.play();}catch{}setMusicState();}
musicToggle.addEventListener('click',async()=>{if(music.paused)await playMusic();else{music.pause();setMusicState();}});
music.addEventListener('play',setMusicState);music.addEventListener('pause',setMusicState);
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
function safeMap(value){try{const url=new URL(value);return url.protocol==='https:'&&['maps.app.goo.gl','www.google.com','google.com','maps.google.com'].includes(url.hostname)?url.href:null;}catch{return null;}}
function dateText(raw,options){if(!/^\d{4}-\d{2}-\d{2}$/.test(raw||''))return 'Tanggal akan diinformasikan';return new Date(raw+'T12:00:00').toLocaleDateString('id-ID',options);}
let countdownTimer,confettiShown=false;
function celebrate(){
  if(confettiShown||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  confettiShown=true;
  const layer=document.createElement('div');layer.className='confetti-layer';layer.setAttribute('aria-hidden','true');
  const colors=['#e8c69d','#f5e9d6','#a2453c','#bd9c72','#fff9ee'];
  for(let i=0;i<32;i++){
    const piece=document.createElement('span');piece.className='confetti-piece';
    piece.style.setProperty('--x',`${Math.random()*100}%`);
    piece.style.setProperty('--delay',`${Math.random()*4}s`);
    piece.style.setProperty('--duration',`${4+Math.random()*4}s`);
    piece.style.setProperty('--drift',`${Math.random()*160-80}px`);
    piece.style.backgroundColor=colors[i%colors.length];layer.append(piece);
  }
  document.body.append(layer);setTimeout(()=>layer.remove(),12000);
}
function countdown(raw){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw||''))return;
  clearInterval(countdownTimer);
  const target=new Date(raw+'T00:00:00+07:00').getTime();
  function render(){
    const remaining=Math.max(0,target-Date.now());
    const totalSeconds=Math.ceil(remaining/1000);
    const days=Math.floor(totalSeconds/86400);
    const hours=Math.floor(totalSeconds%86400/3600);
    const minutes=Math.floor(totalSeconds%3600/60);
    const seconds=totalSeconds%60;
    $('#hero-days').textContent=String(days);
    $('#hero-hours').textContent=String(hours).padStart(2,'0');
    $('#hero-minutes').textContent=String(minutes).padStart(2,'0');
    $('#hero-seconds').textContent=String(seconds).padStart(2,'0');
    if(!remaining){clearInterval(countdownTimer);celebrate();}
  }
  render();
  if(target>Date.now())countdownTimer=setInterval(render,1000);
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
  const qr=qrcode(0,'M');qr.addData(info.guest.qr);qr.make();$('#personal-qr').innerHTML='<h3>'+safeText(recipient(info.guest))+'</h3>'+qr.createSvgTag(5,20);
  if(info.wish)$('#wish-message').value=info.wish.message;
}
let invitationOpened=false;
$('#open-personal').addEventListener('click',async()=>{
  if(invitationOpened)return;
  invitationOpened=true;
  const button=$('#open-personal');button.disabled=true;
  // Start sound in the tap handler so browsers can authorize playback.
  music.src='/api/invite/public-media/song.mp3';playMusic();
  const video=$('#hero-video');video.src='/api/invite/public-media/film.mp4';video.play().catch(()=>{});
  $('#guest-cover').classList.add('is-opening');
  if(!reducedMotion.matches)await new Promise(resolve=>setTimeout(resolve,420));
  $('#guest-cover').hidden=true;$('#invitation').hidden=false;
  musicToggle.hidden=false;document.body.classList.add('invitation-open');
  window.scrollTo(0,0);$('#invitation').focus({preventScroll:true});
  setupPageMotion();setupNavigation();setupGallery();wishScroller?.refresh();
});
document.querySelectorAll('a[href^="#"]').forEach(anchor=>anchor.addEventListener('click',event=>{if(!personal)return;const target=document.querySelector(anchor.getAttribute('href'));if(target){event.preventDefault();target.scrollIntoView({behavior:reducedMotion.matches?'auto':'smooth'});}}));
$('#rsvp-form').addEventListener('change',()=>{$('#rsvp-count-wrap').hidden=$('#rsvp-form input[name="status"]:checked')?.value!=='attending';});
$('#rsvp-form').addEventListener('submit',async event=>{event.preventDefault();if(!personal)return;const status=$('#rsvp-form input[name="status"]:checked')?.value,count=status==='attending'?Number($('#rsvp-count').value):0,button=$('#rsvp-form button[type=submit]');button.disabled=true;try{const info=await invitePost('rsvp',{...personal,status,count});$('#rsvp-status').textContent=info.rsvp.status==='attending'?'Terima kasih! Kehadiran '+info.rsvp.count+' orang sudah dikonfirmasi.':'Konfirmasi belum bisa hadir telah tersimpan. Terima kasih sudah memberi kabar.';await loadWishes();}catch(error){$('#rsvp-status').textContent=error.message;}finally{button.disabled=false;}});
$('#wish-form').addEventListener('submit',async event=>{event.preventDefault();if(!personal)return;const button=$('#wish-form button[type=submit]');button.disabled=true;try{await invitePost('wish',{...personal,message:$('#wish-message').value});$('#wish-status').textContent='Doa Anda tersimpan. Terima kasih.';await loadWishes();}catch(error){$('#wish-status').textContent=error.message;}finally{button.disabled=false;}});
let calendarURL=null;
let wishScroller=null;
function wishCard(wish){return '<article class="wish-card"><strong>'+safeText(wish.name)+'</strong><span class="wish-attendance '+(['attending','declined'].includes(wish.status)?wish.status:'pending')+'">'+(wish.status==='attending'?'✓ Konfirmasi hadir':wish.status==='declined'?'Tidak bisa hadir':'Belum konfirmasi')+'</span><time>'+safeText(new Date(wish.updated).toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'}))+'</time><p tabindex="0">'+safeText(wish.message)+'</p></article>';}
function renderWishes(wishes){
 wishScroller?.destroy();wishScroller=null;
 const list=$('#wish-list'),groups=wishes.map(wish=>[wish]);
 if(!groups.length){list.innerHTML='<p>Belum ada doa. Jadilah yang pertama mengirimkan ucapan hangat.</p>';list.classList.remove('has-pages');return;}
 list.classList.add('has-pages');
 list.innerHTML=wishes.map(wishCard).join('');
 const cards=[...list.children];
 const clone=document.createElement('div');clone.className='wish-loop-copy';clone.setAttribute('aria-hidden','true');clone.inert=true;clone.innerHTML=cards.map(card=>card.outerHTML).join('');list.append(clone);
 wishScroller=TemuInviteScroll.create({viewport:list,axis:'x',speed:26,stops:()=>cards.map(card=>card.offsetLeft).concat(clone.offsetLeft)});
 requestAnimationFrame(()=>wishScroller?.reset());
}
async function loadWishes(){try{const response=await fetch('/api/invite/wishes',{cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Doa belum dapat dimuat.');renderWishes(data.wishes);}catch(error){wishScroller?.destroy();wishScroller=null;$('#wish-list').classList.remove('has-pages');$('#wish-list').textContent=error.message;}}
async function loadInvitation(){accessAllowed=false;try{const params=new URLSearchParams(location.hash.slice(1)),guest=params.get('g'),key=params.get('k');if(!guest||!key)throw Error('Undangan ini hanya dapat dibuka melalui tautan unik yang dikirimkan kepada Anda.');personal={guest,key};const info=await invitePost('guest',personal);accessAllowed=true;const response=await fetch('/api/invite/public?g='+encodeURIComponent(personal.guest),{cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok||!data.event)throw Error(data.error||'Undangan belum tersedia.');const event=data.event,w=event.wedding||{};const legacy=w.firstName==='Cesar'&&w.secondName==='Revalina',first=legacy?'Reva':w.firstName||'Reva',second=legacy?'Cesar':w.secondName||'Cesar';$('#first-name').textContent=first;$('#second-name').textContent=second;$('#signature').textContent=first+' & '+second;$('#closing-names').textContent=first+' & '+second;$('#cover-date').textContent=dateText(event.date,{day:'numeric',month:'long',year:'numeric'});$('#event-date').textContent=dateText(event.date,{weekday:'long',day:'numeric',month:'long',year:'numeric'});$('#venue').textContent=w.venue||'Tempat akan diinformasikan';$('#address').textContent=w.address||'Bandung, Jawa Barat';setupSchedule(info.guest,w);setupGift(w);setupCalendar(event,w,info);const map=safeMap(w.mapsURL);$('#maps-link').hidden=!map;if(map)$('#maps-link').href=map;countdown(event.date);document.title=first+' & '+second+' — Undangan Pernikahan';$('#load-error').hidden=true;showPersonal(info);loadWishes();}catch(error){accessAllowed=false;music.pause();musicToggle.hidden=true;$('#invitation').hidden=true;$('#guest-cover').hidden=true;$('#error-message').textContent=error.message||'Periksa koneksi dan coba lagi.';$('#load-error').hidden=false;}}
$('#retry').addEventListener('click',loadInvitation);loadInvitation();

function setupPageMotion(){
  window.TemuInvitationMotion?.setup({root:$('#invitation'),preference:reducedMotion});
  if(!('IntersectionObserver' in window))return;
  const sections=document.querySelectorAll('.cover-paper,.section,.portrait-band,footer');
  const sketches=document.querySelectorAll('#invitation .sketch');
  document.body.classList.toggle('motion-ready',!reducedMotion.matches);
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
    // Keep observing: leaving the viewport resets the animation for the next visit.
    const className=entry.target.classList.contains('motion-sketch')?'sketch-in-view':'in-view';
    entry.target.classList.toggle(className,entry.isIntersecting);
  }),{threshold:0,rootMargin:'0px 0px -35px 0px'});
  sections.forEach(section=>{section.classList.add('reveal');observer.observe(section);});
  sketches.forEach(sketch=>{sketch.classList.add('motion-sketch');observer.observe(sketch);});
  reducedMotion.addEventListener('change',event=>document.body.classList.toggle('motion-ready',!event.matches));
}
function setupNavigation(){
  const links=[...document.querySelectorAll('.topbar div a')];
  let frame;
  function update(){
    const marker=innerHeight*.35;
    const current=links.find(link=>{const rect=$(link.getAttribute('href')).getBoundingClientRect();return rect.top<=marker&&rect.bottom>marker;});
    links.forEach(link=>{const active=link===current;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
  }
  window.addEventListener('scroll',()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);},{passive:true});
  window.addEventListener('resize',update);update();
}
const gallery=$('.gallery'),galleryItems=[...document.querySelectorAll('.gallery-item')];
let galleryScroller=null;
function setupGallery(){
 if(galleryScroller)return;
 const groups=TemuInviteScroll.batches(galleryItems,3);
 const pages=groups.map(items=>{const page=document.createElement('div');page.className='gallery-page';items.forEach(item=>page.append(item));return page;});
 gallery.replaceChildren(...pages);
 const clone=pages[0].cloneNode(true);clone.setAttribute('aria-hidden','true');clone.inert=true;clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));clone.classList.add('gallery-clone');gallery.append(clone);
 galleryScroller=TemuInviteScroll.create({viewport:gallery,axis:'x',speed:32,stops:()=>[...pages,clone].map(page=>page.offsetLeft)});
}

const viewer=$('#photo-viewer');let photoTrigger=null;
galleryItems.forEach(item=>item.addEventListener('click',()=>{const photo=item.querySelector('img');photoTrigger=item;$('#photo-full').src=photo.currentSrc||photo.src;$('#photo-full').alt=photo.alt;$('#photo-caption').textContent=item.querySelector('span').textContent;viewer.showModal();}));
$('#photo-close').addEventListener('click',()=>viewer.close());viewer.addEventListener('click',event=>{if(event.target===viewer){const rect=viewer.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)viewer.close();}});viewer.addEventListener('close',()=>photoTrigger?.focus({preventScroll:true}));

function setupSchedule(guest,wedding){
 const show=(selector,raw)=>{const matches=String(raw||'').match(/(\d{1,2})[.:](\d{2}).*?(\d{1,2})[.:](\d{2})/);$(selector).innerHTML=matches?'<strong>'+matches[1]+'.'+matches[2]+' <span>WIB</span></strong><small>hingga '+matches[3]+'.'+matches[4]+' WIB</small>':safeText(raw||'Waktu akan diinformasikan');};
 if(guest.akad==='y')show('#ceremony-time',wedding.ceremonyTime||'15.30 WIB - 17.00 WIB');else $('#ceremony-time').textContent='Family Only';
 show('#reception-time',wedding.receptionTime||'18.30 WIB - 20.30 WIB');
}
function setupGift(w){
 $('#gift').hidden=![w.giftBank,w.giftAccount,w.giftName].every(value=>typeof value==='string'&&value.trim());
 for(const [selector,key] of [['#gift-bank','giftBank'],['#gift-account','giftAccount'],['#gift-name','giftName']])$(selector).textContent=w[key]||'';
 $('#copy-account').onclick=async()=>{try{await navigator.clipboard.writeText(w.giftAccount);$('#gift-status').textContent='Nomor rekening disalin.';}catch{$('#gift-status').textContent='Pilih dan salin nomor rekening di atas.';}};
}
function setupCalendar(event,wedding,info){
 const links=TemuInviteCalendar.links({date:event.date,wedding,akad:info.guest.akad==='y',calendarPath:info.guest.calendarPath,origin:location.origin});
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),android=/Android/.test(navigator.userAgent);
 $('#calendar-native').href=ios?links.apple:android?links.android:links.apple;
 $('#calendar-native').textContent=ios?'Buka Apple Calendar':android?'Buka kalender Android':'Apple Calendar';
 $('#calendar-google').href=links.google;
 $('#calendar-description').textContent=info.guest.akad==='y'?'Simpan jadwal akad dan resepsi.':'Simpan jadwal resepsi.';
 $('.calendar-hint').textContent=info.guest.akad==='y'?'Simpan jadwal akad dan resepsi agar tidak terlewat.':'Simpan jadwal resepsi agar tidak terlewat.';
 $('#save-calendar').onclick=e=>{e.preventDefault();$('#calendar-choice').showModal();};
 $('#calendar-close').onclick=()=>$('#calendar-choice').close();
}
