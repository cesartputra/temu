const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../dist/invitation2.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../server/templates/invitation2.html'),'utf8');

test('each bank copies its own fixed account and handles clipboard denial',async()=>{
 const buttons=[...html.matchAll(/data-copy-account="(\d+)"/g)].map(match=>({dataset:{copyAccount:match[1]},nextElementSibling:{textContent:''}}));
 assert.deepEqual(buttons.map(button=>button.dataset.copyAccount),['4380170260','1230010313163']);
 const copied=[];
 const context={document:{querySelectorAll:()=>buttons},navigator:{clipboard:{writeText:async value=>copied.push(value)}}};
 vm.runInNewContext(source.slice(source.indexOf('function setupGift('),source.indexOf('function setupCalendar('))+'setupGift();',context);
 await buttons[0].onclick();await buttons[1].onclick();assert.deepEqual(copied,['4380170260','1230010313163']);
 assert.equal(buttons[1].nextElementSibling.textContent,'Nomor rekening disalin.');
 context.navigator.clipboard.writeText=async()=>{throw Error('Denied');};await buttons[0].onclick();
 assert.equal(buttons[0].nextElementSibling.textContent,'Pilih dan salin nomor rekening di atas.');
});

for(const reduce of [false,true])test(`envelope opens once, reveals invitation after animation (reduced motion: ${reduce})`,async()=>{
 const nodes=Object.fromEntries(['#open-personal','#guest-cover','#invitation','#hero-video'].map(id=>[id,{hidden:id==='#invitation',disabled:false,classes:[],classList:{add(name){nodes[id].classes.push(name);}},focus(){this.focused=true;},play:async()=>{}}]));
 let click,finish,timer,plays=0;
 nodes['#open-personal'].addEventListener=(event,handler)=>{click=handler;};
 const context={$:selector=>nodes[selector],reducedMotion:{matches:reduce},music:{},playMusic:()=>plays++,musicToggle:{hidden:true},document:{body:{classList:{add(){}}}},window:{scrollTo(){}},setupPageMotion(){},setupNavigation(){},setupGallery(){},wishScroller:null,setTimeout(fn,ms){timer=ms;finish=fn;}};
 vm.runInNewContext(source.slice(source.indexOf('let invitationOpened='),source.indexOf("document.querySelectorAll('a[href")),context);
 const opening=click();assert.equal(nodes['#open-personal'].disabled,true);assert.deepEqual(nodes['#guest-cover'].classes,['opening']);
 await click();assert.equal(plays,1);
 if(!reduce){assert.equal(timer,1150);assert.equal(nodes['#invitation'].hidden,true);finish();}
 await opening;assert.equal(nodes['#guest-cover'].hidden,true);assert.equal(nodes['#invitation'].hidden,false);assert.equal(nodes['#invitation'].focused,true);
});
