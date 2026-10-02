'use strict';
(function(root){
 function batches(items,size=6){const result=[];for(let i=0;i<items.length;i+=size)result.push(items.slice(i,i+size));return result;}
 function create({viewport,axis='y',stops,interval=10000,speed=0,onChange=()=>{}}){
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const cleanups=[];function listen(target,type,fn,options){target.addEventListener(type,fn,options);cleanups.push(()=>target.removeEventListener(type,fn,options));}
  let timer,visible=false,holdUntil=0,index=0,scrollFrame,autoUntil=0,animationFrame,lastFrame=0,cursor=null;
  const position=()=>axis==='y'?viewport.scrollTop:viewport.scrollLeft;
  const points=()=>stops();
  function nearest(){const values=points();return values.reduce((best,value,i)=>Math.abs(value-position())<Math.abs(values[best]-position())?i:best,0);}
  function scrollTo(i,smooth=true){const values=points();if(!values.length)return;index=(i+values.length)%values.length;cursor=values[index];autoUntil=Date.now()+1600;viewport.scrollTo({[axis==='y'?'top':'left']:values[index],behavior:smooth&&!media.matches?'smooth':'instant'});onChange(index);}
  function allowed(){return visible&&!document.hidden&&!media.matches&&Date.now()>=holdUntil&&points().length>1;}
  function tick(){if(!allowed())return;index=nearest();scrollTo(index+1);}
  function start(){clearInterval(timer);timer=setInterval(tick,interval);}
  function hold(){cursor=null;holdUntil=Date.now()+15000;}
  listen(viewport,'wheel',hold,{passive:true});listen(viewport,'touchstart',hold,{passive:true});listen(viewport,'pointerdown',hold,{passive:true});listen(viewport,'keydown',hold);
  listen(viewport,'scroll',()=>{cancelAnimationFrame(scrollFrame);scrollFrame=requestAnimationFrame(()=>{index=nearest();onChange(index);});if(Date.now()>autoUntil)hold();},{passive:true});
  const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;},{threshold:0}):null;
  if(observer)observer.observe(viewport);else visible=true;
  function refresh(){scrollTo(Math.min(index,points().length-1),false);}
  listen(window,'resize',refresh);listen(media,'change',hold);
  function animate(time){
   const elapsed=lastFrame?Math.min(time-lastFrame,50):0;lastFrame=time;
   if(allowed()){
    const values=points(),first=values[0],last=values.at(-1),direction=Math.sign(last-first);
    let next=(cursor??position())+direction*speed*elapsed/1000;
    if(direction*(next-last)>=0)next=first;cursor=next;
    autoUntil=Date.now()+1600;
    viewport.scrollTo({[axis==='y'?'top':'left']:next,behavior:'instant'});
    const current=nearest();if(current!==index){index=current;onChange(index);}
   }
   animationFrame=requestAnimationFrame(animate);
  }
  if(speed)animationFrame=requestAnimationFrame(animate);else start();
  return {reset(i=0){scrollTo(i,false);},go(i){hold();scrollTo(i);},next(){hold();scrollTo(nearest()+1);},previous(){hold();scrollTo(nearest()-1);},refresh,destroy(){clearInterval(timer);cancelAnimationFrame(scrollFrame);cancelAnimationFrame(animationFrame);observer?.disconnect();cleanups.forEach(cleanup=>cleanup());},tick};
 }
 const api={batches,create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TemuInviteScroll=api;
})(typeof window!=='undefined'?window:globalThis);
