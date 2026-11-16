import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {turn,selected} from './cube.js';
import {schedule,motionAt} from './timeline.js';
import {advancePose,setupForSolution} from './cube_pose.js';

const axes=[new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)];
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const cache=new Map();
async function json(url){const r=await fetch(url);if(!r.ok)throw Error(`表示用アセットがありません: ${url}`);return r.json();}

export class HandViewer{
  constructor(element,onTime,onStatus){
    this.element=element;this.onTime=onTime;this.onStatus=onStatus;this.time=0;this.speed=1;this.playing=false;this.disposed=false;this.visible=true;this.needsRender=true;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#f0f3f5');
    this.camera=new THREE.PerspectiveCamera(35,1,0.005,100);this.camera.position.set(1.35,1.0,3.0);
    this.renderer=new THREE.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;element.appendChild(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.target.set(0,0,0);this.controls.addEventListener('change',()=>{this.needsRender=true;});
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x7f8ba0,2.4));
    const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(2,3,4);this.scene.add(light);
    const fill=new THREE.DirectionalLight(0xffffff,1);fill.position.set(-2,0,-3);this.scene.add(fill);
    this.resize=new ResizeObserver(()=>{const w=element.clientWidth,h=element.clientHeight;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);this.needsRender=true;});this.resize.observe(element);
    this.last=performance.now();this.animate=this.animate.bind(this);this.frame=requestAnimationFrame(this.animate);
  }
  async ensureReady(){
    if(this.disposed)throw Error('3D viewer is disposed');
    if(!this.ready){
      const before=new Set(this.scene.children);this.initializationResources=new Set();
      const pending=Promise.resolve().then(()=>this.initialize()).then(()=>{
        if(this.disposed){this.cleanupInitialization(before);throw Error('3D viewer is disposed');}
        this.initializationResources=null;
      }).catch(error=>{this.cleanupInitialization(before);if(this.ready===pending)this.ready=null;throw error;});
      this.ready=pending;
    }
    return this.ready;
  }
  cleanupInitialization(before){
    const resources=new Set(this.initializationResources||[]);
    for(const object of [...this.scene.children])if(!before.has(object)){
      this.scene.remove(object);
      const collect=node=>{if(node.geometry)resources.add(node.geometry);for(const material of [].concat(node.material||[])){if(material.map)resources.add(material.map);resources.add(material);}};
      if(object.traverse)object.traverse(collect);else collect(object);
    }
    for(const geometry of Object.values(this.normalGeometries||{}))resources.add(geometry);
    for(const resource of resources)resource.dispose?.();
    this.rotationCaption?.remove();this.rotationCaption=null;this.hands={};this.cubies=[];this.normalGeometries={};this.initializationResources=null;
  }
  async initialize(){
    [this.manifest,this.topology]=await Promise.all([json('/assets/manifest.json'),json('/assets/topology.json')]);
    if(this.disposed)return;
    const tex=await new THREE.TextureLoader().loadAsync('/assets/hand_texture.png');tex.colorSpace=THREE.SRGBColorSpace;this.initializationResources?.add(tex);if(this.disposed)throw Error('3D viewer is disposed');
    this.hands={};const indices=this.topology.indices.flat();this.lookup=indices;
    for(const hand of ['R','L']){
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(indices.length*3),3));
      geo.setAttribute('uv',new THREE.Float32BufferAttribute(this.topology.uv.flat(),2));
      const mat=new THREE.MeshStandardMaterial({map:tex,roughness:.65,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geo,mat);mesh.frustumCulled=false;this.scene.add(mesh);this.hands[hand]=mesh;
    }
    this.pitch=this.manifest.cube_pitch;this.cubies=[];
    const colors=['#d64b44','#ee8939','#faf9f4','#e8ce43','#3ba46b','#4a81d1'];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      if(x===0&&y===0&&z===0)continue;
      const origin=[x,y,z],materials=colors.map((c,i)=>new THREE.MeshStandardMaterial({color:origin[Math.floor(i/2)]===(i%2?-1:1)?c:'#181b20',roughness:.4}));
      const geo=new THREE.BoxGeometry(...this.pitch.map(v=>Math.abs(v)*.955));
      const obj=new THREE.Mesh(geo,materials);this.scene.add(obj);this.cubies.push({obj,origin});
    }
    this.entries=Object.fromEntries(this.manifest.entries.map(e=>[e.key,e]));this.onStatus('3D準備完了');
  }
  async clip(name){
    if(!cache.has(name))cache.set(name,(async()=>{
      const meta=this.manifest.clips[name];if(!meta)throw Error(`未出力の動作: ${name}`);
      const r=await fetch('/assets/'+meta.file);if(!r.ok)throw Error(`動作読込失敗: ${name}`);
      const data=new Int16Array(await r.arrayBuffer());
      if(data.length!==meta.frames*meta.vertices*3)throw Error('頂点数が一致しません');
      if(meta.codec==='delta16'){
        const stride=meta.vertices*3;for(let i=stride;i<data.length;i++)data[i]+=data[i-stride];
      }
      return {...meta,data};
    })());
    return cache.get(name);
  }
  async load(path){
    const generation=(this.generation||0)+1;this.generation=generation;
    await this.ensureReady();if(this.disposed)return;
    this.playing=false;this.path=path;this.onStatus('動作を読み込み中…');
    const prepared=[];
    const homes=Object.fromEntries(await Promise.all(['R','L'].map(async h=>[h,await this.clip(this.manifest.homes[path.initial_holds[h]])])));
    let current={R:{clip:homes.R,t:0},L:{clip:homes.L,t:0}};
    let state=setupForSolution(this.cubies.map(c=>c.origin),path.steps.filter(s=>s.kind==='turn').map(s=>s.move));
    const physicalSteps=path.steps.flatMap(s=>s.components?.length?s.components.map(c=>({...c,kind:'turn',compound_paths:[]})):[s]);
    const items=[];
    for(const step of physicalSteps){
      const sourceKey=step.key.replace(/^LH__/,'');const entry=this.entries[sourceKey];
      if(!entry)throw Error(`Hand Libraryとの接続がありません: ${step.key}`);
      const clip=await this.clip(entry.name);
      items.push({step,clip});
    }
    const times=schedule(items);
    for(let index=0;index<items.length;index++){
      const {step,clip}=items[index],reset=step.state_change==='both_thumb_transition';
      const home=reset?await this.clip(this.manifest.homes.F):null;
      prepared.push({step,clip,...times[index],home,before:{...current},cube:state.map(s=>({pos:[...s.pos],q:s.q.clone()}))});
      current={...current,[step.hand]:{clip,t:clip.end}};
      if(reset)current={R:{clip:home,t:0},L:{clip:home,t:0}};
      if(step.kind==='turn'){
        state=advancePose(state,step.move);
      }
    }
    if(generation!==this.generation||this.disposed)return;
    this.events=prepared;this.duration=Math.max(0,...prepared.map(e=>e.end));this.time=0;this.onStatus('逆手順で準備した状態から、完成まで再生します');this.draw(0);
  }
  sample(clip,t,index){
    const f=clip.end>0?Math.max(0,Math.min(clip.frames-1,t/clip.end*(clip.frames-1))):0,a=Math.floor(f),b=Math.min(a+1,clip.frames-1),v=f-a;
    return (clip.data[a*clip.vertices*3+index]*(1-v)+clip.data[b*clip.vertices*3+index]*v)*clip.scale;
  }
  sampleState(clip,t){
    const f=clip.end>0?Math.max(0,Math.min(clip.frames-1,t/clip.end*(clip.frames-1))):0,a=Math.floor(f),b=Math.min(a+1,clip.frames-1),v=f-a;
    return {data:clip.data,a:a*clip.vertices*3,b:b*clip.vertices*3,wa:(1-v)*clip.scale,wb:v*clip.scale};
  }
  rootTransform(clip,t){
    const f=clip.end>0?Math.max(0,Math.min(clip.frames-1,t/clip.end*(clip.frames-1))):0,i=Math.floor(f),j=Math.min(i+1,clip.frames-1),v=f-i;
    const a=clip.transforms[i],b=clip.transforms[j];
    return {p:new THREE.Vector3().fromArray(a.p).lerp(new THREE.Vector3().fromArray(b.p),v),
      q:new THREE.Quaternion().fromArray(a.q).slerp(new THREE.Quaternion().fromArray(b.q),v),
      s:new THREE.Vector3().fromArray(a.s).lerp(new THREE.Vector3().fromArray(b.s),v)};
  }
  handPose(hand,a,b,t,blend){
    const attr=this.hands[hand].geometry.attributes.position,out=attr.array;
    let ma=null,mb=null;
    if(blend>0&&blend<1&&a.clip.transforms&&b.transforms){
      const ra=this.rootTransform(a.clip,a.t),rb=this.rootTransform(b,t);
      const arc=new THREE.Quaternion().setFromUnitVectors(ra.p.clone().normalize(),rb.p.clone().normalize());
      const p=ra.p.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(arc,blend)).multiplyScalar(THREE.MathUtils.lerp(ra.p.length(),rb.p.length(),blend));
      const mid=new THREE.Matrix4().compose(p,ra.q.clone().slerp(rb.q,blend),ra.s.clone().lerp(rb.s,blend));
      ma=mid.clone().multiply(new THREE.Matrix4().compose(ra.p,ra.q,ra.s).invert()).elements;
      mb=mid.clone().multiply(new THREE.Matrix4().compose(rb.p,rb.q,rb.s).invert()).elements;
    }
    const sa=this.sampleState(a.clip,a.t),sb=this.sampleState(b,t);
    if(!this.scratch)this.scratch=new Float32Array(this.topology.vertices*3);
    const tmp=this.scratch;
    for(let k=0;k<tmp.length;k+=3){
      const ax=sa.data[sa.a+k]*sa.wa+sa.data[sa.b+k]*sa.wb,ay=sa.data[sa.a+k+1]*sa.wa+sa.data[sa.b+k+1]*sa.wb,az=sa.data[sa.a+k+2]*sa.wa+sa.data[sa.b+k+2]*sa.wb;
      const bx=sb.data[sb.a+k]*sb.wa+sb.data[sb.b+k]*sb.wb,by=sb.data[sb.a+k+1]*sb.wa+sb.data[sb.b+k+1]*sb.wb,bz=sb.data[sb.a+k+2]*sb.wa+sb.data[sb.b+k+2]*sb.wb;
      for(let j=0;j<3;j++){
        const x=ma?ma[j]*ax+ma[4+j]*ay+ma[8+j]*az+ma[12+j]:(j===0?ax:j===1?ay:az);
        const y=mb?mb[j]*bx+mb[4+j]*by+mb[8+j]*bz+mb[12+j]:(j===0?bx:j===1?by:bz);
        let v=x*(1-blend)+y*blend;if(hand==='L'&&j===0)v=-v;tmp[k+j]=v;
      }
    }
    for(let i=0;i<this.lookup.length;i++){const k=this.lookup[i]*3;out[i*3]=tmp[k];out[i*3+1]=tmp[k+1];out[i*3+2]=tmp[k+2];}
    attr.needsUpdate=true;this.hands[hand].geometry.computeVertexNormals();
  }
  draw(time){
    this.needsRender=true;
    if(!this.events?.length)return;
    for(const h of ['R','L']){
      const event=this.events.filter(e=>e.start<=time&&(e.step.hand===h||(e.recovery&&time>=e.end-e.recovery))).at(-1);
      if(!event){const old=this.events[0].before[h];this.handPose(h,old,old.clip,old.t,0);continue;}
      const old=event.before[h],local=Math.max(0,time-event.start),ct=Math.max(0,Math.min(event.clip.end,(local-event.prep)*event.fps));
      if(event.recovery&&time>event.end-event.recovery){
        const from=h===event.step.hand?{clip:event.clip,t:event.clip.end}:old;
        this.handPose(h,from,event.home,0,smooth((time-event.end+event.recovery)/event.recovery));
      }else this.handPose(h,old,event.clip,ct,smooth(local/event.prep));
    }
    const ev=this.events.filter(e=>e.start<=time&&e.step.kind==='turn').at(-1)||this.events[0];
    const local=Math.max(0,time-ev.start),ct=Math.max(0,Math.min(ev.clip.end,(local-ev.prep)*ev.fps));
    const motion=motionAt(ev.clip,ct);
    const isTurn=ev.step.kind==='turn',t=isTurn?turn(ev.step.move):null;
    if(t&&ev.step.move.includes('2')){
      if(ev.step.direction)t.angle*=ev.step.direction;
      else if(ev.step.finger==='wrist'&&ev.step.variant.includes('CCW'))t.angle*=-1;
      else if(motion.cube_angle){
        // Signed clip angles use Blender axes (X right, Y back, Z up).
        const convert=t.axis===2?-1:1,reflection=ev.step.hand==='L'&&t.axis!==0?-1:1;
        t.angle=Math.sign(motion.cube_angle)*convert*reflection*Math.abs(t.angle);
      }
    }
    let frac=0;
    if(t){
      const total=Math.abs(t.angle),angle=motion.cube_angle??motion.wrist_angle??0;
      frac=Math.min(1,Math.abs(angle)/total);
      if(motion.cube_layers){frac=Math.min(1,Math.max(...motion.cube_layers.map(l=>Math.abs(l.angle)),0)/total);}
    }
    for(let i=0;i<this.cubies.length;i++){
      const c=this.cubies[i],s=ev.cube[i];let q=new THREE.Quaternion();
      // Composite R/r clips retain intermediate component angles. Same-axis layers commute.
      if(isTurn&&ev.step.compound_paths?.length&&motion.cube_layers){
        let angle=0;
        for(const l of motion.cube_layers){const axis=[0,2,1][l.axis],layer=l.axis===1?-l.layer:l.layer;
          if(s.pos[axis]===layer)angle+=l.angle*(l.axis===1?-1:1)*(ev.step.hand==='L'?-1:1);
        }
        // Mirror changes X-layer sign as well as angle about Y/Z (X angle is unchanged).
        if(ev.step.hand==='L'){
          angle=0;for(const l of motion.cube_layers){const axis=[0,2,1][l.axis],layer=(l.axis===1?-l.layer:l.layer)*(axis===0?-1:1);
            if(s.pos[axis]===layer)angle+=l.angle*(l.axis===1?-1:1)*(axis===0?1:-1);
          }
        }
        q.setFromAxisAngle(axes[t.axis],angle);
      }else if(t&&selected(s.pos,t))q.setFromAxisAngle(axes[t.axis],t.angle*frac);
      c.obj.position.set(...s.pos.map((v,j)=>v*Math.abs(this.pitch[j]))).applyQuaternion(q);
      c.obj.quaternion.copy(q).multiply(s.q);
    }
    const highlighted=this.events.filter(e=>e.start<=time).at(-1)||this.events[0];
    this.onTime({time,duration:this.duration,index:highlighted.step.index});
  }
  seek(time){this.time=Math.max(0,Math.min(this.duration||0,time));this.draw(this.time);}
  animate(now){
    const dt=Math.min(.1,(now-this.last)/1000);this.last=now;
    if(this.playing){this.time=Math.min(this.duration,this.time+dt*this.speed);this.draw(this.time);if(this.time>=this.duration)this.playing=false;}
    if(this.disposed)return;
    if(this.visible!==false&&!globalThis.document?.hidden){
      const changed=this.controls.update();
      if(this.needsRender||changed||this.playing){this.renderer.render(this.scene,this.camera);this.needsRender=false;}
    }
    this.frame=requestAnimationFrame(this.animate);
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.resize.disconnect();this.controls.dispose();this.renderer.dispose();this.element.replaceChildren();}
}
