import {Quaternion,Vector3} from 'three';
import {turn,selected,rotate} from './cube.js';

const axes=[new Vector3(1,0,0),new Vector3(0,1,0),new Vector3(0,0,1)];
export function advancePose(state,move,inverse=false){
  const t=turn(move);if(inverse)t.angle*=-1;
  const q=new Quaternion().setFromAxisAngle(axes[t.axis],t.angle);
  return state.map(s=>selected(s.pos,t)
    ?{pos:rotate(s.pos,t.axis,t.angle),q:q.clone().multiply(s.q).normalize()}
    :{pos:[...s.pos],q:s.q.clone()});
}

// Keep cubie identity and sticker orientation while applying the inverse setup.
export function setupForSolution(origins,moves){
  let state=origins.map(pos=>({pos:[...pos],q:new Quaternion()}));
  for(const move of [...moves].reverse())state=advancePose(state,move,true);
  return state;
}
