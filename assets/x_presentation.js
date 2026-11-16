// Display-only insertion: search costs, legality and saved source routes are unchanged.
export function addXPresentation(source,index){
 if(source.x_presentation)return source;
 const targets=source.moves.filter(m=>m.execution==='hold_only'&&['x',"x'"].includes(m.move));
 if(!targets.length)return source;
 const route=structuredClone(source),duration=index.duration;
 route.clip_hashes??={};route.pose_bindings??={};
 for(const id of targets.map(m=>m.id)){
  const move=route.moves.find(m=>m.id===id),t=move.start;
  const picks=Object.fromEntries(['R','L'].map(h=>{const e=index.entries.find(e=>e.side===h&&e.move===move.move&&e.from_hold===move.holds_before[h]);if(!e||e.to_hold!==move.holds_after[h])throw Error('x presentation hold mismatch');return [h,e]}));
  // Insert a real interval. Split crossing tracks so their interpolation freezes
  // during the rotation instead of accelerating or stretching an existing action.
  for(const [resource,events] of Object.entries(route.lanes)){
   const out=[];
   for(const e of events){
    if(e.start>=t){out.push({...e,start:e.start+duration,end:e.end+duration});continue;}
    if(e.end<=t){out.push(e);continue;}
    const u0=e.sample_u0??0,u1=e.sample_u1??1,u=u0+(u1-u0)*(t-e.start)/(e.end-e.start);
    out.push({...e,end:t,sample_u0:u0,sample_u1:u});
    out.push({...e,id:e.id+':after-x',start:t+duration,end:e.end+duration,sample_u0:u,sample_u1:u1});
   }route.lanes[resource]=out;
  }
  for(const m of [...route.moves,...(route.regrips||[])]){
   if(m===move)continue;
   if(m.start>=t){m.start+=duration;m.end+=duration;}else if(m.end>t)m.end+=duration;
   for(const s of m.cube_segments||[]){if(s.start>=t){s.start+=duration;s.end+=duration;}else if(s.end>t)s.end+=duration;}
  }
  for(const field of ['t_end','t_motion_end','t_task_end','t_turn_end'])if(route[field]>=t)route[field]+=duration;
  if(route.playback_start>t)route.playback_start+=duration;
  move.end=t+duration;move.presentation='authored_x_wrists';move.animation='authored';
  for(const s of move.cube_segments){s.start=t;s.end=t+duration;s.instant=false;}
  for(const h of ['R','L']){
   const e=picks[h],key=h+'.wrist',from='presentation-home-'+move.holds_before[h],to='presentation-home-'+move.holds_after[h];
   route.pose_bindings[key+':'+from]={kind:'home',key:h+'__'+move.holds_before[h]};
   route.pose_bindings[key+':'+to]={kind:'home',key:h+'__'+move.holds_after[h]};
   route.clip_hashes[e.file]=e.sha256;
   const events=route.lanes[key]||[];
   // Subsequent transfers start at the newly reached hold, not at the old
   // zero-duration operation's unchanged wrist. Authored strokes keep endpoints.
   const after=events.filter(v=>v.start>=move.end).sort((a,b)=>a.start-b.start);
   for(const next of after){
    if(next.clip)break;
    const old=next.from_pose;next.from_pose=to;
    if(next.to_pose!==old)break;
    next.to_pose=to;
   }
   events.push({id:id+':presentation:'+h,event_id:id,kind:'stroke',start:t,end:t+duration,clip:e.file,from_pose:from,to_pose:to,from_hold:move.holds_before[h],to_hold:move.holds_after[h],role:'wrist_motion',exclusive:false});
   route.lanes[key]=events;
  }
 }
 route.x_presentation=true;return route;
}
let pending;
export async function presentX(route){
 if(!route.moves.some(m=>m.execution==='hold_only'&&['x',"x'"].includes(m.move)))return route;
 pending??=fetch('/product/dist/x_presentation.json').then(r=>{if(!r.ok)throw Error('x animation index unavailable');return r.json()}).catch(e=>{pending=null;throw e});
 return addXPresentation(route,await pending);
}
