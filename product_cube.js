// Stable cubie membership for partially overlapping scheduled turns.
export function rotationStages(segments){
  const groups=[];
  for(const s of [...segments].sort((a,b)=>a.start-b.start||a.end-b.end)){
    let g=groups.find(g=>Math.abs(g.start-s.start)<1e-8&&Math.abs(g.end-s.end)<1e-8);
    if(!g){g={start:s.start,end:s.end,moves:[]};groups.push(g);}
    g.moves.push(s.move);
  }
  return groups;
}
export function segmentFraction(segment,time,start=segment.start){
  return segment.instant||segment.end===start ? (time>=segment.end?1:0) : Math.max(0,Math.min(1,(time-start)/(segment.end-start)));
}
export function productCube(THREE) {
function segmentPose(state,segment,fraction=1,members=null,snap=true){
  const axis='xyz'.indexOf(segment.axis),q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...[0,1,2].map(i=>i===axis?1:0)),segment.angle*fraction);
  return state.map((s,i)=>{
    if(!(members?members.has(i):segment.layers.includes(Math.round(s.pos[axis]))))return {pos:[...s.pos],q:s.q.clone()};
    const pos=new THREE.Vector3(...s.pos).applyQuaternion(q).toArray();
    return {pos:snap&&Math.abs(fraction)===1?pos.map(Math.round):pos,q:q.clone().multiply(s.q)};
  });
}
return {segmentPose};
}
