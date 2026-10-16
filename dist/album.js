'use strict';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const presets={original:'none',film:'sepia(.3) saturate(.85) contrast(1.08) brightness(1.03)',warm:'sepia(.45) saturate(1.15) brightness(1.04)',mono:'grayscale(1) contrast(1.1)',dazz:'sepia(.18) saturate(.82) contrast(1.08) brightness(1.06)'};
let uploadController,pendingTicket;
let info,file,preset='film',overlayStyle='celebration',previewArt,previewURL,xhr,preparing=false,items=[],next=0,loading=false,hasName=false;
function notice(text,error=false){$('#status').hidden=!error;$('#status').textContent=text;$('#status').classList.toggle('error',error);if(file||xhr){$('#upload-state').hidden=false;$('#upload-state').textContent=text;$('#upload-state').classList.toggle('error',error);}}
function captureState(){
 const busy=!!xhr||preparing,camera=TemuAlbumCamera.isActive(),recording=TemuAlbumCamera.isRecording();
 if(camera)$('#camera-shutter').disabled=busy||!$('#camera-live').srcObject||$('#camera-live').readyState<2;
 $('#upload').disabled=busy||camera||!file||!info?.uploadsOpen;
 $('#take-photo').disabled=$('#take-video').disabled=busy||recording||!info?.uploadsOpen;
 for(const id of ['edit-name','tab-capture','tab-gallery'])$('#'+id).disabled=recording;
 for(const [id,kind] of [['take-photo','photo'],['take-video','video']])$('#'+id).setAttribute('aria-pressed',String(camera&&TemuAlbumCamera.mode===kind));
 $('#discard').hidden=!file;$('#discard').disabled=busy;$('#close-caption').disabled=busy;
 $('#capture-review').hidden=$('#review-capture').hidden=!file||camera;$('#review-capture').disabled=$('#retake-capture').disabled=busy;
 for(const selector of ['[data-filter]','[data-overlay]'])for(const button of document.querySelectorAll(selector))button.disabled=busy||recording;
 $('#overlay-fieldset').hidden=camera?TemuAlbumCamera.mode==='video':!!file&&!file.type.startsWith('image/');
 $('#preview-label').hidden=!file||camera;
}
function showPage(page){
 if(page!=='camera')TemuAlbumCamera.close();
 for(const [id,name] of [['name-step','name'],['capture','camera'],['gallery','gallery']])$('#'+id).hidden=page!==name;
 $('#studio-header').hidden=$('#album-nav').hidden=page==='name';document.body.classList.toggle('camera-page',page==='camera');
 for(const [id,name] of [['tab-capture','camera'],['tab-gallery','gallery']]){$('#'+id).classList.toggle('selected',page===name);$('#'+id).setAttribute('aria-pressed',String(page===name));}
 if(page==='camera')TemuAlbumCamera.layout();
}
$('#guest-name').oninput=()=>$('#guest-name').setCustomValidity('');
$('#name-form').onsubmit=event=>{
 event.preventDefault();const name=$('#guest-name').value.trim();
 if(!name){$('#guest-name').setCustomValidity('Isi nama kamu terlebih dahulu.');$('#guest-name').reportValidity();return;}
 $('#guest-name').value=name;hasName=true;showPage(info?.uploadsOpen?'camera':'gallery');
 if(info?.uploadsOpen&&!file)TemuAlbumCamera.open('photo',selectFile,cameraChanged);
 else if(!info?.uploadsOpen)loadGallery(true);
};
$('#edit-name').onclick=()=>{showPage('name');$('#guest-name').focus();};
async function api(path,body){
 let r;try{r=await fetch('/api/album/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Temu-Album':'1'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});}catch(error){error.status=0;throw error;}
 let data;try{data=await r.json();}catch{data={error:'Server belum dapat diakses. Silakan coba lagi.'};}
 if(!r.ok){const error=Error(data.error||'Album belum dapat diakses.');error.status=r.status;error.retryAfter=data.retryAfter||Number(r.headers?.get('Retry-After'));throw error;}return data;
}
function choosePreset(value){preset=Object.hasOwn(presets,value)?value:'original';for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===preset));for(const el of [$('#photo-preview'),$('#video-preview'),$('#camera-live')])el.style.filter=presets[preset];$('#preview-label').textContent='PREVIEW · '+({original:'ORIGINAL',film:'FILM',warm:'WARM',mono:'BLACK & WHITE',dazz:'DAZZ CAM'}[preset]);$('#viewfinder').classList.toggle('dazz',preset==='dazz');}
function prettyDate(value){return new Date(value).toLocaleString('id-ID',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Jakarta'})+' WIB';}
function applyInfo(data){info=data;$('#count').textContent=data.count;captureState();$('#locked').hidden=data.revealed;$('#release-copy').textContent=data.releaseAt?'Galeri dibuka pada '+prettyDate(data.releaseAt)+'.':'';notice(data.uploadsOpen?'Album '+data.title+' · Bagikan momen favoritmu.':'Unggahan sudah ditutup. Kenangan tetap dapat dilihat saat galeri dibuka.');}
async function init(){$('#album-loading').hidden=false;try{const key=new URLSearchParams(location.hash.slice(1)).get('k');const data=key?await api('join',{key}):await api('info');if(key)history.replaceState(null,'',location.pathname);applyInfo(data);choosePreset(data.filter);resumePending();const style=overlayStyle;TemuAlbumPhoto.overlay(style).then(art=>{if(style===overlayStyle){previewArt=art;renderOverlay(art,style,file);}}).catch(()=>{});$('#gate').hidden=true;$('#content').hidden=false;if(!hasName)showPage('name');}catch(e){$('#gate').hidden=false;$('#content').hidden=true;notice(e.message,true);}finally{$('#album-loading').hidden=true;}}
async function selectFile(f){
 if(!f||xhr||preparing)return;
 if(f.size>100*1024*1024){notice('Momen terlalu besar. Coba rekam video lebih singkat, maksimal 100 MB.',true);return;}
 if(!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'].includes(f.type)){notice('Gunakan JPG, PNG, WebP atau video MP4, MOV, WebM. Untuk HEIC, ubah ke JPG dahulu.',true);return;}
 const isPhoto=f.type.startsWith('image/');let art;
 if(isPhoto){preparing=true;captureState();notice('Menyiapkan hiasan fotomu…');try{art=await TemuAlbumPhoto.overlay(overlayStyle);previewArt=art;}catch(e){notice(e.message,true);}finally{preparing=false;captureState();}}
 if(previewURL)URL.revokeObjectURL(previewURL);file=f;previewURL=URL.createObjectURL(f);
 $('#photo-preview').hidden=!isPhoto;$('#video-preview').hidden=isPhoto;$('#photo-overlay').hidden=true;
 $('#viewfinder').style.aspectRatio='';$('#video-preview').pause();$('#video-preview').removeAttribute('src');
 if(isPhoto){
  const photo=$('#photo-preview');photo.onload=()=>{
   if(file!==f)return;const width=photo.naturalWidth,height=photo.naturalHeight;
   TemuAlbumCamera.layout();
   if(art)renderOverlay(art,overlayStyle,f);
  };photo.src=previewURL;
 }else{$('#photo-preview').removeAttribute('src');$('#photo-preview').onload=null;$('#video-preview').onloadedmetadata=()=>TemuAlbumCamera.layout();$('#video-preview').src=previewURL;}
 $('#placeholder').hidden=true;$('#file-info').textContent=f.name+' · '+(f.size/1024/1024).toFixed(1)+' MB';captureState();choosePreset(preset);
 notice(isPhoto?'Foto siap dibagikan.':'Video siap dibagikan.');if(!$('#caption-dialog').open){$('#caption-dialog').showModal();$('#upload-form').scrollTop=0;}
}
function renderOverlay(art,style,selectedFile){
 const live=TemuAlbumCamera.isActive(),photo=live?$('#camera-live'):$('#photo-preview'),overlay=$('#photo-overlay');overlay.hidden=true;
 if(style!==overlayStyle||(live?TemuAlbumCamera.mode!=='photo':file!==selectedFile||!file?.type.startsWith('image/')))return;
 const frame=live?TemuAlbumCamera.frame():null,width=live?frame.width:photo.naturalWidth,height=live?frame.height:photo.naturalHeight;
 if(!art||!width||!height)return;
 const box=TemuAlbumPhoto.placement(width,height,art.naturalWidth/art.naturalHeight,style);
 overlay.src=art.src;overlay.style.left=box.x/width*100+'%';overlay.style.top=box.y/height*100+'%';overlay.style.width=box.width/width*100+'%';overlay.hidden=false;
}
async function chooseOverlay(value){
 if(xhr||preparing)return;
 overlayStyle=['celebration','monogram','none'].includes(value)?value:'celebration';
 for(const button of document.querySelectorAll('[data-overlay]'))button.setAttribute('aria-pressed',String(button.dataset.overlay===overlayStyle));
 const selectedFile=file,style=overlayStyle;preparing=true;captureState();
 try{const art=await TemuAlbumPhoto.overlay(style);previewArt=art;renderOverlay(art,style,selectedFile);$('#photo-preview').onload=()=>renderOverlay(art,style,selectedFile);if(file||TemuAlbumCamera.isActive())notice(style==='none'?'Tanpa overlay. Filter pilihanmu tetap digunakan.':'Pratinjau overlay sudah diperbarui. Siap dibagikan.');}
 catch(e){$('#photo-overlay').hidden=true;notice(e.message,true);}finally{preparing=false;captureState();}
}
$('#overlays').onclick=e=>{const button=e.target.closest('[data-overlay]');if(button)chooseOverlay(button.dataset.overlay);};
function clearPreview(){file=null;$('#photo-preview').hidden=$('#video-preview').hidden=$('#photo-overlay').hidden=true;$('#photo-preview').onload=null;$('#viewfinder').style.aspectRatio='';$('#video-preview').pause();for(const el of [$('#photo-preview'),$('#video-preview')])el.removeAttribute('src');$('#placeholder').hidden=false;$('#file-info').textContent='◎ Belum ada momen diambil.';if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;captureState();}
$('#retake-capture').onclick=$('#discard').onclick=()=>{if(xhr||preparing)return;$('#caption-dialog').close();$('#upload-state').hidden=true;TemuAlbumCamera.open(file?.type.startsWith('video/')?'video':'photo',selectFile,cameraChanged);};
$('#close-caption').onclick=()=>$('#caption-dialog').close();$('#caption-dialog').addEventListener('cancel',event=>{if(xhr||preparing)event.preventDefault();});$('#review-capture').onclick=()=>{if(file&&!xhr&&!preparing)$('#caption-dialog').showModal();};
function cameraChanged(){captureState();renderOverlay(previewArt,overlayStyle,file);}
$('#take-photo').onclick=()=>{if(!TemuAlbumCamera.isActive()||TemuAlbumCamera.mode!=='photo')TemuAlbumCamera.open('photo',selectFile,cameraChanged);};
$('#take-video').onclick=()=>{if(!TemuAlbumCamera.isActive()||TemuAlbumCamera.mode!=='video')TemuAlbumCamera.open('video',selectFile,cameraChanged);};
$('#filters').onclick=e=>{const button=e.target.closest('[data-filter]');if(button)choosePreset(button.dataset.filter);};
$('#retry').onclick=init;
function tab(gallery){
 if(!hasName){showPage('name');return;}
 showPage(gallery?'gallery':'camera');
 if(gallery)loadGallery(true);
 else if(!file&&info?.uploadsOpen&&!TemuAlbumCamera.isActive())TemuAlbumCamera.open('photo',selectFile,cameraChanged);
}
$('#tab-capture').onclick=()=>tab(false);$('#tab-gallery').onclick=()=>tab(true);$('#share-first').onclick=$('#share-empty').onclick=()=>tab(false);
$('#upload-form').onsubmit=async e=>{
 e.preventDefault();if(!file||xhr||preparing||TemuAlbumCamera.isActive()||!info?.uploadsOpen)return;
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
   if(file===capturedFile){$('#caption-dialog').close();clearPreview();$('#camera-status').textContent='✓ Momen tersimpan. Siap untuk kenangan berikutnya.';$('#caption').value='';$('#file-info').textContent='✓ Momen tersimpan. Siap untuk kenangan berikutnya.';$('#upload-state').hidden=false;$('#upload-state').textContent='Terima kasih! Momenmu sudah menjadi bagian dari album.';}
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
function renderGallery(){
 TemuAlbumLoading.stop($('#grid'));const type=$('#media-type').value;
 $('#grid').innerHTML=items.filter(item=>type==='all'||(type==='photo')===item.mime.startsWith('image/')).map(item=>`<button class="moment-card" data-id="${item.id}" aria-label="Buka momen dari ${esc(item.name)}">${item.mime.startsWith('image/')?TemuAlbumLoading.photo('/api/album/file/'+item.id+'?thumb=1','Momen dari '+item.name,'moment-photo filter-'+item.filter):'<div class="moment-video" aria-hidden="true"><span>▷</span><small>VIDEO</small></div><span class="media-badge" aria-hidden="true">▷</span>'}</button>`).join('');
 TemuAlbumLoading.watch($('#grid'));$('#gallery-empty').hidden=!info.revealed||!!$('#grid').childElementCount;$('#more').hidden=next===null||!info.revealed;
}
async function loadGallery(reset=false){if(loading)return;loading=true;$('#refresh').disabled=true;$('#more').disabled=true;$('#gallery-loading').hidden=false;$('#grid').setAttribute('aria-busy','true');$('#gallery-empty').hidden=true;try{applyInfo(await api('info'));if(!info.revealed){items=[];next=null;renderGallery();return;}const data=await api('items?offset='+(reset?0:(next||0)));items=reset?data.items:[...items,...data.items];next=data.next;renderGallery();}catch(e){notice(e.message,true);}finally{loading=false;$('#refresh').disabled=false;$('#more').disabled=false;$('#gallery-loading').hidden=true;$('#grid').setAttribute('aria-busy','false');}}
$('#refresh').onclick=()=>loadGallery(true);$('#more').onclick=()=>loadGallery();$('#media-type').onchange=renderGallery;
$('#grid').onclick=e=>{const card=e.target.closest('[data-id]');if(!card)return;const item=items.find(x=>x.id===card.dataset.id);const photo=item.mime.startsWith('image/');TemuAlbumLoading.stop($('#moment-detail'));$('#moment-detail').innerHTML=`<h2>${esc(item.name)}</h2><p><time>${esc(prettyDate(item.created))}</time></p><p>${esc(item.caption)}</p>${photo?TemuAlbumLoading.photo('/api/album/file/'+item.id,'Momen dari '+item.name,'detail-media filter-'+item.filter,true):`<video class="detail-media filter-${item.filter}" src="/api/album/file/${item.id}?preview=1" controls playsinline preload="metadata"></video>`}<div class="detail-actions"><a class="solid" href="/api/album/file/${item.id}?download=1" download>Unduh file ↗</a>${photo&&item.filter!=='original'?'<button class="outline" id="save-filtered">Siapkan foto dengan filter</button>':''}</div>`;$('#moment-dialog').showModal();TemuAlbumLoading.watch($('#moment-detail'));if(!photo){const video=$('#moment-detail video');video.addEventListener('error',()=>{const time=video.currentTime||0;video.src='/api/album/file/'+item.id;video.addEventListener('loadedmetadata',()=>{video.currentTime=time;},{once:true});},{once:true});}if(photo&&item.filter!=='original')$('#save-filtered').onclick=async()=>{const button=$('#save-filtered');button.disabled=true;try{const r=await fetch('/api/album/file/'+item.id);if(!r.ok)throw Error('File belum tersedia.');const image=await createImageBitmap(await r.blob());const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');if(!('filter' in ctx))throw Error('Browser ini belum mendukung simpan filter. Gunakan unduh file asli.');ctx.filter=presets[item.filter];ctx.drawImage(image,0,0);image.close();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.98));if(!blob)throw Error('Foto terlalu besar untuk diproses pada perangkat ini. Unduh file asli.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='momen-'+item.id.slice(0,8)+'-'+item.filter+'.jpg';a.className='outline';a.textContent='Unduh foto dengan filter ↗';button.replaceWith(a);$('#moment-dialog').addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});}catch(e){const error=document.createElement('p');error.className='small';error.setAttribute('role','alert');error.textContent=e.message;button.after(error);}finally{button.disabled=false;}};};
$('#close-dialog').onclick=()=>$('#moment-dialog').close();$('#moment-dialog').addEventListener('close',()=>{TemuAlbumLoading.stop($('#moment-detail'));$('#moment-dialog video')?.pause();});
window.addEventListener('beforeunload',e=>{if(xhr||preparing){e.preventDefault();e.returnValue='';}});
// Refresh reveal time without forcing a guest to reload the page.
setInterval(()=>{if(info&&!document.hidden&&!$('#gallery').hidden&&!loading&&!info.revealed)loadGallery(true);},30000);
$('#open-cover').onclick=()=>{
 const button=$('#open-cover');if(button.disabled)return;button.disabled=true;$('#album-cover').classList.add('opening');
 setTimeout(()=>{$('#album-cover').hidden=true;$('#album-app').inert=false;document.body.classList.remove('cover-closed');const target=$('#content').hidden?$('#retry'):$('#guest-name');target.tabIndex=-1;target.focus({preventScroll:true});},window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1150);
};
init();

window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('k'))init();});
