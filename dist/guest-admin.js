'use strict';
function invitationOrigin(){const configured=db.event.wedding?.publicOrigin;return configured||location.origin;}
async function guestInvitationURL(g){
 await syncNow();const record=await TemuStore.read();
 if(record.outbox.length||record.conflicts.some(x=>!x.resolved))throw Error('Selesaikan sinkronisasi sebelum membagikan tautan tamu.');
 if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk membuat tautan unik tamu.');
 const response=await fetch('/api/invite/admin/link',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+record.config.token,'X-Temu-Invite':'1'},body:JSON.stringify({event:db.event.id,guest:g.id}),cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await response.json();
 if(!response.ok)throw Error(data.error||'Tautan tamu belum dapat dibuat.');
 const url=new URL('/invitation2',invitationOrigin());url.hash=new URLSearchParams({g:data.guest,k:data.key}).toString();return url.href;
}
async function showGuestInvitation(g){
 modal('Undangan digital · '+g.name,'<p id="invite-loading">Menyiapkan tautan unik tamu…</p>');
 const loading=$('#invite-loading');
 try{const link=await guestInvitationURL(g);if($('#invite-loading')!==loading||!$('#modal').open)return;const url=new URL(link),isPublic=db.guests.find(guest=>guest.id===g.id)?.invitationMode==='public';
 $('#modal-body').innerHTML=`<p>Tautan ini menampilkan sapaan khusus untuk <strong>${esc(g.name)}</strong>, serta memungkinkan RSVP dan kirim doa. QR masuk dibagikan terpisah.</p><label>Mode akses undangan</label><button id="invitation-access-toggle" type="button" class="guest-toggle ${isPublic?'is-on':''}" role="switch" aria-checked="${isPublic}" aria-label="Akses Public untuk ${esc(g.name)}"><span class="toggle-track" aria-hidden="true"></span><span>${isPublic?'Public':'Private'}</span></button><p>${isPublic?'Public: tautan dapat dibuka di beberapa browser. Siapa pun yang memiliki tautan bisa mengisi RSVP dan ucapan atas nama tamu ini.':'Private: akses dikunci ke browser pertama yang membuka tautan. Jangan buka tautan tamu dari perangkat pengelola.'}</p><label>Tautan unik tamu<input id="personal-invite-link" readonly value="${esc(link)}"></label><div class="actions"><button id="reset-invitation-device">Pulihkan akses perangkat</button><button id="copy-public-link">Salin tautan</button><button id="share-public-invite" class="primary">Siapkan QR + tautan WhatsApp</button></div><p class="hint">${url.hostname==='localhost'||url.hostname==='127.0.0.1'?'Alamat masih lokal dan tidak dapat dibuka di ponsel tamu. Siapkan hosting HTTPS.':'URL undangan tetap sama saat mode Private/Public diubah.'}</p>`;
 $('#invitation-access-toggle').onclick=()=>showInvitationAccessChange(g);
 $('#reset-invitation-device').onclick=()=>resetInvitationDevice(g);
 $('#copy-public-link').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('Tautan disalin.');}catch{$('#personal-invite-link').select();toast('Pilih dan salin tautan secara manual.');}};
 $('#share-public-invite').onclick=()=>{if(url.hostname==='localhost'||url.hostname==='127.0.0.1')return toast('Atur alamat publik HTTPS sebelum membagikan tautan.');showWhatsApp(g,link);};
 }catch(error){if($('#invite-loading')===loading)loading.textContent=error.message;}
}
async function showInvitationAccessChange(g){
 if(!await admin())return;
 const current=db.guests.find(guest=>guest.id===g.id&&guest.active&&!guest.deleted);if(!current)return toast('Undangan sudah tidak aktif.');
 const mode=current.invitationMode==='public'?'private':'public',publicMode=mode==='public';
 modal('Ubah akses menjadi '+(publicMode?'Public':'Private')+'?',`<p>URL undangan <strong>${esc(current.name)}</strong> yang sudah dibagikan tetap sama.</p><p>${publicMode?'Siapa pun yang memiliki tautan dapat membuka undangan dari browser mana saja, serta mengisi RSVP dan ucapan atas nama tamu ini.':'Browser pemilik sebelumnya tetap mendapat akses. Jika belum ada pemilik, browser pertama yang membuka tautan setelah mode Private aktif menjadi pemiliknya.'}</p><div class="actions"><button id="invitation-access-confirm" type="button" class="primary">Jadikan ${publicMode?'Public':'Private'}</button><button id="invitation-access-cancel" type="button">Batal</button></div><p id="invitation-access-status" role="status"></p>`);
 const button=$('#invitation-access-confirm'),status=$('#invitation-access-status');$('#invitation-access-cancel').onclick=()=>showGuestInvitation(current);
 button.onclick=async()=>{
  button.disabled=true;
  try{
   if((db.guests.find(guest=>guest.id===g.id)?.invitationMode||'private')!==mode)await commit(state=>{const guest=state.guests.find(guest=>guest.id===g.id&&guest.active&&!guest.deleted);if(!guest)throw Error('Undangan sudah tidak aktif.');guest.invitationMode=mode;});
   await syncNow();const record=await TemuStore.read(),saved=record.state.guests.find(guest=>guest.id===g.id&&guest.active&&!guest.deleted);
   if(!saved)throw Error('Undangan sudah tidak aktif. Perbarui daftar tamu.');
   if(!record.config.enabled||!record.config.token||record.outbox.length||record.conflicts.some(conflict=>!conflict.resolved)||(saved.invitationMode||'private')!==mode)throw Error('Perubahan belum diterapkan di server. Hubungkan dan sinkronkan server, periksa konflik, lalu coba lagi.');
   toast('Akses '+(publicMode?'Public':'Private')+' tersimpan. URL undangan tetap sama.');
   if($('#modal').open&&$('#invitation-access-confirm')===button)await showGuestInvitation(saved);
  }catch(error){if($('#modal').open&&$('#invitation-access-confirm')===button)status.textContent=error.message;}
  finally{button.disabled=false;}
 };
}
async function showBulkPublicInvitations(){
 if(!await admin())return;
 modal('Jadikan semua undangan Public?','<p id="bulk-public-loading" role="status">Memeriksa sinkronisasi undangan…</p>');
 const loading=$('#bulk-public-loading');
 try{
  await syncNow();const record=await TemuStore.read();
  if(!$('#modal').open||$('#bulk-public-loading')!==loading)return;
  if(!record.config.enabled||!record.config.token||record.outbox.length||record.conflicts.some(c=>!c.resolved))throw Error('Hubungkan dan sinkronkan server serta selesaikan konflik sebelum mengubah semua undangan.');
  const event=record.state.event.id,guests=record.state.guests.filter(g=>g.active&&!g.deleted&&g.invitationMode!=='public'),ids=new Set(guests.map(g=>g.id));
  if(!ids.size){$('#modal').close();return toast('Semua undangan aktif sudah Public, atau belum ada undangan aktif.');}
  modal('Jadikan semua undangan Public?',`<p><strong>${ids.size} undangan aktif</strong> akan diubah menjadi Public, termasuk undangan di luar filter daftar. Undangan nonaktif atau yang dihapus dilewati.</p><p>Siapa pun yang memiliki tautan dapat membuka undangan dari browser mana saja, serta mengisi RSVP dan ucapan atas nama tamu tersebut.</p><p>URL yang sudah dibagikan tetap sama. Mode akses tiap tamu tetap dapat diubah kembali satu per satu.</p><div class="actions"><button id="bulk-public-confirm" type="button" class="primary">Ya, jadikan semua Public</button><button id="bulk-public-cancel" type="button">Batal</button></div><p id="bulk-public-status" role="status"></p>`);
  const button=$('#bulk-public-confirm'),status=$('#bulk-public-status');$('#bulk-public-cancel').onclick=()=>$('#modal').close();
  button.onclick=async()=>{
   if(button.disabled)return;button.disabled=true;status.textContent='Menyimpan dan menyinkronkan perubahan…';
   try{
    if(!await admin())return;
    await commit(state=>{
     if(state.event.id!==event)throw Error('Acara telah berubah. Buka kembali konfirmasi.');
     const targets=state.guests.filter(g=>ids.has(g.id)&&g.active&&!g.deleted);
     if(targets.length!==ids.size)throw Error('Daftar tamu berubah. Buka kembali konfirmasi.');
     for(const guest of targets)guest.invitationMode='public';
    });
    await syncNow();const saved=await TemuStore.read();
    if(saved.state.event.id!==event||!saved.config.enabled||!saved.config.token||saved.outbox.length||saved.conflicts.some(c=>!c.resolved)||saved.state.guests.filter(g=>ids.has(g.id)&&g.active&&!g.deleted&&g.invitationMode==='public').length!==ids.size)throw Error('Perubahan belum diterapkan di server. Sinkronkan dan periksa konflik, lalu coba lagi.');
    toast(ids.size+' undangan berhasil menjadi Public. URL undangan tetap sama.');
    if($('#modal').open&&$('#bulk-public-confirm')===button)$('#modal').close();
   }catch(error){if($('#modal').open&&$('#bulk-public-confirm')===button)status.textContent=error.message;}
   finally{button.disabled=false;}
  };
 }catch(error){if($('#modal').open&&$('#bulk-public-loading')===loading)loading.textContent=error.message;}
}
$('#bulk-public-invitations').onclick=showBulkPublicInvitations;
function renderRsvpWhatsApp(){
 const guests=new Map(db.guests.filter(g=>!g.deleted).map(g=>[g.id,g]));
 document.querySelectorAll('[data-rsvp-whatsapp]').forEach(cell=>{
  const guest=guests.get(cell.dataset.rsvpWhatsapp),status=guest?.whatsappSentAt?'sent':guest?.whatsappOpenedAt?'opened':'pending';
  cell.className='rsvp-status rsvp-whatsapp '+status;
  cell.textContent=!guest?'Belum tercatat':status==='sent'?'Sudah kirim':status==='opened'?'Dibuka · belum ditandai kirim':'Belum ditandai kirim';
 });
}
async function loadRsvp(){
 const summary=$('#rsvp-summary'),list=$('#rsvp-list');if(!summary||!list)return;
 try{const record=await TemuStore.read();if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk melihat konfirmasi tamu.');
 const response=await fetch('/api/invite/admin/rsvp',{headers:{'Authorization':'Bearer '+record.config.token},cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Konfirmasi belum dapat dimuat.');
 const s=data.summary;summary.innerHTML=[['attending',s.attending,'Konfirmasi hadir'],['declined',s.declined,'Tidak bisa hadir'],['pending',s.pending,'Belum konfirmasi'],['persons',s.persons,'Orang rencana hadir']].map(([status,total,label])=>`<div class="rsvp-metric ${status}"><strong>${Number(total)||0}</strong><span>${label}</span></div>`).join('');
 list.innerHTML=data.guests.length?'<div class="rsvp-list-head"><span>Tamu undangan</span><span>Status WhatsApp</span><span>Status RSVP</span></div>'+data.guests.map(g=>{const status=['attending','declined'].includes(g.status)?g.status:'pending',group=g.group??db.guests.find(x=>x.id===g.id)?.group??'',initial=Array.from(g.name.trim())[0]||'·';return `<div class="rsvp-row"><div class="rsvp-guest"><span class="rsvp-avatar" aria-hidden="true">${esc(initial.toUpperCase())}</span><div><strong>${esc(g.name)}</strong><span class="rsvp-group">${esc(group||'Tanpa kelompok')}</span></div></div><span class="rsvp-status rsvp-whatsapp" data-rsvp-whatsapp="${esc(g.id)}"></span><span class="rsvp-status ${status}">${status==='attending'?'Hadir · '+(Number(g.count)||0)+' orang':status==='declined'?'Tidak bisa hadir':'Belum konfirmasi'}</span></div>`;}).join(''):'<p class="rsvp-empty">Belum ada tamu aktif.</p>';
 renderRsvpWhatsApp();
 }catch(error){summary.innerHTML=`<p role="status">${esc(error.message)}</p>`;list.replaceChildren();}
}
$('#refresh-rsvp').onclick=loadRsvp;

async function showWishManagement(){
 if(!await admin())return;
 modal('Kelola doa & ucapan','<div class="actions"><button id="wish-admin-refresh" type="button">Perbarui</button></div><p id="wish-admin-status" role="status">Memuat doa dan ucapan…</p><div id="wish-admin-list" class="wish-admin-list"></div>');
 const list=$('#wish-admin-list'),status=$('#wish-admin-status');$('#wish-admin-refresh').onclick=showWishManagement;
 try{
  const record=await TemuStore.read();if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk mengelola doa dan ucapan.');
  const response=await fetch('/api/invite/admin/wishes',{headers:{'Authorization':'Bearer '+record.config.token},cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();
  if(!response.ok)throw Error(data.error||'Doa dan ucapan belum dapat dimuat.');
  if($('#wish-admin-list')!==list||!$('#modal').open)return;
  if(data.event!==db.event.id)throw Error('Acara berubah. Buka kembali daftar doa dan ucapan.');
  status.textContent=data.wishes.length+' doa dan ucapan.';
  list.innerHTML=data.wishes.length?data.wishes.map(item=>`<article class="card wish-admin-card"><h3>${esc(item.name)}</h3><p>${esc(item.message)}</p><small>${esc(new Date(item.updated).toLocaleString('id-ID'))}</small><div class="actions"><button type="button" class="danger" data-delete-wish="${esc(item.guest)}">Hapus ucapan</button></div></article>`).join(''):'<p>Belum ada doa dan ucapan.</p>';
  list.onclick=event=>{const button=event.target.closest('[data-delete-wish]'),item=data.wishes.find(item=>item.guest===button?.dataset.deleteWish);if(item)showDeleteWish(item,data.event);};
 }catch(error){if($('#wish-admin-list')===list)status.textContent=error.message;}
}
function showDeleteWish(item,event){
 if(!db.pin)return toast('Atur dan sinkronkan PIN pengelola sebelum menghapus ucapan.');
 modal('Hapus doa & ucapan?',`<p>Hapus ucapan dari <strong>${esc(item.name)}</strong> pada undangan digital? Data tamu dan RSVP tetap tersimpan. Tindakan ini tidak dapat dibatalkan dari aplikasi.</p><blockquote class="wish-admin-message">${esc(item.message)}</blockquote><form id="wish-delete-form"><label>Masukkan ulang PIN pengelola<input id="wish-delete-pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" required autocomplete="off"></label><div class="actions"><button type="submit" class="danger">Hapus ucapan</button><button id="wish-delete-cancel" type="button">Batal</button></div><p id="wish-delete-status" role="status"></p></form>`);
 const form=$('#wish-delete-form'),status=$('#wish-delete-status');
 $('#wish-delete-cancel').onclick=showWishManagement;
 form.onsubmit=async e=>{
  e.preventDefault();const button=$('#wish-delete-form button[type=submit]'),pin=$('#wish-delete-pin').value;button.disabled=true;
  try{
   if(event!==db.event.id)throw Error('Acara berubah. Buka kembali daftar doa dan ucapan.');
   const record=await TemuStore.read();if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk menghapus ucapan.');
   if(!$('#modal').open||$('#wish-delete-form')!==form)return;
   const response=await fetch('/api/invite/admin/wishes/delete',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+record.config.token,'X-Temu-Invite':'1'},body:JSON.stringify({event,guest:item.guest,updated:item.updated,pin}),cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();
   if(!response.ok||!data.ok)throw Error(data.error||'Ucapan belum dapat dihapus.');
   toast('Doa dan ucapan dihapus.');if($('#modal').open&&$('#wish-delete-form')===form)await showWishManagement();
  }catch(error){if($('#modal').open&&$('#wish-delete-form')===form)status.textContent=error.message;}
  finally{button.disabled=false;}
 };
}
$('#manage-wishes').onclick=showWishManagement;

async function resetInvitationDevice(g){
 modal('Pulihkan akses · '+g.name,`<p>Tautan lama akan dibatalkan. Tautan pengganti dapat dibuka pertama kali pada browser tamu yang baru. QR check-in tetap sama.</p><form id="reset-device-form"><label>Masukkan ulang PIN pengelola<input id="reset-device-pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" required autocomplete="off"></label><button class="primary">Buat tautan pengganti</button><p id="reset-device-status" role="status"></p></form>`);
 $('#reset-device-form').onsubmit=async event=>{event.preventDefault();const button=$('#reset-device-form button');button.disabled=true;try{await syncNow();const record=await TemuStore.read();if(record.outbox.length||record.conflicts.some(x=>!x.resolved))throw Error('Selesaikan sinkronisasi terlebih dahulu.');const response=await fetch('/api/invite/admin/reset-device',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+record.config.token,'X-Temu-Invite':'1'},body:JSON.stringify({event:db.event.id,guest:g.id,pin:$('#reset-device-pin').value}),cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Akses belum dapat dipulihkan.');await showGuestInvitation(g);}catch(error){if($('#reset-device-status'))$('#reset-device-status').textContent=error.message;}finally{button.disabled=false;}};
}
