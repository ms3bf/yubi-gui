// Geometry is already in GUI coordinates; origin is the existing integer lattice.
import {readJSON} from './core.js';
import {unpackModelBytes} from '../assets/hand_model.js';
const assets=new Map();
export async function loadCubeModel(variant="stickered"){
 if(!["stickered","stickerless","legacy"].includes(variant))throw Error("Unknown cube style");
 let assetPromise=assets.get(variant);
  if(!assetPromise)assetPromise=(async()=>{
    const base=variant==='legacy'?'/product-assets/':'/assets/';
    const response=await fetch(variant==='legacy'?base+'cube.json':base+'speedcube_'+variant+'.json',{cache:'no-cache'});if(!response.ok)throw Error('キューブモデルを読み込めません');
    const meta=await readJSON(response,variant==='legacy'?base+'cube.json':base+'speedcube_'+variant+'.json'),r=await fetch(base+meta.binary,{cache:"no-cache"});if(!r.ok)throw Error('キューブ形状を読み込めません');
    const bytes=await unpackModelBytes(await r.arrayBuffer());
    if(bytes.byteLength!==meta.bytes)throw Error('キューブモデルのサイズが一致しません');
    return {meta,bytes};
  })().catch(error=>{assets.delete(variant);throw error;});
  assets.set(variant,assetPromise);return assetPromise;
}
export function createCubeMeshes(THREE,{meta,bytes},pitch){
  if(meta.cubies.length!==26||pitch.some((v,i)=>Math.abs(v-meta.pitch[i])>1e-6))throw Error('キューブモデルの座標定義が一致しません');
  const materials=(Array.isArray(meta.materials)?meta.materials:[{roughness:.36,metalness:0}]).map(m=>new THREE.MeshPhysicalMaterial({vertexColors:true,...m,...(Array.isArray(m.color)?{color:new THREE.Color().setRGB(...m.color)}:{})}));
  const make=c=>{
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(bytes,c.positionOffset,c.vertexCount*3),3));
    geometry.setAttribute('normal',new THREE.BufferAttribute(new Int16Array(bytes,c.normalOffset,c.vertexCount*3),3,true));
    geometry.setAttribute('color',new THREE.BufferAttribute(new Uint8Array(bytes,c.colorOffset,c.vertexCount*3).slice(),3,true));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(bytes,c.indexOffset,c.indexCount),1));
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    for(const g of c.groups||[{start:0,count:c.indexCount,materialIndex:0}])geometry.addGroup(g.start,g.count,g.materialIndex);
 const obj=new THREE.Mesh(geometry,materials);obj.userData.baseColors=geometry.attributes.color.array.slice();obj.name=c.name;obj.userData.cubeOrigin=[...c.origin];obj.position.set(...c.origin.map((v,i)=>v*pitch[i]));
    return {obj,origin:[...c.origin]};
  };
 const cubies=meta.cubies.map(make);cubies.statics=(meta.staticMeshes||[]).map(make);cubies.palette=meta.palette;return cubies;
}
