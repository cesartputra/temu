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
 $('#modal-body').innerHTML=`<p>Tautan ini menampilkan sapaan khusus untuk <strong>${esc(g.name)}</strong>, serta memungkinkan RSVP dan kirim doa. Halaman utama tetap terbuka untuk umum; QR masuk dibagikan terpisah.</p><label>Tautan unik tamu<input id="personal-invite-link" readonly value="${esc(link)}"></label><div class="actions"><button id="preview-invitation">Lihat undangan</button><button id="copy-public-link">Salin tautan</button><button id="share-public-invite" class="primary">Siapkan QR + tautan WhatsApp</button></div><p class="hint">${url.hostname==='localhost'||url.hostname==='127.0.0.1'?'Alamat masih lokal dan tidak dapat dibuka di ponsel tamu. Siapkan hosting HTTPS.':'Tautan dapat diteruskan oleh penerimanya; bagikan hanya kepada tamu yang dituju.'}</p>`;
 $('#preview-invitation').onclick=()=>window.open(link,'_blank','noopener,noreferrer');
 $('#copy-public-link').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('Tautan disalin.');}catch{$('#personal-invite-link').select();toast('Pilih dan salin tautan secara manual.');}};
 $('#share-public-invite').onclick=()=>{if(url.hostname==='localhost'||url.hostname==='127.0.0.1')return toast('Atur alamat publik HTTPS sebelum membagikan tautan.');showWhatsApp(g,link);};
 }catch(error){if($('#invite-loading'))$('#invite-loading').textContent=error.message;}
}
async function loadRsvp(){
 const summary=$('#rsvp-summary'),list=$('#rsvp-list');if(!summary||!list)return;
 try{const record=await TemuStore.read();if(!record.config.enabled||!record.config.token)throw Error('Hubungkan server untuk melihat konfirmasi tamu.');
 const response=await fetch('/api/invite/admin/rsvp',{headers:{'Authorization':'Bearer '+record.config.token},cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();if(!response.ok)throw Error(data.error||'Konfirmasi belum dapat dimuat.');
 const s=data.summary;summary.innerHTML=`<span><strong>${s.attending}</strong> konfirmasi hadir</span><span><strong>${s.declined}</strong> tidak bisa hadir</span><span><strong>${s.pending}</strong> belum konfirmasi</span><span><strong>${s.persons}</strong> orang rencana hadir</span>`;
 list.innerHTML=data.guests.map(g=>`<div class="rsvp-row"><strong>${esc(g.name)}</strong><span>${g.status==='attending'?'Hadir · '+g.count+' orang':g.status==='declined'?'Tidak bisa hadir':'Belum konfirmasi'}</span></div>`).join('')||'<p>Belum ada tamu aktif.</p>';
 }catch(error){summary.textContent=error.message;list.replaceChildren();}
}
$('#refresh-rsvp').onclick=loadRsvp;
