/* Bounded retries and asynchronous job polling; no binary media enters API calls. */
(function(root){
'use strict';
function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));const stop=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});}
async function retry(task,options={}){
 const {signal,onWait=()=>{},wait=sleep,random=Math.random,now=Date.now,maxWait=30*60*1000}=options;const deadline=now()+maxWait;let attempt=0;
 for(;;){if(signal?.aborted)throw new DOMException('Aborted','AbortError');try{return await task();}catch(error){
  if(error.name==='AbortError'||![429,502,503,504,0].includes(error.status)||now()>=deadline)throw error;
  const delay=Math.min(30000,Math.max((error.retryAfter||0)*1000,1500*2**Math.min(attempt++,4)))*(0.8+random()*0.4);
  onWait(error);await wait(Math.min(delay,Math.max(0,deadline-now())),signal);
 }}
}
async function settled(ticket,request,options={}){
 const wait=options.wait||sleep,random=options.random||Math.random,now=options.now||Date.now,deadline=now()+60*60*1000;
 let data=await retry(()=>request('uploads/'+ticket.id+'/complete',{token:ticket.token}),options);
 while(data.pending){
  if(now()>=deadline){const error=Error('Momen masih diproses. Buka kembali album untuk melihat statusnya.');error.status=408;throw error;}
  options.onPending?.(data);
  await wait(Math.max(3000,Math.min(15000,(data.retryAfter||6)*1000))*(0.8+random()*0.4),options.signal);
  data=await retry(()=>request('uploads/'+ticket.id+'/status',{token:ticket.token}),options);
 }
 return data;
}
const api={sleep,retry,settled};if(typeof module!=='undefined')module.exports=api;else root.TemuAlbumUpload=api;
})(typeof window==='undefined'?globalThis:window);
