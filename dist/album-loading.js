'use strict';
(function(root){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function photo(url,alt,classes,detail=false){
  return `<div class="photo-shell ${detail?'photo-shell-detail':'photo-shell-card'} is-loading" aria-busy="true"><img class="${esc(classes)}" src="${esc(url)}" ${detail?'':'loading="lazy"'} decoding="async" alt="${esc(alt)}"><div class="photo-loading" ${detail?'role="status"':'aria-hidden="true"'}><span class="album-spinner" aria-hidden="true"></span><span>Memuat foto…</span></div><div class="photo-error" hidden><span aria-hidden="true">◎</span><span>Foto belum dapat dimuat.</span>${detail?'<button type="button" class="outline photo-retry">Coba lagi ↻</button>':'<small>Ketuk untuk membuka foto</small>'}</div></div>`;
 }
 function watch(root){
  for(const shell of root.querySelectorAll('.photo-shell')){
   const image=shell.querySelector('img'),loader=shell.querySelector('.photo-loading'),error=shell.querySelector('.photo-error'),retry=shell.querySelector('.photo-retry');
   let generation=0;
   function state(value){
    shell.classList.toggle('is-loading',value==='loading');shell.classList.toggle('is-ready',value==='ready');shell.classList.toggle('is-error',value==='error');
    shell.setAttribute('aria-busy',String(value==='loading'));loader.hidden=value!=='loading';error.hidden=value!=='error';
   }
   function failed(){generation++;state('error');}
   async function loaded(){
    const current=++generation;
    try{
     if(!image.naturalWidth)throw Error('Image unavailable');
     if(image.decode)await image.decode();
     if(current===generation)state('ready');
    }catch{if(current===generation)failed();}
   }
   image.addEventListener('load',loaded);image.addEventListener('error',failed);
   if(retry)retry.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();generation++;state('loading');image.src=image.getAttribute('src');
   });
   // Cached images can finish before listeners are attached.
   if(image.complete){if(image.naturalWidth)loaded();else failed();}
  }
 }
 const api={photo,watch};if(typeof module==='object'&&module.exports)module.exports=api;else root.TemuAlbumLoading=api;
})(typeof window==='object'?window:globalThis);
