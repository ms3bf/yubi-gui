import {uiText,uiHTML} from './i18n.js';
import {escapeHTML as esc, apiFetch} from './core.js';
const fingers=['index','middle','ring','thumb','pinky'];
const names={index:'人差し指',middle:'中指',ring:'薬指',thumb:'親指',pinky:'小指',wrist:'手首'};
const roleNames={driving:'駆動',supporting:'支持',repositioning:'退避・調整',anchor:'固定',wrist_motion:'手首動作',preserve:'保持拘束',regrip:'持ち替え',recovery:'回復'};
export function filterActions(rows,{hand='',move='',hold='',query=''}={}){
 const q=query.trim().toLowerCase();return rows.filter(r=>(!hand||r.hand===hand)&&(!move||r.move===move)&&(!hold||(r.hold_before===hold||r.hold_before==='*'))&&(!q||[r.key,r.action_id,r.variant,r.move].join(' ').toLowerCase().includes(q)));
}
export function eventStyle(e){return e.kind==='recovery'?'recovery':e.kind==='regrip'?'regrip':e.role||'preserve';}
const num=n=>Number(n).toFixed(2);
const holds=h=>typeof h==='object'?`右 ${h.R} / 左 ${h.L}`:h;
function card(r,max){
 const hands=r.hand==='BOTH'||r.whole_cube?['R','L']:[r.hand];
 const lanes=hands.flatMap(h=>fingers.map(f=>{
  const key=h+'.'+f,events=r.lanes[key]||[],owned=r.resources.includes(key);
  const label=r.hand==='BOTH'&&owned?(f==='wrist'?'手首動作':'保持拘束'):owned?(f==='wrist'?(h!==r.hand?'保持拘束':r.wrist_moves&&h===r.hand?'手首動作':'固定'):h!==r.hand?'保持拘束':r.driving.includes(f)?'駆動':r.supporting.includes(f)?'支持':r.repositioning.includes(f)?'退避・調整':'保持拘束'):'自由';
  return `<div class="atlas-lane"><span class="atlas-resource">${h}.${f}<small>${names[f]}</small></span><div class="atlas-track" aria-label="${esc(key+' '+label)}">${events.map(e=>{const kind=eventStyle(e),title=`${e.exclusive===false?'姿勢・拘束なし':roleNames[kind]||kind} ${num(e.start)}–${num(e.end)}${e.reason==='terminal_home'?' ホームへ戻す':''}`;return `<span class="atlas-segment atlas-${esc(kind)}" style="left:${e.start/(max||1)*100}%;width:${Math.max(0,(e.end-e.start)/(max||1)*100)}%" title="${esc(title)}"><span>${esc(e.exclusive===false?'姿勢・拘束なし':roleNames[kind]||kind)}</span></span>`;}).join('')}${!events.length?'<span class="atlas-unbound">自由 · 拘束なし</span>':''}</div></div>`;
 })).join('');
 return `<article class="atlas-card" data-action-key="${esc(r.key)}"><header><div><b class="atlas-move">${esc(r.move==='REGRIP'?'RG':r.move)}</b><span class="atlas-hand ${r.hand}">${r.hand==='BOTH'?'両手':r.hand==='R'?'右手':'左手'}</span><strong>${esc(holds(r.hand==='BOTH'?r.holds_before:r.hold_before))} → ${esc(holds(r.hand==='BOTH'?r.holds_after:r.hold_after))}</strong></div><span class="atlas-duration">動作 ${num(r.duration)}<small>戻しまで ${num(r.total)}</small></span></header><p class="atlas-technique">${esc(r.execution==='hold_only'?'キューブ回転とホールド変更 · 時間0':r.execution==='manual_both_wrists'?'両手首操作 · 接続補間による仮表示':r.variant)}${r.whole_cube?' · 両手の状態変化':''}</p><div class="atlas-axis"><span>相対時間</span><div>${[0,.25,.5,.75,1].map(u=>`<span style="left:${u*100}%">${num(u*max)}</span>`).join('')}</div></div>${lanes}<details><summary>動作ID・定義を見る</summary><dl><dt>action_id</dt><dd>${esc(r.action_id)}</dd><dt>配置キー</dt><dd>${esc(r.key)}</dd><dt>時間クラス</dt><dd>${esc(r.d_class)}</dd><dt>回転開始</dt><dd>${r.move==='REGRIP'?'対象外':num(r.drive_start)}</dd><dt>製品データ</dt><dd>${esc(r.clip)}</dd></dl><p>回復は単独動作のホーム復帰です。実際の手順では、次に使う位置へ向かう経路と時刻に変わります。</p></details></article>`;
}
if(typeof document!=='undefined'){
 const $=id=>document.getElementById(id);let data=null,loading=false,current='search',shown=[],scroll={search:0,all:0};
 const controls=['all-query','all-hand','all-move','all-hold','all-scale'];
 function render(){
  if(!data)return;shown=filterActions(data.rows,{query:$('all-query').value,hand:$('all-hand').value,move:$('all-move').value,hold:$('all-hold').value});
  uiText($('all-count'),`${shown.length} / ${data.count} 配置`);
  const common=Math.max(1,...shown.map(r=>r.total));
  uiHTML($('all-grid'),shown.map(r=>card(r,$('all-scale').value==='shared'?common:r.total)).join(''));
  uiText($('all-status'),shown.length?`${$('all-scale').value==='shared'?'全カードで共通の時間軸':'カードごとに時間軸を拡大'} · 左右・開始ホールド違いを別配置として表示`:'条件に一致する配置がありません。絞り込みを解除してください。');
  $('all-download').disabled=!shown.length;
 }
 async function load(){
  if(data||loading)return;loading=true;uiText($('all-status'),'製品の指役割と、現在のモデルの拘束レーンを読み込み中…');$('all-retry').hidden=true;
  try{const response=await apiFetch('/api/action-lanes');const result=await response.json();if(!response.ok)throw Error(result.error||'読み込みに失敗しました');data=result;
   uiHTML($('all-move'),'<option value="">すべて（持ち替え含む）</option>'+[...new Set(data.rows.map(r=>r.move))].sort().map(m=>`<option value="${esc(m)}">${esc(m==='REGRIP'?'RG（持ち替え）':m)}</option>`).join(''));render();
  }catch(e){uiText($('all-status'),e.message);$('all-retry').hidden=false;uiText($('all-count'),'読み込み失敗');}finally{loading=false;}
 }
 /* 画面タブは「手順の探索」と「全指使い一覧」の2つ。ケース一覧と保存済みは右パネルのタブ（app.js の switchPanel）。 */
 const compactScreen=window.matchMedia('(max-width:700px)');
 function activate(name){
  if(compactScreen.matches)name='search';
  scroll[current]=window.scrollY;current=name;document.body.dataset.workspace=name;
  for(const n of ['search','all']){$(n+'-workspace').hidden=n!==name;$('tab-'+n).setAttribute('aria-selected',String(n===name));$('tab-'+n).tabIndex=n===name?0:-1;}
  window.dispatchEvent(new Event('workspace-view'));window.scrollTo(0,scroll[name]);if(name==='all')load();
 }
 compactScreen.addEventListener('change',()=>{if(compactScreen.matches&&current==='all')activate('search');});
 for(const name of ['search','all']){
  $('tab-'+name).onclick=()=>activate(name);
  $('tab-'+name).onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const next=e.key==='Home'?'search':e.key==='End'?'all':name==='search'?'all':'search';activate(next);$('tab-'+next).focus();}};
 }
 for(const id of controls)$(id).addEventListener(id==='all-query'?'input':'change',render);
 $('all-reset').onclick=()=>{for(const id of ['all-query','all-hand','all-move','all-hold'])$(id).value='';render();};
 $('all-retry').onclick=load;
 $('all-download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({...data,rows:shown,count:shown.length},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='yubi-gui-action-lanes.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
}
