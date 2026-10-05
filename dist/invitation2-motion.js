/* Local GSAP timelines: replay on viewport re-entry; no network dependency. */
(function(scope){
 'use strict';
 function setup({root,preference}){
  const gsap=scope.gsap;
  if(!root||!gsap||!scope.IntersectionObserver)return;
  const records=new Map();
  const sections=root.querySelectorAll('.cover-paper,.section,.portrait-band,footer');
  root.classList.add('gsap-ready');
  for(const section of sections){
   const hero=section.classList.contains('cover-paper');
   const targets=section.querySelectorAll(hero?'.eyebrow,h1 span,h1 em,.cover-intro,.cover-date,.cover-place,.hero-countdown':':scope > h2,:scope > .eyebrow,:scope > blockquote,.gallery-heading,.rsvp-heading,.couple-grid article,.schedule article,.venue-card,.portrait-band > div,footer > h2');
   if(!targets.length)continue;
   const timeline=gsap.timeline({paused:true});
   timeline.fromTo(targets,{opacity:0,y:hero?24:18},{opacity:1,y:0,duration:hero?1.1:.85,stagger:hero?.13:.1,ease:'power2.out',immediateRender:false});
   records.set(section,{timeline,targets,visible:false});
  }
  function settle(record){record.timeline.pause();gsap.set(record.targets,{clearProps:'opacity,transform'});}
  const observer=new scope.IntersectionObserver(entries=>{
   for(const entry of entries){
    const record=records.get(entry.target);if(!record)continue;
    record.visible=entry.isIntersecting;
    if(preference.matches){settle(record);continue;}
    if(record.visible)record.timeline.restart();
    else settle(record);
   }
  },{threshold:0,rootMargin:'0px 0px -35px 0px'});
  records.forEach((record,section)=>observer.observe(section));
  function updatePreference(){
   records.forEach(record=>{if(preference.matches||!record.visible)settle(record);else record.timeline.restart();});
  }
  preference.addEventListener('change',updatePreference);
  // Stop active animation work while the tab is hidden, resume only visible sections.
  function visibility(){records.forEach(record=>{if(document.hidden)record.timeline.pause();else if(!preference.matches&&record.visible)record.timeline.resume();});}
  document.addEventListener('visibilitychange',visibility);
  return {destroy(){observer.disconnect();records.forEach(record=>{record.timeline.kill();gsap.set(record.targets,{clearProps:'opacity,transform'});});preference.removeEventListener('change',updatePreference);document.removeEventListener('visibilitychange',visibility);root.classList.remove('gsap-ready');}};
 }
 scope.TemuInvitationMotion={setup};
})(window);
