// Lossless delivery format; the decoded mesh keeps the existing JS contract.
// Some embedded browsers deliver .gz bodies without HTTP decompression.
// Inspect the bytes, not Content-Encoding (which can remain after decoding).
export async function unpackModelBytes(buffer){
 const bytes=new Uint8Array(buffer);
 if(bytes[0]!==0x1f||bytes[1]!==0x8b||bytes[2]!==0x08)return buffer;
 if(typeof DecompressionStream!=='function')throw Error('このブラウザでは圧縮モデルを解凍できません。Safariで開いてください');
 return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
export function decodeHandModel(buffer){
 const view=new DataView(buffer),length=view.getUint32(0,true);
 if(length>buffer.byteLength-4)throw Error('Invalid hand header');
 const header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));
 if(header.version!==1)throw Error('Unsupported hand format');
 const start=Math.ceil((4+length)/8)*8,cache=new Map();
 const array=id=>{if(!cache.has(id)){const b=header.blocks[id];if(!b||!['d','H'].includes(b.type))throw Error('Invalid hand block');const C=b.type==='d'?Float64Array:Uint16Array;cache.set(id,Array.from(new C(buffer,start+b.offset,b.count)));}return cache.get(id);};
 function decode(v){
  if(Array.isArray(v))return v.map(decode);
  if(v&&typeof v==='object'){
   if('$array' in v)return array(v.$array);
   if('$rows' in v){const lengths=decode(v.$rows),values=decode(v.values);let i=0;const rows=lengths.map(n=>{const row=values.slice(i,i+n);i+=n;return row});if(i!==values.length)throw Error('Invalid hand rows');return rows;}
   return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x)]));
  }return v;
 }
 return decode(header.tree);
}
let pending;
export function loadHandModel(){
 return pending??=(async()=>{const r=await fetch('/assets/hand_model.bin.gz');if(!r.ok)throw Error('手モデルの読込に失敗しました');return decodeHandModel(await unpackModelBytes(await r.arrayBuffer()));})().catch(e=>{pending=null;throw e});
}
// Preserve UV seams and existing smooth normals, sharing only identical corners.
export function createHandGeometry(T,data){
 const map=new Map(),lookup=[],uv=[],indices=[];
 for(let i=0;i<data.indices.length;i++){
  const j=data.indices[i],u=Math.fround(data.uv[i*2]),v=Math.fround(data.uv[i*2+1]),key=`${j}/${u}/${v}`;
  if(!map.has(key)){map.set(key,lookup.length);lookup.push(j);uv.push(u,v);}
  indices.push(map.get(key));
 }
 const geometry=new T.BufferGeometry();
 for(const name of ['position','normal'])geometry.setAttribute(name,new T.BufferAttribute(new Float32Array(lookup.length*3),3));
 geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geometry.setIndex(indices);
 return {geometry,lookup};
}
