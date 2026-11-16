// Pure product-pose compositor. Times belong to the search schedule; no rescore.
export function createProductPlayer(runtime, route, homes, clips) {
  const {sampleClip,mixNode}=runtime;
  const identity=[[1,0,0],[0,1,0],[0,0,1]];
  const clamp=x=>Math.max(0,Math.min(1,x));
  const names={thumb:'Thumb',index:'Index',middle:'Middle',ring:'Ring',pinky:'Little'};
  function endpoint(resource,signature) {
    const binding=route.pose_bindings?.[resource+':'+signature];
    if(!binding)throw Error(`姿勢の接続情報がありません: ${resource}:${signature}`);
    return binding.kind==='home'?homes[binding.key].pose:clips[binding.file][binding.endpoint];
  }
  function owns(name,hand,finger) {
    const prefix=hand==='R'?'Right':'Left';
    return finger==='wrist'?name===prefix+'Hand':name.startsWith(prefix+names[finger]);
  }
  const lanes=Object.fromEntries(Object.entries(route.lanes).map(([r,es])=>[r,es.filter(e=>['stroke','regrip','recovery','carry','manual'].includes(e.kind)).toSorted((a,b)=>a.start-b.start)]));
  function at(hand,time) {
    const pose=structuredClone(homes[hand+'__'+route.initial_holds[hand]].pose);
    let frameFrom=route.moves[0]?.cube_frame_before||identity,frameTo=frameFrom,frameProgress=0;
    for(const finger of [...Object.keys(names),'wrist']) {
      const resource=hand+'.'+finger,events=lanes[resource]||[];
      const previous=events.filter(e=>e.start<=time).at(-1),e=previous||events[0];
      if(!e)continue;
      const fraction=clamp((time-e.start)/(e.end-e.start||1));
      const u=(e.sample_u0??0)+((e.sample_u1??1)-(e.sample_u0??0))*fraction;
      let value,mask;
      if(e.clip&&['stroke','regrip'].includes(e.kind)) {
        const clip=clips[e.clip];value=sampleClip(clip,u*clip.duration);mask=clip.roles.write_mask;
      } else {
        const a=endpoint(resource,e.from_pose),b=endpoint(resource,e.to_pose);
        value={wrist:mixNode(a.wrist,b.wrist,u),joints:{}};
        for(const n of Object.keys(a.joints))if(owns(n,hand,finger))value.joints[n]=mixNode(a.joints[n],b.joints[n],u);
      }
      if(finger==='wrist') {
        if(!mask||mask.wrist)pose.wrist=value.wrist;
        frameFrom=e.from_frame||identity;frameTo=e.to_frame||frameFrom;
        // The authored whole-cube clip already includes its own rotation.
        frameProgress=e.clip&&['stroke','regrip'].includes(e.kind)?0:u;
      }
      for(const [n,node] of Object.entries(value.joints))if(owns(n,hand,finger)&&(!mask||mask.joints.includes(n)))pose.joints[n]=node;
    }
    // Product wrists are already in physical coordinates. Cube sticker-frame
    // rotations must never orbit the whole hand mesh (including old snapshots).
    return {pose,frameFrom:identity,frameTo:identity,frameProgress:0};
  }
  return {at,endpoint,owns};
}
