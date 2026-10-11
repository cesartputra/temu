'use strict';
(function(root){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function photo(url,alt,classes,detail=false){
  // Assign src only when the queue grants a slot; native lazy loading alone
  // can start every visible thumbnail at the same time.
  return `<div class="photo-shell ${detail?'photo-shell-detail':'photo-shell-card'} is-loading" aria-busy="true"><img class="${esc(classes)}" data-photo-src="${esc(url)}" decoding="async" alt="${esc(alt)}"><div class="photo-loading" ${detail?'role="status"':'aria-hidden="true"'}><span class="album-spinner" aria-hidden="true"></span><span>Memuat foto…</span></div><div class="photo-error" hidden><span aria-hidden="true">◎</span><span>Foto belum dapat dimuat.</span>${detail?'<button type="button" class="outline photo-retry">Coba lagi ↻</button>':'<small>Ketuk untuk membuka foto</small>'}</div></div>`;
 }
 function createLoader({maxConcurrent=2,maxRetries=3,timeout=15000,delay=attempt=>750*2**(attempt-1)+Math.random()*250,schedule=setTimeout,cancel=clearTimeout,Observer=root.IntersectionObserver}={}){
  const watchers=new WeakMap(),queue=[];let active=0;
  function pump(){
   while(active<maxConcurrent&&queue.length){
    const entry=queue.shift();entry.queued=false;
    if(entry.cancelled)continue;
    entry.active=true;active++;entry.start();
   }
  }
  function enqueue(entry){
   if(entry.cancelled||entry.queued||entry.active)return;
   entry.queued=true;
   // A tapped full photo goes ahead of thumbnails that have not started.
   if(entry.detail)queue.unshift(entry);else queue.push(entry);
   pump();
  }
  function release(entry){if(entry.active){entry.active=false;active--;pump();}}
  function stop(container){watchers.get(container)?.();watchers.delete(container);}
  function watch(container){
   stop(container);
   const entries=[],observed=new Map();
   const observer=Observer?new Observer(records=>{
    for(const record of records)if(record.isIntersecting){const entry=observed.get(record.target);if(entry){observer.unobserve(record.target);enqueue(entry);}}
   },{rootMargin:'200px'}):null;
   for(const shell of container.querySelectorAll('.photo-shell')){
   const image=shell.querySelector('img'),loader=shell.querySelector('.photo-loading'),error=shell.querySelector('.photo-error'),retry=shell.querySelector('.photo-retry');
   const url=image.getAttribute('data-photo-src');
   const entry={queued:false,active:false,cancelled:false,detail:shell.classList.contains('photo-shell-detail')};entries.push(entry);
   let generation=0,retries=0,timer=null,retryTimer=null,decoding=false;
   function state(value){
    shell.classList.toggle('is-loading',value==='loading');shell.classList.toggle('is-ready',value==='ready');shell.classList.toggle('is-error',value==='error');
    shell.setAttribute('aria-busy',String(value==='loading'));loader.hidden=value!=='loading';error.hidden=value!=='error';
   }
   function clearTimer(){if(timer!==null){cancel(timer);timer=null;}}
   function failed(){
    if(entry.cancelled||!entry.active)return;
    generation++;decoding=false;clearTimer();image.removeAttribute('src');
    if(retries<maxRetries){
     retries++;retryTimer=schedule(()=>{retryTimer=null;enqueue(entry);},delay(retries));
    }else state('error');
    release(entry);
   }
   async function loaded(){
    if(entry.cancelled||!entry.active||decoding)return;
    decoding=true;const current=generation;
    try{
     if(!image.naturalWidth)throw Error('Image unavailable');
     if(image.decode)await image.decode();
     if(current===generation&&!entry.cancelled){clearTimer();state('ready');release(entry);}
    }catch{if(current===generation&&!entry.cancelled)failed();}
   }
   image.addEventListener('load',loaded);image.addEventListener('error',failed);
   function manualRetry(event){
    event.preventDefault();event.stopPropagation();
    if(entry.cancelled||entry.active||entry.queued)return;
    if(retryTimer!==null){cancel(retryTimer);retryTimer=null;}
    retries=0;state('loading');enqueue(entry);
   }
   if(retry)retry.addEventListener('click',manualRetry);
   entry.start=()=>{
    generation++;decoding=false;state('loading');
    timer=schedule(failed,timeout);image.src=url;
    // Cached images can finish before the next load event.
    if(image.complete&&image.naturalWidth)loaded();
   };
   entry.dispose=()=>{
    entry.cancelled=true;generation++;clearTimer();
    if(retryTimer!==null)cancel(retryTimer);
    image.removeEventListener('load',loaded);image.removeEventListener('error',failed);
    if(retry)retry.removeEventListener('click',manualRetry);
    image.removeAttribute('src');release(entry);
   };
   observed.set(shell,entry);
   if(observer&&!entry.detail)observer.observe(shell);else enqueue(entry);
   }
   const cleanup=()=>{observer?.disconnect();for(const entry of entries)entry.cancelled=true;for(const entry of entries)entry.dispose();};
   watchers.set(container,cleanup);return cleanup;
  }
  return {photo,watch,stop};
 }
 const api={...createLoader(),createLoader};if(typeof module==='object'&&module.exports)module.exports=api;else root.TemuAlbumLoading=api;
})(typeof window==='object'?window:globalThis);
