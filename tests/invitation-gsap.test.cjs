const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../dist/invitation2-motion.js'),'utf8');
function mount(reduce=false){
 let callback,change,visibility;const calls=[];
 const targets=[{},{}],section={classList:{contains:()=>true},querySelectorAll:()=>targets};
 const timeline={fromTo(){return this;},restart(){calls.push('restart');},pause(){calls.push('pause');},resume(){calls.push('resume');},kill(){calls.push('kill');}};
 const gsap={timeline:()=>timeline,set(){calls.push('clear');}};
 const preference={matches:reduce,addEventListener(_,fn){change=fn;},removeEventListener(){}};
 const document={hidden:false,addEventListener(_,fn){visibility=fn;},removeEventListener(){}};
 const root={querySelectorAll:()=>[section],classList:{add(){},remove(){}}};
 const window={gsap,IntersectionObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){calls.push('disconnect');}}};
 vm.runInNewContext(source,{window,document});const motion=window.TemuInvitationMotion.setup({root,preference});
 return {calls,preference,document,motion,visit:on=>callback([{target:section,isIntersecting:on}]),change:()=>change(),visibility:()=>visibility()};
}
test('GSAP replays names on re-entry and pauses hidden tab work',()=>{
 const p=mount();p.visit(true);p.visit(false);p.visit(true);assert.equal(p.calls.filter(c=>c==='restart').length,2);
 p.document.hidden=true;p.visibility();assert.equal(p.calls.at(-1),'pause');p.document.hidden=false;p.visibility();assert.equal(p.calls.at(-1),'resume');
 p.motion.destroy();assert.ok(p.calls.includes('disconnect'));assert.ok(p.calls.includes('kill'));
});
test('reduced motion clears animated styles and can be changed while reading',()=>{
 const p=mount(true);p.visit(true);assert.ok(!p.calls.includes('restart'));assert.equal(p.calls.at(-1),'clear');
 p.preference.matches=false;p.change();assert.equal(p.calls.at(-1),'restart');p.preference.matches=true;p.change();assert.equal(p.calls.at(-1),'clear');
});
