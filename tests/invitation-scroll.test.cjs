const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../dist/invitation2-scroll.js'),'utf8');
const {batches}=require('../dist/invitation2-scroll.js');
test('14 ucapan dibagi 6/6/2 tanpa menghilangkan ucapan',()=>{const data=Array.from({length:14},(_,i)=>i);const groups=batches(data);assert.deepEqual(groups.map(g=>g.length),[6,6,2]);assert.deepEqual(groups.flat(),data);assert.deepEqual(batches([]),[]);});
function fixture(axis,stops,reduce=false,speed=0){
 let now=0,tick,visibleCallback,frame,scrolls=[];const events=new Map();
 function target(){return {addEventListener(name,fn){events.set(this+':'+name,fn);this.listeners??={};this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];}};}
 const viewport=Object.assign(target(),{scrollTop:0,scrollLeft:0,contains(){return false;},scrollTo(data){scrolls.push(data);if('top'in data)this.scrollTop=data.top;if('left'in data)this.scrollLeft=data.left;}});
 const media=Object.assign(target(),{matches:reduce});const window=Object.assign(target(),{matchMedia:()=>media,IntersectionObserver:true});
 class Observer{constructor(fn){visibleCallback=fn;}observe(){visibleCallback([{isIntersecting:true}]);}disconnect(){}}
 const c=vm.createContext({window,document:{hidden:false},IntersectionObserver:Observer,Date:{now:()=>now},setInterval(fn){tick=fn;return 1;},clearInterval(){tick=null;},requestAnimationFrame(fn){frame=fn;return 1;},cancelAnimationFrame(){},module:{exports:{}}});vm.runInContext(source,c);
 const carousel=c.module.exports.create({viewport,axis,speed,stops:()=>stops});
 return {carousel,viewport,scrolls,media,advance(ms=12000){now+=ms;tick?.();},frame(time){frame?.(time);},visible(value){visibleCallback([{isIntersecting:value}]);}};
}
test('kloter ucapan bergerak ke bawah, dan foto bergerak ke kiri',()=>{
 const wishes=fixture('y',[1800,1200,600,0]);wishes.carousel.reset();wishes.advance();assert.equal(wishes.viewport.scrollTop,1200);wishes.advance();assert.equal(wishes.viewport.scrollTop,600);
 const photos=fixture('x',[0,460,920,1380]);photos.carousel.reset();photos.advance();assert.equal(photos.viewport.scrollLeft,460);photos.advance();assert.equal(photos.viewport.scrollLeft,920);
});
test('autoscroll berhenti ketika tidak terlihat, pengurangan gerakan aktif, atau tamu berinteraksi',()=>{
 const page=fixture('x',[0,460]);page.carousel.reset();page.visible(false);page.advance();assert.equal(page.viewport.scrollLeft,0);page.visible(true);page.viewport.listeners.wheel();page.advance(5000);assert.equal(page.viewport.scrollLeft,0);page.advance(16000);assert.equal(page.viewport.scrollLeft,460);
 const reduced=fixture('x',[0,460],true);reduced.carousel.reset();reduced.advance();assert.equal(reduced.viewport.scrollLeft,0);
 page.carousel.destroy();assert.deepEqual(Object.keys(page.viewport.listeners),[]);
});

test('continuous autoplay accumulates subpixel movement and wraps seamlessly in both directions',()=>{
 const photos=fixture('x',[0,100],false,32);photos.carousel.reset();photos.frame(1);photos.frame(17);assert.ok(photos.viewport.scrollLeft>0);for(let t=33;t<3500;t+=16)photos.frame(t);assert.ok(photos.viewport.scrollLeft<20);
 const wishes=fixture('y',[100,0],false,28);wishes.carousel.reset();wishes.frame(1);wishes.frame(17);assert.ok(wishes.viewport.scrollTop<100);for(let t=33;t<3900;t+=16)wishes.frame(t);assert.ok(wishes.viewport.scrollTop>80);
});
