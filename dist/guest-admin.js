'use strict';
function invitationOrigin(){const configured=db.event.wedding?.publicOrigin;return configured||location.origin;}
async function guestInvitationURL(g){
 await syncNow();const record=await TemuStore.read();
 if(record.outbox.length||record.conflicts.some(x=>!x.resolved))throw Error('Selesaikan sinkronisasi sebelum membagikan tautan tamu.');
 if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk membuat tautan unik tamu.');
 const response=await fetch('/api/invite/admin/link',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+record.config.token,'X-Temu-Invite':'1'},body:JSON.stringify({event:db.event.id,guest:g.id}),cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await response.json();
 if(!response.ok)throw Error(data.error||'Tautan tamu belum dapat dibuat.');
 const url=new URL('/invite',invitationOrigin());url.hash=new URLSearchParams({g:data.guest,k:data.key}).toString();return url.href;
}
async function showGuestInvitation(g){
 modal('Undangan digital · '+g.name,'<p id="invite-loading">Menyiapkan tautan unik tamu…</p>');
 try{const link=await guestInvitationURL(g);if(!$('#invite-loading'))return;const url=new URL(link);
 $('#modal-body').innerHTML=`<p>Tautan ini menampilkan sapaan khusus untuk <strong>${esc(g.name)}</strong>, serta memungkinkan RSVP dan kirim doa. Akses dikunci ke browser pertama yang membuka tautan; QR masuk dibagikan terpisah. Jangan buka tautan tamu dari perangkat pengelola.</p><label>Tautan unik tamu<input id="personal-invite-link" readonly value="${esc(link)}"></label><div class="actions"><button id="reset-invitation-device">Pulihkan akses perangkat</button><button id="copy-public-link">Salin tautan</button><button id="share-public-invite" class="primary">Siapkan QR + tautan WhatsApp</button></div><p class="hint">${url.hostname==='localhost'||url.hostname==='127.0.0.1'?'Alamat masih lokal dan tidak dapat dibuka di ponsel tamu. Siapkan hosting HTTPS.':'Bagikan langsung kepada tamu yang dituju. Browser pertama yang membuka tautan akan menjadi browser pemilik akses.'}</p>`;
 $('#reset-invitation-device').onclick=()=>resetInvitationDevice(g);
 $('#copy-public-link').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('Tautan disalin.');}catch{$('#personal-invite-link').select();toast('Pilih dan salin tautan secara manual.');}};
 $('#share-public-invite').onclick=()=>{if(url.hostname==='localhost'||url.hostname==='127.0.0.1')return toast('Atur alamat publik HTTPS sebelum membagikan tautan.');showWhatsApp(g,link);};
 }catch(error){if($('#invite-loading'))$('#invite-loading').textContent=error.message;}
}
async function loadRsvp(){
 const summary=$('#rsvp-summary'),list=$('#rsvp-list');if(!summary||!list)return;
 try{const record=await TemuStore.read();if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk melihat konfirmasi tamu.');
 const response=await fetch('/api/invite/admin/rsvp',{headers:{'Authorization':'Bearer '+record.config.token},cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Konfirmasi belum dapat dimuat.');
 const s=data.summary;summary.innerHTML=[['attending',s.attending,'Konfirmasi hadir'],['declined',s.declined,'Tidak bisa hadir'],['pending',s.pending,'Belum konfirmasi'],['persons',s.persons,'Orang rencana hadir']].map(([status,total,label])=>`<div class="rsvp-metric ${status}"><strong>${Number(total)||0}</strong><span>${label}</span></div>`).join('');
 list.innerHTML=data.guests.length?'<div class="rsvp-list-head"><span>Tamu undangan</span><span>Status RSVP</span></div>'+data.guests.map(g=>{const status=['attending','declined'].includes(g.status)?g.status:'pending',group=g.group??db.guests.find(x=>x.id===g.id)?.group??'',initial=Array.from(g.name.trim())[0]||'·';return `<div class="rsvp-row"><div class="rsvp-guest"><span class="rsvp-avatar" aria-hidden="true">${esc(initial.toUpperCase())}</span><div><strong>${esc(g.name)}</strong><span class="rsvp-group">${esc(group||'Tanpa kelompok')}</span></div></div><span class="rsvp-status ${status}">${status==='attending'?'Hadir · '+(Number(g.count)||0)+' orang':status==='declined'?'Tidak bisa hadir':'Belum konfirmasi'}</span></div>`;}).join(''):'<p class="rsvp-empty">Belum ada tamu aktif.</p>';
 }catch(error){summary.innerHTML=`<p role="status">${esc(error.message)}</p>`;list.replaceChildren();}
}
$('#refresh-rsvp').onclick=loadRsvp;

async function resetInvitationDevice(g){
 modal('Pulihkan akses · '+g.name,`<p>Tautan lama akan dibatalkan. Tautan pengganti dapat dibuka pertama kali pada browser tamu yang baru. QR check-in tetap sama.</p><form id="reset-device-form"><label>Masukkan ulang PIN pengelola<input id="reset-device-pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" required autocomplete="off"></label><button class="primary">Buat tautan pengganti</button><p id="reset-device-status" role="status"></p></form>`);
 $('#reset-device-form').onsubmit=async event=>{event.preventDefault();const button=$('#reset-device-form button');button.disabled=true;try{await syncNow();const record=await TemuStore.read();if(record.outbox.length||record.conflicts.some(x=>!x.resolved))throw Error('Selesaikan sinkronisasi terlebih dahulu.');const response=await fetch('/api/invite/admin/reset-device',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+record.config.token,'X-Temu-Invite':'1'},body:JSON.stringify({event:db.event.id,guest:g.id,pin:$('#reset-device-pin').value}),cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Akses belum dapat dipulihkan.');await showGuestInvitation(g);}catch(error){if($('#reset-device-status'))$('#reset-device-status').textContent=error.message;}finally{button.disabled=false;}};
}
