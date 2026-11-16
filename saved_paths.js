import {uiText,uiHTML,formatDate} from './i18n.js';
/* 保存済みは端末（localStorage）の一覧。サーバの記録は読まない。書式は app.js の MYROUTES と共有する。 */
import {escapeHTML as esc,validateRoute} from './core.js';
import {loadRoutes,addRoutes,renameRoute,deleteRoute,isRouteStorageKey} from './route_store.js';
const $=id=>document.getElementById(id);
let shown=[],selectedId=null,timer;
const day=v=>String(v||'').slice(0,10);
const when=formatDate;
function load(){try{return loadRoutes();}catch{return [];}}
function persist(action){try{return action();}catch{uiText($('saved-status'),'端末に保存できませんでした（容量不足の可能性）。JSONを書き出して保管してください。');return false;}}
function matches(entry,words){const text=((entry.name||'')+' '+(entry.alg||'')).toUpperCase();return words.every(w=>text.includes(w));}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function render(){
 const all=load(),words=$('saved-query').value.trim().toUpperCase().split(/\s+/).filter(Boolean);
 shown=all.filter(e=>matches(e,words));
 uiText($('saved-tab-count'),all.length||'');
 uiText($('saved-count'),`${shown.length} 件`);
 uiText($('saved-status'),'この端末に保存した指使い。他の端末へはJSONで書き出して読み込みます。');
 $('saved-list').after($('saved-detail'));
 uiHTML($('saved-list'),shown.map((e,i)=>`<button class="row" data-saved-index="${i}" aria-pressed="${e.id===selectedId}" data-i18n-preserve-title title="${esc(e.name||e.alg)}&#10;${esc(e.alg||'')}&#10;${esc(when(e.at))}"><span class="nm" ${e.name||e.alg?'translate="no"':''}>${esc(e.name||e.alg||'名前なし')}</span><span class="alg">${esc(e.alg||'')}</span><span class="dt">${esc(day(e.at))}</span></button>`).join('')
  ||`<p class="saved-empty">${words.length?'検索条件に一致する保存はありません。':'保存した指使いはありません。チャート上の「保存」で追加できます。'}</p>`);
 const index=shown.findIndex(e=>e.id===selectedId);
 if(index<0){selectedId=null;$('saved-detail').hidden=true;$('saved-list').after($('saved-detail'));}
 else{$('saved-detail').hidden=false;$('saved-list').querySelectorAll('button')[index].after($('saved-detail'));detail(shown[index]);}
}
function detail(entry){
 uiHTML($('saved-detail'),`<h3 ${entry.name||entry.alg?'translate="no"':''}>${esc(entry.name||entry.alg||'名前なし')}</h3>`
  +`<label>名前<input id="saved-name" maxlength="120" value="${esc(entry.name||'')}" placeholder="この指使いの名前"></label>`
  +`<button id="saved-rename">名前を保存</button><button id="saved-delete">削除</button>`
  +`<span id="saved-delete-check" hidden>この保存を削除しますか？ <button id="saved-delete-confirm">削除する</button><button id="saved-delete-cancel">キャンセル</button></span>`
  +`<p id="saved-edit-status" role="status"></p>`
  +`<p translate="no">${esc(entry.alg||'')}</p><p><time data-i18n-date datetime="${esc(entry.at||'')}">${esc(when(entry.at))}</time> · ${(entry.route?.moves||[]).length}手 · 持ち替え ${(entry.route?.regrips||[]).length}</p>`
  +`<p class="pnote">行を押すと「探索」に読み込みます。</p>`
  +`<button id="saved-export">JSONで書き出し</button>`);
 $('saved-rename').onclick=()=>{
  const name=$('saved-name').value.trim();
  if(persist(()=>renameRoute(entry.id,name))){entry.name=name;uiText($('saved-edit-status'),'名前を保存しました。');render();}
  else if(!load().some(row=>row.id===entry.id)){render();uiText($('saved-status'),'この保存は別のタブで削除されました。');}
 };
 $('saved-delete').onclick=()=>{$('saved-delete-check').hidden=false;};
 $('saved-delete-cancel').onclick=()=>{$('saved-delete-check').hidden=true;};
 $('saved-delete-confirm').onclick=()=>{
  if(persist(()=>deleteRoute(entry.id))){selectedId=null;render();}
 };
 $('saved-export').onclick=()=>download(`yubi-gui-${day(entry.at)||'route'}.json`,JSON.stringify({name:entry.name||'',alg:entry.alg||'',at:entry.at||'',route:entry.route},null,2));
}
export function importRows(data){
 const rows=Array.isArray(data)?data:[data];
 if(!rows.length)throw Error('書き出したJSON（route を含むオブジェクトまたはその配列）が必要です');
 // Validate the whole batch before generating identities or persisting anything.
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row))throw Error('書き出したJSON（route を含むオブジェクトまたはその配列）が必要です');
  validateRoute(row.route);
 }
 return rows.map(row=>({id:crypto.randomUUID(),name:String(row.name||row.alg||'読み込んだ指使い'),alg:String(row.alg||row.route.alg||''),at:typeof row.at==='string'?row.at:new Date().toISOString(),route:row.route}));
}
function importFile(file){
 const reader=new FileReader();
 reader.onload=()=>{
  try{
   const data=JSON.parse(String(reader.result));
   const rows=importRows(data);
   if(persist(()=>addRoutes(rows))){selectedId=null;render();uiText($('saved-status'),`${rows.length} 件を読み込みました。`);}
  }catch(e){uiText($('saved-status'),`読み込めません: ${e.message}`);}
 };
 reader.readAsText(file);
}
$('saved-list').onclick=e=>{
 const b=e.target.closest('[data-saved-index]');if(!b)return;
 const entry=shown[Number(b.dataset.savedIndex)];if(!entry)return;
 selectedId=entry.id;render();
 window.dispatchEvent(new CustomEvent('open-saved-route',{detail:{entry}}));
 $('tab-search').click();
};
$('saved-query').oninput=()=>{clearTimeout(timer);timer=setTimeout(render,200);};
$('saved-import').onclick=()=>$('saved-import-file').click();
$('saved-import-file').onchange=e=>{const file=e.target.files[0];if(file)importFile(file);e.target.value='';};
window.addEventListener('saved-paths-open',render);
window.addEventListener('saved-record',render);
window.addEventListener('storage',e=>{
 if(!isRouteStorageKey(e.key))return;
 const input=$('saved-name'),entry=shown.find(row=>row.id===selectedId);
 if(input&&entry&&input.value!==(entry.name||'')){
  uiText($('saved-status'),'別のタブで保存が更新されました。編集中の名前は保持しています。');return;
 }
 render();
});
render();
