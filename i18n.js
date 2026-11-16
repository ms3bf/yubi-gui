import {messages,errors} from './i18n_messages.js';

export const LOCALE_KEY='yubi-gui.locale.v1';
export const SUPPORTED_LOCALES=['ja','en'];
const bindings=new Set();
const nodeBindings=new WeakMap();
const pendingAttachments=new Set();
let attachmentCheckQueued=false;
const listeners=new Set();
const japanese=/[\u3040-\u30ff\u3400-\u9fff]/;
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const decode=s=>s.replace(/&#10;/g,'\n').replace(/&amp;/g,'&');
const errorPattern=new RegExp(Object.keys(errors).sort((a,b)=>b.length-a.length).map(escaped).join('|'),'g');
const shouldBind=value=>japanese.test(value)||Object.keys(errors).some(key=>value.includes(key));
const dictionary=new Map(messages.flatMap(m=>[[m.ja,m.en],[decode(m.ja),decode(m.en)]]));
// Compact score notation uses fixed semantic abbreviations, never user names.
for(const [hand,enHand] of Object.entries({右:'R',左:'L',両:'B'})){
 for(const [finger,enFinger] of Object.entries({親:'T',人:'I',中:'M',薬:'R',小:'P',腕:'W',背面指:'back',人中:'IM',薬中:'RM',薬小:'RP'}))dictionary.set(hand+finger,enHand+'·'+enFinger);
 dictionary.set('持替'+hand,'RG·'+enHand);dictionary.set('持'+hand,'RG·'+enHand);
}
dictionary.set('右 ','Right ');dictionary.set('左 ','Left ');
for(const axis of ['x','y','z'])dictionary.set('軸'+axis,'axis '+axis);
for(const face of ['U','D','F','B','R','L'])for(const [color,en] of Object.entries({白:'White',黄:'Yellow',赤:'Red',橙:'Orange',緑:'Green',青:'Blue'}))dictionary.set(face+' '+color,face+' '+en);
const patterns=messages.filter(m=>/\{\d+\}/.test(m.ja)).map(m=>{
 const keys=[];
 const parts=decode(m.ja).trim().split(/(\{\d+\})/g);
 const regex=new RegExp('^'+parts.map(p=>/^\{\d+\}$/.test(p)?(keys.push(p),'([\\s\\S]*?)'):escaped(p)).join('')+'$');
 return {...m,en:decode(m.en).trim(),regex,keys,weight:parts.filter(p=>!/^\{\d+\}$/.test(p)).join('').length};
}).sort((a,b)=>b.weight-a.weight);
// Some legacy labels are assembled from separate strings. Longer exact phrases
// take precedence; one-character finger abbreviations are never substring rules.
const fragments=[...dictionary].filter(([ja])=>!/{\d+}/.test(ja)&&ja.length>1).sort((a,b)=>b[0].length-a[0].length);
const fragmentPattern=new RegExp(fragments.map(([ja])=>escaped(ja)).join('|'),'g');
// Only known UI compositions recursively translate interpolated fragments.
// In diagnostics, quoted bad tokens, file names, and other input stay verbatim.
const composedMessages=new Set([
 '右 {0} / 左 {1}','持ち替え {0}手 {1} → {2} · {3}–{4}',
 '{5}手目の指使い {6}','止まり +{0}{1}','持替{4}',
 '候補 {0} 件{1} · 評価値と時刻は相対値',
 '{0} {1} ／ 相性評価で順位付け・再生は相対時間','{0} {1} ／ 共有リンクから表示',
 '{0}手目の直前に{1}の持ち替え → {2} を挿入しました。前の指使いを保持して再探索しました。',
 '{0}行目：{1}','スクランブルと解法 {0} 行を探索しました。{1}',
 '{0} · 左右・開始ホールド違いを別配置として表示','読み込めません: {0}',
]);
// These slots are generated UI labels; never apply these rules to user text.
const regripSlots=new Map([
 ['持ち替え {0}手 {1} → {2} · {3}–{4} · 手順上の位置: {5}',new Set(['{0}','{5}'])],
 ['RG:{0}:{1}>{2} · {3}–{4} · 手順上の位置: {5}',new Set(['{5}'])],
 ['持ち替えを{0}へ移動しました。',new Set(['{0}'])],
 ['持ち替えを{0}に固定して再探索しました。黄色は変更された指使いです。',new Set(['{0}'])],
 ['持ち替えを{0}へ移動しました。時間表示は開始時刻順のため、並びは同じです。',new Set(['{0}'])],
]);
function regripLabel(value,target,depth){
 const labels={右:'R',左:'L',両:'B',先頭:'start',末尾:'end'};
 const after=/^(\d+)手目の後$/.exec(value);if(after)return `after move ${after[1]}`;
 return labels[value]??t(value,{},target,depth);
}
let locale=initialLocale();

export function resolveLocale(saved,languages=[]){
 if(SUPPORTED_LOCALES.includes(saved))return saved;
 for(const language of languages){const base=String(language).toLowerCase().split('-')[0];if(SUPPORTED_LOCALES.includes(base))return base;}
 return 'ja';
}
function initialLocale(){
 let saved;try{saved=globalThis.localStorage?.getItem(LOCALE_KEY);}catch{}
 return resolveLocale(saved,globalThis.navigator?.languages||[globalThis.navigator?.language].filter(Boolean));
}
export const getLocale=()=>locale;
export function t(source,values={},target=locale,depth=0){
 source=String(source??'');
 if(Object.keys(values).length){
  const template=target==='ja'?source:(dictionary.get(source)??source);
  return template.replace(/\{(\d+)\}/g,(all,key)=>values[key]??all);
 }
 if(target==='ja')return source.replace(errorPattern,part=>errors[part]);
 if(!japanese.test(source))return source;
 if(dictionary.has(source))return dictionary.get(source);
 const trim=source.trim(),padding=[source.slice(0,source.indexOf(trim)),source.slice(source.indexOf(trim)+trim.length)];
 if(dictionary.has(trim))return padding[0]+dictionary.get(trim)+padding[1];
 if(depth<5)for(const pattern of patterns){
  const match=pattern.regex.exec(trim);if(!match)continue;
  const args=new Map(pattern.keys.map((key,i)=>[key,regripSlots.get(pattern.ja)?.has(key)?regripLabel(match[i+1],target,depth+1):composedMessages.has(pattern.ja)?t(match[i+1],{},target,depth+1):match[i+1]]));
  return padding[0]+pattern.en.replace(/\{\d+\}/g,key=>args.get(key)??key)+padding[1];
 }
 return source.replace(fragmentPattern,part=>dictionary.get(part)).replace(/(\d+)手(?=$|[\s·/])/g,'$1 moves');
}
export const formatDate=value=>{
 const date=new Date(value);return Number.isNaN(date.valueOf())?String(value||'—'):new Intl.DateTimeFormat(locale==='ja'?'ja-JP':'en-US',{dateStyle:'medium',timeStyle:'short'}).format(date);
};
function write(binding){
 const {node,attribute,source,date}=binding;
 const value=date?formatDate(source):t(source);
 if(attribute){if(node.getAttribute(attribute)!==value)node.setAttribute(attribute,value);}
 else if(node.nodeValue!==value)node.nodeValue=value;
}
function bind(node,source,attribute=null,date=false){
 let map=nodeBindings.get(node);if(!map){map=new Map();nodeBindings.set(node,map);}
 const key=attribute||'#text';let binding=map.get(key);
 if(!binding){binding={node,attribute,source,date};map.set(key,binding);bindings.add(binding);}
 else Object.assign(binding,{source,date});
 bindings.add(binding);
 write(binding);
 // Popup controls are bound before they are appended. Allow that synchronous
 // construction, but do not retain late async writes into a removed dialog.
 if(node.isConnected===false){
  pendingAttachments.add(binding);
  if(!attachmentCheckQueued){attachmentCheckQueued=true;queueMicrotask(()=>{
   attachmentCheckQueued=false;
   for(const pending of pendingAttachments)if(pending.node.isConnected===false){
    bindings.delete(pending);
    const map=nodeBindings.get(pending.node);if(map?.get(pending.attribute||'#text')===pending)map.delete(pending.attribute||'#text');
   }
   pendingAttachments.clear();
  });}
 }
}
const protectedSelector='[translate="no"],script,style,code,pre,textarea,.alg,.candidate-alg,.segnote .user-text';
export function localizeDOM(root=globalThis.document){
 if(!root)return;
 const visit=node=>{
  if(node.nodeType===3){if(!node.parentElement?.closest(protectedSelector)&&shouldBind(node.nodeValue||''))bind(node,node.nodeValue);return;}
  if(node.nodeType!==1&&node.nodeType!==9&&node.nodeType!==11)return;
  if(node.nodeType===1){
   if(node.matches('[translate="no"],script,style,code,pre,.alg,.candidate-alg'))return;
   for(const attr of ['title','aria-label','aria-description','aria-valuetext','placeholder'])if(!(attr==='title'&&node.hasAttribute('data-i18n-preserve-title'))&&node.hasAttribute(attr)&&shouldBind(node.getAttribute(attr)))bind(node,node.getAttribute(attr),attr);
   if(node.matches('time[data-i18n-date]')){releaseDOM(node);node.textContent='';const text=document.createTextNode('');node.append(text);bind(text,node.getAttribute('datetime'),null,true);return;}
   if(node.matches('textarea'))return;
   if(node.matches('[data-locale-select]'))node.value=locale;
  }
  for(const child of [...node.childNodes])visit(child);
 };
 visit(root);
}
function releaseDOM(root){
 for(const node of [root,...(root.querySelectorAll?.('*')||[])]){
  for(const child of [...(node.childNodes||[])]){const map=nodeBindings.get(child);if(map){for(const binding of map.values())bindings.delete(binding);nodeBindings.delete(child);}}
 }
}
export function uiRemove(node){
 if(!node)return;
 releaseDOM(node);
 const map=nodeBindings.get(node);if(map){for(const binding of map.values())bindings.delete(binding);nodeBindings.delete(node);}
 node.remove();
}
export function uiText(node,source){
 releaseDOM(node);
 node.textContent=String(source??'');localizeDOM(node);return source;
}
export function uiHTML(node,source){
 releaseDOM(node);
 node.innerHTML=String(source??'');localizeDOM(node);return source;
}
export function uiAttr(node,name,source){
 if(['title','aria-label','aria-description','aria-valuetext','placeholder'].includes(name))bind(node,String(source??''),name);
 else node.setAttribute(name,source);
 return source;
}
export function uiInsertHTML(node,position,source){node.insertAdjacentHTML(position,source);localizeDOM(node);}
export function onLocaleChange(callback){listeners.add(callback);return()=>listeners.delete(callback);}
export function setLocale(next,{persist=true}={}){
 if(!SUPPORTED_LOCALES.includes(next))return false;
 locale=next;
 try{if(persist)globalThis.localStorage?.setItem(LOCALE_KEY,next);}catch{}
 if(globalThis.document){document.documentElement.lang=next;for(const select of document.querySelectorAll('[data-locale-select]'))select.value=next;}
 for(const binding of bindings){if(binding.node.isConnected===false){bindings.delete(binding);continue;}write(binding);}
 for(const callback of listeners)callback(next);
 return true;
}
if(typeof document!=='undefined'){
 localizeDOM(document);
 document.documentElement.lang=locale;
 document.addEventListener('change',event=>{if(event.target.matches('[data-locale-select]'))setLocale(event.target.value);});
 for(const select of document.querySelectorAll('[data-locale-select]'))select.value=locale;
 window.addEventListener('storage',event=>{if(event.key===LOCALE_KEY)setLocale(resolveLocale(event.newValue,navigator.languages),{persist:false});});
}
