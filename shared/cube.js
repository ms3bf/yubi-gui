// Right-handed coordinates: X right, Y up, Z front. Angles are mathematical.
export function turn(move) {
  const b=move[0], s=move.slice(1);
  const defs={R:[0,1,-1],L:[0,-1,1],U:[1,1,-1],D:[1,-1,1],F:[2,1,-1],B:[2,-1,1],
    M:[0,0,1],E:[1,0,1],S:[2,0,-1],x:[0,null,-1],y:[1,null,-1],z:[2,null,-1]};
  const [axis,layer,sign]=defs[b.toUpperCase()]||defs[b];
  const wide='rludfb'.includes(b);
  const angle=sign*(s.includes("'")?-1:1)*(s.includes('2')?2:1)*Math.PI/2;
  return {axis,layer,wide,angle};
}
export function selected(position,t){return t.layer===null||position[t.axis]===t.layer||(t.wide&&position[t.axis]===0);}
export function rotate(p,axis,angle){
  const c=Math.round(Math.cos(angle)),s=Math.round(Math.sin(angle)),[x,y,z]=p;
  return axis===0?[x,c*y-s*z,s*y+c*z]:axis===1?[c*x+s*z,y,-s*x+c*z]:[c*x-s*y,s*x+c*y,z];
}
export function apply(state,move){
  const t=turn(move);return state.map(p=>selected(p,t)?rotate(p,t.axis,t.angle):[...p]);
}
