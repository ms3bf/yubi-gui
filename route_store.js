/* Legacy arrays remain untouched. Independent records never rewrite another tab's list. */
export const LEGACY_ROUTES='fingerweight.ui-v4.routes';
export const ROUTE_PREFIX='fingerweight.ui-v5.routes.';
export const isRouteStorageKey=key=>key===LEGACY_ROUTES||key?.startsWith(ROUTE_PREFIX);
const valid=row=>row&&typeof row==='object'&&!Array.isArray(row)&&row.route;
const read=(storage,key,fallback)=>{try{return JSON.parse(storage.getItem(key)??'null')??fallback;}catch{return fallback;}};
const field=(kind,id)=>`${ROUTE_PREFIX}${kind}.${encodeURIComponent(id)}`;

export function loadRoutes(storage=localStorage){
 const legacy=read(storage,LEGACY_ROUTES,[]),rows=new Map();
 if(Array.isArray(legacy))for(const [index,row] of legacy.entries())if(valid(row)){
  const id=String(row.id??`legacy-${index}`);if(!rows.has(id))rows.set(id,{...row,id});
 }
 const batches=[];
 for(let index=0;index<storage.length;index++){
  const key=storage.key(index);if(!key?.startsWith(ROUTE_PREFIX+'add.'))continue;
  const batch=read(storage,key,null);
  if(batch?.version===1&&Array.isArray(batch.rows))batches.push({...batch,key});
 }
 batches.sort((a,b)=>a.created-b.created||a.key.localeCompare(b.key));
 let ordered=[...rows.keys()];
 for(const batch of batches)for(const row of [...batch.rows].reverse())if(valid(row)&&typeof row.id==='string'){
  // An existing identity is immutable; additions cannot replace or resurrect it.
  if(!rows.has(row.id)){rows.set(row.id,row);ordered.unshift(row.id);}
 }
 return ordered.filter(id=>!read(storage,field('delete',id),false)).map(id=>{
  const row=rows.get(id),rename=read(storage,field('name',id),null);
  return rename&&typeof rename.name==='string'?{...row,name:rename.name}:row;
 });
}

export function addRoutes(rows,storage=localStorage,uuid=()=>crypto.randomUUID()){
 if(!rows.length||rows.some(row=>!valid(row)||typeof row.id!=='string'||!row.id))throw Error('Invalid saved records');
 // One setItem is atomic even for an imported batch. Quota failure saves no prefix.
 storage.setItem(ROUTE_PREFIX+'add.'+uuid(),JSON.stringify({version:1,created:Date.now(),rows}));
 return true;
}

export function renameRoute(id,name,storage=localStorage){
 if(!loadRoutes(storage).some(row=>row.id===id))return false;
 storage.setItem(field('name',id),JSON.stringify({name}));return true;
}

export function deleteRoute(id,storage=localStorage){
 // The tombstone wins over every rename, including an overlapping stale edit.
 storage.setItem(field('delete',id),'true');
 // Deletion is already committed even if subsequent space reclamation fails.
 try{pruneDeleted(storage);}catch{}
 return true;
}

export function pruneDeleted(storage=localStorage){
 const keys=[];
 for(let index=0;index<storage.length;index++){
  const key=storage.key(index);if(key?.startsWith(ROUTE_PREFIX+'add.'))keys.push(key);
 }
 for(const key of keys){
  const batch=read(storage,key,null);if(batch?.version!==1||!Array.isArray(batch.rows))continue;
  const rows=batch.rows.filter(row=>!read(storage,field('delete',row.id),false));
  if(rows.length===batch.rows.length)continue;
  if(!rows.length)storage.removeItem(key);
  else storage.setItem(key,JSON.stringify({...batch,rows}));
  // An overlapping prune can retain hidden bytes from an older snapshot, but
  // tombstones always hide those identities; another sweep safely reclaims them.
 }
}
