'use strict';
async function openInvitation(){
 const status=document.querySelector('#gate-status'),retry=document.querySelector('#gate-retry');retry.hidden=true;
 try{
  const params=new URLSearchParams(location.hash.slice(1)),guest=params.get('g'),key=params.get('k');
  if(!guest||!key)throw Error('Undangan ini hanya dapat dibuka melalui tautan unik yang dikirimkan kepada Anda.');
  status.textContent='Memeriksa tautan undangan…';
  const preparation=await fetch('/api/invite/device',{method:'POST',headers:{'Content-Type':'application/json','X-Temu-Invite':'1'},body:'{}',cache:'no-store',signal:AbortSignal.timeout(12000)});if(!preparation.ok)throw Error('Browser belum dapat disiapkan. Coba lagi.');
  const response=await fetch('/api/invite/guest',{method:'POST',headers:{'Content-Type':'application/json','X-Temu-Invite':'1'},body:JSON.stringify({guest,key}),cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();
  if(!response.ok)throw Error(data.error||'Undangan belum dapat dibuka.');
  // The next request must carry the HttpOnly device cookie. No cookie means no page.
  const url=new URL(location.href);url.searchParams.set('open','1');location.replace(url.href);
 }catch(error){status.textContent=error.message||'Periksa koneksi dan coba lagi.';retry.hidden=false;}
}
document.querySelector('#gate-retry').onclick=openInvitation;window.addEventListener('hashchange',openInvitation);openInvitation();
