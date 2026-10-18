'use strict';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const presets={original:'none',film:'sepia(.3) saturate(.85) contrast(1.08) brightness(1.03)',warm:'sepia(.45) saturate(1.15) brightness(1.04)',mono:'grayscale(1) contrast(1.1)',dazz:'sepia(.18) saturate(.82) contrast(1.08) brightness(1.06)'};
const classicFilters=[['original','Original'],['film','Film'],['warm','Warm'],['mono','Black & White'],['dazz','Dazz Cam']].map(([id,name])=>({id,name,family:'Classic'}));
let lightroomFilters=[],filteredURL,filterVersion=0,filterLoadError='',filterRender=Promise.resolve();
let info,file,preset='film',previewURL,enqueuing=false,items=[],next=0,loading=false,hasName=false,queueRows=[],mirrorPhoto=false,frontPhoto=false,captureFacing='environment';
function notice(text,error=false){$('#status').hidden=!error;$('#status').textContent=text;$('#status').classList.toggle('error',error);$('#upload-state').hidden=!text;$('#upload-state').textContent=text;$('#upload-state').classList.toggle('error',error);}
function captureState(){
 $('#upload').disabled=enqueuing||!file||!info?.uploadsOpen;
 $('#take-photo').disabled=$('#take-selfie').disabled=$('#take-video').disabled=enqueuing||!info?.uploadsOpen;
 $('#discard').hidden=!file;$('#discard').disabled=$('#close-caption').disabled=enqueuing;
 $('#capture-review').hidden=!file;$('#review-capture').hidden=!file;
 $('#review-capture').disabled=$('#retake-capture').disabled=enqueuing;
 for(const button of document.querySelectorAll('[data-filter]'))button.disabled=enqueuing;$('#filter-family').disabled=enqueuing;
 $('#mirror-photo').hidden=!file?.type.startsWith('image/');$('#mirror-photo').disabled=enqueuing;$('#mirror-photo').setAttribute('aria-pressed',String(mirrorPhoto));$('#photo-preview').style.transform=mirrorPhoto?'scaleX(-1)':'';
 $('#preview-label').hidden=!file;$('#native-actions').hidden=!!file;
}
function layout(){
 const image=$('#photo-preview'),video=$('#video-preview'),box=$('#camera-stage').getBoundingClientRect();
 const ratio=file?.type.startsWith('image/')&&image.naturalWidth?image.naturalWidth/image.naturalHeight:video.videoWidth?video.videoWidth/video.videoHeight:3/4;
 const view=$('#viewfinder');view.style.aspectRatio=String(ratio);
 if(box.width&&box.height){const width=Math.min(box.width,box.height*ratio);view.style.width=width+'px';view.style.height=width/ratio+'px';}
}
function showPage(page){
 for(const [id,name] of [['name-step','name'],['capture','camera'],['gallery','gallery']])$('#'+id).hidden=page!==name;
 $('#studio-header').hidden=$('#album-nav').hidden=page==='name';document.body.classList.toggle('camera-page',page==='camera');
 for(const [id,name] of [['tab-capture','camera'],['tab-gallery','gallery']]){$('#'+id).classList.toggle('selected',page===name);$('#'+id).setAttribute('aria-pressed',String(page===name));}
 if(page==='camera')layout();
}
$('#guest-name').oninput=()=>$('#guest-name').setCustomValidity('');
$('#name-form').onsubmit=event=>{
 event.preventDefault();const name=$('#guest-name').value.trim();
 if(!name){$('#guest-name').setCustomValidity('Isi nama kamu terlebih dahulu.');$('#guest-name').reportValidity();return;}
 $('#guest-name').value=name;hasName=true;showPage(info?.uploadsOpen?'camera':'gallery');if(!info?.uploadsOpen)loadGallery(true);
};
$('#edit-name').onclick=()=>{showPage('name');$('#guest-name').focus();};
async function api(path,body,options={}){
 const request=async()=>{
 const timeout=AbortSignal.timeout(15000),controller=new AbortController(),cancel=()=>controller.abort(options.signal?.aborted?options.signal.reason:timeout.reason);
 timeout.addEventListener('abort',cancel,{once:true});options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
 try{
 let r;try{r=await fetch('/api/album/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Temu-Album':'1'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:controller.signal});}catch(error){error.status=0;throw error;}
 let data;try{data=await r.json();}catch{if(controller.signal.aborted)throw controller.signal.reason;throw Object.assign(Error('Respons server belum lengkap. Silakan coba lagi.'),{status:r.ok?502:r.status});}
 if(!r.ok){const error=Error(data.error||'Album belum dapat diakses.');error.status=r.status;error.retryAfter=data.retryAfter||Number(r.headers?.get('Retry-After'));throw error;}return data;
 }finally{timeout.removeEventListener('abort',cancel);options.signal?.removeEventListener('abort',cancel);}
 };
 return body?request():TemuAlbumUpload.retry(request,{maxWait:30000,signal:options.signal});
}
function filterRecords(){return [...classicFilters,...lightroomFilters];}
function renderFilters(family){
 const focused=document.activeElement?.dataset?.filter;
 const video=file?.type.startsWith('video/'),records=filterRecords(),families=[...new Set(records.map(p=>p.family))];
 if(video)family='Classic';
 $('#filter-family').innerHTML=families.map(name=>`<option ${video&&name!=='Classic'?'disabled':''}>${esc(name)}</option>`).join('');$('#filter-family').value=family;
 $('#filters').innerHTML=records.filter(p=>p.family===family).map(p=>`<button type="button" data-filter="${p.id}" aria-pressed="${p.id===preset}" title="${esc(p.name)}"><span class="swatch ${classicFilters.some(c=>c.id===p.id)?p.id:''}" ${p.swatch?`style="background:linear-gradient(150deg,${p.swatch[0]} 0 60%,${p.swatch[1]} 60%)"`:''}><span>R&amp;C</span></span><span class="filter-name">${esc(p.name)}</span></button>`).join('');
 if(focused)for(const button of $('#filters').querySelectorAll('[data-filter]'))if(button.dataset.filter===focused)button.focus({preventScroll:true});
}
async function loadPresets(){
 try{lightroomFilters=await TemuAlbumPresets.load();for(const record of lightroomFilters)presets[record.id]='none';filterLoadError='';}
 catch(error){filterLoadError=error.message;}
}
function choosePreset(value){
 preset=Object.hasOwn(presets,value)?value:'original';
 if(file?.type.startsWith('video/')&&TemuAlbumPresets.has(preset))preset='original';
 const record=filterRecords().find(p=>p.id===preset);renderFilters(record.family);
 for(const el of [$('#photo-preview'),$('#video-preview')])el.style.filter=presets[preset];
 $('#preview-label').textContent='PREVIEW · '+record.name.toUpperCase();$('#viewfinder').classList.toggle('dazz',preset==='dazz');
 const current=++filterVersion,captured=file;
 if(filteredURL){URL.revokeObjectURL(filteredURL);filteredURL=null;}
 if(captured?.type.startsWith('image/'))$('#photo-preview').src=previewURL;
 $('#filter-note').textContent=filterLoadError||(captured?.type.startsWith('video/')?'Preset Lightroom tersedia untuk foto. Video memakai koleksi Classic.':'');
 if(captured?.type.startsWith('image/')&&TemuAlbumPresets.has(preset)){
  $('#filter-note').textContent='Menerapkan '+record.name+'…';
  filterRender=filterRender.catch(()=>{}).then(async()=>{
   if(current!==filterVersion||captured!==file)return;
   const blob=await TemuAlbumPhoto.preview(captured,preset);
   if(current!==filterVersion||captured!==file)return;
   filteredURL=URL.createObjectURL(blob);$('#photo-preview').src=filteredURL;$('#filter-note').textContent='';
  }).catch(error=>{if(current===filterVersion)$('#filter-note').textContent=error.message;});
 }
}
$('#filter-family').onchange=()=>{if(enqueuing)return;const record=filterRecords().find(p=>p.family===$('#filter-family').value);if(record)choosePreset(record.id);};
function prettyDate(value){return new Date(value).toLocaleString('id-ID',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Jakarta'})+' WIB';}
function applyInfo(data){info=data;$('#count').textContent=data.count;captureState();$('#locked').hidden=data.revealed;$('#release-copy').textContent=data.releaseAt?'Galeri dibuka pada '+prettyDate(data.releaseAt)+'.':'';}
async function init(){
 $('#album-loading').hidden=false;
 try{const key=new URLSearchParams(location.hash.slice(1)).get('k');const data=key?await TemuAlbumUpload.retry(()=>api('join',{key}),{maxWait:30000}):await api('info');if(key)history.replaceState(null,'',location.pathname);applyInfo(data);choosePreset(data.filter);const initial=preset;loadPresets().then(()=>{if(!file&&!enqueuing&&preset===initial)choosePreset(data.filter);else{renderFilters(filterRecords().find(p=>p.id===preset).family);captureState();}});$('#gate').hidden=true;$('#content').hidden=false;if(!hasName)showPage('name');outbox.resume().catch(e=>notice(e.message,true));resumePending();}
 catch(e){$('#gate').hidden=false;$('#content').hidden=true;notice(e.message,true);}finally{$('#album-loading').hidden=true;}
}
function selectFile(f,front=false){
 if(!f||enqueuing)return;
 if(f.size>100*1024*1024){notice('Momen terlalu besar. Batas foto atau video adalah 100 MB.',true);return;}
 if(!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'].includes(f.type)){notice('Gunakan foto JPG, PNG, WebP atau video MP4, MOV, WebM. Pilih format Paling Kompatibel pada kamera jika hasilnya HEIC.',true);return;}
 if(previewURL)URL.revokeObjectURL(previewURL);file=f;frontPhoto=front;mirrorPhoto=front&&f.type.startsWith('image/');previewURL=URL.createObjectURL(f);
 const photo=f.type.startsWith('image/');$('#photo-preview').hidden=!photo;$('#video-preview').hidden=photo;$('#video-preview').pause();
 for(const media of [$('#photo-preview'),$('#video-preview')])media.removeAttribute('src');
 const media=photo?$('#photo-preview'):$('#video-preview');media.src=previewURL;media.onload=media.onloadedmetadata=layout;
 $('#placeholder').hidden=true;captureState();choosePreset(preset);layout();notice('');
}
function openCamera(kind,facing='environment'){if(enqueuing||!info?.uploadsOpen)return;const input=$('#native-'+kind);captureFacing=facing;input.setAttribute('capture',facing);input.value='';input.click();}
for(const kind of ['photo','video']){$('#take-'+kind).onclick=()=>openCamera(kind);$('#native-'+kind).onchange=event=>selectFile(event.target.files[0],kind==='photo'&&captureFacing==='user');}
$('#take-selfie').onclick=()=>openCamera('photo','user');
$('#mirror-photo').onclick=()=>{if(enqueuing||!file?.type.startsWith('image/'))return;mirrorPhoto=!mirrorPhoto;captureState();};
function clearPreview(){filterVersion++;if(filteredURL){URL.revokeObjectURL(filteredURL);filteredURL=null;}$('#filter-note').textContent='';file=null;mirrorPhoto=frontPhoto=false;$('#photo-preview').hidden=$('#video-preview').hidden=true;$('#video-preview').pause();for(const media of [$('#photo-preview'),$('#video-preview')])media.removeAttribute('src');$('#placeholder').hidden=false;if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;captureState();layout();}
$('#retake-capture').onclick=$('#discard').onclick=()=>{if(enqueuing)return;$('#caption-dialog').close();openCamera(file?.type.startsWith('video/')?'video':'photo',frontPhoto?'user':'environment');};
$('#close-caption').onclick=()=>$('#caption-dialog').close();$('#caption-dialog').addEventListener('cancel',event=>{if(enqueuing)event.preventDefault();});$('#review-capture').onclick=()=>{if(file&&!enqueuing)$('#caption-dialog').showModal();};
$('#filters').onclick=e=>{const button=e.target.closest('[data-filter]');if(button)choosePreset(button.dataset.filter);};
$('#retry').onclick=init;
function tab(gallery){if(!hasName){showPage('name');return;}showPage(gallery?'gallery':'camera');if(gallery)loadGallery(true);}
$('#tab-capture').onclick=()=>tab(false);$('#tab-gallery').onclick=()=>tab(true);$('#share-first').onclick=$('#share-empty').onclick=()=>tab(false);
const outbox=TemuAlbumQueue.create({send:sendQueued,onChange:renderQueue,onSaved:()=>{if(!$('#gallery').hidden)loadGallery(true);else api('info').then(applyInfo).catch(()=>{});}});
function renderQueue(rows,error){
 queueRows=rows;$('#upload-queue').hidden=!rows.length&&!error;
 $('#queue-summary').textContent=error?error.message:rows.length+' momen dalam antrean'+(rows.some(x=>x.state==='failed')?' · perlu diperiksa':'');
 const phases={recovering:'Memeriksa unggahan sebelumnya…',ticket:'Meminta giliran unggah…',waiting:'Menunggu server · file tetap tersimpan di HP',processing:'Memproses album…',thumbnail:'Foto tersimpan · menyiapkan thumbnail'};
 $('#queue-items').innerHTML=rows.map(job=>`<div class="queue-item"><span>${esc(job.name)} · ${job.state==='failed'?esc(job.error):job.result?phases.thumbnail:job.state!=='uploading'?'Menunggu unggahan':job.phase==='uploading'?'Mengunggah '+Math.round(job.progress||0)+'%':phases[job.phase]||'Memeriksa unggahan sebelumnya…'}</span><button type="button" class="text-button" data-retry="${job.id}">Coba lagi</button>${job.state==='failed'?`<button type="button" class="text-button" data-remove="${job.id}">Hapus antrean</button>`:''}</div>`).join('');
}
$('#queue-items').onclick=async event=>{const retry=event.target.closest('[data-retry]'),remove=event.target.closest('[data-remove]');try{if(retry)await outbox.retry(retry.dataset.retry);if(remove&&confirm('Hapus momen ini dari antrean HP? Foto yang sudah tersimpan di album tetap ada.'))await outbox.discard(remove.dataset.remove);}catch(e){notice(e.message,true);}};
$('#upload-form').onsubmit=async event=>{
 event.preventDefault();if(!file||enqueuing||!info?.uploadsOpen)return;const name=$('#guest-name').value.trim();if(!name)return;
 enqueuing=true;captureState();const captured=file;
 try{
  const uploadFile=mirrorPhoto?await TemuAlbumPhoto.mirror(captured):captured;
  if(uploadFile.size>100*1024*1024)throw Error('Hasil mirror melebihi batas 100 MB. Matikan Mirror atau ambil ulang.');
  await outbox.enqueue({id:crypto.randomUUID().replaceAll('-',''),blob:uploadFile,name,caption:$('#caption').value.trim(),filter:preset});
  $('#caption-dialog').close();clearPreview();$('#caption').value='';$('#camera-status').textContent='Masuk antrean. Kamu bisa langsung mengambil foto atau video berikutnya.';notice('');
 }catch(e){notice(e.message,true);}finally{enqueuing=false;captureState();}
};
function putFile(url,headers,blob,progress,options={}){return new Promise((resolve,reject)=>{
 const signal=options.signal;if(signal?.aborted)return reject(signal.reason);let finished=false;
 const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.timeout=180000;for(const [key,value] of Object.entries(headers))xhr.setRequestHeader(key,value);
 const done=(error,value)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve(value);};
 const stop=()=>{xhr.abort();done(signal.reason);};signal?.addEventListener('abort',stop,{once:true});
 xhr.upload.onprogress=event=>{if(!finished&&event.lengthComputable)progress(event.loaded/event.total*100);};
 xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300){let result=null;try{result=xhr.responseText?JSON.parse(xhr.responseText):null;}catch{}done(null,result);}else{const error=Error('Unggahan belum berhasil. File tetap ada di antrean.');error.status=xhr.status;done(error);}};
 xhr.onerror=xhr.ontimeout=xhr.onabort=()=>{const error=signal?.aborted?signal.reason:Object.assign(Error('Koneksi terputus. File tetap tersimpan; coba lagi dari antrean.'),{status:0});done(error);};xhr.send(blob);
});}
async function sendQueued(job,save,progress,options={}){
 const {signal}=options,request=(path,body)=>api(path,body,{signal});
 let result=job.result;
 if(!result){
  if(info.storage==='s3'){
   for(let attempt=0;attempt<2&&!result;attempt++){
    const ticket=await TemuAlbumUpload.retry(async()=>{await save({phase:'ticket'});return request('uploads',{requestId:job.id,name:job.name,caption:job.caption,mime:job.blob.type,size:job.blob.size,filter:job.filter,multipart:true});},{signal,onWait:()=>save({phase:'waiting'})});
    if(ticket.completed)result=ticket;
    else{
     const uploaded=ticket.pending||(job.stage==='uploaded'&&job.ticket?.id===ticket.id);
     await save({ticket,stage:uploaded?'uploaded':null});
     if(!uploaded){
      try{await TemuAlbumUpload.retry(async()=>{await save({phase:'uploading'});return putFile(ticket.url,ticket.headers,job.blob,progress,{signal});},{signal,maxWait:5*60*1000,onWait:()=>save({phase:'waiting'})});}
      catch(error){if(attempt===0&&[403,404].includes(error.status))continue;throw error;}
      await save({stage:'uploaded'});
     }
     await save({phase:'processing'});result=await TemuAlbumUpload.settled(ticket,request,{signal,onPending:()=>save({phase:'processing'}),onWait:()=>save({phase:'waiting'})});
    }
   }
  }else{
   // Local deployments share the same idempotent request ID as direct S3 uploads.
   await save({phase:'uploading'});result=await putFile('/api/album/upload',{'Content-Type':job.blob.type,'X-Temu-Album':'1','X-Album-Name':encodeURIComponent(job.name),'X-Album-Caption':encodeURIComponent(job.caption),'X-Album-Filter':job.filter,'X-Album-Request-Id':job.id},job.blob,progress,{signal});
  }
  await save({result});
 }
 if(job.blob.type.startsWith('image/')){
  await save({phase:'thumbnail'});
  const thumbnail=await TemuAlbumPhoto.thumbnail(job.blob,job.filter);
  await TemuAlbumUpload.retry(async()=>{
   if(signal?.aborted)throw signal.reason;
   let response;try{response=await fetch('/api/album/thumbnail/'+result.id,{method:'PUT',headers:{'Content-Type':'image/jpeg','X-Temu-Album':'1','X-Album-Thumbnail-Key':result.thumbnailKey},body:thumbnail,signal:signal||AbortSignal.timeout(15000)});}catch(error){error.status=0;throw error;}
   if(!response.ok){const error=Error('Foto asli tersimpan, thumbnail belum tersedia. Coba lagi untuk menyiapkan preview.');error.status=response.status;throw error;}
  },{signal,maxWait:60000,onWait:()=>save({phase:'thumbnail'})});
 }
 return result;
}
async function resumePending(){
 let saved;try{saved=JSON.parse(sessionStorage.getItem('temu-album-pending'));}catch{}if(!saved?.id||!saved?.token)return;
 try{await TemuAlbumUpload.settled(saved,api);sessionStorage.removeItem('temu-album-pending');applyInfo(await api('info'));}catch(e){notice(e.message,true);}
}
window.addEventListener('online',()=>{if(info)outbox.resume().catch(e=>notice(e.message,true));});
window.addEventListener('pageshow',()=>{if(info)outbox.resume().catch(e=>notice(e.message,true));});
window.addEventListener('pagehide',()=>outbox.pause());window.addEventListener('offline',()=>outbox.pause());
document.addEventListener('visibilitychange',()=>{if(document.hidden)outbox.pause();else if(info)outbox.resume().catch(e=>notice(e.message,true));});
window.addEventListener('resize',layout);
window.addEventListener('beforeunload',event=>{if(enqueuing||file||queueRows.length){event.preventDefault();event.returnValue='';}});
function renderGallery(){
 TemuAlbumLoading.stop($('#grid'));const type=$('#media-type').value;
 $('#grid').innerHTML=items.filter(item=>type==='all'||(type==='photo')===item.mime.startsWith('image/')).map(item=>`<button class="moment-card" data-id="${item.id}" aria-label="Buka momen dari ${esc(item.name)}">${item.mime.startsWith('image/')?(item.thumbnail?TemuAlbumLoading.photo('/api/album/file/'+item.id+'?thumb=1','Momen dari '+item.name,'moment-photo filter-'+item.filter):'<div class="moment-video"><span>◎</span><small>PREVIEW BELUM TERSEDIA</small></div>'):'<div class="moment-video" aria-hidden="true"><span>▷</span><small>VIDEO</small></div><span class="media-badge" aria-hidden="true">▷</span>'}</button>`).join('');
 TemuAlbumLoading.watch($('#grid'));$('#gallery-empty').hidden=!info.revealed||!!$('#grid').childElementCount;$('#more').hidden=next===null||!info.revealed;
}
async function loadGallery(reset=false){if(loading)return;loading=true;$('#refresh').disabled=true;$('#more').disabled=true;$('#gallery-loading').hidden=false;$('#grid').setAttribute('aria-busy','true');$('#gallery-empty').hidden=true;try{applyInfo(await api('info'));if(!info.revealed){items=[];next=null;renderGallery();return;}const data=await api('items?offset='+(reset?0:(next||0)));items=reset?data.items:[...items,...data.items];next=data.next;renderGallery();}catch(e){notice(e.message,true);}finally{loading=false;$('#refresh').disabled=false;$('#more').disabled=false;$('#gallery-loading').hidden=true;$('#grid').setAttribute('aria-busy','false');}}
$('#refresh').onclick=()=>loadGallery(true);$('#more').onclick=()=>loadGallery();$('#media-type').onchange=renderGallery;
$('#grid').onclick=event=>{
 const card=event.target.closest('[data-id]');if(!card)return;const item=items.find(x=>x.id===card.dataset.id);if(!item)return;
 const photo=item.mime.startsWith('image/');TemuAlbumLoading.stop($('#moment-detail'));
 $('#moment-detail').innerHTML=`<h2>${esc(item.name)}</h2><p><time>${esc(prettyDate(item.created))}</time></p><p>${esc(item.caption)}</p>${photo?TemuAlbumLoading.photo('/api/album/file/'+item.id,'Momen dari '+item.name,'detail-media filter-'+item.filter,true,item.filter.startsWith('lr-')?item.filter:''):`<video class="detail-media filter-${item.filter}" src="/api/album/file/${item.id}?preview=1" controls playsinline preload="metadata"></video>`}<div class="detail-actions"><a class="solid" href="/api/album/file/${item.id}?download=1" download>Unduh file asli ↗</a>${photo?'<button class="outline" id="open-story" type="button">Bagikan ke Story Instagram</button>':''}</div>`;
 $('#moment-dialog').showModal();TemuAlbumLoading.watch($('#moment-detail'));
 if(photo)$('#open-story').onclick=()=>openStory(item);
 else{const video=$('#moment-detail video');video.addEventListener('error',()=>{const time=video.currentTime||0;video.src='/api/album/file/'+item.id;video.addEventListener('loadedmetadata',()=>{video.currentTime=time;},{once:true});},{once:true});}
};
$('#close-dialog').onclick=()=>$('#moment-dialog').close();$('#moment-dialog').addEventListener('close',()=>{TemuAlbumLoading.stop($('#moment-detail'));$('#moment-dialog video')?.pause();});
let storySource,storyItem,storyFile,storyURL,storyVersion=0,storyOverlay='celebration',storyController,storyBusy=false;
function clearStory(){storyVersion++;storyBusy=false;for(const button of document.querySelectorAll('[data-story-overlay]'))button.disabled=true;storyController?.abort();storySource=storyItem=storyFile=null;$('#story-preview').hidden=true;$('#story-preview').removeAttribute('src');if(storyURL)URL.revokeObjectURL(storyURL);storyURL=null;$('#download-story').hidden=true;$('#download-story').removeAttribute('href');$('#share-story').disabled=true;}
async function openStory(item){
 clearStory();storyItem=item;storyOverlay='celebration';$('#moment-dialog').close();$('#story-dialog').showModal();$('#story-status').textContent='Memuat foto asli…';
 const current=storyVersion;storyController=new AbortController();
 try{const response=await fetch('/api/album/file/'+item.id,{signal:storyController.signal});if(!response.ok)throw Error('Foto asli belum dapat diambil. Tutup lalu coba lagi.');const blob=await response.blob();if(current!==storyVersion)return;storySource=blob;await prepareStory();}
 catch(e){if(current===storyVersion)$('#story-status').textContent=e.message;}
}
async function prepareStory(){
 const current=++storyVersion;storyBusy=true;storyFile=null;$('#share-story').disabled=true;$('#download-story').hidden=true;$('#story-preview').hidden=true;$('#story-status').textContent='Menyiapkan Story dari foto asli…';
 for(const button of document.querySelectorAll('[data-story-overlay]')){button.disabled=true;button.setAttribute('aria-pressed',String(button.dataset.storyOverlay===storyOverlay));}
 if(!storySource)return;
 try{const result=await TemuAlbumPhoto.story(storySource,presets[storyItem.filter]||'none',storyOverlay,storyItem.filter);if(current!==storyVersion)return;
  storyFile=result;if(storyURL)URL.revokeObjectURL(storyURL);storyURL=URL.createObjectURL(result);$('#story-preview').src=storyURL;$('#story-preview').hidden=false;
  $('#download-story').href=storyURL;$('#download-story').hidden=false;
  const canShare=!!navigator.share&&!!navigator.canShare?.({files:[result]});$('#share-story').disabled=!canShare;$('#story-status').textContent=canShare?'Foto dengan rasio asli siap. Pilih Instagram dari menu berbagi HP.':'Berbagi file tidak tersedia di browser ini. Unduh Story lalu buka Instagram.';
 }catch(e){if(current===storyVersion)$('#story-status').textContent=e.message;}finally{if(current===storyVersion){storyBusy=false;for(const button of document.querySelectorAll('[data-story-overlay]'))button.disabled=false;}}
}
$('#story-overlays').onclick=event=>{const button=event.target.closest('[data-story-overlay]');if(!button||storyBusy||!storySource)return;storyOverlay=button.dataset.storyOverlay;prepareStory();};
$('#share-story').onclick=async()=>{if(!storyFile||!navigator.share)return;try{await navigator.share({files:[storyFile]});}catch(e){if(e.name!=='AbortError')$('#story-status').textContent='Belum dapat dibagikan. Gunakan Unduh Story lalu buka Instagram.';}};
$('#close-story').onclick=()=>$('#story-dialog').close();$('#story-dialog').addEventListener('close',clearStory);
// Refresh reveal time without forcing a guest to reload the page.
setInterval(()=>{if(info&&!document.hidden&&!$('#gallery').hidden&&!loading&&!info.revealed)loadGallery(true);},30000);
$('#open-cover').onclick=()=>{
 const button=$('#open-cover');if(button.disabled)return;button.disabled=true;$('#album-cover').classList.add('opening');
 setTimeout(()=>{$('#album-cover').hidden=true;$('#album-app').inert=false;document.body.classList.remove('cover-closed');const target=$('#content').hidden?$('#retry'):$('#guest-name');target.tabIndex=-1;target.focus({preventScroll:true});},window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1150);
};
init();

window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('k'))init();});
