'use strict';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const presets={original:'none',film:'sepia(.3) saturate(.85) contrast(1.08) brightness(1.03)',warm:'sepia(.45) saturate(1.15) brightness(1.04)',mono:'grayscale(1) contrast(1.1)',dazz:'sepia(.18) saturate(.82) contrast(1.08) brightness(1.06)'};
let uploadController,pendingTicket;
let info,file,preset='film',overlayStyle='celebration',previewURL,xhr,preparing=false,items=[],next=0,loading=false;
function notice(text,error=false){$('#status').textContent=text;$('#status').classList.toggle('error',error);if(file||xhr){$('#upload-state').hidden=false;$('#upload-state').textContent=text;$('#upload-state').classList.toggle('error',error);}}
function captureState(){const busy=!!xhr||preparing;$('#upload').disabled=busy||!file||!info?.uploadsOpen;$('#take-photo').disabled=$('#take-video').disabled=busy||!info?.uploadsOpen;$('#discard').hidden=!file;$('#discard').disabled=busy;for(const selector of ['[data-filter]','[data-overlay]'])for(const button of document.querySelectorAll(selector))button.disabled=busy;$('#overlay-fieldset').hidden=!!file&&!file.type.startsWith('image/');$('#upload-form').classList.toggle('ready',!!file);$('#form-hint').textContent=file?'Momen sudah siap. Pilih nuansa, beri nama, lalu bagikan.':'Ambil momen terlebih dahulu, lalu lengkapi bagian ini.';$('#preview-label').hidden=!file;}
async function api(path,body){
 let r;try{r=await fetch('/api/album/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Temu-Album':'1'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});}catch(error){error.status=0;throw error;}
 let data;try{data=await r.json();}catch{data={error:'Server belum dapat diakses. Silakan coba lagi.'};}
 if(!r.ok){const error=Error(data.error||'Album belum dapat diakses.');error.status=r.status;error.retryAfter=data.retryAfter||Number(r.headers?.get('Retry-After'));throw error;}return data;
}
function choosePreset(value){preset=Object.hasOwn(presets,value)?value:'original';for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===preset));for(const el of [$('#photo-preview'),$('#video-preview'),$('#camera-live')])el.style.filter=presets[preset];$('#preview-label').textContent='PREVIEW · '+({original:'ORIGINAL',film:'FILM',warm:'WARM',mono:'BLACK & WHITE',dazz:'DAZZ CAM'}[preset]);$('#viewfinder').classList.toggle('dazz',preset==='dazz');}
function prettyDate(value){return new Date(value).toLocaleString('id-ID',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Jakarta'})+' WIB';}
function applyInfo(data){info=data;$('#count').textContent=data.count;captureState();$('#locked').hidden=data.revealed;$('#release-copy').textContent=data.releaseAt?'Galeri dibuka pada '+prettyDate(data.releaseAt)+'.':'';notice(data.uploadsOpen?'Album '+data.title+' · Bagikan momen favoritmu.':'Unggahan sudah ditutup. Kenangan tetap dapat dilihat saat galeri dibuka.');}
async function init(){try{const key=new URLSearchParams(location.hash.slice(1)).get('k');const data=key?await api('join',{key}):await api('info');if(key)history.replaceState(null,'',location.pathname);applyInfo(data);choosePreset(data.filter);resumePending();$('#gate').hidden=true;$('#content').hidden=false;}catch(e){$('#gate').hidden=false;$('#content').hidden=true;notice(e.message,true);}}
async function selectFile(f){
 if(!f||xhr||preparing)return;
 if(f.size>100*1024*1024){notice('Momen terlalu besar. Coba rekam video lebih singkat, maksimal 100 MB.',true);return;}
 if(!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'].includes(f.type)){notice('Gunakan JPG, PNG, WebP atau video MP4, MOV, WebM. Untuk HEIC, ubah ke JPG dahulu.',true);return;}
 const isPhoto=f.type.startsWith('image/');let art;
 if(isPhoto){preparing=true;captureState();notice('Menyiapkan hiasan fotomu…');try{art=await TemuAlbumPhoto.overlay(overlayStyle);}catch(e){notice(e.message,true);return;}finally{preparing=false;captureState();}}
 if(previewURL)URL.revokeObjectURL(previewURL);file=f;previewURL=URL.createObjectURL(f);
 $('#photo-preview').hidden=!isPhoto;$('#video-preview').hidden=isPhoto;$('#photo-overlay').hidden=true;
 $('#viewfinder').style.aspectRatio='';$('#video-preview').pause();$('#video-preview').removeAttribute('src');
 if(isPhoto){
  const photo=$('#photo-preview');photo.onload=()=>{
   if(file!==f)return;const width=photo.naturalWidth,height=photo.naturalHeight;
   $('#viewfinder').style.aspectRatio=width+'/'+height;
   if(art)renderOverlay(art,overlayStyle,f);
  };photo.src=previewURL;
 }else $('#video-preview').src=previewURL;
 $('#placeholder').hidden=true;$('#file-info').textContent=f.name+' · '+(f.size/1024/1024).toFixed(1)+' MB';captureState();choosePreset(preset);
 notice(isPhoto?'Foto siap. Pilih filter dan overlay, lalu bagikan.':'Momen siap dibagikan. Pilih nuansa, lalu simpan ke album.');
}
function renderOverlay(art,style,selectedFile){
 if(file!==selectedFile||!file?.type.startsWith('image/'))return;
 const photo=$('#photo-preview'),width=photo.naturalWidth,height=photo.naturalHeight,overlay=$('#photo-overlay');overlay.hidden=true;
 if(!art||!width||!height)return;
 const box=TemuAlbumPhoto.placement(width,height,art.naturalWidth/art.naturalHeight,style);
 overlay.src=art.src;overlay.style.left=box.x/width*100+'%';overlay.style.top=box.y/height*100+'%';overlay.style.width=box.width/width*100+'%';overlay.hidden=false;
}
async function chooseOverlay(value){
 if(xhr||preparing)return;
 overlayStyle=['celebration','monogram','none'].includes(value)?value:'celebration';
 for(const button of document.querySelectorAll('[data-overlay]'))button.setAttribute('aria-pressed',String(button.dataset.overlay===overlayStyle));
 if(!file?.type.startsWith('image/'))return;
 const selectedFile=file,style=overlayStyle;preparing=true;captureState();
 try{const art=await TemuAlbumPhoto.overlay(style);renderOverlay(art,style,selectedFile);$('#photo-preview').onload=()=>renderOverlay(art,style,selectedFile);notice(style==='none'?'Tanpa overlay. Filter pilihanmu tetap digunakan.':'Pratinjau overlay sudah diperbarui. Siap dibagikan.');}
 catch(e){$('#photo-overlay').hidden=true;notice(e.message,true);}finally{preparing=false;captureState();}
}
$('#overlays').onclick=e=>{const button=e.target.closest('[data-overlay]');if(button)chooseOverlay(button.dataset.overlay);};
function clearPreview(){file=null;$('#photo-preview').hidden=$('#video-preview').hidden=$('#photo-overlay').hidden=true;$('#photo-preview').onload=null;$('#viewfinder').style.aspectRatio='';$('#video-preview').pause();for(const el of [$('#photo-preview'),$('#video-preview')])el.removeAttribute('src');$('#placeholder').hidden=false;$('#file-info').textContent='◎ Belum ada momen diambil.';for(const el of document.querySelectorAll('input[type=file]'))el.value='';if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;captureState();}
$('#discard').onclick=()=>{if(xhr||preparing)return;clearPreview();$('#upload-state').hidden=true;notice('Pratinjau dihapus. Ambil momen baru dengan kamera.');};
$('#take-photo').onclick=()=>TemuAlbumCamera.open('photo',selectFile);
$('#take-video').onclick=()=>TemuAlbumCamera.open('video',selectFile);
$('#filters').onclick=e=>{const button=e.target.closest('[data-filter]');if(button)choosePreset(button.dataset.filter);};
$('#retry').onclick=init;
function tab(gallery){$('#capture').hidden=gallery;$('#gallery').hidden=!gallery;for(const [id,active] of [['tab-capture',!gallery],['tab-gallery',gallery]]){$('#'+id).classList.toggle('selected',active);$('#'+id).setAttribute('aria-pressed',String(active));}if(gallery)loadGallery(true);$('#'+(gallery?'gallery-title':'capture-title')).scrollIntoView({block:'start'});}
$('#tab-capture').onclick=()=>tab(false);$('#tab-gallery').onclick=()=>tab(true);$('#share-first').onclick=$('#share-empty').onclick=()=>tab(false);
$('#upload-form').onsubmit=async e=>{
 e.preventDefault();if(!file||xhr||preparing||!info?.uploadsOpen)return;
 try{if(sessionStorage.getItem('temu-album-pending')){resumePending();return;}}catch{}
 const name=$('#guest-name').value.trim();if(!name)return;
 uploadController=new AbortController();
 const capturedFile=file,currentPreset=preset,currentOverlay=overlayStyle,caption=$('#caption').value.trim();let currentFile=capturedFile;
 const photo=capturedFile.type.startsWith('image/');
 if(photo){
  preparing=true;captureState();notice('Memasang hiasan dan nuansa pada fotomu…');
  try{currentFile=await TemuAlbumPhoto.prepare(capturedFile,presets[currentPreset],currentOverlay,currentPreset);}
  catch(e){notice(e.message||'Foto belum berhasil diproses. Coba lagi.',true);return;}
  finally{preparing=false;captureState();}
 }
 let ticket;
 if(info.storage==='s3'){
  preparing=true;captureState();notice('Menyiapkan unggahan…');
  try{const requestId=crypto.randomUUID().replaceAll('-','');$('#cancel-upload').hidden=false;ticket=await TemuAlbumUpload.retry(()=>api('uploads',{requestId,name,caption,mime:currentFile.type,size:currentFile.size,filter:photo?'original':currentPreset}),{signal:uploadController.signal,onWait:()=>notice('Menunggu giliran unggah… Foto atau videomu tetap siap. Jangan tutup halaman ini.')});pendingTicket=ticket;}
  catch(e){preparing=false;captureState();$('#cancel-upload').hidden=true;notice(e.name==='AbortError'?'Unggahan dibatalkan. Foto atau videomu tetap siap.':e.message,true);return;}
 }
 $('#progress').hidden=false;$('#progress').value=0;$('#cancel-upload').hidden=false;notice('Mengunggah momenmu… Jangan tutup halaman ini.');
 xhr=new XMLHttpRequest();preparing=false;captureState();xhr.open('PUT',ticket?ticket.url:'/api/album/upload');xhr.timeout=180000;
 const headers=ticket?ticket.headers:{'Content-Type':currentFile.type,'X-Temu-Album':'1','X-Album-Name':encodeURIComponent(name),'X-Album-Caption':encodeURIComponent(caption),'X-Album-Filter':photo?'original':currentPreset};
 for(const [k,v] of Object.entries(headers))xhr.setRequestHeader(k,v);
 xhr.upload.onprogress=e=>{if(e.lengthComputable){$('#progress').value=e.loaded/e.total*100;$('#upload-state').textContent='Mengunggah momenmu… '+Math.round(e.loaded/e.total*100)+'%';}};
 let putRetries=0;
 async function repeatPut(){if(!ticket||putRetries>=2||uploadController.signal.aborted)return false;putRetries++;notice('Koneksi sedang sibuk. Mencoba unggah kembali…');await TemuAlbumUpload.sleep((2000*2**putRetries)*(0.8+Math.random()*0.4),uploadController.signal);xhr.open('PUT',ticket.url);xhr.timeout=180000;for(const [key,value] of Object.entries(ticket.headers))xhr.setRequestHeader(key,value);xhr.send(currentFile);return true;}
 xhr.onload=async()=>{
  try{
   let data;
   if(ticket){
    if([429,500,502,503,504].includes(xhr.status)&&await repeatPut())return;
    if(![200,204].includes(xhr.status))throw Error('Unggahan ke penyimpanan belum berhasil. Silakan coba lagi.');
    notice('Menyimpan momen ke album…');$('#cancel-upload').hidden=true;
    rememberPending(ticket);data=await TemuAlbumUpload.settled(ticket,api,{onPending:()=>notice('Momen sudah diunggah. Sedang diproses untuk masuk album…'),onWait:()=>notice('Momen sudah diunggah. Menunggu server kembali tersedia…')});forgetPending();
   }else{data=JSON.parse(xhr.responseText);if(xhr.status!==201)throw Error(data.error);}
   notice('Momen tersimpan. Terima kasih sudah berbagi!');$('#cancel-upload').hidden=true;
   if(photo)await uploadThumbnail(currentFile,data.id,data.thumbnailKey);
   if(file===capturedFile){clearPreview();$('#caption').value='';$('#file-info').textContent='✓ Momen tersimpan. Siap untuk kenangan berikutnya.';$('#upload-state').hidden=false;$('#upload-state').textContent='Terima kasih! Momenmu sudah menjadi bagian dari album.';}
   info.count++;$('#count').textContent=info.count;
  }catch(e){if([403,410,422].includes(e.status))forgetPending();notice(e.message||'Unggahan gagal. Silakan ulangi.',true);}finish();
 };
 xhr.onerror=xhr.ontimeout=async()=>{try{if(await repeatPut())return;}catch{}notice('Koneksi terputus. File belum terkonfirmasi tersimpan; silakan ulangi.',true);finish();};
 xhr.onabort=()=>{if(ticket)api('uploads/'+ticket.id+'/cancel',{token:ticket.token}).catch(()=>{});notice('Unggahan dibatalkan. Pilihan file tetap tersedia.');finish();};xhr.send(currentFile);
};
async function uploadThumbnail(source,id,key){try{const image=await createImageBitmap(source,{resizeWidth:720});const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);image.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));if(!blob||blob.size>512*1024)return;await fetch('/api/album/thumbnail/'+id,{method:'PUT',headers:{'Content-Type':'image/jpeg','X-Temu-Album':'1','X-Album-Thumbnail-Key':key},body:blob,signal:AbortSignal.timeout(15000)});}catch{/* Original stays saved even if a lightweight preview cannot be generated. */}}
function finish(){xhr=null;uploadController=null;pendingTicket=null;captureState();$('#progress').hidden=$('#cancel-upload').hidden=true;}
$('#cancel-upload').onclick=()=>{uploadController?.abort();if(xhr){xhr.abort();if(xhr)finish();}else if(pendingTicket)api('uploads/'+pendingTicket.id+'/cancel',{token:pendingTicket.token}).catch(()=>{});};
function rememberPending(ticket){try{sessionStorage.setItem('temu-album-pending',JSON.stringify({id:ticket.id,token:ticket.token}));}catch{}}
function forgetPending(){try{sessionStorage.removeItem('temu-album-pending');}catch{}}
async function resumePending(){
 let saved;try{saved=JSON.parse(sessionStorage.getItem('temu-album-pending'));}catch{}
 if(!saved?.id||!saved?.token||preparing||xhr)return;preparing=true;captureState();notice('Melanjutkan pemeriksaan momen yang sudah diunggah…');
 try{await TemuAlbumUpload.settled(saved,api,{onPending:()=>notice('Momenmu sudah diunggah dan masih diproses…')});forgetPending();applyInfo(await api('info'));notice('Momen tersimpan. Terima kasih sudah berbagi!');}
 catch(e){if([403,410,422].includes(e.status))forgetPending();notice(e.message,true);}
 finally{preparing=false;captureState();}
}
function renderGallery(){const type=$('#media-type').value;$('#grid').innerHTML=items.filter(item=>type==='all'||(type==='photo')===item.mime.startsWith('image/')).map((item,index)=>`<button class="moment-card" data-id="${item.id}" aria-label="Buka momen dari ${esc(item.name)}">${item.mime.startsWith('image/')&&item.thumbnail?`<img class="moment-photo filter-${item.filter}" src="/api/album/file/${item.id}${item.thumbnail?'?thumb=1':''}" loading="lazy" decoding="async" alt="Momen dari ${esc(item.name)}">`:`<div class="moment-video"><span>${item.mime.startsWith('image/')?'◎':'▷'}</span><small>${item.mime.startsWith('image/')?'KETUK UNTUK MELIHAT FOTO':'VIDEO · KENANGAN BERGERAK'}</small></div>`}<span class="moment-number" aria-hidden="true">${item.mime.startsWith('image/')?'FOTO':'VIDEO'} · ${String(index+1).padStart(2,'0')}</span><div class="moment-meta"><h3>${esc(item.name)}</h3>${item.caption?`<p class="caption">${esc(item.caption)}</p>`:''}<p><time>${esc(prettyDate(item.created))}</time></p></div></button>`).join('');$('#gallery-empty').hidden=!info.revealed||!!$('#grid').childElementCount;$('#more').hidden=next===null||!info.revealed;}
async function loadGallery(reset=false){if(loading)return;loading=true;$('#refresh').disabled=true;try{applyInfo(await api('info'));if(!info.revealed){items=[];next=null;renderGallery();return;}if(reset){items=[];next=0;}const data=await api('items?offset='+(next||0));items.push(...data.items);next=data.next;renderGallery();}catch(e){notice(e.message,true);}finally{loading=false;$('#refresh').disabled=false;}}
$('#refresh').onclick=()=>loadGallery(true);$('#more').onclick=()=>loadGallery();$('#media-type').onchange=renderGallery;
$('#grid').onclick=e=>{const card=e.target.closest('[data-id]');if(!card)return;const item=items.find(x=>x.id===card.dataset.id);const photo=item.mime.startsWith('image/');$('#moment-detail').innerHTML=`<h2>${esc(item.name)}</h2><p>${esc(item.caption)}</p>${photo?`<img class="detail-media filter-${item.filter}" src="/api/album/file/${item.id}" alt="Momen dari ${esc(item.name)}">`:`<video class="detail-media filter-${item.filter}" src="/api/album/file/${item.id}" controls playsinline preload="metadata"></video>`}<div class="detail-actions"><a class="solid" href="/api/album/file/${item.id}?download=1" download>Unduh file ↗</a>${photo&&item.filter!=='original'?'<button class="outline" id="save-filtered">Siapkan foto dengan filter</button>':''}</div><p class="small">Foto baru menggunakan filter dan pilihan overlay kamu. File diunduh sesuai yang tersimpan; nuansa video berlaku pada tampilan pemutar.</p>`;$('#moment-dialog').showModal();if(photo&&item.filter!=='original')$('#save-filtered').onclick=async()=>{const button=$('#save-filtered');button.disabled=true;try{const r=await fetch('/api/album/file/'+item.id);if(!r.ok)throw Error('File belum tersedia.');const image=await createImageBitmap(await r.blob());const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');if(!('filter' in ctx))throw Error('Browser ini belum mendukung simpan filter. Gunakan unduh file asli.');ctx.filter=presets[item.filter];ctx.drawImage(image,0,0);image.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.98));if(!blob)throw Error('Foto terlalu besar untuk diproses pada perangkat ini. Unduh file asli.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='momen-'+item.id.slice(0,8)+'-'+item.filter+'.jpg';a.className='outline';a.textContent='Unduh foto dengan filter ↗';button.replaceWith(a);$('#moment-dialog').addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});}catch(e){const error=document.createElement('p');error.className='small';error.setAttribute('role','alert');error.textContent=e.message;button.after(error);}finally{button.disabled=false;}};};
$('#close-dialog').onclick=()=>$('#moment-dialog').close();$('#moment-dialog').addEventListener('close',()=>{$('#moment-dialog video')?.pause();});
window.addEventListener('beforeunload',e=>{if(xhr||preparing){e.preventDefault();e.returnValue='';}});
// Refresh reveal time without forcing a guest to reload the page.
setInterval(()=>{if(info&&!document.hidden&&!$('#gallery').hidden&&!loading&&!info.revealed)loadGallery(true);},30000);
init();

window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('k'))init();});
