import {loadRoutes,addRoutes} from './route_store.js';
import {uiText,uiHTML,uiAttr,uiInsertHTML,uiRemove,t} from './i18n.js';
import {presentX} from '/assets/x_presentation.js';
import {ScheduleStage} from './stage.js';
import {escapeHTML as esc, clone, tag, RESOURCES, rowFor, enrich, validateRoute, filterRoutes, diverse, formatScore, normalizeInput, stepTarget, apiFetch, engineStatus, engineReady, readJSON, shareTable, encodeShareCode, decodeShareCode, shareCodeFrom, shareRequest, SHARE_KEY, expandAndSimplify, continuationState, actionMatchesToken} from './core.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const TEST=new URLSearchParams(location.search).get('test')==='1';
const VERSION='ui-v3-product.4', STORAGE='fingerweight.ui-v3.session.1'+(TEST?'.test':'');
let saved={};try{saved=JSON.parse(localStorage.getItem(STORAGE)||'{}');}catch{}
let state={session:crypto.randomUUID(),selected:0,pins:[],exclude:[],history:[],queue:[],queueIndex:0,prefix:null, ...saved};
state.history=[];state.redo=[];
let editBusy=false;
/* 除外リストと判断の記録は廃止。/api/search には常に exclude:[] を送り、保存は端末内だけに残す。 */
state.exclude=[];for(const key of ['records','outbox','compare','stars','by'])delete state[key];
/* 表示設定の記憶。v5 で初期値を作り直したのでキーを上げる（保存した指使い fingerweight.ui-v4.routes は触らない）。
   表示時間は「選好補正」に固定した（切り替えの選択肢は撤去）。
   新しい既定：開始ホールドは左右とも自由、尺度は等間隔、再生の間合いも等間隔、速度は 1×（実効は旧2×）、表示時間は選好補正、キューブは cube.bin に焼いてある見た目のまま（黄U・緑F）。 */
const LAYOUT_KEY='fingerweight.ui-v5.layout';
const layout={pw:396,ch:330,collapsed:false,scale:'even',timeMode:'preference',panelTab:'cand',diff:true,speed:1,cubeU:'yellow',cubeF:'green',cubeStyle:'stickered'};
let storedLayout=null;try{storedLayout=JSON.parse(localStorage.getItem(LAYOUT_KEY)||'null');}catch{}
const freshLayout=!storedLayout||typeof storedLayout!=='object';
/* 既定のチャート幅を作り直したので、以前の版が書き残したズーム倍率だけは捨てる（保存した指遣いには触れない）。 */
if(storedLayout&&typeof storedLayout==='object'){delete storedLayout.zoom;delete storedLayout.chartZoom;}
if(!freshLayout)Object.assign(layout,storedLayout);
layout.timeMode='preference';delete layout.showUnused;delete layout.pace;/* 撤去した設定は残さない。 */
function saveLayout(){try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layout));}catch{}}
const HOLD_VALUES=['auto','F','U','D','B_CW','B_CCW'];
function readStartHolds(){const out={};for(const hand of ['R','L']){const on=document.querySelector(`.holdrow.${hand} .hbtn[aria-pressed="true"]`);out[hand]=HOLD_VALUES.includes(on?.dataset.hold)?on.dataset.hold:'auto';}return out;}
function setStartHold(hand,value){for(const button of $$(`.holdrow.${hand} .hbtn`)){const on=button.dataset.hold===value;button.setAttribute('aria-pressed',String(on));button.classList.toggle('on',on);}}
for(const hand of ['R','L']){
 const value=freshLayout?'auto':(state.startHolds?.[hand]||'auto');
 setStartHold(hand,HOLD_VALUES.includes(value)?value:'auto');
 for(const button of $$(`.holdrow.${hand} .hbtn`))button.onclick=()=>{setStartHold(hand,button.dataset.hold);state.startHolds=readStartHolds();persist();};
}
if(freshLayout){state.startHolds=readStartHolds();saveLayout();}
/* チャートの既定幅。ズームは1段 ×1.25 / ÷1.25（＝×0.8）。
   等間隔は1手あたりの幅を、もとの 72/26px より1段ぶん広く（PC 91px、スマホ 33px）。
   時間尺度は広すぎたので基準の「相対時間1あたりの幅」を2段ぶん狭くする（PC 1180→755px、スマホ 620→397px）。
   ズームはこの基準に対する倍率で、+ − はこれまでどおり効く。 */
const ZOOM_STEP=1.25;
const EVEN_SLOT_PC=91, EVEN_SLOT_M=33;
const TIME_SPAN_PC=Math.round(1180/(ZOOM_STEP*ZOOM_STEP)), TIME_SPAN_M=Math.round(620/(ZOOM_STEP*ZOOM_STEP));
let zoom=1,playUntil=null;
const narrowScreen=()=>matchMedia('(max-width:700px)').matches;
let catalog, fixtures, bank=[], routes=[], route, stage, selected=0, selectedLane=null, lastEnd=null, applying=false;
let loadingGeneration=0, searchBusy=false;
let searchRequest=null;
const holdText=h=>typeof h==='object'?`右 ${h.R} / 左 ${h.L}`:h;
const number=n=>Number(n).toFixed(2);
let displayPlan=null,pacePlan=null;
const displayCache=new Map();
function shownRoute(){return pacePlan||displayPlan||route;}
async function prepareDisplay(next){
  if(layout.timeMode==='base'||next.provenance==='synthetic-preview'||next.origin){
    return next;
  }
  const key=JSON.stringify([next.model_version,next.alg,next.path,next.initial_holds]);
  if(!displayCache.has(key)){
    const response=await apiFetch('/api/display-schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alg:next.alg,path:next.path,initial_holds:next.initial_holds})});
    const result=await readJSON(response,'/api/display-schedule');if(!response.ok)throw Error(result.error||'表示補正に失敗');
    if(displayCache.size>=64)displayCache.delete(displayCache.keys().next().value);
    displayCache.set(key,result);
  }
  const result=displayCache.get(key);
  return enrichWarped({...next,...result.display,id:next.id,preference_score:next.preference_score,display_adjustments:result.adjustments,time_warped:false},catalog.rows);
}
const displayEnd=p=>Math.max(.01,p.t_end,...Object.values(p.lanes).flat().map(e=>e.end));

/* ── 再生速度。表示ラベルの2倍を実効速度にする（1× が旧2×、2× はその倍） ── */
const SPEED_BASE=2;
function applySpeed(label){
  if(recording){cancelRecording();return;}
  /* '実時間'（recon）は「相対時間の合計 ÷ 入力したタイム」を倍率にして、再生が実際のタイムと同じ長さになるようにする。 */
  const real=label==='real'&&reconOn();
  const value=real?'real':(Number(label)>0?Number(label):1);
  layout.speed=value;saveLayout();
  if(stage)stage.speed=real?(reconRealFactor()??SPEED_BASE):value*SPEED_BASE;
  for(const button of $$('#main-speeds button,#m-speeds button'))button.classList.toggle('active',button.dataset.speed===String(value));
}

/* ── キューブの配色。U面とF面を決めると24通りの向きのうち1つに定まる ── */
const CUBE_FACES=['U','D','F','B','R','L'];
const CUBE_NAME={white:'白',yellow:'黄',red:'赤',orange:'橙',green:'緑',blue:'青'};
const CUBE_OPPOSITE={white:'yellow',yellow:'white',red:'orange',orange:'red',green:'blue',blue:'green'};
/* 標準配色：白の裏が黄、赤の裏が橙、緑の裏が青。U=白・F=緑 のとき R=赤（この1点で鏡像が決まる）。 */
const CUBE_BASE={U:'white',D:'yellow',F:'green',B:'blue',R:'red',L:'orange'};
const rotateX=m=>({U:m.F,F:m.D,D:m.B,B:m.U,R:m.R,L:m.L});
const rotateY=m=>({U:m.U,D:m.D,F:m.R,R:m.B,B:m.L,L:m.F});
const CUBE_SCHEMES=(()=>{
  const key=m=>CUBE_FACES.map(f=>m[f]).join('/'),seen=new Set([key(CUBE_BASE)]),all=[CUBE_BASE];
  for(let i=0;i<all.length;i++)for(const rotate of [rotateX,rotateY]){
    const next=rotate(all[i]),id=key(next);
    if(!seen.has(id)){seen.add(id);all.push(next);}
  }
  return all;
})();
function schemeFor(up,front){return CUBE_SCHEMES.find(m=>m.U===up&&m.F===front)||null;}
function validFronts(up){return Object.keys(CUBE_NAME).filter(v=>v!==up&&v!==CUBE_OPPOSITE[up]);}
function currentScheme(){return schemeFor(layout.cubeU,layout.cubeF)||schemeFor(CUBE_BASE.U,CUBE_BASE.F);}
/* 3Dのキューブは cube.bin に焼いた頂点色で描いている（stage.js は変えない）。焼いてある6色は
   U=黄 D=白 F=緑 B=青 R=橙 L=赤 の並びなので、その色そのものを6色の絵の具として使い、面ごとに読み替える。
   既定（黄U・緑F）では元の頂点色をそのまま書き戻すので、見た目は従来と1バイトも変わらない。 */
const CUBE_BAKED=[['255,39,0','R'],['170,0,0','L'],['255,171,0','U'],['255,255,255','D'],['32,184,2','F'],['6,31,255','B']];
const CUBE_BAKED_SCHEME={R:'orange',L:'red',U:'yellow',D:'white',F:'green',B:'blue'};
const CUBE_PAINT=Object.fromEntries(CUBE_BAKED.map(([bytes,face])=>[CUBE_BAKED_SCHEME[face],bytes.split(',').map(Number)]));
let bakedCubeColors=null;
function paintCube(){
  const cubies=stage?.cubies;
  if(!Array.isArray(cubies)||!cubies.length)return;
  try{
    if(!bakedCubeColors)bakedCubeColors=cubies.map(c=>{const a=c.obj?.geometry?.getAttribute?.('color');return a?Uint8Array.from(a.array):null;});
    const scheme=currentScheme(),replacement={};
    const palette=cubies.palette;
    const baked=palette?Object.entries(palette).map(([f,c])=>[c.join(','),f]):CUBE_BAKED;
    const paint=palette?Object.fromEntries(Object.entries(palette).map(([f,c])=>[CUBE_BAKED_SCHEME[f],c])):CUBE_PAINT;
    for(const [source,face] of baked)replacement[source]=paint[scheme[face]]||null;
    for(let k=0;k<cubies.length;k++){
      const attribute=cubies[k].obj?.geometry?.getAttribute?.('color'),base=cubies[k].obj.userData.baseColors||bakedCubeColors[k];
      if(!attribute||!base||attribute.array.length!==base.length)continue;
      const out=attribute.array;
      for(let i=0;i<base.length;i+=3){
        const hit=replacement[base[i]+','+base[i+1]+','+base[i+2]]||null;
        out[i]=hit?hit[0]:base[i];out[i+1]=hit?hit[1]:base[i+1];out[i+2]=hit?hit[2]:base[i+2];
      }
      attribute.needsUpdate=true;
    }
    stage.needsRender=true;
  }catch(error){console.warn('cube colors',error);}
}

/* ── 回転（x・y・z）の表示時間 ──
   探索が出す時刻では y・y'・y2 が約3.5秒（普通の一手の3倍以上）で、再生が止まって見える。
   これは単調な区分線形写像で「普通の一手の長さの中央値」へ縮める（前後の時刻もまとめてずらす）。

   x・x' は別物で、`execution:'hold_only'`・`resources:[]`・`cube_segments:[]` の長さ0。
   記法の読み替えだけなので、**この動作そのものには手の動きが1つも入っていない**（キューブも回らない）。
   ここへ時間を差し込むと、ただの無音区間が増えるだけになる。そこで x には時間を差し込まず、
   すでに動いている区間（同時刻に走る持ち替えのクリップ、または直前のストローク）の中へ
   「最短の一手」ぶんの幅を置く。持ち替えはスケジュールどおりの長さのまま動き、全体の尺も変わらない。
   評価値（cost・preference_score）と順位は触らない。元の時刻は route.schedule_times に残す。 */
const ROTATION=/^[xyz]/;
const WARP_EPS=1e-6;
const moveToken=m=>String(m?.input_move||m?.move||m?.row?.move||'');
function warpRoute(source){
  if(!source||source.time_warped)return source;
  if(!Array.isArray(source.moves)||!source.moves.some(m=>ROTATION.test(moveToken(m)))){return {...source,time_warped:true,continuation_state_version:1};}
  const route=clone(source);
  const plain=route.moves.filter(m=>!ROTATION.test(moveToken(m))).map(m=>(+m.end||0)-(+m.start||0)).filter(d=>d>1e-9).sort((a,b)=>a-b);
  const middle=plain.length?(plain.length%2?plain[(plain.length-1)/2]:(plain[plain.length/2-1]+plain[plain.length/2])/2):0.35;
  const shortest=plain.length?plain[0]:0.2;
  const spans=[];
  for(const m of route.moves.filter(m=>ROTATION.test(moveToken(m))).sort((a,b)=>(+a.start||0)-(+b.start||0))){
    const start=+m.start||0,end=+m.end||start;
    /* 長さ0の回転（x・x'）は写像では扱わない。時刻をずらさず、あとで置き場所だけ決める。 */
    if(end-start<WARP_EPS)continue;
    const want=moveToken(m)[0]==='x'?shortest:middle;
    if(spans.length&&start<spans[spans.length-1].end)continue;
    if(Math.abs((end-start)-want)<1e-9)continue;
    spans.push({start,end,want});
  }
  route.schedule_times={t_end:route.t_end,t_turn_end:route.t_turn_end,t_task_end:route.t_task_end,t_motion_end:route.t_motion_end,playback_start:route.playback_start};
  if(spans.length)applyTimeMap(route,spans);
  placeInstantRotations(route,shortest);
  /* レーンの回復の尻尾は元から t_end より後ろにあり（t_motion_end）、chart と stage は displayEnd() で見ている。
     ここで t_end に混ぜると回転のある経路だけ値が伸びるので、手と持ち替えの終端だけで押し上げる。 */
  route.t_end=Math.max(+route.t_end||0,...route.moves.map(m=>m.end),...(route.regrips||[]).map(r=>r.end));
  route.time_warped=true;route.continuation_state_version=1;
  return route;
}
/* 長さ0の回転に、時間を差し込まずに表示上の幅を与える。
   ・その瞬間をまたいで動いているもの（持ち替えのクリップなど）があれば、その中に前向きに置く。
   ・無ければ、その瞬間で終わる動き（直前のストローク）の末尾に後ろ向きに置く。
   ・どちらも無ければ（実データでは出ていない）そこだけ伸ばす。
   持ち替えの開始・終了は動かさないので、同時刻の持ち替えが潰れることも押し出されることもない。 */
function placeInstantRotations(route,target){
  const kinds=['stroke','regrip','recovery','carry','manual'];
  const motion=[...(route.regrips||[]),
    ...route.moves.filter(m=>!ROTATION.test(moveToken(m))&&(+m.end||0)-(+m.start||0)>WARP_EPS),
    ...Object.values(route.lanes||{}).filter(Array.isArray).flat().filter(e=>kinds.includes(e.kind))]
    .filter(e=>Number.isFinite(e.start)&&Number.isFinite(e.end));
  for(const m of route.moves){
    if(!ROTATION.test(moveToken(m)))continue;
    const at=+m.start||0;
    if((+m.end||at)-at>=WARP_EPS)continue;
    const across=motion.filter(e=>e.start<=at+1e-9&&e.end>at+1e-9);
    const before=motion.filter(e=>e.end>=at-1e-9&&e.start<at-1e-9);
    if(across.length){m.start=at;m.end=Math.min(at+target,Math.max(...across.map(e=>e.end)));}
    else if(before.length){
      /* 直前の持ち替えより前へは出さない。holdsAt() が持ち替えの前後関係を start で見ているため。 */
      const floor=Math.max(Math.min(...before.map(e=>e.start)),...(route.regrips||[]).filter(r=>r.end<=at+1e-9).map(r=>r.end),-Infinity);
      m.end=at;m.start=Math.max(at-target,floor);
    }
    else{m.start=at;m.end=at+target;}
    if(m.end-m.start<1e-9)m.end=m.start+target;
  }
}
/* 単調な区分線形写像。B は非減少、T も非減少。B[0] より前は素通し、最後の区切りより後ろは平行移動。 */
function timeMapper(B,T){
  const tail=T[T.length-1]-B[B.length-1];
  return t=>{
    if(!Number.isFinite(t))return t;
    if(t<=B[0])return t;
    for(let i=1;i<B.length;i++)if(t<=B[i])return B[i]>B[i-1]?T[i-1]+(t-B[i-1])/(B[i]-B[i-1])*(T[i]-T[i-1]):T[i];
    return t+tail;
  };
}
function applyTimeMap(route,spans){
  const B=[],T=[];let shift=0;
  for(const span of spans){
    B.push(span.start);T.push(span.start+shift);
    shift+=span.want-(span.end-span.start);
    B.push(span.end);T.push(span.end+shift);
  }
  remapRoute(route,timeMapper(B,T));
}
function remapRoute(route,map){
  for(const field of ['t_end','t_turn_end','t_task_end','t_motion_end','playback_start','origin'])if(Number.isFinite(route[field]))route[field]=map(route[field]);
  // end_state is the physical continuation contract, never a display clock.
  const shiftEvent=event=>{
    const start=map(+event.start||0),end=map(Math.max(+event.end||0,+event.start||0));
    if(Number.isFinite(event.wait))event.wait=Math.max(0,start-map((+event.start||0)-event.wait));
    if(event.resource_wait&&typeof event.resource_wait==='object')
      for(const key of Object.keys(event.resource_wait))event.resource_wait[key]=Math.max(0,start-map((+event.start||0)-(+event.resource_wait[key]||0)));
    if(event.ready_times&&typeof event.ready_times==='object')
      for(const key of Object.keys(event.ready_times))if(Number.isFinite(event.ready_times[key]))event.ready_times[key]=map(event.ready_times[key]);
    for(const segment of event.cube_segments||[]){
      const s=map(+segment.start||0),e=map(Math.max(+segment.end||0,+segment.start||0));
      segment.start=s;segment.end=e;
      if(Number.isFinite(segment.offset))segment.offset=s-start;
      if(Number.isFinite(segment.finish))segment.finish=e-start;
    }
    event.start=start;event.end=end;
  };
  for(const m of route.moves)shiftEvent(m);
  for(const r of route.regrips||[])shiftEvent(r);
  for(const events of Object.values(route.lanes||{}))if(Array.isArray(events))for(const e of events)shiftEvent(e);
}
const enrichWarped=(route,rows)=>enrich(warpRoute(route),rows);
/* ── 等間隔再生 ──
   譜面の「等間隔」と同じスロットで時間を引き直す。1手＝1スロット、持ち替えも1スロット
   （selectionIntervals がそのまま使える）。スロットの幅は D＝その経路の回転以外の手の長さの
   中央値（取れなければ 0.5）。スロットの中は「動き share・間 1-share」の一定比で割るので、
   どの手・どの持ち替えも同じ長さ share*D になる。スロットに入らない空き（キューブが止まって
   いる区間）はその比に押し込まれて潰れる。
   スロットの境目は譜面の等間隔の境目と同じ時刻に来るので、再生ヘッドは一定の速さで譜面を横切る。
   実時間（x・y・z 補正後）は route.schedule_times.real に数値の列として控える。経路そのものは
   複製してから書き換えるので、実時間へ戻すと元の値に完全に一致する。 */
const PACE_SHARE_MIN=0.35;
const median=list=>{const v=[...list].sort((a,b)=>a-b);if(!v.length)return 0;return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
/* 時刻フィールドを決まった順に並べる。控えを経路の複製ではなく数値の列にして、保存を太らせない。 */
function timeSlots(route){
  const slots=[],num=(obj,key)=>{if(obj&&Number.isFinite(obj[key]))slots.push([obj,key]);};
  for(const field of ['t_end','t_turn_end','t_task_end','t_motion_end','playback_start','origin'])num(route,field);
  num(route.end_state,'t');
  const event=e=>{
    num(e,'start');num(e,'end');num(e,'wait');
    if(e.resource_wait&&typeof e.resource_wait==='object')for(const key of Object.keys(e.resource_wait).sort())num(e.resource_wait,key);
    if(e.ready_times&&typeof e.ready_times==='object')for(const key of Object.keys(e.ready_times).sort())num(e.ready_times,key);
    for(const segment of e.cube_segments||[]){num(segment,'start');num(segment,'end');num(segment,'offset');num(segment,'finish');}
  };
  for(const m of route.moves||[])event(m);
  for(const r of route.regrips||[])event(r);
  for(const key of Object.keys(route.lanes||{}).sort())for(const e of route.lanes[key]||[])event(e);
  return slots;
}
function uniformRoute(source){
  if(!source||!Array.isArray(source.moves)||!source.moves.length)return source;
  const slots=selectionIntervals(source);
  if(slots.length<2)return source;
  const plain=source.moves.filter(m=>!ROTATION.test(moveToken(m))).map(m=>(+m.end||0)-(+m.start||0)).filter(d=>d>1e-9);
  const D=plain.length?median(plain):0.5;
  if(!(D>1e-9))return source;
  const starts=slots.map(s=>+s.start||0);
  const spans=[];for(let i=0;i+1<starts.length;i++)if(starts[i+1]>starts[i])spans.push(starts[i+1]-starts[i]);
  /* 最後のスロットには次の手が無いので、スロット幅の中央値ぶんを与える（末尾の回復もこの中に入る）。 */
  const typical=spans.length?median(spans):D;
  const ends=starts.slice(1).concat([Math.max(+slots[slots.length-1].own||0,starts[starts.length-1]+typical)]);
  const share=Math.max(PACE_SHARE_MIN,Math.min(1,typical>1e-9?D/typical:1));
  const route=clone(source);
  const real=timeSlots(route).map(([obj,key])=>obj[key]);
  const B=[],T=[];
  const push=(b,t)=>{if(B.length&&b<=B[B.length-1]+1e-12){T[T.length-1]=Math.max(T[T.length-1],t);return;}B.push(b);T.push(t);};
  let u=starts[0];
  for(let k=0;k<starts.length;k++){
    const own=Math.min(Math.max(+slots[k].own||starts[k],starts[k]),ends[k]);
    push(starts[k],u);push(own,u+D*share);push(ends[k],u+D);
    u+=D;
  }
  remapRoute(route,timeMapper(B,T));
  route.t_end=Math.max(+route.t_end||0,...route.moves.map(m=>m.end),...(route.regrips||[]).map(r=>r.end));
  route.pace='even';
  route.schedule_times={...(route.schedule_times||{}),real};
  return route;
}
/* 実時間へ戻す。控えた数値を同じ順に書き戻すので、往復しても値は1ビットも変わらない。 */
function restoreRealTimes(route){
  const real=route?.schedule_times?.real;
  if(!Array.isArray(real))return route;
  const slots=timeSlots(route);
  if(slots.length!==real.length)return route;
  slots.forEach(([obj,key],i)=>{obj[key]=real[i];});
  delete route.schedule_times.real;delete route.pace;
  return route;
}
/* 再生の間合いは譜面の尺度と同じ設定（layout.scale）で決まる。
   '等間隔' なら1手＝同じ長さ、'時間' ならスケジュールどおりの実時間。既定は等間隔。 */
const pacedView=view=>layout.scale==='even'?uniformRoute(view):view;
/* 上部の青いバナー。普通の知らせは4秒で自分から消える。エラーは残すが、押せば消える。進行中の「探索中…」は次の知らせで置き換わる。 */
let messageTimer=null;
function message(text,error=false){
  const el=$('#message');uiText(el,text);el.hidden=false;el.classList.toggle('error',error);el.classList.remove('notice');
  clearTimeout(messageTimer);messageTimer=null;
  if(!error&&!/探索中|記録中/.test(text))messageTimer=setTimeout(()=>{el.hidden=true;},4000);
}
function dismissMessage(){const el=$('#message');el.hidden=true;clearTimeout(messageTimer);messageTimer=null;}
$('#message').onclick=dismissMessage;
/* ブラウザには軽い状態だけを残す。history（Undo用の候補の複製）は最大1.5MBあり、iOS Safari の localStorage 上限を超えて保存が毎回失敗していた。 */
let persistWarned=false;
function persist(){try{state.selected=selected;state.routeId=route?.id;const {history,redo,...slim}=state;localStorage.setItem(STORAGE,JSON.stringify(slim));persistWarned=false;}catch{if(!persistWarned){persistWarned=true;message('ブラウザへの保存に失敗しました（容量不足の可能性）。',true);}}}
function download(name,text,mime='text/plain'){const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([text],{type:mime}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
function dialog(title,html){uiText($('#dialog-title'),title);uiHTML($('#dialog-content'),html);$('#dialog').showModal();}
function closeDialog(){$('#dialog').close();}
async function get(url){const r=await apiFetch(url);if(!r.ok)throw Error(`${url} の読み込みに失敗しました (${r.status})`);return readJSON(r,url);}
async function normalizeAlg(alg){alg=normalizeInput(alg);const response=await apiFetch('/api/normalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alg})});const result=await readJSON(response,'/api/normalize');if(!response.ok)throw Error(result.error||'手順を解釈できません');return result.alg;}
function variantText(r){if(r.action_id.includes('SYNC_RING_THEN_WIDE'))return '同時回し → ワイド';if(r.action_id.includes('WIDE_THEN_SYNC_RING'))return 'ワイド → 同時回し';if(r.action_id.includes('SLICE_REVERSE_HALF'))return '逆ワイド半回転 → 外層半回転';return r.variant;}
function entryWristsAt(index){const wrists={...(route.initial_wrist_poses||{})};for(const key of (route.path||[]).slice(0,route.moves[index].path_index)){const a=catalog.rows.find(r=>r.engine_key===key);if(!a)continue;if(a.execution==='hold_only'){wrists.L=null;wrists.R=null;}else Object.assign(wrists,a.end_wrists||{});}return wrists;}
function legalOptions(){const m=route.moves[selected];const holds=holdsAt(selected),wrists=entryWristsAt(selected);return catalog.rows.filter(r=>r.move===m.row.move&&(!m.input_move?.includes("3")||r.authored_move===m.input_move)&&(r.hold_before==='*'||r.hold_before===holds[r.hand])&&(!r.required_wrist_pose||wrists[r.hand]===r.required_wrist_pose)&&Object.entries(r.required_holds||{}).every(([h,v])=>holds[h]===v));}
function holdsAt(index){if(route.moves[index].holds_before)return clone(route.moves[index].holds_before);const holds={...route.initial_holds};for(const m of route.moves.slice(0,index)){holds[m.hand]=m.hold_after;if((route.provenance!=='model-search'&&m.row.state_change==='both_thumb_transition'))holds.R=holds.L=m.hold_after;}for(const r of route.regrips||[])if(r.end<=route.moves[index].start)holds[r.hand]=r.hold_to;return holds;}
const EDIT_LIMIT=1500000;
function editSnapshot(){return clone({route,bank,routes,selected,pins:state.pins,exclude:state.exclude,prefix:state.prefix,imported:state.imported??null,order:state.order??null,labelTask:state.labelTask??null,alg:state.alg??route.alg,recon,searchRequest,lastEnd});}
function restoreEditData(snapshot){
  route=clone(snapshot.route);bank=clone(snapshot.bank);routes=clone(snapshot.routes);selected=snapshot.selected;recon=clone(snapshot.recon);searchRequest=clone(snapshot.searchRequest);lastEnd=clone(snapshot.lastEnd);
  for(const key of ['pins','exclude','prefix','imported','order','labelTask','alg'])state[key]=clone(snapshot[key]);
}
function recordEdit(before){
  state.redo=[];
  if(JSON.stringify(before).length>EDIT_LIMIT){state.history=[];state.redo=[];message('この変更は大きいため、元に戻す履歴を保存できません。',true);return;}
  state.history.push(before);
  while(state.history.length>30||JSON.stringify(state.history).length>EDIT_LIMIT)state.history.shift();
}
async function editTransaction(work){
  if(editBusy||searchBusy||applying||recording||!route)return false;
  editBusy=true;const before=editSnapshot();
  try{
    const ok=await work();
    if(ok){recordEdit(before);render();return true;}
    restoreEditData(before);return false;
  }catch(error){
    restoreEditData(before);message(error.message,true);return false;
  }finally{editBusy=false;}
}
async function travelHistory(redo=false){
  if(editBusy||searchBusy||applying||recording||!route)return false;
  const from=redo?state.redo:state.history,to=redo?state.history:state.redo,previous=from.at(-1);if(!previous)return false;
  const version=value=>value&&typeof value==='object'?JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value;
  if(['engine','params','legal','actions'].some(key=>version(previous.route?.model_version?.[key])!==version(route.model_version?.[key]))){message('旧モデルの履歴です。現在の候補へは戻せません。',true);return false;}
  const current=editSnapshot();editBusy=true;
  try{
    const ok=await setRoute(clone(previous.route),{commit:()=>{restoreEditData(previous);from.pop();to.push(current);while(to.length>30||JSON.stringify(to).length>EDIT_LIMIT)to.shift();}});
    if(ok){message(redo?'画面の変更をやり直しました。':'画面の変更を戻しました。');return true;}return false;
  }catch(error){message(error.message,true);return false;}finally{editBusy=false;}
}
function chooseCandidate(next,pos=selected){return editTransaction(async()=>{if(!next||next.id===route.id)return false;return setRoute(next,{commit:()=>{selected=pos;}});});}
function changeConditions(...args){return editTransaction(()=>changeConditionsNow(...args));}

function activeSet(){const available=filterRoutes(bank,state.pins,state.exclude);return bank.every(r=>r.provenance==='model-search')?available:diverse(available);}
/* 譜面のセルは「次のセルが始まるまで」を占める。同じ時刻に2つ始まると前のセルが幅0になるので
   （x と、それを実現する持ち替えがまさにこれ）、その組だけは自分の長さで順に並べる。 */
function selectionIntervals(source){
  const route=source||shownRoute();
  const events=[...route.moves.map((m,index)=>({start:m.start,own:m.end,index})),...(route.regrips||[]).map((r,rg)=>({start:r.start,own:r.end,index:Math.max(0,r.after_pos??0),rg}))].sort((a,b)=>a.start-b.start);
  let cursor=-Infinity;
  return events.map((e,i)=>{
    const start=Math.max(e.start,cursor),next=events[i+1]?.start??route.t_end;
    const end=Math.max(start,next>start+1e-9?next:(e.own??start));
    cursor=end;
    return {...e,start,end};
  });
}
const roleLabel=r=>({driving:'駆動',supporting:'支持',repositioning:'退避・調整',preserve:'自由・保持',anchor:'手首の固定姿勢',wrist_motion:'手首の動作'}[r]||'');
const kindLabel=k=>({stroke:'ストローク',recovery:'回復',wait:'待ち',regrip:'持ち替え',preparation:'準備',startup:'起動',carry:'保持',manual:'両手首操作'}[k]||k);
const HOLD_JP={F:'F',U:'U',D:'D',B_CW:'B⟳',B_CCW:'B⟲'};
const holdJP=h=>typeof h==='object'&&h?`右 ${HOLD_JP[h.R]||h.R} / 左 ${HOLD_JP[h.L]||h.L}`:(HOLD_JP[h]||h||'—');
const LANE_ORDER=['thumb','index','middle','ring','pinky'];
const FINGER_JP={thumb:'親',index:'人',middle:'中',ring:'薬',pinky:'小',wrist:'腕'};
function barHTML(event,resource,X){
  const left=X(event.start),right=X(event.end);if(right<left)return '';
  const cause=(event.cause||route.moves[event.i]?.wait_cause||[]).join(', ');
  const label=`${resource} · ${roleLabel(event.role)} ${kindLabel(event.kind)} ${number(event.start)}–${number(event.end)}${cause?' / '+cause:''}`;
  return `<button class="lane-bar ${esc(resource[0])} ${esc(event.kind)} role-${esc(event.role||'unspecified')} ${selectedLane===resource?'focused':''}" style="left:${left}px;width:${Math.max(2,right-left)}px" data-lane="${esc(resource)}" data-pos="${event.i??selected}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
}
let chartX=null,chartLX=96;
function laneKeys(){
  return [...new Set([...RESOURCES,...Object.keys(route.lanes)])].filter(r=>!r.endsWith('.wrist'))
    .sort((a,b)=>{const [ha,fa]=a.split('.'),[hb,fb]=b.split('.');return ha===hb?LANE_ORDER.indexOf(fa)-LANE_ORDER.indexOf(fb):(ha==='R'?-1:1);});
}
/* 等間隔は区分線形写像。手の開始時刻を等間隔スロットへ写し、指レーンは写像後の時間で描く（データは変えない）。 */
function mapper(starts,extent,W,even){
  if(!even)return t=>t/Math.max(1e-4,extent)*W;
  const n=Math.max(1,starts.length),unit=W/n,B=[0],T=[0];
  starts.forEach((s,i)=>{B.push(s);T.push(i*unit+unit*0.12);});
  B.push(extent);T.push(W);
  for(let i=1;i<B.length;i++)if(B[i]<=B[i-1])B[i]=B[i-1]+1e-6;
  return t=>{if(t<=B[0])return T[0];for(let i=1;i<B.length;i++)if(t<=B[i])return T[i-1]+(t-B[i-1])/(B[i]-B[i-1])*(T[i]-T[i-1]);return T[T.length-1];};
}
function timeline(){
  const route=shownRoute();
  if(!route)return;
  const extent=displayEnd(route),intervals=selectionIntervals(),even=layout.scale==='even',narrow=narrowScreen();
  chartLX=narrow?46:96;
  const W=Math.round((even?intervals.length*(narrow?EVEN_SLOT_M:EVEN_SLOT_PC):(narrow?TIME_SPAN_M:TIME_SPAN_PC))*zoom);
  const X=mapper(intervals.map(t=>t.start),extent,W,even);chartX=X;
  const unit=W/Math.max(1,intervals.length);
  const row=(cls,label,body)=>`<div class="crow ${cls}"><div class="ll">${label}</div><div class="tk" style="width:${W}px">${body}</div></div>`;
  let ticks='';
  if(even)intervals.forEach((t,i)=>{ticks+=`<i style="left:${i*unit}px"></i><span style="left:${i*unit+unit/2}px">${i+1}</span>`;});
  else for(let tick=0,step=Math.max(1,Math.ceil(extent/Math.min(200,Math.max(2,Math.floor(W/45)))));tick<=200&&tick*step<=extent;tick++){const u=tick*step;ticks+=`<i style="left:${X(u)}px"></i><span style="left:${Math.max(7,X(u))}px">${u}</span>`;}
  let html=row('ruler',even?'手番号':'相対時間',ticks);
  let seglines='';
  if(route.segments?.length>1){
    let segs='';
    route.segments.forEach((sg,k)=>{
      const idx=intervals.map((t,i)=>[t,i]).filter(([t])=>t.index>=sg.move_start&&t.index<sg.move_start+sg.move_count);
      if(!idx.length)return;
      const i0=idx[0][1],i1=idx[idx.length-1][1];
      const left=even?i0*unit:X(intervals[i0].start),right=even?(i1+1)*unit:X(intervals[i1].end);
      segs+=`<span class="seg" translate="no" style="left:${left}px;width:${Math.max(24,right-left)}px" title="${esc(sg.alg)}">${k+1}. ${esc(sg.comment||sg.alg)}</span>`;
      if(k)seglines+=`<i class="segline" style="left:${chartLX+left}px"></i>`;
    });
    html+=row('segrow','手順',segs);
  }
  let sym='',tags='';
  intervals.forEach((t,i)=>{
    const L=even?i*unit+2:X(t.start),Wd=even?Math.max(6,unit-4):Math.max(18,X(Math.max(t.end,t.start+.08))-X(t.start));
    if(t.rg!==undefined){
      const r=route.regrips[t.rg],name=r.hand==='R'?'右':'左';
      const title=esc(`持ち替え ${name}手 ${holdJP(r.hold_from)} → ${holdJP(r.hold_to)} · ${number(r.start)}–${number(r.end)} · 手順上の位置: ${r.after_pos<0?'先頭':(r.after_pos+1)+'手目の後'}`);
      sym+=`<button class="score-cell G" style="left:${L}px;width:${Wd}px;touch-action:pan-y" data-rg="${t.rg}" title="${title}" aria-label="持ち替え">↻</button>`;/* 移動先のホールド名は出さない（U などが回転記号と紛らわしい）。行き先は title に出る。 */
      tags+=`<button class="score-cell G" style="left:${L}px;width:${Wd}px;touch-action:pan-y" data-rg="${t.rg}" title="${title}" aria-label="持ち替え">${narrow?'持':'持替'}${esc(name)}</button>`;
      return;
    }
    const m=route.moves[t.index],locked=state.pins.some(c=>c.pos===t.index);
    const mark=(m.wait>1e-9?'<span class="wm"></span>':'')+(locked?'<span class="pin" title="固定">◆</span>':'');
    const cls=`${esc(m.hand)} ${t.index===selected?'selected':''} ${m.changed?'changed':''}`;
    const title=esc(`${t.index+1}. ${tag(m.row)} / ${holdText(m.hold_before)} → ${holdText(m.hold_after)}${m.wait>1e-9?' / 止まり +'+number(m.wait):''}`);
    sym+=`<button class="score-cell ${cls}" style="left:${L}px;width:${Wd}px" data-cell="${t.index}" title="${title}" aria-label="${t.index+1}手目 ${esc(m.input_move||m.row.move)}">${esc(m.input_move||m.row.move)}${mark}</button>`;
    tags+=`<button class="score-cell ${cls}" style="left:${L}px;width:${Wd}px" data-cycle="${t.index}" title="${title}" aria-label="${t.index+1}手目の指使い ${esc(tag(m.row))}">${esc(tag(m.row))}</button>`;
  });
  html+=row('symrow','回転記号',sym)+row('tagrow','指遣い',tags);
  /* 回転中の行。回転区間のバーと、回転が止まっていた区間 wait = max(0, start - t_turn_end) の赤い破線枠。 */
  let cube=route.moves.flatMap(m=>(m.cube_segments||[]).map(s=>`<i class="lane-bar cube ${(s.layers||[]).length>=3?'whole':''}" style="left:${X(s.start)}px;width:${Math.max(2,X(s.end)-X(s.start))}px" title="${esc((m.input_move||m.row.move)+' 軸'+(s.axis||'')+' '+number(s.start)+'–'+number(s.end))}"></i>`)).join('');
  cube+=route.moves.map((m,i)=>m.wait>1e-9?`<button class="lane-bar wait" style="left:${X(m.start-m.wait)}px;width:${Math.max(3,X(m.start)-X(m.start-m.wait))}px" data-wait="${i}" title="${esc('回転が止まっていた区間 +'+number(m.wait)+(m.wait_cause?.length?' / 条件 '+m.wait_cause.join(', '):''))}"></button>`:'').join('');
  html+=row('cube','回転中',cube);
  for(const hand of ['R','L']){
    html+=row('grp',hand==='R'?'右手':'左手','');
    for(const key of laneKeys().filter(k=>k.startsWith(hand+'.'))){
      const items=(route.lanes[key]||[]).filter(e=>e.kind!=='wait');if(!items.length)continue;/* 使っていない指のレーンは出さない。 */
      html+=row('lane'+(items.length?'':' dim'),esc((hand==='R'?'右':'左')+(FINGER_JP[key.split('.')[1]]||key.split('.')[1])),items.map(e=>barHTML(e,key,X)).join(''));
    }
  }
  uiHTML($('#timeline'),`<div class="cinner" style="width:${W+chartLX}px"><div class="playhead" id="playhead" style="left:${chartLX}px"></div>${seglines}${html}</div>`);
  movePlayhead(stage?.time??0);scrollSelectedIntoView();
}
function movePlayhead(time){const bar=$('#playhead');if(bar&&chartX)bar.style.left=(chartLX+chartX(time))+'px';}
function scrollSelectedIntoView(){
  const wrap=$('#timeline'),cell=wrap?.querySelector('.crow.symrow .score-cell.selected');if(!wrap||!cell)return;
  const left=chartLX+cell.offsetLeft,right=left+cell.offsetWidth;
  if(left-chartLX<wrap.scrollLeft)wrap.scrollLeft=Math.max(0,left-chartLX-24);
  else if(right>wrap.scrollLeft+wrap.clientWidth)wrap.scrollLeft=right-wrap.clientWidth+24;
}
/* HUD。独立した「基本情報」「セル詳細・編集」ボックスは置かず、こことチャートの行に載せる。 */
function hud(){
  const route=shownRoute();
  if(!route)return;
  const m=route.moves[selected],r=m.row,holds=holdsAt(selected);
  uiText($('#hud-sym'),m.input_move||r.move);
  const seg=route.recon?reconSegment(selected):null;
  uiHTML($('#hud-sub'),`<span class="pos">${selected+1} / ${route.moves.length}</span>`
    +(seg?`<span class="segnote" title="${esc(seg.alg)}">手順 ${seg.index+1}/${recon.segments.length}${seg.comment?' · <span class="user-text" translate="no">'+esc(seg.comment)+'</span>':''}</span>`:'')
    +`<span class="finger-tag ${esc(m.hand)}">${esc(tag(r))}</span>`
    +`<span class="mono">${esc(holdText(m.hold_before))} → ${esc(holdText(m.hold_after))}</span>`
    +(m.wait>1e-9?`<span class="waitnote">止まり +${number(m.wait)}${m.wait_cause?.length?' / '+esc(m.wait_cause.join(', ')):''}</span>`:'')
    +(route.display_adjustments?.[m.path_index]?`<span class="mono" title="${esc(route.display_adjustments[m.path_index].reason)}">表示 ×${number(route.display_adjustments[m.path_index].multiplier)}</span>`:'')
    +(state.pins.some(c=>c.pos===selected)?'<span class="pinnote">◆ 固定</span>':''));
  uiText($('#hud-hold-R'),holdJP(holds.R));
  uiText($('#hud-hold-L'),holdJP(holds.L));
  $('#m-scrub').max=Math.max(0,route.moves.length-1);$('#m-scrub').value=selected;
}
function candidateCells(p){
  return [...p.moves.map((m,j)=>({start:m.start,m,j})),...(p.regrips||[]).map(r=>({start:r.start,rg:r}))].sort((a,b)=>a.start-b.start);
}
function candidateList(){
  const top=routes[0],diff=layout.diff;
  const sameAsTop=(p,c)=>{
    if(!top||p===top)return false;
    if(c.rg)return (top.regrips||[]).some(r=>r.after_pos===c.rg.after_pos&&r.hand===c.rg.hand&&r.hold_to===c.rg.hold_to);
    return top.moves[c.j]?.action_id===c.m.action_id;
  };
  const currentId=route?.recon?reconSegment(selected)?.route.id:route?.id;
  const localSelected=route?.recon?selected-(reconSegment(selected)?.move_start||0):selected;
  const cell=(p,c)=>{
    const mark=diff&&top&&p!==top?(sameAsTop(p,c)?'same':'diff'):'';
    if(c.rg)return `<button type="button" class="cellpair G ${mark}" data-pick-route="${esc(p.id)}" data-pick-pos="${Math.max(0,(c.rg.after_pos??-1)+1)}" title="${esc('持ち替え '+(c.rg.hand==='R'?'右手':'左手')+' '+holdJP(c.rg.hold_from)+' → '+holdJP(c.rg.hold_to))}"><span class="mv">↻</span><span class="fg">持替${esc(c.rg.hand==='R'?'右':'左')}</span></button>`;
    const m=c.m,sel=p.id===currentId&&c.j===localSelected;
    return `<button type="button" class="cellpair ${esc(m.hand)} ${sel?'sel':''} ${m.wait>1e-9?'wait':''} ${mark}" data-pick-route="${esc(p.id)}" data-pick-pos="${c.j}" title="${esc(m.action_id+' / '+holdText(m.hold_before)+' → '+holdText(m.hold_after)+(m.wait>1e-9?' / 止まり +'+number(m.wait):''))}"><span class="mv">${esc(m.input_move||m.row.move)}</span><span class="fg">${esc(tag(m.row))}</span></button>`;
  };
  const seg=route?.recon?reconSegment(selected):null;
  uiHTML($('#candidate-heading'),seg?`手順 ${seg.index+1} / ${recon.segments.length} の候補 ${routes.length} 件 · <span translate="no">${esc(seg.comment||seg.alg)}</span>`:`候補 ${routes.length} 件${routes.length===8?'（上位8件）':''} · 評価値と時刻は相対値`);
  uiText($('#cand-tab-count'),routes.length||'');
  uiHTML($('#candidates'),routes.map((p,i)=>{
    const value=Number.isFinite(p.preference_score)?p.preference_score:p.t_end;
    const equal=Number.isFinite(p.preference_score)?Math.abs(p.preference_score-route.preference_score)<1e-6:Math.abs(p.t_end-route.t_end)<=(p.d_u_flick||0)*.25;
    const waits=p.moves.filter(m=>m.wait>1e-9).length;
    return `<article class="candidate-row ${p.id===currentId?'selected':''}" draggable="${!route.recon}" data-route="${esc(p.id)}">`
      +`<div class="candidate-head"><span class="rank-number">${i+1}</span><span class="candidate-name" ${state.labelTask?.name?'translate="no"':''}>${esc(seg?`手順 ${seg.index+1}`:(state.labelTask?.name||'自由入力の手順'))}</span>`
      +`<span class="candidate-cost"><small>${Number.isFinite(p.preference_score)?'評価 ↓':'t_end'}</small>${number(value)}${equal?'<span class="equal-badge">ほぼ同等</span>':''}</span></div>`
      +`<div class="candidate-alg">${esc(p.alg)}</div>`
      +`<div class="candidate-score">${candidateCells(p).map(c=>cell(p,c)).join('')}</div>`
      +`<div class="candidate-bottom"><span>${p.moves.length}手</span><span>持替 ${(p.regrips||[]).length}</span><span>止まり ${waits}</span>`
      +`<button class="choose ${p.id===currentId?'active':''}" data-choose="${esc(p.id)}">${p.id===currentId?'選択中':'この候補を選択'}</button>`
      +(route.recon?'':`<span class="reorder-buttons"><button data-up="${i}" aria-label="候補${i+1}を上へ" ${i===0?'disabled':''}>↑</button><button data-down="${i}" aria-label="候補${i+1}を下へ" ${i===routes.length-1?'disabled':''}>↓</button></span>`)+`</div></article>`;
  }).join('')||'<p class="saved-empty">候補がありません。条件を変えて探索してください。</p>');
}
function render(){timeline();hud();candidateList();$('#clear-pins').disabled=!state.pins.length&&!state.prefix;$('#undo').disabled=!state.history.length;if($('#redo'))$('#redo').disabled=!state.redo.length;persist();}
async function setRoute(next, {seek=true,commit=null}={}) {
  cancelRecording();
  const token=++loadingGeneration;applying=true;
  try{
    let view;try{view=await prepareDisplay(next);}catch(error){if(token===loadingGeneration)message('補正失敗・標準時間：'+error.message,true);view=next;}
    view=await presentX(view);if(token!==loadingGeneration)return false;
    const display=view===next?null:view,paced=pacedView(view),pace=paced===view?null:paced;
    stage.cubeStyle=layout.cubeStyle||'stickered';await stage.load(paced);if(token!==loadingGeneration)return false;
    // Commit the UI and session only after assets and the stage accepted the view.
    route=next;displayPlan=display;pacePlan=pace;if(commit)commit();
    selected=Math.min(selected,route.moves.length-1);stepCursor=selected;if(!route.recon)state.alg=route.alg;
    render();paintCube();uiRemove(stage.element.querySelector('.stage-loading'));if(layout.speed==='real')applySpeed('real');if(seek)stage.seek(shownRoute().moves[selected].start);return true;
  }catch(e){message('3D: '+e.message,true);throw e;}finally{if(token===loadingGeneration)applying=false;}
}
/* 一手ずつの再生。選んだ手の start から end まで動かしてその手の上で止まる。
   再生中にもう一度押すと、今の手を切って次（前）の手の頭から動かす。≪ ≫ は再生せずに飛ぶ。 */
/* 手送りのカーソル。stepCursor は「次に › が再生する手」。core.js の stepTarget が決める。 */
let stepCursor=0;
function stepCount(){return shownRoute()?.moves.length||0;}
function stepGo(action){
  if(!route||!stage)return;
  const next=stepTarget(action,stepCursor,stepCount(),selected);
  stepCursor=next.cursor;
  if(next.play===null){selectCell(next.selected);return;}
  stepPlay(next.play);
}
function stepPlay(index){
  if(recording){cancelRecording();return;}
  if(!route||!stage)return;
  const view=shownRoute(),target=Math.max(0,Math.min(view.moves.length-1,index)),m=view.moves[target];
  if(!m)return;
  selected=target;selectedLane=null;stepCursor=Math.min(view.moves.length-1,target+1);
  stage.playing=false;playUntil=null;
  stage.seek(m.start);
  playUntil=Math.max(m.end,m.start+1e-3);
  stage.playing=true;
  timeline();hud();candidateList();persist();
}
function selectCell(index,seek=true){if(recording){cancelRecording();return;}if(!route)return;selected=Math.max(0,Math.min(route.moves.length-1,index));stepCursor=selected;selectedLane=null;playUntil=null;timeline();hud();candidateList();if(seek){stage.playing=false;stage.seek(shownRoute().moves[selected].start);}persist();}
async function pin(change){
  const kind=p=>p.action_id?'action':p.regrip_before?'before':'after';
  const pins=state.pins.filter(p=>!(p.pos===change.pos&&kind(p)===kind(change))).concat(change);
  let prefix=state.prefix;
  if(change.action_id&&route.provenance==='model-search'){
    const cut=change.pos?route.moves[change.pos-1].path_index+1:0;
    prefix={path:clone(route.path.slice(0,cut)),initial_holds:clone(route.initial_holds)};
    const before=route.regrips?.find(r=>r.after_pos===change.pos-1);
    if(before&&!pins.some(p=>p.pos===change.pos&&p.regrip_before))pins.push({pos:change.pos,regrip_before:{hand:before.hand,to_hold:before.hold_to}});
  }
  const ok=await changeConditions(pins,state.exclude,change.pos,prefix);
  if(ok)message(change.action_id?`${change.pos+1}手目を置き換えました。前の指使いと開始ホールドを保持し、この手以降を再探索しました。`:`${change.pos+1}手目を固定して再探索しました。黄色は連鎖変更です。`);
  return ok;
}
function cycle(index){selectCell(index);const options=legalOptions();if(options.length<2)return;const current=options.findIndex(r=>r.action_id===route.moves[index].action_id);pin({pos:index,action_id:options[(current+1)%options.length].engine_key});}
async function querySearch(request){
  if(searchBusy)return null;
  searchBusy=true;$('#search-button').disabled=true;uiText($('#search-button'),'探索中…');
  try{
    const response=await apiFetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    const data=await readJSON(response,'/api/search');if(!response.ok)throw Error(data.error||'探索に失敗しました');
    if(!data.routes?.length)throw Error(data.reason||'条件を満たす候補がありません');
    return {data,available:data.routes.map(r=>enrichWarped(validateRoute(r),catalog.rows))};
  }catch(e){message(e.message+' 表示中の候補は変更していません。',true);return null;}
  finally{searchBusy=false;$('#search-button').disabled=false;uiText($('#search-button'),'探索');}
}
async function loadDataset(alg,reset=true,labelTask=undefined){
  if(searchBusy||applying||editBusy)return false;
  /* ワイド表記は探索へ渡す前にここで一度だけ直す。入力欄・貼り付け・ケース一覧・手順リストの
     すべてがこの関数を通るので、エンジンが読む形はここで揃う。 */
  /* [A, B] などの記法を展開し、同じ軸で打ち消し合う手をまとめる（core.js の expandAndSimplify）。
     読めないときは理由を出して止める。全部消えたときも止める。 */
  let moves;try{moves=expandAndSimplify(alg);}catch(e){message(e.message,true);return false;}
  if(!moves.length){message('手順が空です（打ち消し合って手が残りません）。',true);return false;}
  alg=moves.join(' ');$('#alg').value=alg;
  let initialState=null;try{if($('#initial-state').value==='previous')initialState=continuationState(route);}catch(e){message(e.message,true);return false;}
  const request={alg,prefix:reset?null:clone(state.prefix),constraints:reset?[]:clone(state.pins),exclude:reset?[]:clone(state.exclude),start_holds:readStartHolds(),initial_state:initialState};
  if($('#initial-state').value==='previous'&&!request.initial_state){message('引き継ぐ探索結果がありません。',true);return;}
  const found=await querySearch(request);if(!found)return false;
  const nextRoutes=filterRoutes(found.available,request.constraints,request.exclude);if(!nextRoutes.length)return false;
  const applied=await setRoute(nextRoutes[0],{commit:()=>{
    if(reset){state.prefix=null;state.pins=[];state.history=[];state.redo=[];selected=0;}
    state.imported=null;searchRequest=clone(request);lastEnd=request.initial_state;bank=found.available;routes=nextRoutes;$('#alg').value=found.data.alg;
    uiText($('#mode-note'),`${found.data.model.endsWith("_migrated")?"既存係数の移行版":"学習済み"} ${found.data.model} ／ 相性評価で順位付け・再生は相対時間`);
    state.labelTask=labelTask!==undefined?labelTask:(state.labelTask?.alg===found.data.alg?state.labelTask:null);
  }});
  if(!applied)return false;labelContext();message('現在の係数と最新の指拘束・両手定義で候補を探索しました。');return true;
}
function labelContext(){
  const task=state.labelTask;
  $('#label-current').dataset.taskId=task?.id||'';
  $('#label-current-name').setAttribute('translate',task?.name?'no':'yes');uiText($('#label-current-name'),task?.name||'自由入力の手順');
  uiText($('#label-current-status'),'');
  uiText($('#label-current-note'),task?'保存するとこのケース名が付きます':'現在の指使いを保存します');
  window.dispatchEvent(new Event('label-case-change'));persist();
}
window.addEventListener('open-label-task',async e=>{
  const {task,resolve,reject}=e.detail;
  if(!catalog||!stage||searchBusy||applying){reject(Error('初期化・探索が完了してから選択してください。'));return;}
  const previous=$('#initial-state').value;
  $('#initial-state').value='none';
  try{
    if(!await loadDataset(task.alg,true,clone(task)))throw Error('候補を探索できませんでした。ケースは未登録のままです。');
    resolve();
  }catch(error){$('#initial-state').value=previous;reject(error);}
});
async function changeConditionsNow(pins,exclude=state.exclude,changePos=null,prefix=state.prefix){
  if(searchBusy)return false;
  if(route?.recon)return reconChangeConditions(pins,changePos,prefix);
  if(prefix&&changePos!==null){
    let count=0,cut=prefix.path.length;
    for(let i=0;i<prefix.path.length;i++){const a=catalog.rows.find(r=>r.engine_key===prefix.path[i]);if(a?.move!=='REGRIP'){if(count===changePos){cut=i;break;}count++;}}
    if(cut<prefix.path.length){while(cut&&catalog.rows.find(r=>r.engine_key===prefix.path[cut-1])?.move==='REGRIP')cut--;prefix={...prefix,path:prefix.path.slice(0,cut)};}
  }
  let available;
  if(route.provenance==='model-search'){
    const request={...searchRequest,prefix:clone(prefix),constraints:clone(pins),exclude:clone(exclude)};
    const found=await querySearch(request);if(!found)return false;
    available=found.available;
  }else available=diverse(filterRoutes(bank,pins,exclude));
  if(!available.length){message('条件に合う候補がありません。',true);return false;}
  const old=route;state.prefix=clone(prefix);state.pins=clone(pins);state.exclude=clone(exclude);
  if(route.provenance==='model-search')bank=available;
  routes=available;
  const next=clone(available[0]);next.moves.forEach((m,i)=>m.changed=i!==changePos&&(m.key!==old.moves[i]?.key||m.hold_before!==old.moves[i]?.hold_before));
  await setRoute(next);return true;
}
/* 端末内の保存。サーバへ判断を記録する仕組みは廃止し、指使いそのものを localStorage に残す。 */
const MYROUTES='fingerweight.ui-v4.routes';
function loadMyRoutes(){return loadRoutes();}

function reorder(from,to){if(editBusy||searchBusy||applying||recording)return;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>=routes.length||to<0||to>=routes.length||from===to)return;const before=editSnapshot();const [item]=routes.splice(from,1);routes.splice(to,0,item);candidateList();state.order=routes.map(r=>r.id);recordEdit(before);render();}
function nextQueue(){if(searchBusy||applying||editBusy)return;if(!state.queue.length){message('手順リスト（1行1手順のTXT）を読み込むと次へ進めます。');return;}state.queueIndex=Math.min(state.queueIndex+1,state.queue.length-1);$('#alg').value=state.queue[state.queueIndex];queueStatus();loadDataset($('#alg').value);}
function queueStatus(){uiText($('#queue-status'),state.queue.length?`手順 ${state.queueIndex+1} / ${state.queue.length}`:'');$('#queue-next').hidden=!state.queue.length;$('#queue-next').disabled=state.queueIndex>=state.queue.length-1;}
function requestPayload(){return {alg:$('#alg').value,prefix:clone(state.prefix),constraints:clone(state.pins),exclude:clone(state.exclude),start_holds:readStartHolds(),initial_state:$('#initial-state').value==='previous'?lastEnd||continuationState(route):null};}


let regripDraft=null;
let popupMenus=[],popupOrigin=null;
function closeCellMenu(){for(const menu of popupMenus)uiRemove(menu);popupMenus=[];}
function popup(items,point,level=0,anchor=null){
  while(popupMenus.length>level)uiRemove(popupMenus.pop());
  const menu=document.createElement('div');menu.className='cell-popup';menu.setAttribute('role','menu');uiAttr(menu,'aria-label',level?'選択肢':'手の操作');document.body.append(menu);popupMenus.push(menu);
  for(const item of items){
    if(item.sep){const line=document.createElement('div');line.className='sep';menu.append(line);continue;}
    if(item.heading!==undefined){const head=document.createElement('div');head.className='mh';uiText(head,item.heading);menu.append(head);continue;}
    if(item.note!==undefined){const note=document.createElement('div');note.className='mf';uiText(note,item.note);menu.append(note);continue;}
    const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');uiText(button,item.label+(item.children?'  ›':''));button.disabled=!!item.disabled;
    if(item.children){button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');}
    const expand=()=>{if(button.disabled)return;for(const other of menu.querySelectorAll('[aria-expanded]'))other.setAttribute('aria-expanded','false');if(item.children){button.setAttribute('aria-expanded','true');popup(item.children,point,level+1,button);}else while(popupMenus.length>level+1)uiRemove(popupMenus.pop());};
    button.onpointerenter=e=>{if(e.pointerType==='mouse')expand();};
    button.onclick=()=>{if(item.children){expand();popupMenus[level+1]?.querySelector('button:not(:disabled)')?.focus();}else{closeCellMenu();item.run();}};
    button.onkeydown=e=>{
      const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(button);
      if(['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Escape','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();}
      if(e.key==='ArrowDown'||e.key==='ArrowUp')buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();
      if(e.key==='Home')buttons[0]?.focus();if(e.key==='End')buttons.at(-1)?.focus();
      if(e.key==='ArrowRight'&&item.children)button.click();
      if(e.key==='ArrowLeft'&&anchor){while(popupMenus.length>level)uiRemove(popupMenus.pop());anchor.focus();}
      if(e.key==='Escape'){closeCellMenu();popupOrigin?.focus();}
    };
    menu.append(button);
  }
  const rect=anchor?.getBoundingClientRect();let x=rect?rect.right-2:point.x,y=rect?rect.top:point.y;
  if(x+menu.offsetWidth>innerWidth-8)x=rect?rect.left-menu.offsetWidth+2:innerWidth-menu.offsetWidth-8;
  menu.style.left=Math.max(8,x)+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
}
function menuPoint(e){const rect=e?.currentTarget?.getBoundingClientRect?.();return e?.clientX?{x:e.clientX,y:e.clientY}:{x:rect?.left||20,y:rect?.bottom||100};}
function regripItems(){
  const pos=selected,cut=pos?route.moves[pos-1].path_index+1:0;
  const draft={pos,routeId:route.id,prefix:{path:clone(route.path.slice(0,cut)),initial_holds:clone(route.initial_holds)},holds:clone(pos?route.moves[pos-1].holds_after:route.initial_holds)};
  return ['R','L'].map(hand=>({label:hand==='R'?'右手':'左手',children:catalog.holds.map(hold=>({
    label:hold+(hold===draft.holds[hand]?'（現在）':''),
    disabled:!catalog.rows.some(r=>r.move==='REGRIP'&&r.hand===hand&&r.hold_before===draft.holds[hand]&&r.hold_after===hold),
    run:()=>{regripDraft={...draft,hand};insertRegrip(hold);}
  }))}));
}
function replacementItems(){
  const pos=selected,id=route.id;
  return legalOptions().map(r=>({label:`${r.action_id===route.moves[pos].action_id?'✓ ':''}${tag(r)} · ${variantText(r)} (${holdText(r.hold_before)} → ${holdText(r.hold_after)})`,run:()=>{if(route.id===id)pin({pos,action_id:r.engine_key});}}));
}
/* 置き換え・持ち替え・固定・局所指摘はすべてこのメニューに集約する（専用の編集ボックスは持たない）。 */
function cellMenu(e,kind){
  if(!route||searchBusy||applying)return;
  closeCellMenu();stage.playing=false;playUntil=null;popupOrigin=e?.target?.closest('button');
  const model=route.provenance==='model-search';
  if(kind==='regrip'||kind==='choices'){
    popup(kind==='regrip'?(model?regripItems():[]):replacementItems(),menuPoint(e));
    popupMenus[0]?.querySelector('button:not(:disabled)')?.focus();return;
  }
  const m=route.moves[selected];
  const locked=state.pins.some(c=>c.pos===selected);
  const inserted=state.pins.find(p=>p.pos===selected&&p.regrip_before)?.regrip_before;
  /* 見出し行は置かない。選んだ手はチャート側の選択で分かるので、メニューは操作だけを並べる。 */
  const items=[
    {label:'指遣いを変更',children:replacementItems()},
    {sep:true},
    {label:'直前に持ち替えを挿入',disabled:!model,children:model?regripItems():[]},
    ...(inserted?[{label:`持ち替えの挿入指定を解除（${inserted.hand==='R'?'右手':'左手'} → ${inserted.to_hold}）`,run:()=>changeConditions(state.pins.filter(p=>!(p.pos===selected&&p.regrip_before)))}]:[]),
    {sep:true},
    locked?{label:'固定を外す',run:()=>changeConditions(state.pins.filter(p=>p.pos!==selected))}
          :{label:'指遣いを固定',run:()=>pin({pos:selected,action_id:m.key||m.action_id})},
  ];
  popup(items,menuPoint(e));popupMenus[0]?.querySelector('button:not(:disabled)')?.focus();
}
function chooseRegripHand(e){cellMenu(e,'regrip');}
function chooseReplacement(e){cellMenu(e,'choices');}
window.addEventListener('pointerdown',e=>{if(!e.target.closest('.cell-popup'))closeCellMenu();});
window.addEventListener('resize',closeCellMenu);
window.addEventListener('workspace-view',closeCellMenu);
window.addEventListener('scroll',e=>{if(!e.target.closest?.('.cell-popup'))closeCellMenu();},true);

async function insertRegrip(hold){
  const draft=regripDraft;if(!draft||route.id!==draft.routeId)return;
  const pins=state.pins.filter(p=>!(p.pos===draft.pos&&(p.regrip_before||'no_regrip_before' in p))&&!(p.pos===draft.pos-1&&'regrip_after' in p));
  pins.push({pos:draft.pos,regrip_before:{hand:draft.hand,to_hold:hold}});
  closeCellMenu();
  if(await changeConditions(pins,state.exclude,draft.pos,draft.prefix))message(`${draft.pos+1}手目の直前に${draft.hand==='R'?'右手':'左手'}の持ち替え → ${hold} を挿入しました。前の指使いを保持して再探索しました。`);
}
// A drop fixes the regrip boundary; unpinned strokes are searched again.
function regripMoveTarget(index,boundary){
  const base=route,rg=base?.regrips?.[index];
  if(!rg||rg.initial_setup)throw Error('開始ホールドの準備は移動できません。');
  if(!Number.isInteger(boundary)||boundary<0||boundary>base.moves.length)throw Error('持ち替えの移動先が不正です。');
  if(!base.recon)return {base,rg,source:base,localBoundary:boundary};
  if(!recon?.segments||base.provenance==='imported-schedule')throw Error('この連結経路の開始状態がありません。再探索してください。');
  const k=rg.segment_index,sg=recon.segments[k];if(!sg)throw Error('持ち替えの所属行を確認できません。');
  if(boundary<sg.move_start||boundary>sg.move_start+sg.move_count)throw Error('Reconの行をまたいで持ち替えを移動できません。');
  const local=sg.route.regrips[rg.source_regrip_index];if(!local)throw Error('持ち替えの所属行を確認できません。');
  return {base,rg:local,source:sg.route,k,localBoundary:boundary-sg.move_start};
}
function movedRegripPins(pins,oldBoundary,boundary,rg,count){
  // Replace only regrip fields at the two edited boundaries. Action pins may
  // share the same object and must survive; other boundaries remain fixed.
  const out=pins.map(pin=>{
    const p=clone(pin);
    for(const at of [oldBoundary,boundary]){
      if(p.pos===at){delete p.regrip_before;delete p.no_regrip_before;}
      if(p.pos===at-1)delete p.regrip_after;
    }
    return p;
  }).filter(p=>Object.keys(p).some(key=>key!=='pos'));
  const need={hand:rg.hand,to_hold:rg.hold_to??rg.hold_after};
  out.push(boundary===count?{pos:count-1,regrip_after:need}:{pos:boundary,regrip_before:need});
  return out;
}
function regripSearchRequest(source,previous,pins,exclude,initialState){
  if(source.origin&&!initialState)throw Error('この連結経路の開始状態がありません。再探索してください。');
  return {...clone(previous||{}),alg:source.alg,prefix:null,constraints:clone(pins),exclude:clone(exclude||[]),
    start_holds:clone(previous?.start_holds||source.initial_holds),initial_state:clone(initialState)};
}
async function planRegripMove(index,boundary){
  const {base,rg,source,k,localBoundary}=regripMoveTarget(index,boundary);
  if(base.recon){
    const next=clone(recon);
    for(let j=k;j<next.segments.length;j++){
      const row=next.segments[j],initial=j?next.segments[j-1].route.end_state:row.request?.initial_state||row.route.replay_initial_state||null;
      let request;
      if(j===k){
        const pins=movedRegripPins(row.request?.constraints||[],rg.after_pos+1,localBoundary,rg,source.moves.length);
        request=regripSearchRequest(row.route,row.request,pins,row.request?.exclude,initial);
      }else request={...clone(row.request||{}),alg:row.alg,initial_state:clone(initial)};
      if(j)request.start_holds={R:'auto',L:'auto'};
      // Never drop a user's constraints to manufacture a successful move.
      const found=await querySearch(request);if(!found)return null;
      const available=filterRoutes(found.available,request.constraints||[],request.exclude||[]);
      if(!available.length)throw Error('固定した持ち替え位置を満たす候補がありません。');
      row.request=request;row.available=available;row.bank=found.data.routes.filter(r=>available.some(a=>a.id===r.id));
      row.route=clone(row.bank.find(r=>r.id===available[0].id));
    }
    return {base,recon:next};
  }
  const pins=movedRegripPins(state.pins,rg.after_pos+1,localBoundary,rg,source.moves.length);
  const previous=base.provenance==='model-search'?searchRequest:null;
  const initial=base.replay_initial_state||previous?.initial_state||null;
  const request=regripSearchRequest(base,previous,pins,state.exclude,initial);
  const found=await querySearch(request);if(!found)return null;
  const available=filterRoutes(found.available,pins,request.exclude);
  if(!available.length)throw Error('固定した持ち替え位置を満たす候補がありません。');
  return {base,request,available,pins};
}
function visibleActionOrder(source){return selectionIntervals(source).map(item=>item.rg===undefined?'M:'+item.index:'G:'+source.regrips[item.rg].hand+':'+source.regrips[item.rg].hold_from+'>'+source.regrips[item.rg].hold_to).join('|');}
function moveRegrip(index,boundary){return editTransaction(async()=>{
  if(route.regrips[index]?.after_pos+1===boundary)return false;
  message('持ち替え位置を固定して、他の指遣いを再探索しています…');
  const plan=await planRegripMove(index,boundary);if(!plan)return false;
  if(route!==plan.base)throw Error('編集中に経路が変更されました。');
  const next=plan.recon?enrichWarped(validateRoute(combineSegments(plan.recon.segments,plan.recon.scramble)),catalog.rows):clone(plan.available[0]);
  next.moves.forEach((m,i)=>{m.changed=m.key!==plan.base.moves[i]?.key||m.hold_before!==plan.base.moves[i]?.hold_before;});
  if(!await setRoute(next,{commit:()=>{
    selected=Math.min(boundary,next.moves.length-1);state.imported=null;
    if(plan.recon){
      recon=plan.recon;recon.segments.forEach((sg,k)=>Object.assign(sg,next.segments[k]));reconCollectPins();
      const sg=recon.segments[reconSegIndex(selected)]||recon.segments[0];bank=sg.available;routes=sg.available;
    }else{
      bank=plan.available;routes=plan.available;state.pins=plan.pins;state.prefix=null;
      searchRequest=clone(plan.request);lastEnd=clone(plan.request.initial_state);
    }
  }}))return false;
  const destination=boundary===0?'手順の先頭':`${boundary}手目の後`;
  message(`持ち替えを${destination}に固定して再探索しました。黄色は変更された指使いです。`);return true;
});}
function regripMoveItems(index){
  const original=route,rg=route.regrips[index],at=rg.after_pos+1,count=route.moves.length;
  const move=boundary=>{if(route!==original){message('編集中に経路が変更されました。',true);return;}return moveRegrip(index,boundary);};
  return [{label:'1手前へ移動',disabled:at<=0,run:()=>move(at-1)},{label:'1手後へ移動',disabled:at>=count,run:()=>move(at+1)},
    {label:'移動先の境界を選ぶ',children:Array.from({length:count+1},(_,boundary)=>({label:boundary===0?'手順の先頭':boundary===count?'手順の末尾':`${boundary}手目の後`,disabled:boundary===at,run:()=>move(boundary)}))},
    {sep:true},{label:'この持ち替えを削除',run:()=>deleteRegrip(index)}];
}
async function deleteRegrip(index){
  if(searchBusy||applying||route.provenance!=='model-search')return;
  const rg=route.regrips[index];if(!rg)return;
  if(rg.initial_setup){closeCellMenu();message('これは開始ホールドを作る準備です。上部の'+(rg.hand==='R'?'右手':'左手')+'開始ホールドをFに変更して探索すると省けます。');return;}
  const boundary=rg.after_pos+1,pos=Math.min(boundary,route.moves.length-1);
  const cut=pos?route.moves[pos-1].path_index+1:0;
  const prefix={path:clone(route.path.slice(0,cut)),initial_holds:clone(route.initial_holds)};
  const pins=state.pins.filter(p=>!(p.pos===boundary&&(p.regrip_before||'no_regrip_before' in p))&&!(p.pos===boundary-1&&'regrip_after' in p));
  if(boundary===route.moves.length){pins.push({pos:boundary-1,regrip_after:false});if(!pins.some(p=>p.pos===pos&&p.action_id))pins.push({pos,action_id:route.moves[pos].key});}
  else pins.push({pos:boundary,no_regrip_before:true});
  closeCellMenu();
  if(await changeConditions(pins,state.exclude,pos,prefix))message('持ち替えを削除しました。この境界での再挿入を禁止して、後ろを再探索しました。');
}
$('#algorithm-form').addEventListener('submit',e=>{e.preventDefault();if(reconOn()){reconDialog();return;}loadDataset($('#alg').value);});
/* 上部バーの貼り付け。クリップボードの手順をそのまま入力欄へ入れて「探索」と同じ処理を走らせる。
   読めないとき（APIなし・権限拒否・空）は入力欄を選択状態にして、手で貼れるようにする。 */
$('#paste-alg').onclick=async()=>{
  const focusInput=()=>{const box=$('#alg');box.focus();box.select();};
  let text=null;
  try{if(navigator.clipboard&&typeof navigator.clipboard.readText==='function')text=await navigator.clipboard.readText();}catch{text=null;}
  if(typeof text!=='string'){focusInput();message('クリップボードを読めませんでした。手順を入力欄に貼り付けてください。',true);return;}
  text=text.trim();
  if(!text){focusInput();message('クリップボードに手順がありませんでした。手順を入力欄に貼り付けてください。',true);return;}
  $('#alg').value=normalizeInput(text);
  $('#algorithm-form').requestSubmit();
};
$('#dialog-close').onclick=closeDialog;
$('#examples').onclick=()=>{dialog('入力例',`<p>入力例を選ぶと学習済みモデルで探索します。</p>${fixtures.datasets.map((d,i)=>`<p><button data-example="${i}">${esc(d.alg)}</button></p>`).join('')}`);};
$('#dialog-content').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.example!==undefined){closeDialog();loadDataset(fixtures.datasets[+b.dataset.example].alg);}if(b.id==='choose-file')$('#file-input').click();if(b.id==='export-request')download('search-request.json',JSON.stringify(requestPayload(),null,2),'application/json');if(b.id==='download-score')download('finger-score.txt',t(formatScore(route))+'\n\n'+formatScore(route,true));});
/* ── 探索エンジンの表示 ──
   探索・正規化・表示補正をこのブラウザの WASM で回しているか、サーバの /api/* に出しているかを下段に出す。
   'auto' でブラウザ内を使えなかったときは、その理由を title に入れる。 */
function showEngine(){
  const box=$('#engine-status');if(!box)return;
  const status=engineStatus(),wasm=status.backend==='wasm';
  if(status.backend==='error'){
    uiText(box,'エンジン: 起動失敗');
    uiAttr(box,'title',status.fallbackReason||'ブラウザ内エンジンを起動できませんでした');
    return;
  }
  uiText(box,'エンジン: '+(wasm?'ブラウザ内':'読み込み中'));
  uiAttr(box,'title','推論はこの端末のブラウザ内で実行します');
}
engineReady().then(showEngine,showEngine);
/* 表示の設定。キューブの配色はU面とF面だけを選び、残り4面は24通りの向きから導く。
   選んだ色は layout.cubeU / layout.cubeF として localStorage の fingerweight.ui-v5.layout に残り、
   次回の起動時に applyLayout → paintCube で戻る。 */
const swatchStyle=name=>{const rgb=CUBE_PAINT[name];return rgb?`background:rgb(${rgb.join(',')})`:'';};
function swatchRow(face,current,disabledFor){
  return Object.keys(CUBE_NAME).map(v=>{
    const off=disabledFor&&disabledFor(v),on=v===current;
    return `<button type="button" class="swatch${on?' on':''}" data-face="${face}" data-color="${v}" style="${swatchStyle(v)}"`
      +` aria-pressed="${on}" aria-label="${CUBE_NAME[v]}" title="${CUBE_NAME[v]}"${off?' disabled':''}>${on?'✓':''}</button>`;
  }).join('');
}
function settingsDialog(){
  dialog('表示の設定',
    '<p><label>Language / 言語 <select data-locale-select aria-label="Language / 言語"><option value="ja" lang="ja">日本語</option><option value="en" lang="en">English</option></select></label></p>'
    +'<p class="small">キューブの配色。U面とF面を選ぶと、残りの4面は向きから決まります（白⇔黄・赤⇔橙・緑⇔青）。</p>'
    +'<div class="swatchrow"><span class="small">U面</span><span id="cube-up" class="swatches"></span></div>'
    +'<div class="swatchrow"><span class="small">F面</span><span id="cube-front" class="swatches"></span></div>'
    +'<p class="small muted" id="cube-derived"></p>'
    +'<p><label>キューブの種類 <select id="cube-style"><option value="stickered">黒素体＋ステッカー</option><option value="stickerless">ステッカーレス</option></select></label></p>'
    +'<p><label class="check"><input type="checkbox" id="recon-mode">Reconモード（β）</label></p>'
    +'<p class="small muted">スクランブルと解法を行ごとに入れて、ソルブ全体の指遣いを探索します。再生に「実時間」（入力したタイムに合わせた速さ）が加わります。</p>'
    +'<p class="small muted">推論はこの端末のブラウザ内で実行します。</p>'
    +'<button id="open-credits">クレジット・ライセンス</button>');
  $('#recon-mode').checked=reconOn();
  $('#recon-mode').onchange=e=>{layout.recon=e.target.checked;saveLayout();applyRecon();};
  if(new URLSearchParams(location.search).has('cubeCompare'))uiInsertHTML($('#cube-style'),'beforeend','<option value="legacy">旧モデル（接触比較用）</option>');
  $('#cube-style').value=layout.cubeStyle||'stickered';
  $('#cube-style').onchange=async e=>{try{await stage.setCubeStyle(e.target.value);if(e.target.value!=='legacy'){layout.cubeStyle=e.target.value;saveLayout();}bakedCubeColors=null;paintCube();}catch(error){message(error.message,true);}};
  $('#open-credits').onclick=creditsDialog;
  const up=$('#cube-up'),front=$('#cube-front');
  const describe=()=>{const scheme=currentScheme();uiText($('#cube-derived'),CUBE_FACES.map(f=>`${f} ${CUBE_NAME[scheme[f]]}`).join(' ／ '));};
  const paint=()=>{
    const allowed=validFronts(layout.cubeU);
    if(!allowed.includes(layout.cubeF))layout.cubeF=allowed[0];
    uiHTML(up,swatchRow('U',layout.cubeU));
    uiHTML(front,swatchRow('F',layout.cubeF,v=>!allowed.includes(v)));
    describe();
  };
  paint();
  for(const box of [up,front])box.onclick=e=>{
    const button=e.target.closest('.swatch');if(!button||button.disabled)return;
    if(button.dataset.face==='U')layout.cubeU=button.dataset.color;else layout.cubeF=button.dataset.color;
    saveLayout();paint();paintCube();
  };
}
/* クレジットとライセンス。⚙ の下から開き、「戻る」で設定へ返る。 */
const MIT_GODOT=`Copyright (c) 2014-present Godot Engine contributors.
Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const LINK=(href,text)=>`<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;
function creditsDialog(){
  dialog('クレジット・ライセンス',
    '<h3 class="credit-h">手モデル</h3>'
    +'<p class="small">手モデル：Godot OpenXR Hand Tracking Demo</p>'
    +`<p class="small">出典：Godot Engine Demo Projects → ${LINK('https://github.com/godotengine/godot-demo-projects/tree/master/xr/openxr_hand_tracking_demo','https://github.com/godotengine/godot-demo-projects/tree/master/xr/openxr_hand_tracking_demo')}</p>`
    +'<p class="small">ライセンス：MIT License</p>'
    +'<p class="small">本アプリでは、元のモデルに形状・リグ・ウェイトの調整、左右反転および独自の指使いアニメーションの追加を行っています。</p>'
    +`<details class="credit-license"><summary>MITライセンス全文を表示</summary><pre>${esc(MIT_GODOT)}</pre></details>`
    +'<h3 class="credit-h">キューブモデル</h3><p class="small">本プロジェクトで制作したオリジナルモデル（ステッカー版・ステッカーレス版）。外部メッシュ・画像テクスチャは使用していません。</p>'
    +'<button id="credits-back">戻る</button>');
  $('#credits-back').onclick=settingsDialog;
}
$('#settings').onclick=settingsDialog;
$('#open-files').onclick=()=>dialog('スケジュール・手順リストを読み込む','<p>探索結果の JSON、または1行1手順の TXT を読み込めます。</p><p class="small">YUBI GUIから書き出した指遣いのJSONを選んでください。複数の候補を一緒に読み込む場合は、同じ手順のものを使います。</p><p class="small muted">入力ファイルは読み取りのみ。対応していない動作は丸めず、理由を表示します。</p><button class="primary" id="choose-file">ファイルを選ぶ</button><button id="export-request">探索への要求JSONを書き出す</button>');
/* 読み込んだ経路の適用は、ファイル読込と「保存済み」からの復元で共有する。 */
async function loadImported(list,note){
  if(editBusy)throw Error('編集が終わるまでお待ちください。');
  const parsed=list.map((r,i)=>enrichWarped(validateRoute({...r,id:r.id||`import-${i}`,provenance:r.provenance==='synthetic-preview'?'synthetic-preview':'imported-schedule'}),catalog.rows));
  if(parsed.some(r=>r.alg!==parsed[0].alg||r.moves.length!==parsed[0].moves.length))throw Error('同一手順の候補をまとめて読み込んでください');
  const normalized=await normalizeAlg(parsed[0].alg);
  const tokens=normalized.split(/\s+/);
  if(parsed.some(r=>r.moves.length!==tokens.length||r.moves.some((m,i)=>!actionMatchesToken(m.row,tokens[i]))))throw Error('手順の回転と action_id の列が一致しません');
  const applied=await setRoute(parsed[0],{commit:()=>{
    state.labelTask=null;state.pins=[];state.exclude=[];state.history=[];state.redo=[];state.prefix=null;state.imported=clone(list);
    recon=null;searchRequest=null;lastEnd=null;bank=parsed;routes=activeSet();selected=0;
    $('#alg').value=parsed[0].alg;uiText($('#mode-note'),'読込スケジュール ／ 探索ボタンでモデル評価');labelContext();
  }});
  if(!applied)throw Error('別の操作で読み込みが置き換えられました。');
  message(note);return parsed;
}
window.addEventListener('open-saved-route',async e=>{
  const entry=e.detail?.entry;if(!entry?.route)return;
  if(!catalog||!stage||searchBusy||applying){message('初期化・探索が完了してから選んでください。',true);return;}
  try{await loadImported([clone(entry.route)],'保存した指使いを読み込みました。「探索」でモデル候補と比較できます。');}
  catch(error){message(error.message,true);}
});
$('#file-input').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const text=await file.text();if(file.name.endsWith('.txt')){state.queue=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);state.queueIndex=0;queueStatus();persist();closeDialog();if(state.queue.length)await loadDataset(state.queue[0]);}else{const data=JSON.parse(text),raw=Array.isArray(data)?data:Array.isArray(data?.routes)?data.routes:data?.route?[data.route]:null,list=raw?.map(value=>value?.route??value);if(!Array.isArray(list)||!list.length)throw Error('YUBI GUIの保存JSON、または1行1手順のTXTを選んでください。');closeDialog();await loadImported(list,`${list.length}経路を読み込みました。入力スケジュールの時刻をそのまま表示します。`);}}catch(error){message(error.message,true);}finally{e.target.value='';}};
$('#timeline').addEventListener('click',e=>{
  const el=e.target.closest('button');if(!el||!route)return;if(suppressRegripClick&&el.dataset.rg!==undefined){e.preventDefault();return;}
  if(el.dataset.cell!==undefined||el.dataset.cycle!==undefined){selectCell(+(el.dataset.cell??el.dataset.cycle));cellMenu(e);return;}
  if(el.dataset.wait!==undefined){selectCell(+el.dataset.wait);message(el.title);return;}
  if(el.dataset.rg!==undefined){
    const index=+el.dataset.rg,r=shownRoute().regrips[index];
    selectCell(Math.min(route.moves.length-1,(r.after_pos??-1)+1),false);
    stage.playing=false;stage.seek(r.start);
    message(`RG:${r.hand}:${r.hold_from}>${r.hold_to} · ${number(r.start)}–${number(r.end)} · 手順上の位置: ${r.after_pos<0?'先頭':(r.after_pos+1)+'手目の後'}`);
    closeCellMenu();popupOrigin=el;popup(regripMoveItems(index),menuPoint(e));return;
  }
  if(el.dataset.lane){selected=Math.max(0,Math.min(route.moves.length-1,+el.dataset.pos));selectedLane=el.dataset.lane;timeline();hud();candidateList();message(el.title);cellMenu(e);}
});
$('#timeline').addEventListener('contextmenu',e=>{
  if(!route)return;
  const rg=e.target.closest('[data-rg]');
  if(rg){e.preventDefault();closeCellMenu();popup(regripMoveItems(+rg.dataset.rg),menuPoint(e));return;}
  const cell=e.target.closest('[data-cell],[data-cycle]');
  if(cell){e.preventDefault();selectCell(+(cell.dataset.cell??cell.dataset.cycle));cellMenu(e);}
});
/* Regrip pointer drag uses existing cells; no persistent controls or extra row. */
let regripDrag=null,suppressRegripClick=false;
function finishRegripDrag(){
  const drag=regripDrag;if(!drag)return;regripDrag=null;
  if(drag.timer)clearInterval(drag.timer);for(const marker of drag.markers||[])marker.remove();
  drag.button.style.opacity='';try{drag.button.releasePointerCapture(drag.pointerId);}catch{}
  if(drag.active){suppressRegripClick=true;setTimeout(()=>{suppressRegripClick=false;},0);}return drag;
}
function updateRegripDrag(){
  const drag=regripDrag;if(!drag?.active)return;
  if(route!==drag.route){finishRegripDrag();return;}
  const area=$('#timeline'),rect=area.getBoundingClientRect();
  if(drag.x<rect.left+28)area.scrollLeft-=14;else if(drag.x>rect.right-28)area.scrollLeft+=14;
  const cells=[...area.querySelectorAll('.symrow [data-cell]')],track=area.querySelector('.symrow .tk');if(!cells.length||!track)return;
  const positions=cells.map(cell=>cell.getBoundingClientRect().left).concat(cells.at(-1).getBoundingClientRect().right);
  const boundary=positions.reduce((best,x,i)=>Math.abs(x-drag.x)<Math.abs(positions[best]-drag.x)?i:best,0);
  if(!drag.markers.length)for(let n=0;n<positions.length;n++){const marker=document.createElement('i');marker.style.cssText='position:absolute;top:0;bottom:0;width:2px;background:#6ba6d6;pointer-events:none;z-index:6';track.append(marker);drag.markers.push(marker);}
  const left=track.getBoundingClientRect().left;drag.markers.forEach((marker,i)=>{marker.style.left=(positions[i]-left)+'px';marker.style.opacity=i===boundary?'1':'.25';});
  if(drag.boundary===boundary)return;drag.boundary=boundary;drag.valid=false;drag.markers[boundary].style.background='#e5b449';
  try{regripMoveTarget(drag.index,boundary);drag.valid=true;message('離すと、この位置を固定して他の指遣いを再探索します。');}
  catch(error){drag.markers[boundary].style.background='#e46767';message(error.message,true);}
}
$('#timeline').addEventListener('pointerdown',e=>{
  const button=e.target.closest('[data-rg]');if(!button||e.button!==0||editBusy||searchBusy||applying||recording)return;
  finishRegripDrag();regripDrag={button,index:+button.dataset.rg,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,x:e.clientX,route,active:false,boundary:null,markers:[]};
});
$('#timeline').addEventListener('pointermove',e=>{
  const drag=regripDrag;if(!drag||e.pointerId!==drag.pointerId)return;drag.x=e.clientX;
  if(!drag.active&&Math.abs(e.clientY-drag.startY)>6&&Math.abs(e.clientY-drag.startY)>Math.abs(e.clientX-drag.startX)){finishRegripDrag();return;}
  if(!drag.active&&Math.abs(e.clientX-drag.startX)>=6){drag.active=true;closeCellMenu();stage.playing=false;drag.button.style.opacity='.55';drag.button.setPointerCapture(e.pointerId);drag.timer=setInterval(updateRegripDrag,50);}
  if(drag.active){e.preventDefault();updateRegripDrag();}
});
$('#timeline').addEventListener('pointerup',e=>{if(!regripDrag||e.pointerId!==regripDrag.pointerId)return;const drag=finishRegripDrag();if(drag.active){e.preventDefault();if(route===drag.route)moveRegrip(drag.index,drag.boundary);else message('編集中に経路が変更されました。',true);}});
for(const name of ['pointercancel','lostpointercapture'])$('#timeline').addEventListener(name,()=>finishRegripDrag());
$('#timeline').addEventListener('keydown',e=>{const button=e.target.closest('[data-rg]');if(!button||!['ArrowLeft','ArrowRight'].includes(e.key)||e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;e.preventDefault();e.stopPropagation();const rg=route.regrips[+button.dataset.rg];moveRegrip(+button.dataset.rg,rg.after_pos+1+(e.key==='ArrowLeft'?-1:1));});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&regripDrag){e.preventDefault();finishRegripDrag();message('持ち替えの移動を取り消しました。');}});
window.addEventListener('blur',finishRegripDrag);
/* 尺度は譜面の描き方と再生の間合いを兼ねる。経路を作り直してからチャートを引き直す。 */
$('#scale-seg').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(layout.scale===b.dataset.mode)return;layout.scale=b.dataset.mode;saveLayout();$$('#scale-seg button').forEach(x=>x.classList.toggle('on',x===b));if(route&&!searchBusy&&!editBusy&&!applying)setRoute(route);else timeline();};
$('#zoom-seg').onclick=e=>{const b=e.target.closest('button');if(!b)return;zoom=Math.max(.5,Math.min(3,zoom*(+b.dataset.z>0?ZOOM_STEP:1/ZOOM_STEP)));timeline();};
$('#diff-only').onchange=()=>{layout.diff=$('#diff-only').checked;saveLayout();candidateList();};
$('#candidates').onclick=e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.pickRoute!==undefined){const target=routes.find(r=>r.id===b.dataset.pickRoute);if(!target)return;const pos=Math.max(0,Math.min(target.moves.length-1,+b.dataset.pickPos));if(route.recon){reconPick(target.id,pos);closeSheet();return;}if(target.id===route.id)selectCell(pos);else chooseCandidate(target,pos);closeSheet();return;}
 if(b.dataset.choose){if(route.recon)reconPick(b.dataset.choose,null);else chooseCandidate(routes.find(r=>r.id===b.dataset.choose));closeSheet();}
 if(route?.recon)return;
 if(b.dataset.up!==undefined)reorder(+b.dataset.up,+b.dataset.up-1);if(b.dataset.down!==undefined)reorder(+b.dataset.down,+b.dataset.down+1);};
let dragFrom=null;
$('#candidates').ondragstart=e=>{const row=e.target.closest('[data-route]');dragFrom=null;if(!row)return;const item=routes.find(r=>r.id===row.dataset.route);if(!item)return;dragFrom=item;e.dataTransfer.setData('application/x-yubi-route',item.id);e.dataTransfer.effectAllowed='move';row.classList.add('dragging');};
$('#candidates').ondragover=e=>{if(dragFrom&&routes.includes(dragFrom))e.preventDefault();};
$('#candidates').ondrop=e=>{const item=dragFrom;dragFrom=null;const row=e.target.closest('[data-route]');if(!item||!row||e.dataTransfer.getData('application/x-yubi-route')!==item.id)return;e.preventDefault();reorder(routes.indexOf(item),routes.findIndex(r=>r.id===row.dataset.route));};
$('#candidates').ondragend=()=>{dragFrom=null;$$('.dragging').forEach(el=>el.classList.remove('dragging'));};
/* ── 動画として保存 ──
   3Dの canvas をそのまま MediaRecorder で録る。サーバも外部ライブラリも使わない。
   録画中だけステージを 3:4（540×720 CSS px）の箱にする。viewer.js は ResizeObserver で
   element.clientWidth/Height を見て renderer.setSize するので、箱を変えれば描画バッファも
   縦長になる（devicePixelRatio 倍。viewer.js には触っていない）。
   iOS Safari は video/mp4 しか録れず、ダウンロードではなく共有シートになることがある。 */
const VIDEO_TYPES=['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'];
/* 動画は正方形で録る。three.js は縦の画角（camera.fov）を保ち、横の画角を aspect ぶん狭めるので、
   半径 r の球を収めるのに要る距離は縦・横の半画角の小さいほうで決まる：
     halfV = fov/2、halfH = atan(tan(fov/2)*aspect)、d = r / sin(min(halfV,halfH))。
   純粋な関数にしてあるので、three.js が無くても数値で確かめられる。 */
/* 動画は 4:3 の横長。箱は 640×480 CSS px を上限に、画面に収まるところまで縮める。
   寄りは CAPTURE_FRAME で決める：キューブの外接球の半径をこの倍率にしたものが画角にちょうど収まる
   距離へカメラを置く。1.0 ならキューブが画面いっぱい、1.15 でその周りに手のぶんの余白が少し残る。
   指が画面の端に触れることはある（そこまで寄せたい、という指定）。値を変えれば寄り／引きを調整できる。 */
const CAPTURE_WIDTH=640, CAPTURE_RATIO=4/3, CAPTURE_FRAME=1.15, CAPTURE_MARGIN=1.0;
function fitDistance(radius,fov,aspect,margin=CAPTURE_MARGIN){
  if(!(radius>0)||!(fov>0)||!(aspect>0))return 0;
  const halfV=fov/2,halfH=Math.atan(Math.tan(halfV)*aspect),half=Math.min(halfV,halfH);
  return radius*margin/Math.sin(half);
}
/* キューブの外接球の半径。キュービーの中心は ±pitch、箱の一辺は 0.955*pitch なので
   軸ごとの半分の伸びは 1.5*pitch（半キュービーぶんを少し多めに見る）。 */
function cubeRadius(view){
  const pitch=view?.pitch;
  if(!Array.isArray(pitch)||pitch.length<3)return 0;
  const half=pitch.map(v=>Math.abs(+v||0)*1.5);
  return Math.hypot(half[0],half[1],half[2]);
}
/* 画角合わせに使う半径。手の頂点まで測ると、前腕や手首が伸びている瞬間に半径がふくらんで
   画がだいぶ引きになる。キューブの外接球だけを基準にして CAPTURE_FRAME 倍する。 */
function captureRadius(view){
  return cubeRadius(view)*CAPTURE_FRAME;
}
function videoType(){
  if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function')return null;
  return VIDEO_TYPES.find(t=>MediaRecorder.isTypeSupported(t))||null;
}
function videoSupported(){
  return !!videoType()&&typeof HTMLCanvasElement!=='undefined'&&typeof HTMLCanvasElement.prototype.captureStream==='function';
}
let recording=false,recordingSession=null;
function cancelRecording(){
  if(!recordingSession)return;
  recordingSession.cancelled=true;
  const error=new Error('動画の記録を取り消しました。');error.name='AbortError';recordingSession.reject?.(error);
}
async function saveVideo(){
  if(recording||!route||!stage)return;
  const type=videoType(),canvas=stage.element?.querySelector('canvas');
  if(!type||!canvas||typeof canvas.captureStream!=='function'){message('このブラウザは動画の保存に対応していません。',true);return;}
  recording=true;recordingSession={cancelled:false,reject:null};closeDialog();
  const view=shownRoute(),targetRoute=route,back=stage.time,captureSpeed=stage.speed;
  /* 4:3 の箱。幅も高さも画面に収める。 */
  const width=Math.max(240,Math.min(CAPTURE_WIDTH,innerWidth,Math.floor(innerHeight*CAPTURE_RATIO)));
  const height=Math.round(width/CAPTURE_RATIO);
  document.documentElement.style.setProperty('--capw',width+'px');
  document.documentElement.style.setProperty('--caph',height+'px');
  const cam=stage.camera,ctl=stage.controls;
  const cameraBack=cam?{x:cam.position.x,y:cam.position.y,z:cam.position.z,aspect:cam.aspect}:null;
  $('#confirm-path').disabled=true;$('#search-button').disabled=true;$('#main-view').disabled=true;
  document.body.classList.add('recording');
  let recorder=null,timer=null,stream=null,downloadURL=null,recorderError=null;
  try{
    /* 箱を変えてから ResizeObserver と描画が追いつくのを待つ。canvas が 4:3 になり、
       camera.aspect も 4/3 になってから録り始める（最大およそ1秒待つ）。 */
    let ready=false;
    for(let tries=0;tries<30&&!ready;tries++){
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const ratio=canvas.height?canvas.width/canvas.height:0;
      ready=Math.abs(ratio-CAPTURE_RATIO)<0.03&&(!cam||Math.abs(cam.aspect-CAPTURE_RATIO)<0.03);
    }
    if(recordingSession.cancelled){const error=new Error('動画の記録を取り消しました。');error.name='AbortError';throw error;}
    if(!ready)throw Error('3Dの表示を4:3に切り替えられませんでした');
    /* キューブの外接球×CAPTURE_FRAME が画角にちょうど収まる距離へ、注視点はそのまま
       視線方向に沿って動かす（寄せも引きもする）。向きと注視点は変えない。 */
    if(cam&&ctl){
      const radius=captureRadius(stage);
      const want=fitDistance(radius,cam.fov*Math.PI/180,cam.aspect);
      const away=cam.position.clone().sub(ctl.target);
      if(want>0&&away.length()>1e-6){away.setLength(want);cam.position.copy(ctl.target).add(away);}
      cam.updateProjectionMatrix();ctl.update();
    }
    const chunks=[];stream=canvas.captureStream(30);
    recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:6000000});
    recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
    const stopped=new Promise(done=>{recorder.onstop=()=>{if(recordingSession?.reject)cancelRecording();done();};});
    recorder.onerror=e=>{recorderError=new Error(e.error?.message||'録画中にエラーが発生しました。');recordingSession?.reject?.(recorderError);};
    stage.playing=false;playUntil=null;
    stage.seek(view.playback_start||0);
    const duration=Math.max(0.01,stage.duration||displayEnd(view));
    message('動画を記録中… 0%');
    recorder.start();
    stage.speed=captureSpeed;stage.playing=true;
    await new Promise((done,reject)=>{
      recordingSession.reject=reject;
      timer=setInterval(()=>{
        message(`動画を記録中… ${Math.min(100,Math.round(stage.time/duration*100))}%`);
        if(recorderError){reject(recorderError);return;}
        if(recordingSession.cancelled||route!==targetRoute||!stage.playing&&stage.time<duration-1e-6){cancelRecording();return;}
        if(stage.time>=duration-1e-6){clearInterval(timer);timer=null;recordingSession.reject=null;done();}
      },120);
    });
    await new Promise(r=>setTimeout(r,300));
    if(recordingSession.cancelled||recorderError){const error=recorderError||new Error('動画の記録を取り消しました。');if(!recorderError)error.name='AbortError';throw error;}
    recorder.stop();await stopped;
    if(recordingSession.cancelled||recorderError){const error=recorderError||new Error('動画の記録を取り消しました。');if(!recorderError)error.name='AbortError';throw error;}
    const blob=new Blob(chunks,{type});
    if(!blob.size)throw Error('フレームを取得できませんでした');
    const name=`yubi-gui-${String(targetRoute.alg||'route').replace(/\s+/g,'').replace(/[\\/:*?"<>|]/g,'')||'route'}.${type.startsWith('video/mp4')?'mp4':'webm'}`;
    const url=downloadURL=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);downloadURL=null;
    message(`動画を保存しました（${name}）。`);
  }catch(e){message(e.name==='AbortError'?'動画の記録を取り消しました。':'動画の保存に失敗しました：'+(e.message||e),e.name!=='AbortError');}
  finally{
    if(timer)clearInterval(timer);if(recordingSession)recordingSession.reject=null;
    if(recorder){recorder.ondataavailable=null;recorder.onerror=null;recorder.onstop=null;}
    try{if(recorder&&recorder.state!=='inactive')recorder.stop();}catch{}
    for(const track of stream?.getTracks?.()||[])try{track.stop();}catch{}
    if(downloadURL)URL.revokeObjectURL(downloadURL);
    document.body.classList.remove('recording');
    document.documentElement.style.removeProperty('--capw');document.documentElement.style.removeProperty('--caph');
    /* 視点と画角をそのまま戻す。箱が戻れば ResizeObserver が aspect を引き直すが、
       ここでも書き戻しておく。 */
    if(cam&&cameraBack){
      cam.position.set(cameraBack.x,cameraBack.y,cameraBack.z);
      cam.aspect=cameraBack.aspect;cam.updateProjectionMatrix();ctl?.update();
    }
    if(route===targetRoute){stage.playing=false;playUntil=null;stage.seek(back);}
    $('#confirm-path').disabled=false;$('#search-button').disabled=searchBusy;$('#main-view').disabled=false;
    recording=false;recordingSession=null;
  }
}
/* 「保存・共有」。端末内の保存（localStorage）、動画、共有リンクの3つを1つのダイアログに並べる。 */
let shareTableCache=null;
const shareTableNow=()=>shareTableCache??=shareTable(catalog.rows);
/* 共有する文。1行目は「名前: 手順」（名前が無ければ手順だけ）、2行目は案内、3行目がリンク。 */
function buildShare(name){
  if(!route.path?.length)throw Error('この指使いは共有リンクにできません（経路の情報が足りません）。一度「探索」してから共有してください。');
  const code=encodeShareCode({path:route.path,initial_holds:route.initial_holds,start_holds:searchRequest?.start_holds||readStartHolds(),alg:route.alg},shareTableNow());
  const url=`${location.origin}${location.pathname}#${SHARE_KEY}=${code}`;
  const title=name&&name!==route.alg?`${name}: ${route.alg}`:route.alg;
  const text=t('{0}\nYUBI GUIで指遣いを見る',{0:title});
  return {url,text,full:`${text}\n${url}`};
}
async function copyText(text){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}}catch{}
  const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.append(area);area.select();area.setSelectionRange(0,text.length);
  let ok=false;try{ok=document.execCommand('copy');}catch{}area.remove();return ok;
}
$('#confirm-path').onclick=()=>{
  if(!route)return;
  const video=videoSupported()?'<button id="myroute-video">動画として保存</button>':'';
  const videoNote=videoSupported()
    ?'<p class="small muted">動画：3Dの表示を 4:3 の動画にして、この端末にダウンロードします。キューブと手が画面いっぱいになる位置から、いまの速度と尺度のまま最初から最後まで記録します。</p>'
    :'<p class="small muted">このブラウザは動画の保存に対応していません。</p>';
  dialog('保存・共有',`<label>名前<input id="myroute-name" type="text" maxlength="120" value="${esc(state.labelTask?.name||route.alg)}"></label><p class="small">保存はこの端末のブラウザに残します。共有は、同じ手順・指遣いを開けるリンクと説明文を作ります。</p><div class="save-actions"><button class="primary" id="myroute-save">保存</button>${video}<button id="myroute-share">共有</button></div>${videoNote}<section id="share-box" class="share-box" hidden></section>`);
  const input=$('#myroute-name');input.focus();input.select();
  const videoButton=document.getElementById('myroute-video');if(videoButton)videoButton.onclick=saveVideo;
  $('#myroute-save').onclick=()=>{
    try{addRoutes([{id:crypto.randomUUID(),name:input.value.trim()||route.alg,alg:route.alg,at:new Date().toISOString(),route:clone(route)}]);}
    catch{message('端末に保存できませんでした（容量不足の可能性）。JSONを書き出して保管してください。',true);return;}
    closeDialog();message('この指使いを端末に保存しました。「保存済み」タブで開けます。');
    window.dispatchEvent(new Event('saved-record'));
  };
  $('#myroute-share').onclick=async()=>{
    const box=$('#share-box');box.hidden=false;uiHTML(box,'<p class="small">共有リンクを作成中…</p>');
    let share;
    try{share=buildShare(input.value.trim());}
    catch(e){uiHTML(box,`<p class="small share-error">${esc(e.message)}</p>`);return;}
    const canShare=typeof navigator.share==='function';
    uiHTML(box,`<p class="small">この文をコピーして送ってください。リンクを開いた人は、同じ手順・指遣いを見られます。</p><textarea id="share-text" readonly rows="4" aria-label="共有する文とリンク"></textarea><div class="save-actions"><button class="primary" id="share-copy">文とリンクをコピー</button><button id="share-copy-url">リンクだけコピー</button>${canShare?'<button id="share-native">ほかのアプリで共有</button>':''}</div><p id="share-status" class="small muted" role="status"></p>`);
    const area=$('#share-text');area.value=share.full;area.onfocus=()=>area.select();
    const status=$('#share-status');
    $('#share-copy').onclick=async()=>{uiText(status,await copyText(share.full)?'文とリンクをコピーしました。':'コピーできませんでした。上の欄を長押しして選択してください。');};
    $('#share-copy-url').onclick=async()=>{uiText(status,await copyText(share.url)?'リンクをコピーしました。':'コピーできませんでした。上の欄を長押しして選択してください。');};
    const native=document.getElementById('share-native');
    if(native)native.onclick=async()=>{try{await navigator.share({text:share.text,url:share.url});uiText(status,'共有しました。');}catch(e){if(e?.name!=='AbortError')uiText(status,'共有できませんでした：'+(e.message||e));}};
  };
};
/* 共有リンクを開く。最後の回転だけ固定・それより前を prefix にして探索し、共有元と同じ経路を1位に出す。
   開いた後はふつうの探索結果として編集できるよう、searchRequest は条件なしの探索として持つ。 */
function replayAliases(result,id){return {...result,id,moves:result.moves.map((m,i)=>({...m,i})),regrips:(result.regrips||[]).map(r=>({...r,hold_from:r.hold_before,hold_to:r.hold_after,after_pos:result.moves.filter(m=>m.path_index<r.path_index).length-1}))};}
async function openShared(code){
  try{
    const data=decodeShareCode(code,shareTableNow());
    const isRegrip=k=>catalog.rows.find(r=>r.engine_key===k)?.move==='REGRIP';
    const request=shareRequest(data,isRegrip);
    const response=await apiFetch('/api/refresh-schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    const result=await readJSON(response,'/api/refresh-schedule');if(!response.ok)throw Error(result.error||'共有された経路を再現できません。');
    if(JSON.stringify(result.path)!==JSON.stringify(data.path)||['R','L'].some(hand=>result.initial_holds?.[hand]!==data.initial_holds[hand]))throw Error('共有された経路を正確に再現できません。');
    // refresh returns scheduler events; attach the UI's positional aliases.
    const replay=replayAliases(result,'shared-0');
    await loadImported([replay],'共有された指遣いを開きました。');
    for(const hand of ['R','L'])setStartHold(hand,data.start_holds[hand]);
    state.startHolds=readStartHolds();$('#initial-state').value='none';lastEnd=null;searchRequest=null;persist();
    uiText($('#mode-note'),'共有リンクの指遣い ／ 探索ボタンでモデル候補と比較');
    try{history.replaceState(null,'',location.pathname+location.search);}catch{}
    $('#message').classList.add('notice');clearTimeout(messageTimer);messageTimer=setTimeout(dismissMessage,6000);return true;
  }catch(e){message(e.message,true);return false;}
}
window.addEventListener('hashchange',()=>{
  const code=shareCodeFrom(location.hash);if(!code)return;
  if(!catalog||!stage||searchBusy||applying){message('初期化・探索が完了してから、もう一度リンクを開いてください。',true);return;}
  openShared(code);
});
$('#clear-pins').onclick=()=>changeConditions([],state.exclude,null,null);
$('#undo').onclick=()=>travelHistory(false);if($('#redo'))$('#redo').onclick=()=>travelHistory(true);
/* 再生はPCもスマホも同じ処理。▶ は再生中に ⏸ へ変わる。 */
function playToggle(){
  if(recording){cancelRecording();return;}
  if(!stage)return;
  if(stage.playing){stage.playing=false;syncPlayGlyph();return;}
  playUntil=null;
  if(stage.time>=stage.duration)stage.seek(shownRoute()?.playback_start||0);
  stage.playing=true;syncPlayGlyph();
}
function transport(act){
  if(act==='playtoggle'){playToggle();return;}
  if(!route)return;
  if(act==='first'||act==='prev'||act==='next'||act==='last')stepGo(act);
}
$('#main-steps').onclick=e=>{const b=e.target.closest('[data-act]');if(!b)return;transport(b.dataset.act);};
$('#scrubber').oninput=e=>{playUntil=null;stage.playing=false;stage.seek(+e.target.value);};
$('#main-speeds').onclick=e=>{const b=e.target.closest('[data-speed]');if(!b)return;applySpeed(b.dataset.speed);};$('#main-view').onchange=e=>{if(!recording)stage.view(e.target.value);};
$('#queue-next').onclick=nextQueue;
$('#export').onclick=()=>dialog('書き出す','<p>現在の譜面と、探索への要求をローカルファイルに書き出します。</p><button id="download-score">譜面（日本語・ASCII）</button><button id="export-request">探索への要求 JSON</button>');
window.addEventListener('workspace-view',()=>{cancelRecording();if(stage){stage.visible=!document.body.dataset.workspace||document.body.dataset.workspace==='search';stage.needsRender=true;if(!stage.visible)stage.playing=false;}});
document.addEventListener('keydown',e=>{
  if(document.body.dataset.workspace&&document.body.dataset.workspace!=='search')return;
  if((e.ctrlKey||e.metaKey)&&!e.defaultPrevented&&e.keyCode!==229&&!e.altKey&&!e.isComposing&&!e.target.isContentEditable&&!e.target.closest?.('input,textarea,[contenteditable]:not([contenteditable=false])')&&!$('#dialog').open){
    const key=e.key.toLowerCase();if(key==='z'||key==='y'&&e.ctrlKey&&!e.metaKey){e.preventDefault();travelHistory(key==='y'||e.shiftKey);return;}
  }
  if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.ctrlKey||e.metaKey||e.altKey||e.target.isContentEditable||e.target.closest?.('input,select,textarea,button,a[href],[role=button],[role=tab],[contenteditable]:not([contenteditable=false])')||$('#dialog').open)return;
  if(e.key==='P'){e.preventDefault();setCollapsed(!layout.collapsed);return;}
  if(popupMenus.length||!route)return;
  if(e.code==='Space'){e.preventDefault();playToggle();}
  if(e.key==='ArrowLeft'){e.preventDefault();stepGo('prev');}if(e.key==='ArrowRight'){e.preventDefault();stepGo('next');}
  if(e.key==='Escape'){closeCellMenu();dismissMessage();}
  if(e.key==='n')nextQueue();
  if(e.key==='Enter')$('#confirm-path').click();if(/^[1-5]$/.test(e.key)&&routes[+e.key-1]&&!route.recon)chooseCandidate(routes[+e.key-1]);
  const finger={i:'index',m:'middle',r:'ring',t:'thumb',p:'pinky',w:'wrist'}[e.key];if(finger){const next=legalOptions().find(r=>r.finger===finger);if(next)pin({pos:selected,action_id:next.engine_key});else message('このセルに該当する指の合法配置はありません。',true);}
  if(['L','R'].includes(e.key)){const next=legalOptions().find(r=>r.hand===e.key);if(next)pin({pos:selected,action_id:next.engine_key});}
});


/* ── 右パネル・仕切り・記憶（キー fingerweight.ui-v5.layout） ── */
function switchPanel(name){
  cancelRecording();
  layout.panelTab=name;saveLayout();document.body.dataset.panel=name;
  for(const n of ['cand','label','saved']){
    const tab=$('#tab-'+n);tab.setAttribute('aria-selected',String(n===name));tab.tabIndex=n===name?0:-1;
    $('#'+n+'-workspace').hidden=n!==name;$('#pfilter-'+n).hidden=n!==name;$('#pfoot-'+n).hidden=n!==name;
  }
  window.dispatchEvent(new Event('panel-view'));
  if(name==='label')window.dispatchEvent(new Event('label-tasks-open'));
  if(name==='saved')window.dispatchEvent(new Event('saved-paths-open'));
}
function applyPanel(){
  if(narrowScreen()){$('#panel').hidden=false;$('#vsplit').hidden=true;$('#rail').hidden=true;return;}
  document.body.classList.remove('panel-open');
  $('#panel').hidden=layout.collapsed;$('#vsplit').hidden=layout.collapsed;$('#rail').hidden=!layout.collapsed;
}
function setCollapsed(value){
  layout.collapsed=value;saveLayout();
  if(narrowScreen())document.body.classList.toggle('panel-open',!value);else applyPanel();
}
function openPanel(){if(narrowScreen())document.body.classList.add('panel-open');else setCollapsed(false);}
function closeSheet(){document.body.classList.remove('panel-open');}
for(const name of ['cand','label','saved']){const tab=$('#tab-'+name);tab.onclick=()=>{openPanel();switchPanel(name);};tab.onkeydown=e=>{const names=['cand','label','saved'],i=names.indexOf(name);let next;if(e.key==='ArrowRight')next=(i+1)%3;else if(e.key==='ArrowLeft')next=(i+2)%3;else if(e.key==='Home')next=0;else if(e.key==='End')next=2;else return;e.preventDefault();openPanel();switchPanel(names[next]);$('#tab-'+names[next]).focus();};}
$('#panel-collapse').onclick=()=>{if(narrowScreen())closeSheet();else setCollapsed(true);};
$('#panel-expand').onclick=()=>setCollapsed(false);
window.addEventListener('pointerdown',e=>{if(document.body.classList.contains('panel-open')&&!e.target.closest('#panel')&&!e.target.closest('[data-act="panel"]')&&!e.target.closest('.cell-popup'))closeSheet();});
(function splitters(){
  let dh=false,dv=false;
  $('#vsplit').addEventListener('pointerdown',e=>{dh=true;document.body.classList.add('dragging');e.preventDefault();});
  $('#hsplit').addEventListener('pointerdown',e=>{dv=true;document.body.classList.add('draggingV');e.preventDefault();});
  document.addEventListener('pointermove',e=>{
    if(dh){layout.pw=Math.round(Math.max(260,Math.min(innerWidth-360,innerWidth-e.clientX)));document.documentElement.style.setProperty('--pw',layout.pw+'px');}
    if(dv){layout.ch=Math.round(Math.max(150,Math.min(innerHeight-260,innerHeight-e.clientY)));document.documentElement.style.setProperty('--ch',layout.ch+'px');}
  });
  document.addEventListener('pointerup',()=>{if(dh||dv){saveLayout();timeline();}dh=dv=false;document.body.classList.remove('dragging');document.body.classList.remove('draggingV');});
})();
/* ── スマホ：ページのピンチ拡大・ダブルタップ拡大を止める（3Dの上だけは OrbitControls に渡す） ── */
(function(){
  const inStage=t=>!!t?.closest?.('#main-stage');
  document.addEventListener('gesturestart',e=>{if(!inStage(e.target))e.preventDefault();},{passive:false});
  document.addEventListener('gesturechange',e=>{if(!inStage(e.target))e.preventDefault();},{passive:false});
  document.addEventListener('touchmove',e=>{if(e.touches.length>1&&!inStage(e.target))e.preventDefault();},{passive:false});
})();
/* ── スマホの操作段。id を重ねず、本体のボタンを click() する ── */
/* 3D の見た目：背景を画面と同じ暗い放射グラデーションにし、既定の視点を1.5倍に寄せる。stage.js は変更しない。 */
const STAGE_ZOOM=1.5;
/* 視点は stage.js のプリセットを当てたあと、注視点まわりに仰角を13°足して少し上から見下ろす。
   距離と方位はそのままで、真上に回り込まないよう87°で止める。OrbitControls はそのまま使える。 */
const STAGE_LIFT=13*Math.PI/180, STAGE_LIFT_MAX=87*Math.PI/180;
async function stageLook(){
  if(!stage)return;
  try{
    const THREE=await import('three');
    const c=document.createElement('canvas');c.width=c.height=512;const g=c.getContext('2d');
    const grad=g.createRadialGradient(256,176,8,256,176,440);grad.addColorStop(0,'#1b2027');grad.addColorStop(1,'#0c0e11');
    g.fillStyle=grad;g.fillRect(0,0,512,512);
    const tex=new THREE.CanvasTexture(c);if('SRGBColorSpace' in THREE)tex.colorSpace=THREE.SRGBColorSpace;
    const apply=()=>{if(stage.scene)stage.scene.background=tex;};
    apply();
    const originalView=stage.view.bind(stage);
    stage.view=name=>{originalView(name);apply();zoomStage();};
    zoomStage();
  }catch(e){console.warn('stage look',e);}
}
function zoomStage(){
  if(recording)return;/* 録画中の画角合わせを上書きしない */
  const cam=stage?.camera,ctl=stage?.controls;if(!cam||!ctl)return;
  const v=cam.position.clone().sub(ctl.target).multiplyScalar(1/STAGE_ZOOM);
  const r=v.length(),flat=Math.hypot(v.x,v.z);
  if(r>1e-6&&flat>1e-6){
    const next=Math.min(Math.atan2(v.y,flat)+STAGE_LIFT,STAGE_LIFT_MAX),k=Math.cos(next)*r/flat;
    v.set(v.x*k,Math.sin(next)*r,v.z*k);
  }
  cam.position.copy(ctl.target).add(v);ctl.update();
}
/* 再生・一時停止はインラインSVGの出し分け。文字を使わないので絵文字に化けない。 */
function syncPlayGlyph(){
  const playing=!!stage?.playing;
  for(const id of ['#m-play','#main-play']){
    const button=$(id);if(!button)continue;
    uiAttr(button,'aria-label',playing?'一時停止':'再生');
    button.querySelector('.ic-play')?.toggleAttribute('hidden',playing);
    button.querySelector('.ic-pause')?.toggleAttribute('hidden',!playing);
  }
}
/* スマホの「探索」は上部の #search-button を押すだけなので、状態（探索中・押せない）もそちらをそのまま写す。
   探索・再探索・動画記録・起動待ちのどれで変わっても追従するよう、属性と文字の変化を監視する。 */
(()=>{
  const source=$('#search-button'),mirror=document.querySelector('.mfoot [data-act="search"]');if(!source||!mirror)return;
  const sync=()=>{uiText(mirror,searchBusy?'探索中…':'探索');mirror.disabled=source.disabled;mirror.classList.toggle('busy',searchBusy);mirror.setAttribute('aria-busy',String(searchBusy));};
  new MutationObserver(sync).observe(source,{attributes:true,attributeFilter:['disabled'],childList:true,characterData:true,subtree:true});sync();
})();
document.querySelector('.mfoot').onclick=e=>{
  const button=e.target.closest('[data-act]');if(!button)return;
  const act=button.dataset.act;
  if(act==='panel'){openPanel();switchPanel(layout.panelTab);return;}
  if(act==='adopt'){$('#confirm-path').click();return;}
  if(act==='search'){$('#search-button').click();return;}
  transport(act);
};
$('#m-speeds').onclick=e=>{const b=e.target.closest('[data-speed]');if(!b)return;applySpeed(b.dataset.speed);};
$('#m-scrub').oninput=e=>selectCell(+e.target.value);
window.addEventListener('resize',()=>{applyPanel();timeline();});
function applyLayout(){
  document.documentElement.style.setProperty('--pw',layout.pw+'px');
  document.documentElement.style.setProperty('--ch',layout.ch+'px');
  $('#diff-only').checked=layout.diff!==false;
  $$('#scale-seg button').forEach(b=>b.classList.toggle('on',b.dataset.mode===layout.scale));
  applySpeed(layout.speed);
  applyPanel();switchPanel(layout.panelTab||'cand');
}
applyLayout();
window.addEventListener('label-case-change',()=>{if(state.labelTask)closeSheet();});
window.addEventListener('load',()=>switchPanel(layout.panelTab||'cand'));


/* ── Reconモード（β） ──
   スクランブルと解法（1行＝1手順）とタイムを入れ、行ごとに探索を**順に**つないでソルブ全体の指遣いを出す。
   ・各行の探索は前の行の end_state を initial_state に渡す（既存の「前の候補を引き継ぐ」と同じ仕組み）。
     時刻は前の行の終わりから続くので、結果は1本の経路につなげられる（combineSegments）。
   ・つないだ経路は普通の経路として setRoute に渡す。3D・チャート・手送り・保存・動画はそのまま動く。
     区切りは route.segments（行ごとの move の範囲）で持ち、チャートに「手順」行と縦線を出す。
   ・キューブの初期状態は route.scramble_setup（スクランブルの記号列）を stage.js が読んで作る。
   ・編集（置き換え・持ち替え・固定）は選んだ手の行の中だけで効く。その行を再探索し、後ろの行は
     新しい end_state で（各行が持つ条件のまま）順に探索し直す。
   ・「実時間」は 相対時間の合計 ÷ タイム を再生倍率にする（applySpeed）。 */
const RECON_TOKEN=/^([URFDLBurfdlbMESxyz])(2'|'2|2|'|3)?$/;
let recon=null;
function reconOn(){return !!layout.recon;}
function applyRecon(){
  document.body.classList.toggle('recon',reconOn());
  if(!reconOn()&&layout.speed==='real')applySpeed(1);
}
function reconSegment(pos){if(!route?.recon||!recon)return null;return recon.segments.find(sg=>pos>=sg.move_start&&pos<sg.move_start+sg.move_count)||null;}
function reconRealFactor(){
  if(!route?.recon||!(recon?.time>0))return null;
  const v=shownRoute();const total=displayEnd(v)-(v.playback_start||0);
  return total>1e-9?total/recon.time:null;
}
/* 「R U R' // cross」→ {alg:"R U R'", comment:"cross"}。# も同じ。空行は飛ばす。 */
/* 「R U R' // cross」→ {alg:"R U R'", comment:"cross"}。# も同じ。空行は飛ばす。
   [A, B]・[A: B]・(…)2 などの記法は展開し、隣り合う同じ面の手はまとめる（core.js の expandAndSimplify）。
   展開して形が変わった行は、説明が無ければ元の書き方を説明に残す。展開して空になった行（U U' だけなど）は飛ばす。 */
function parseSolution(text){
  const lines=[];
  String(text||'').split(/\r?\n/).forEach((raw,n)=>{
    const m=/^(.*?)(?:\/\/|#)(.*)$/.exec(raw);
    const source=(m?m[1]:raw).trim().replace(/\s+/g,' '),comment=(m?m[2]:'').trim();
    if(!source)return;
    let moves;try{moves=expandAndSimplify(source);}catch(e){throw Error(`${n+1}行目：${e.message}`);}
    if(!moves.length)return;
    const alg=moves.join(' ');
    lines.push({alg,comment:comment||(alg!==normalizeInput(source)?source:''),source});
  });
  return lines;
}
function parseScramble(text){
  let tokens;
  try{tokens=expandAndSimplify(String(text||'').replace(/\/\/.*$/gm,'').replace(/#.*$/gm,''));}
  catch(e){throw Error(`スクランブル：${e.message}`);}
  const bad=tokens.find(t=>!RECON_TOKEN.test(t));
  if(bad)throw Error(`スクランブルに読めない記号があります：${bad}`);
  return tokens.map(t=>t.replace(/'2$/,"2'").replace(/^(.)3$/,"$1'"));
}
function parseTime(text){
  const t=String(text||'').trim();if(!t)return null;
  const m=/^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);if(!m)throw Error('タイムは 12.34 または 1:02.34 の形で入れてください。');
  const sec=(+m[1]||0)*60+ +m[2];if(!(sec>0))throw Error('タイムは0より大きい値にしてください。');
  return sec;
}
/* 行ごとの生の経路（エンジン出力そのまま）を1本にする。時刻は行ごとに続いているのでそのまま並べ、
   move の i・path_index・regrip の after_pos だけ全体の番号に直す。lanes は前の行の残り（回復など）が
   次の行にも入っているので id で重複を落とす。 */
function combineSegments(segments,scramble){
  const first=segments[0].route,last=segments[segments.length-1].route;
  const out={...clone(first),moves:[],path:[],regrips:[],lanes:{},pose_bindings:{},clip_hashes:{},limitations:[],segments:[],recon:true,scramble_setup:[...scramble]};
  const seen=new Set();let moveOffset=0,pathOffset=0;
  segments.forEach((sg,k)=>{
    const r=sg.route;
    out.segments.push({index:k,alg:sg.alg,comment:sg.comment,move_start:moveOffset,move_count:r.moves.length,path_start:pathOffset,path_count:r.path.length});
    for(const m of r.moves)out.moves.push({...clone(m),i:moveOffset+m.i,path_index:pathOffset+m.path_index});
    for(const [rgIndex,rg] of (r.regrips||[]).entries())out.regrips.push({...clone(rg),path_index:pathOffset+rg.path_index,segment_index:k,source_regrip_index:rgIndex,after_pos:moveOffset+(rg.after_pos??-1)});
    out.path.push(...r.path);
    for(const [key,events] of Object.entries(r.lanes||{})){
      out.lanes[key]??=[];
      for(const e of events){const id=e.id||JSON.stringify([key,e.kind,e.start,e.end]);if(seen.has(id))continue;seen.add(id);out.lanes[key].push(clone(e));}
    }
    Object.assign(out.pose_bindings,r.pose_bindings||{});
    if(Array.isArray(r.clip_hashes)){if(!Array.isArray(out.clip_hashes))out.clip_hashes=[];out.clip_hashes.push(...r.clip_hashes);}else Object.assign(out.clip_hashes,r.clip_hashes||{});
    out.limitations.push(...(r.limitations||[]));
    moveOffset+=r.moves.length;pathOffset+=r.path.length;
  });
  for(const key of Object.keys(out.lanes))out.lanes[key].sort((a,b)=>a.start-b.start);
  for(const field of ['t_end','t_turn_end','t_task_end','t_motion_end'])out[field]=Math.max(...segments.map(sg=>+sg.route[field]||0));
  out.end_state=clone(last.end_state);
  for(const field of ['cost','preference_score','physical_cost','awk','bursts'])if(segments.every(sg=>Number.isFinite(sg.route[field])))out[field]=segments.reduce((a,sg)=>a+sg.route[field],0);
  out.alg=segments.map(sg=>sg.alg).join(' ');
  out.id='recon:'+segments.map(sg=>sg.route.id).join('|');
  return out;
}
function reconRequest(k,{prefix=null,constraints=[]}={}){
  const sg=recon.segments[k];
  return {alg:sg.alg,prefix,constraints,exclude:[],start_holds:k?{R:'auto',L:'auto'}:readStartHolds(),initial_state:k?recon.segments[k-1].route.end_state:null};
}
/* k 行目から順に探索し直す。各行は自分の request（固定・前半固定）を新しい initial_state で持ち越す。
   その条件で候補が出なければ、条件を捨てて素の探索に落とす。 */
async function reconRunFrom(k,{fresh=false}={}){
  const n=recon.segments.length;
  for(let i=k;i<n;i++){
    const sg=recon.segments[i];
    const keep=!fresh&&sg.request&&(sg.request.prefix||sg.request.constraints?.length);
    message(`探索中… ${i+1} / ${n}`);
    let request=keep?{...sg.request,initial_state:i?recon.segments[i-1].route.end_state:null,start_holds:i?{R:'auto',L:'auto'}:readStartHolds()}:reconRequest(i);
    let found=await querySearch(request);
    if(!found&&keep){request=reconRequest(i);found=await querySearch(request);}
    if(!found)throw Error(`${i+1}行目「${sg.alg}」を探索できませんでした。`);
    const wantId=sg.route?.id;
    sg.request=request;sg.bank=found.data.routes;sg.available=found.available;
    sg.route=(keep&&found.data.routes.find(r=>r.id===wantId))||found.data.routes[0];
  }
}
function reconCollectPins(){
  state.pins=[];state.prefix=null;
  recon.segments.forEach(sg=>{
    for(const c of sg.request?.constraints||[])state.pins.push({...clone(c),pos:sg.move_start+c.pos});
    if(sg.request?.prefix?.path?.length)state.prefix={recon:true};
  });
}
async function reconApply({select=null}={}){
  const combined=combineSegments(recon.segments,recon.scramble);
  recon.segments.forEach((sg,k)=>Object.assign(sg,combined.segments[k]));
  reconCollectPins();
  if(select!==null)selected=select;
  const seg=recon.segments[reconSegIndex(selected)]||recon.segments[0];
  routes=seg.available;
  const next=enrichWarped(validateRoute(combined),catalog.rows);
  if(!await setRoute(next))throw Error('別の操作で読み込みが置き換えられました。');
  return next;
}
const reconSegIndex=pos=>{const i=recon.segments.findIndex(sg=>pos>=sg.move_start&&pos<sg.move_start+sg.move_count);return i<0?recon.segments.length-1:i;};
/* 全体の番号で来た固定・前半固定を、選んだ手の行の中の番号に直してその行だけ再探索する。 */
async function reconChangeConditions(pins,changePos,prefix){
  if(changePos===null){
    const before=recon.segments.map(s=>({request:s.request,route:s.route,bank:s.bank,available:s.available}));
    for(const sg of recon.segments)sg.request=null;
    try{await reconRunFrom(0,{fresh:true});await reconApply();message('固定をすべて外して、全行を探索し直しました。');return true;}
    catch(e){recon.segments.forEach((s,i)=>Object.assign(s,before[i]));message(e.message,true);return false;}
  }
  const k=reconSegIndex(changePos),sg=recon.segments[k];
  const local=pins.filter(p=>p.pos>=sg.move_start&&p.pos<sg.move_start+sg.move_count).map(p=>({...clone(p),pos:p.pos-sg.move_start}));
  let localPrefix=null;
  if(prefix?.path){
    const path=prefix.path.slice(sg.path_start);
    if(prefix.path.length>sg.path_start&&path.length)localPrefix={path,initial_holds:clone(sg.route.initial_holds)};
  }
  const before=recon.segments.map(s=>({request:s.request,route:s.route,bank:s.bank,available:s.available}));
  sg.request={...reconRequest(k),prefix:localPrefix,constraints:local};
  try{
    await reconRunFrom(k);
    const old=before[k].route;
    await reconApply({select:changePos});
    route.moves.forEach((m,i)=>{const s=reconSegment(i);if(s?.index===k){const o=old.moves[i-s.move_start];m.changed=i!==changePos&&(!o||m.key!==o.key||m.hold_before!==o.hold_before);}});
    timeline();
    return true;
  }catch(e){
    recon.segments.forEach((s,i)=>Object.assign(s,before[i]));
    message(e.message+' 表示中の候補は変更していません。',true);return false;
  }
}
/* 候補タブでその行の別候補を選ぶ。以降の行はつなぎ直す。 */
function reconPick(id,localPos){const sg=recon.segments[reconSegIndex(selected)];if(sg?.route.id===id){if(localPos!==null)selectCell(sg.move_start+localPos);return Promise.resolve(false);}return editTransaction(()=>reconPickNow(id,localPos));}
async function reconPickNow(id,localPos){
  const k=reconSegIndex(selected),sg=recon.segments[k];
  if(sg.route.id===id){if(localPos!==null)selectCell(sg.move_start+localPos);return;}
  const chosen=sg.bank.find(r=>r.id===id);if(!chosen||searchBusy)return;
  const before=recon.segments.map(s=>({request:s.request,route:s.route,bank:s.bank,available:s.available}));
  sg.route=chosen;
  try{await reconRunFrom(k+1);await reconApply({select:sg.move_start+(localPos??0)});message(`手順 ${k+1} の候補を切り替え、後ろの行をつなぎ直しました。`);return true;}
  catch(e){recon.segments.forEach((s,i)=>Object.assign(s,before[i]));message(e.message,true);}
}
function reconDialog(){
  const saved=state.recon||{};
  dialog('スクランブル・解法を追加',
    '<label class="field">スクランブル<input id="recon-scramble" type="text" autocomplete="off" spellcheck="false" placeholder="R U F\' D2 L B …"></label>'
    +'<label class="field">解法<textarea id="recon-solution" rows="8" spellcheck="false" placeholder="1行に1手順。// や # の後ろは説明として扱います&#10;x2 // inspection&#10;R\' D L F\' // cross&#10;U R U\' R\' // F2L 1"></textarea></label>'
    +'<label class="field">タイム<input id="recon-time" type="text" inputmode="decimal" autocomplete="off" placeholder="12.34 または 1:02.34（秒）"></label>'
    +'<p class="small muted">行ごとに順に探索し、つないで表示します。行数ぶん時間がかかります。</p>'
    +'<button class="primary" id="recon-run">探索</button><span id="recon-status" class="small muted" role="status"></span>');
  $('#recon-scramble').value=saved.scramble||'';$('#recon-solution').value=saved.solution||'';$('#recon-time').value=saved.time||'';
  $('#recon-run').onclick=()=>reconRun();
  $('#recon-scramble').focus();
}
async function reconRun(){
  const scrambleText=$('#recon-scramble').value,solutionText=$('#recon-solution').value,timeText=$('#recon-time').value;
  const status=$('#recon-status');
  let scramble,lines,time;
  try{scramble=parseScramble(scrambleText);lines=parseSolution(solutionText);time=parseTime(timeText);if(!lines.length)throw Error('解法を1行以上入れてください。');}
  catch(e){uiText(status,e.message);status.classList.add('share-error');return;}
  if(!catalog||!stage||searchBusy||applying||editBusy){uiText(status,'初期化・探索が完了してから押してください。');return;}
  state.recon={scramble:scrambleText.trim(),solution:solutionText,time:timeText.trim()};persist();
  const previous=recon,before=route?editSnapshot():null;editBusy=true;
  recon={scramble,time,segments:lines.map(l=>({alg:normalizeInput(l.alg),comment:l.comment,request:null,route:null,bank:[],available:[]}))};
  $('#recon-run').disabled=true;status.classList.remove('share-error');
  const tick=setInterval(()=>{const done=recon.segments.filter(sg=>sg.route).length;uiText(status,`探索中… ${done} / ${recon.segments.length}`);},200);
  try{
    $('#initial-state').value='none';
    await reconRunFrom(0,{fresh:true});
    state.labelTask=null;state.imported=null;
    closeDialog();
    await reconApply({select:0});state.history=[];state.redo=[];render();labelContext();
    message(`スクランブルと解法 ${recon.segments.length} 行を探索しました。${time?'「実時間」で '+number(time)+' 秒に合わせて再生できます。':''}`);
  }catch(e){if(before)restoreEditData(before);else recon=previous;uiText(status,e.message);status.classList.add('share-error');message(e.message,true);}
  finally{editBusy=false;clearInterval(tick);const run=document.getElementById('recon-run');if(run)run.disabled=false;}
}
$('#recon-add').onclick=reconDialog;

async function init(){
  try{
    [catalog,fixtures]=await Promise.all([get('/api/catalog'),get('/fixtures.json')]);uiText($('#catalog-status'),`合法配置 ${catalog.count} · 左右CSV＋両手定義`);
    stage=new ScheduleStage($('#main-stage'),({time,duration,index})=>{
      $('#scrubber').max=duration;$('#scrubber').value=time;
      const readout=`${number(time)} / ${number(duration)}`;
      uiHTML($('#main-time'),`${readout} <small>相対時間</small>`);syncPlayGlyph();
      uiText($('#current-move'),`${index+1} / ${stage.route?.moves.length||0} · ${stage.route?.moves[index]?.row.move||''}`);
      movePlayhead(time);
      if(playUntil!==null&&time>=playUntil){stage.playing=false;playUntil=null;}
      else if(stage.playing&&!applying&&playUntil===null&&index!==selected){selected=index;timeline();hud();}
    },text=>uiText($('#asset-status'),text));
    stageLook();applySpeed(layout.speed);
    selected=state.selected||0;queueStatus();applyRecon();
    const sharedCode=shareCodeFrom(location.hash);let sharedError=null;
    if(sharedCode&&!await openShared(sharedCode))sharedError=$('#message').textContent;
    if(sharedCode&&!sharedError){}
    else if(state.imported?.length){state.labelTask=null;labelContext();bank=state.imported.map((r,i)=>enrichWarped(validateRoute({...r,id:r.id||`import-${i}`,provenance:r.provenance==='synthetic-preview'?'synthetic-preview':'imported-schedule'}),catalog.rows));routes=activeSet();$('#alg').value=bank[0].alg;uiText($('#mode-note'),'読込スケジュール ／ 探索ボタンでモデル評価');await setRoute(routes.find(r=>r.id===state.routeId)||routes[0]);}
    else await loadDataset(state.alg||$('#alg').value,false);
    if(state.order?.length){routes.sort((a,b)=>{const x=state.order.indexOf(a.id),y=state.order.indexOf(b.id);return (x<0?999:x)-(y<0?999:y);});candidateList();}
    if(sharedError)message(sharedError,true);
    $('#search-button').disabled=false;
    window.addEventListener('beforeunload',persist);
  }catch(e){message('初期化に失敗しました [JSON診断3]：'+e.message,true);uiText($('#asset-status'),catalog&&stage?'「探索」で更新して再試行できます':'再読み込みで再試行できます');if(catalog&&stage)$('#search-button').disabled=false;}
}
/* ?test=1 のときだけ、時間の写像と配色の導出を外から確かめられるようにする。 */
if(TEST)window.fingerweightTest={combineSegments,parseSolution,parseScramble,parseTime,get recon(){return recon;},warpRoute,uniformRoute,restoreRealTimes,fitDistance,cubeRadius,captureRadius,normalizeInput,stepTarget,stepGo,selectionIntervals,placeInstantRotations,schemeFor,currentScheme,stepPlay,applySpeed,paintCube,layout,CUBE_SCHEMES,get stepCursor(){return stepCursor;},get stage(){return stage;},get route(){return shownRoute();},get selected(){return selected;}};
init();
