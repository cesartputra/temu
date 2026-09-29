'use strict';
let syncTimer,syncing=false,lastSyncError='';
function refreshSyncStatus(r){
 const conflicts=r.conflicts.filter(c=>!c.resolved).length;
 $('#sync-banner').textContent=lastSyncError||`${r.outbox.length} perubahan menunggu · ${conflicts} konflik${r.config.enabled?' · sinkronisasi aktif':' · server belum terhubung'}`;
 $('#sync-details').textContent=(r.lastSync?'Terakhir tersinkron: '+new Date(r.lastSync).toLocaleString('id-ID')+'. ':'Belum ada sinkronisasi. ')+(r.config.enabled?'Pengiriman otomatis aktif.':'Pengiriman otomatis dijeda.');
 $('#backup-status').textContent=`${r.backups.length} cadangan lokal. `+(r.serverBackupAt?'Cadangan server: '+new Date(r.serverBackupAt).toLocaleString('id-ID')+'. ':'Belum ada cadangan server terkonfirmasi. ')+(r.serverBackupError||'');
}
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncNow(),1200);}
async function api(path,body,config){const response=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.token},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});let result;try{result=await response.json();}catch{throw Error('Server sinkronisasi belum tersedia di alamat ini.');}if(!response.ok)throw Error(result.error||'Server belum dapat dihubungi.');return result;}
async function syncNow(){
 if(syncing||readFailed)return;syncing=true;
 try{
  const start=await TemuStore.read();if(!start.config.enabled)return;
  const sent=start.outbox.slice(0,50);const result=await api('/api/sync',{event:start.state.event.id,operations:sent},start.config);
  if(!result.state)throw Error('Acara belum tersedia di server. Perubahan lokal tetap disimpan.');validate(result.state);
  if(!Array.isArray(result.results)||!Number.isInteger(result.revision))throw Error('Jawaban server tidak valid.');
  const applied=await TemuStore.transaction(current=>{
   if(current.state.event.id!==start.state.event.id||current.config.token!==start.config.token)return current;
   if(result.revision<(current.serverRevision||0))throw Error('Versi server lebih lama daripada sinkronisasi terakhir. Periksa pemulihan server sebelum melanjutkan.');
   if(JSON.stringify(current.state)!==JSON.stringify(result.state)||result.results.some(x=>!x.ok))TemuStore.backup(current);
   const acknowledged=new Map(result.results.map(r=>[r.id,r]));
   for(const op of current.outbox){const answer=acknowledged.get(op.id);if(answer&&!answer.ok&&!current.conflicts.some(c=>c.id===op.id))current.conflicts.push({id:op.id,op,reason:answer.reason,at:new Date().toISOString()});}
   const pending=current.outbox.filter(op=>!acknowledged.has(op.id));const rebased=TemuModel.rebase(result.state,pending);validate(rebased.state);
   current.state=rebased.state;current.outbox=rebased.remaining;current.conflicts.push(...rebased.conflicts);current.serverRevision=result.revision;current.lastSync=new Date().toISOString();current.serverBackupAt=result.backupAt;current.serverBackupError=result.backupError;
   return current;
  });
  const pinChanged=db.pin!==applied.state.pin;db=applied.state;if(pinChanged)unlocked=!db.pin;render();lastSyncError='';refreshSyncStatus(applied);if(applied.outbox.length)scheduleSync();
 }catch(e){lastSyncError=e.name==='TimeoutError'||e instanceof TypeError?'Server belum terjangkau. Perubahan tersimpan lokal dan akan dicoba lagi.':e.message;const r=await TemuStore.read().catch(()=>null);if(r)refreshSyncStatus(r);}
 finally{syncing=false;}
}
$('#sync-form').onsubmit=async e=>{e.preventDefault();if(!await admin())return;try{const token=$('#server-token').value.trim();if(token.length<32)throw Error('Masukkan kunci server yang lengkap.');await api('/api/events',null,{token});await TemuStore.transaction(r=>{r.config={enabled:true,token};return r;});$('#server-token').value='';lastSyncError='';await syncNow();}catch(e){toast(e.message);}};
$('#sync-now').onclick=async()=>{if(await admin()){const r=await TemuStore.read();if(!r.config.enabled)return toast('Hubungkan server terlebih dahulu.');await syncNow();}};
$('#disconnect').onclick=async()=>{if(!await admin())return;const r=await TemuStore.transaction(r=>{r.config.enabled=false;return r;});lastSyncError='';refreshSyncStatus(r);toast('Pengiriman otomatis dijeda. Data lokal tetap tersedia.');};
$('#join-event').onclick=async()=>{if(!await admin())return;try{
 const current=await TemuStore.read();const token=current.config.token||$('#server-token').value.trim();if(token.length<32)throw Error('Isi kunci koneksi terlebih dahulu.');
 const config={token};const answer=await api('/api/events',null,config);modal('Acara di server',answer.events.length?'<p>Pilih acara untuk menggunakan daftar dan QR yang sama pada perangkat ini.</p>'+answer.events.map((e,i)=>`<button class="wide" data-join="${i}">${esc(e.name)}</button>`).join(''):'<p>Belum ada acara di server.</p>');
 document.querySelectorAll('[data-join]').forEach(button=>button.onclick=async()=>{try{
  const event=answer.events[Number(button.dataset.join)];if(!confirm('Buka acara ini? Salinan lokal disimpan otomatis. Perubahan yang belum terkirim harus disinkronkan dahulu.'))return;
  const incoming=await api('/api/sync',{event:event.id,operations:[]},config);validate(incoming.state);
  const r=await TemuStore.transaction(r=>{const empty=r.state.guests.length===0&&r.state.logs.length===0;if(r.outbox.length&&!empty)throw Error('Masih ada perubahan lokal. Sinkronkan dahulu.');TemuStore.backup(r);r.state=incoming.state;r.outbox=[];r.serverRevision=incoming.revision;r.lastSync=new Date().toISOString();r.serverBackupAt=incoming.backupAt;r.serverBackupError=incoming.backupError;r.config={enabled:true,token};return r;});db=r.state;unlocked=!db.pin;render();refreshSyncStatus(r);$('#server-token').value='';$('#modal').close();page('pindai');
 }catch(e){toast(e.message);}});
 }catch(e){toast(e.message);}};
$('#local-backups').onclick=async()=>{if(!await admin())return;const r=await TemuStore.read();modal('Cadangan otomatis perangkat',r.backups.length?'<p>Pemulihan akan dicatat sebagai perubahan baru, lalu diperiksa server saat sinkronisasi.</p>'+r.backups.slice().reverse().map(b=>`<button class="wide" data-backup="${b.id}">${esc(b.state.event.name)} · ${new Date(b.at).toLocaleString('id-ID')}<br>${b.state.guests.length} undangan</button>`).join(''):'<p>Cadangan dibuat otomatis sebelum perubahan pertama.</p>');document.querySelectorAll('[data-backup]').forEach(button=>button.onclick=async()=>{try{const backup=r.backups.find(b=>b.id===button.dataset.backup);if(!confirm('Pulihkan salinan ini? Data saat ini juga akan dicadangkan.'))return;const restored=await TemuStore.replace(backup.state,validate);db=restored.state;unlocked=!db.pin;render();refreshSyncStatus(restored);$('#modal').close();scheduleSync();toast('Salinan lokal dipulihkan.');}catch(e){toast(e.message);}});};
$('#view-conflicts').onclick=async()=>{if(!await admin())return;const r=await TemuStore.read();const conflicts=r.conflicts.filter(c=>!c.resolved);modal('Perubahan yang perlu diperiksa',conflicts.length?'<p>Versi server digunakan untuk perhitungan. Perubahan berikut disimpan untuk ditinjau; jangan mengulang check-in sebelum memastikan siapa yang benar-benar hadir.</p>'+conflicts.map(c=>`<article class="conflict"><strong>${esc(c.reason)}</strong><p>${new Date(c.at).toLocaleString('id-ID')}</p>${(c.op.changes||[]).map(x=>`<p>${esc(x.after?.name||x.before?.name)}: lokal meminta ${x.after?.arrived??0} hadir (sebelumnya ${x.before?.arrived??0}).</p>`).join('')}${c.op.kind==='bootstrap'?'<p>Salinan acara tetap tersedia dalam cadangan otomatis.</p>':''}<p class="hint">Jika diperlukan, lakukan koreksi melalui Daftar tamu setelah pemeriksaan.</p><button data-resolve="${esc(c.id)}">Tandai sudah diperiksa</button></article>`).join(''):'<p>Tidak ada konflik yang menunggu.</p>');document.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=async()=>{if(!confirm('Sudah memeriksa perubahan ini? Catatan tetap disimpan, tanpa mengubah jumlah hadir.'))return;const next=await TemuStore.transaction(r=>{r.conflicts.find(c=>c.id===b.dataset.resolve).resolved=new Date().toISOString();return r;});refreshSyncStatus(next);$('#modal').close();toast('Konflik ditandai sudah diperiksa.');});};
window.addEventListener('online',()=>syncNow());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncNow();});
TemuStore.channel?.addEventListener('message',async()=>{const r=await TemuStore.read();if(r){const changed=db.pin!==r.state.pin;db=r.state;if(changed)unlocked=!db.pin;render();refreshSyncStatus(r);}});
window.addEventListener('unhandledrejection',event=>{toast(event.reason?.message||'Penyimpanan gagal. Coba lagi.');});
async function initialize(){try{const r=await TemuStore.init(()=>{const previous=localStorage.getItem(KEY);return previous?validate(JSON.parse(previous)):fresh();});db=validate(r.state);readFailed=false;unlocked=!db.pin;render();refreshSyncStatus(r);$('#loading').hidden=true;document.querySelectorAll('main,aside').forEach(e=>e.inert=false);if(!r.config.token){try{const response=await fetch('/api/local-session',{method:'POST',headers:{'X-Temu-Local':'1'},signal:AbortSignal.timeout(3000)});if(response.ok){const pair=await response.json();if(typeof pair.token==='string')await TemuStore.transaction(x=>{x.config={enabled:true,token:pair.token};return x;});}}catch{}}scheduleSync();setInterval(()=>syncNow(),30000);}catch(e){$('#loading').textContent='Database tidak dapat dibuka: '+e.message+'. Data lama tidak dihapus. Periksa izin penyimpanan browser dan muat ulang.';}}
const applicationReady=initialize();
