import * as THREE from 'three';
import {readJSON} from './core.js';
import {presentX} from '/assets/x_presentation.js';
import {HandViewer} from '/shared/viewer.js';
import * as runtime from '/product/runtime.mjs';
import {productMath} from './product_math.js';
import {productCube,segmentFraction,rotationStages} from './product_cube.js';
import {loadCubeModel,createCubeMeshes} from './cube_model.js';
import {loadHandModel,createHandGeometry} from '/assets/hand_model.js';
import {advancePose} from '/shared/cube_pose.js';
const {segmentPose}=productCube(THREE);
import {createProductPlayer} from './product_player.js';
const math=productMath(THREE), cache=new Map();
const clamp=x=>Math.max(0,Math.min(1,x));
const json=async url=>{if(!cache.has(url))cache.set(url,fetch(url).then(async r=>{if(!r.ok)throw Error(`製品データ読込失敗: ${url}`);return readJSON(r,url);}).catch(e=>{cache.delete(url);throw e;}));return cache.get(url);};
const clipURL=file=>{if(!/^hand_library\/product\/dist\/clips\/[a-f0-9]+\.json$/.test(file))throw Error('製品クリップのパスが不正です');return '/product/dist/'+file.split('/dist/')[1];};
const verifiedClips=new Map();
async function loadClip(file,manifest,bindings,hashes){
  const entry=manifest.entries.find(e=>'hand_library/product/dist/'+e.file===file)||(hashes?.[file]?{sha256:hashes[file]}:null)||Object.values(bindings||{}).find(b=>b.file===file&&b.sha256);
  if(!entry)throw Error('製品 manifest に動作がありません: '+file);
  const key=file+':'+entry.sha256;
  if(!verifiedClips.has(key))verifiedClips.set(key,(async()=>{
    const response=await fetch(clipURL(file)+'?v='+entry.sha256);if(!response.ok)throw Error('製品クリップの読込に失敗しました');
    const bytes=await response.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==entry.sha256)throw Error('製品クリップの SHA-256 が一致しません');
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch(error){throw Error(`${clipURL(file)}: ${error.message}`);}
  })().catch(error=>{verifiedClips.delete(key);throw error;}));
  return verifiedClips.get(key);
}
const frameQ=rows=>new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(...rows[0],0,...rows[1],0,...rows[2],0,0,0,0,1));
export class ScheduleStage extends HandViewer {
  async initialize(){
    // Softer key light keeps the yellow face from washing out.
    for(const light of this.scene.children){
      if(light.isHemisphereLight)light.intensity=2.0;
      else if(light.isDirectionalLight)light.intensity=light.position.y>0?2.2:0.85;
    }
    this.rotationCaption=document.createElement('div');
    this.rotationCaption.className='rotation-caption';
    this.rotationCaption.style.cssText='position:absolute;bottom:8px;left:8px;right:8px;z-index:3;padding:6px 9px;border-radius:5px;background:#172430dc;color:white;font-size:12px;pointer-events:none';
    this.element.appendChild(this.rotationCaption);
    [this.product,this.skeleton,this.homes,this.meshData]=await Promise.all([json('/product/dist/manifest.json'),json('/product/dist/skeleton.json'),json('/product/dist/homes.json'),loadHandModel().catch(error=>{throw Error(`/assets/hand_model.bin.gz: ${error.message}`);})]);
    const skeletonBytes=await (await fetch('/product/dist/skeleton.json')).arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',skeletonBytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==this.meshData.skeleton_sha256)throw Error('表示メッシュと製品骨格の版が一致しません');
    const texture=await new THREE.TextureLoader().loadAsync('/assets/hand_texture.png');texture.colorSpace=THREE.SRGBColorSpace;this.initializationResources?.add(texture);if(this.disposed)throw Error('3D viewer is disposed');
    this.hands={};this.rigs={};this.normalGeometries={};this.handLookups={};
    for(const h of ['R','L']){
      const data=this.meshData.sides[h],{geometry:geo,lookup}=createHandGeometry(THREE,data);this.handLookups[h]=lookup;
      const shared=new THREE.BufferGeometry();shared.setAttribute('position',new THREE.BufferAttribute(new Float32Array(data.stencils.length*3),3));shared.setIndex(data.indices);this.normalGeometries[h]=shared;
      // Same material and texture for both sides. Reflection is in the product rig.
      const hand=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({map:texture,color:0xffffff,roughness:.65,side:THREE.DoubleSide}));
      hand.frustumCulled=false;this.scene.add(hand);this.hands[h]=hand;this.rigs[h]=math.rigInfo(this.skeleton.sides[h]);
    }
    const cs=this.skeleton.coordinate_system;this.center=cs.center;this.pitch=[cs.half_extent[0],cs.half_extent[2],cs.half_extent[1]].map(v=>v/1.5);this.cubies=[];
    await this.setCubeStyle(this.cubeStyle||"stickered");
    this.scene.background=new THREE.Color('#657480');this.view('right');
  }
  async setCubeStyle(style){
    this.cubeStyle=style;if(!this.pitch)return;
    const token=(this.cubeGeneration||0)+1;this.cubeGeneration=token;
    const asset=await loadCubeModel(style);if(token!==this.cubeGeneration||this.disposed)return;
    const next=createCubeMeshes(THREE,asset,this.pitch),materials=new Set();
    for(const c of [...(this.cubies||[]),...(this.cubies?.statics||[])]){this.scene.remove(c.obj);c.obj.geometry.dispose();for(const m of [].concat(c.obj.material))materials.add(m);}
    for(const m of materials)m.dispose();this.cubies=next;
    for(const c of [...next,...next.statics])this.scene.add(c.obj);
    this.draw(this.time||0);
  }
  async load(route){
    const generation=(this.generation||0)+1;this.generation=generation;this.playing=false;
    await this.ensureReady();if(this.disposed)return;
    if(!route.pose_bindings||!route.moves.every(m=>m.cube_segments))throw Error('この旧スケジュールには製品姿勢の接続情報がありません。「探索」で更新してください。');
    route=await presentX(route);
    const files=new Set([...Object.values(route.lanes).flat().map(e=>e.clip),...Object.values(route.pose_bindings).filter(b=>b.kind==='clip').map(b=>b.file)].filter(Boolean));
    const clips=Object.fromEntries(await Promise.all([...files].map(async file=>[file,await loadClip(file,this.product,route.pose_bindings,route.clip_hashes)])));
    if(generation!==this.generation||this.disposed)return;
    this.route=route;this.clips=clips;this.player=createProductPlayer(runtime,route,this.homes,clips);
    this.events=route.moves;this.cubeEvents=route.moves.flatMap(m=>m.cube_segments.map(s=>({...s,owner:m})));
    this.initialCube=this.cubies.map(c=>({pos:[...c.origin],q:new THREE.Quaternion()}));
    /* Recon：スクランブルを解いた状態から始める（route.scramble_setup の記号を順に当てる）。
       それ以外は従来どおり、全部の回転を逆に当てて「終わりが揃った状態」から逆算する。 */
    if(Array.isArray(route.scramble_setup)&&route.scramble_setup.length){for(const move of route.scramble_setup)this.initialCube=advancePose(this.initialCube,move);}
    else for(const s of [...this.cubeEvents].reverse())this.initialCube=segmentPose(this.initialCube,s,-1);
    // Membership is calculated in discrete cube states, never by rounding a partly turned layer.
    let full=this.initialCube;
    for(const s of this.cubeEvents){const axis='xyz'.indexOf(s.axis);s.members=new Set(full.map((v,i)=>s.layers.includes(Math.round(v.pos[axis]))?i:-1).filter(i=>i>=0));full=segmentPose(full,s,1,s.members);}
    this.duration=Math.max(route.t_end,...Object.values(route.lanes).flat().map(e=>e.end));this.time=route.playback_start||0;
    this.onStatus(route.moves.some(m=>m.execution==='manual_both_wrists')?'両手操作は接続補間で仮表示（専用アニメーション未収録）':'製品クリップ＋指別の戻し ／ xyzはキューブ状態にも反映');this.draw(this.time);
  }
  drawHand(hand,time){
    const state=this.player.at(hand,time),cage=math.skinCage(this.meshData.sides[hand],state.pose,this.rigs[hand]);
    const data=this.meshData.sides[hand],shared=this.normalGeometries[hand],positions=shared.attributes.position.array;
    const q=frameQ(state.frameFrom).slerp(frameQ(state.frameTo),state.frameProgress),v=new THREE.Vector3();
    for(let i=0;i<data.stencils.length;i++){
      let x=0,y=0,z=0;for(const [j,w] of data.stencils[i]){x+=cage[j][0]*w;y+=cage[j][1]*w;z+=cage[j][2]*w;}
      v.set(x-this.center[0],z-this.center[2],-(y-this.center[1])).applyQuaternion(q);v.toArray(positions,i*3);
    }
    shared.computeVertexNormals();const normals=shared.attributes.normal.array,geo=this.hands[hand].geometry;
    const lookup=this.handLookups[hand];
    for(let i=0;i<lookup.length;i++){const j=lookup[i]*3;for(let k=0;k<3;k++){geo.attributes.position.array[i*3+k]=positions[j+k];geo.attributes.normal.array[i*3+k]=normals[j+k];}}
    geo.attributes.position.needsUpdate=true;geo.attributes.normal.needsUpdate=true;
  }
  draw(time){
    this.needsRender=true;
    if(!this.player||!this.initialCube)return;
    for(const hand of ['R','L'])this.drawHand(hand,time);
    let state=this.initialCube.map(s=>({pos:[...s.pos],q:s.q.clone()}));
    for(const segment of this.cubeEvents){
      let start=segment.start;const m=segment.owner,clip=this.clips[m.clip];
      // Simple clips include authored preparation. Compound segments already carry source timings.
      if(m.cube_segments.length===1&&clip?.drive_start&&!(clip.components?.length))start=m.start+(m.end-m.start)*clip.drive_start/clip.duration;
      // A finished component can follow a partial parallel component in storage order.
      // Snapping here would deform that already partially rotated layer.
      let fraction=segmentFraction(segment,time,start);
      if(m.presentation==='authored_x_wrists')fraction=fraction*fraction*(3-2*fraction);
      if(fraction)state=segmentPose(state,segment,fraction,segment.members,false);
    }
    for(let i=0;i<this.cubies.length;i++){this.cubies[i].obj.position.set(...state[i].pos.map((v,j)=>v*this.pitch[j]));this.cubies[i].obj.quaternion.copy(state[i].q);}
    const current=this.events.filter(e=>e.start<=time).at(-1)||this.events[0];
    const phases=rotationStages(current.cube_segments);
    this.rotationCaption.replaceChildren();
    this.rotationCaption.append(document.createTextNode(`${current.move}：`));
    phases.forEach((p,i)=>{
      if(i)this.rotationCaption.append(document.createTextNode(' → '));
      const span=document.createElement('span');span.textContent=p.moves.join(' ＋ ');
      if(p.start<=time&&time<p.end)span.style.cssText='color:#ffdf76;font-weight:bold;text-decoration:underline';
      this.rotationCaption.append(span);
    });
    this.onTime({time,duration:this.duration,index:current.i});
  }
  view(name){const positions={front:[.02,1.1,3.6],right:[1.35,1.05,3.4],left:[-1.35,1.05,3.4],top:[.02,3.8,.6]};this.camera.position.set(...(positions[name]||positions.right));this.controls.target.set(0,0,0);this.controls.minDistance=1.3;this.controls.maxDistance=9;this.controls.update();}
}
