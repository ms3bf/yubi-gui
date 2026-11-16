// Product pose-basis adapter. Three.js users apply skeleton rest transforms
// before these bone bases; never apply a full pose to unrelated finger nodes.
export function slerp(a,b,u) {
  let dot=a.reduce((s,x,i)=>s+x*b[i],0), q=b.slice();
  if(dot<0){dot=-dot;q=q.map(x=>-x);}
  let out;
  if(dot>.9995)out=a.map((x,i)=>x+(q[i]-x)*u);
  else {const th=Math.acos(Math.min(1,dot)), s=Math.sin(th);
    out=a.map((x,i)=>(x*Math.sin((1-u)*th)+q[i]*Math.sin(u*th))/s);}
  const n=Math.hypot(...out);return out.map(x=>x/n);
}
const lerp=(a,b,u)=>a.map((x,i)=>x+(b[i]-x)*u);
export const mixNode=(a,b,u)=>({position:lerp(a.position,b.position,u),quaternion:slerp(a.quaternion,b.quaternion,u),scale:lerp(a.scale,b.scale,u)});
export function mixPose(a,b,u){return {wrist:mixNode(a.wrist,b.wrist,u),joints:Object.fromEntries(Object.keys(a.joints).map(n=>[n,mixNode(a.joints[n],b.joints[n],u)]))};}
export function sampleClip(clip,time){
 const fs=clip.frames;if(time<=0)return structuredClone(clip.start_pose);
 if(time>=clip.duration)return structuredClone(clip.end_pose);
 let lo=0,hi=fs.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(fs[m].time<=time)lo=m;else hi=m;}
 return mixPose(fs[lo].pose,fs[hi].pose,(time-fs[lo].time)/(fs[hi].time-fs[lo].time));
}
export function applyMasked(incoming,pose,mask){
 const out=structuredClone(incoming);
 if(mask.wrist)out.wrist=structuredClone(pose.wrist);
 for(const n of mask.joints)out.joints[n]=structuredClone(pose.joints[n]);
 return out;
}
export const applyClip=(incoming,clip,time)=>applyMasked(incoming,sampleClip(clip,time),clip.roles.write_mask);
export function connect(incoming,nextClip,progress,{home=null,returnFingers=[]}={}){
 const target=applyMasked(incoming,nextClip.start_pose,nextClip.roles.write_mask);
 if(home){const prefix=nextClip.side==='R'?'Right':'Left', owned=new Set(nextClip.roles.write_mask.joints);
  for(const [n,v] of Object.entries(home.pose.joints))if(!owned.has(n)&&returnFingers.some(f=>n.startsWith(prefix+f)))target.joints[n]=structuredClone(v);}
 return mixPose(incoming,target,Math.max(0,Math.min(1,progress)));
}
