'use strict';
function invitationOrigin(){const configured=db.event.wedding?.publicOrigin;return configured||location.origin;}
function showGuestInvitation(g){
 const url=new URL('/invite',invitationOrigin());
 modal('Undangan digital · '+g.name,`<p>Undangan digital dapat dibuka siapa saja melalui tautan ini. QR masuk untuk tamu tetap dibagikan terpisah dan tidak muncul di halaman undangan.</p><label>Tautan undangan<input id="public-invite-link" readonly value="${esc(url.href)}"></label><div class="actions"><button id="preview-invitation">Lihat undangan</button><button id="copy-public-link">Salin tautan</button><button id="share-public-invite" class="primary">QR + tautan via WhatsApp</button></div><p class="hint">${url.hostname==='localhost'||url.hostname==='127.0.0.1'?'Alamat masih lokal dan tidak dapat dibuka di ponsel tamu. Siapkan hosting HTTPS lalu isi Alamat undangan publik di Pengaturan.':'Siapa saja yang memiliki tautan dapat melihat halaman undangan.'}</p>`);
 $('#preview-invitation').onclick=()=>window.open(url.href,'_blank','noopener,noreferrer');
 $('#copy-public-link').onclick=async()=>{try{await navigator.clipboard.writeText(url.href);toast('Tautan disalin.');}catch{$('#public-invite-link').select();toast('Pilih dan salin tautan secara manual.');}};
 $('#share-public-invite').onclick=()=>{if(url.hostname==='localhost'||url.hostname==='127.0.0.1')return toast('Atur alamat publik HTTPS sebelum membagikan tautan kepada tamu.');showWhatsApp(g,url.href);};
}
