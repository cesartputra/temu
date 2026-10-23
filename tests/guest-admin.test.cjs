const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../dist/guest-admin.js'),'utf8');
const item={guest:'g',name:'<img src=x> & Pasangan',message:'<script>doa</script>',updated:'2026-10-23T00:00:00Z'};
function fixture({allowed=true,failDelete=false,delayDelete=false}={}){
 const nodes=new Map(),element=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',disabled:false,open:true});return nodes.get(selector);};
 let finishDelete;const pendingDelete=new Promise(resolve=>{finishDelete=resolve;});
 const requests=[],messages=[],context=vm.createContext({$:element,esc:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),db:{event:{id:'wedding'},pin:'configured'},admin:async()=>allowed,modal:(title,html)=>{element('#modal').open=true;element('#modal-title').textContent=title;element('#modal-body').innerHTML=html;},toast:message=>messages.push(message),TemuStore:{read:async()=>({config:{enabled:true,token:'test-token'}})},AbortSignal,Date,fetch:async(url,options)=>{requests.push({url,options});if(delayDelete&&url.endsWith('/delete'))await pendingDelete;return {ok:!failDelete||!url.endsWith('/delete'),json:async()=>url.endsWith('/delete')?(failDelete?{error:'PIN tidak sesuai.'}:{ok:true}):{event:'wedding',wishes:requests.some(r=>r.url.endsWith('/delete'))&&!failDelete?[]:[item]}};}});
 vm.runInContext(source,context);return {context,element,requests,messages,finishDelete,replace:selector=>{nodes.delete(selector);return element(selector);}};
}
test('manager wish list renders escaped author and message and refuses staff access',async()=>{
 const denied=fixture({allowed:false});await denied.context.showWishManagement();assert.equal(denied.requests.length,0);
 const f=fixture();await f.context.showWishManagement();assert.ok(f.element('#wish-admin-list').innerHTML.includes('&lt;img src=x&gt; &amp; Pasangan'));assert.ok(f.element('#wish-admin-list').innerHTML.includes('&lt;script&gt;doa&lt;/script&gt;'));assert.ok(!f.element('#wish-admin-list').innerHTML.includes('<script>'));
 assert.equal(f.requests[0].options.headers.Authorization,'Bearer test-token');
});
test('wish deletion submits confirmed item version and PIN then refreshes the list',async()=>{
 const f=fixture();await f.context.showWishManagement();f.context.showDeleteWish(item,'wedding');
 assert.ok(f.element('#modal-body').innerHTML.includes('&lt;script&gt;doa&lt;/script&gt;'));
 f.element('#wish-delete-pin').value='1234';await f.element('#wish-delete-form').onsubmit({preventDefault(){}});
 const request=f.requests.find(r=>r.url.endsWith('/delete'));assert.equal(request.options.method,'POST');assert.equal(request.options.headers['X-Temu-Invite'],'1');assert.deepEqual(JSON.parse(request.options.body),{event:'wedding',guest:'g',updated:item.updated,pin:'1234'});
 assert.ok(f.element('#wish-admin-list').innerHTML.includes('Belum ada doa dan ucapan.'));assert.ok(f.messages.includes('Doa dan ucapan dihapus.'));
});
test('failed deletion preserves the dialog and allows another attempt',async()=>{
 const f=fixture({failDelete:true});await f.context.showWishManagement();f.context.showDeleteWish(item,'wedding');f.element('#wish-delete-pin').value='0000';await f.element('#wish-delete-form').onsubmit({preventDefault(){}});
 assert.equal(f.element('#wish-delete-status').textContent,'PIN tidak sesuai.');assert.equal(f.element('#wish-delete-form button[type=submit]').disabled,false);assert.equal(f.messages.length,0);
});
test('a late deletion response does not reopen a closed dialog',async()=>{
 const f=fixture({delayDelete:true});f.context.showDeleteWish(item,'wedding');f.element('#wish-delete-pin').value='1234';const pending=f.element('#wish-delete-form').onsubmit({preventDefault(){}});await new Promise(setImmediate);assert.equal(f.requests.length,1);
 f.element('#modal').open=false;f.finishDelete();await pending;assert.equal(f.element('#modal').open,false);assert.equal(f.requests.length,1);
});
for(const failDelete of [false,true])test(`a late deletion ${failDelete?'failure':'success'} leaves another form untouched`,async()=>{
 const f=fixture({delayDelete:true,failDelete});f.context.showDeleteWish(item,'wedding');f.element('#wish-delete-pin').value='1234';const pending=f.element('#wish-delete-form').onsubmit({preventDefault(){}});await new Promise(setImmediate);assert.equal(f.requests.length,1);
 f.replace('#wish-delete-form');const status=f.replace('#wish-delete-status');f.element('#modal-body').innerHTML='Form lain dengan isi belum disimpan';f.finishDelete();await pending;
 assert.equal(f.element('#modal-body').innerHTML,'Form lain dengan isi belum disimpan');assert.equal(status.textContent,'');assert.equal(f.requests.length,1);
});
