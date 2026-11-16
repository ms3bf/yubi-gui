// Contact phases from the authored clip. Display time is not a predicted solve time.
export function motionAt(clip,frame){
  const rows=clip.motion;if(!rows.length)return {};
  if(frame<=rows[0].frame)return rows[0];
  if(frame>=rows.at(-1).frame)return rows.at(-1);
  let low=0,high=rows.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(rows[mid].frame<=frame)low=mid;else high=mid;}
  const a=rows[low],b=rows[high],f=(frame-a.frame)/(b.frame-a.frame),out={frame};
  for(const key of ['cube_angle','wrist_angle'])if(a[key]!=null&&b[key]!=null)out[key]=a[key]*(1-f)+b[key]*f;
  if(a.cube_layers||b.cube_layers){
    const layers=new Map();
    for(const [rows,weight] of [[a.cube_layers||[],1-f],[b.cube_layers||[],f]])for(const layer of rows){
      const key=layer.axis+':'+layer.layer;
      if(!layers.has(key))layers.set(key,{axis:layer.axis,layer:layer.layer,angle:0});
      layers.get(key).angle+=layer.angle*weight;
    }
    out.cube_layers=[...layers.values()];
  }
  return out;
}
export function turnEndFrame(clip,move){
  if(move==='REGRIP')return clip.end;
  const target=(move.includes('2')?Math.PI:Math.PI/2);
  const row=clip.motion.find(r=>{
    const angle=r.cube_angle??r.wrist_angle??Math.max(0,...(r.cube_layers||[]).map(l=>Math.abs(l.angle)));
    return Math.abs(angle)>=target-.0001;
  });
  return row?.frame??clip.end;
}
export function schedule(items,fps=24){
  const ready={R:0,L:0};let cubeReady=0;
  return items.map(({step,clip})=>{
    const reset=step.state_change==='both_thumb_transition';
    const delay=['same_finger','short_recovery','same_hand_fingers','wrist_to_finger','finger_to_wrist']
      .reduce((sum,k)=>sum+(step.cost_breakdown[k]||0),0)*.2;
    const start=Math.max(cubeReady,ready[step.hand],reset?Math.max(ready.R,ready.L):0)+delay;
    const prep=3/fps,recovery=reset?6/fps:0;
    const end=start+prep+clip.end/fps+recovery;
    const turnEnd=start+prep+turnEndFrame(clip,step.move)/fps;
    ready[step.hand]=end;
    if(reset){ready.R=end;ready.L=end;cubeReady=end;}
    else if(step.kind==='turn')cubeReady=turnEnd;
    return {start,end,prep,recovery,turnEnd,fps};
  });
}
