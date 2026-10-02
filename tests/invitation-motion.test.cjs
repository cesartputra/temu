const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../dist/invitation2.js'),'utf8');
const setup=source.slice(source.indexOf('function setupPageMotion(){'),source.indexOf('function setupNavigation(){'));
function element(){const classes=new Set();return {classList:{add:name=>classes.add(name),contains:name=>classes.has(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},classes};}
function mount(reduce=false){
 const cover=element(),section=element(),bow=element(),body=element();let callback,preferenceChange;
 const observed=new Set();
 class Observer{constructor(fn){callback=fn;}observe(target){observed.add(target);}unobserve(target){observed.delete(target);}}
 const reducedMotion={matches:reduce,addEventListener(type,fn){preferenceChange=fn;}};
 const context={document:{body,querySelectorAll:selector=>selector.includes('.cover-paper')?[cover,section]:[bow]},window:{IntersectionObserver:Observer},IntersectionObserver:Observer,reducedMotion};
 vm.runInNewContext(setup+'setupPageMotion();',context);
 return {cover,section,bow,body,observed,visit(target,visible){callback([{target,isIntersecting:visible}]);},preferenceChange};
}
test('illustrations and hero replay on every viewport re-entry without stopping observation',()=>{
 const page=mount();
 for(const target of [page.cover,page.section,page.bow]){
  const name=target===page.bow?'sketch-in-view':'in-view';
  page.visit(target,true);assert.equal(target.classes.has(name),true);
  page.visit(target,false);assert.equal(target.classes.has(name),false);
  page.visit(target,true);assert.equal(target.classes.has(name),true);
  assert.equal(page.observed.has(target),true);
 }
});
test('reduced motion keeps content visible and can be changed during the visit',()=>{
 const page=mount(true);assert.equal(page.body.classes.has('motion-ready'),false);
 page.preferenceChange({matches:false});assert.equal(page.body.classes.has('motion-ready'),true);
 page.preferenceChange({matches:true});assert.equal(page.body.classes.has('motion-ready'),false);
});
