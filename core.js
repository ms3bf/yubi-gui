export const FINGERS = {index:'人',middle:'中',ring:'薬',thumb:'親',pinky:'小',wrist:'腕',back_fingers:'背面指',index_middle:'人中',ring_middle:'薬中',ring_pinky:'薬小'};
export const RESOURCES = ['R.index','R.middle','R.ring','R.thumb','R.pinky','R.wrist','L.index','L.middle','L.ring','L.thumb','L.pinky','L.wrist'];
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const clone = value => JSON.parse(JSON.stringify(value));
export const tag = row => row.execution==='hold_only'?'両手（回転）': (row.hand==='BOTH'?'両':row.hand==='R'?'右':'左')+(row.driving?.length>1&&row.finger!=='back_fingers'?row.driving.map(f=>FINGERS[f]||f).join(''):FINGERS[row.finger]||row.finger)+(row.companion_driving||[]).map(k=>'＋'+(k[0]==='R'?'右':'左')+(FINGERS[k.split('.')[1]]||k.split('.')[1])).join('');
export function pathOf(route) {
  if(route.path) return [...route.path];
  const events = [...route.moves.map(m=>({...m,token:m.action_id})),...(route.regrips||[]).map(r=>({...r,token:`RG:${r.hand}:${r.hold_from}>${r.hold_to}`}))];
  return events.sort((a,b)=>a.start-b.start).map(e=>e.token);
}
export function rowFor(move, catalog) {
  return catalog.find(r=>r.action_id===move.action_id && (!move.hand||r.hand===move.hand) && (r.hold_before==='*'||r.hold_before===move.hold_before));
}
export function enrich(route, catalog) {
  const result=clone(route), holds={...route.initial_holds};
  const regrips=[...(route.regrips||[])].sort((a,b)=>a.end-b.end);let rg=0;
  result.moves=result.moves.map((move,i)=>{
    while(rg<regrips.length && regrips[rg].end<=move.start){holds[regrips[rg].hand]=regrips[rg].hold_to;rg++;}
    const candidates=catalog.filter(r=>r.action_id===move.action_id && (!move.hand||r.hand===move.hand));
    const row=candidates.find(r=>r.hold_before==='*'||r.hold_before===(move.hold_before??holds[r.hand]));
    if(!row)throw Error(`${i+1}手目の action_id と開始ホールドに合法配置がありません`);
    if(!/^[URFDLBMESxyzurfdlb]([23]'?|')?$/.test(row.move))throw Error(`このビューアは ${row.move} の盤面再生に未対応です。動作は変換しません。`);
    if(move.holds_before)Object.assign(holds,move.holds_before);
    if(row.hand!=='BOTH'&&row.hold_before!==holds[row.hand])throw Error(`${i+1}手目のホールド遷移が一致しません`);
    if(row.hand!=='BOTH')holds[row.hand]=row.hold_after;
    if(!move.holds_after&&row.state_change==='both_thumb_transition')holds.R=holds.L=row.hold_after;
    if(move.holds_after)Object.assign(holds,move.holds_after);
    return {...move,i:move.i??i,hand:row.hand,hold_before:row.hand==='BOTH'?move.holds_before:move.hold_before??row.hold_before,hold_after:row.hand==='BOTH'?move.holds_after:move.hold_after??row.hold_after,key:move.key??row.key,row};
  });
  result.regrips=(route.regrips||[]).map(r=>{
    const row=catalog.find(a=>a.move==='REGRIP'&&a.hand===r.hand&&a.hold_before===r.hold_from&&a.hold_after===r.hold_to);
    if(!row)throw Error('持ち替えの合法配置がありません');
    return {...r,row};
  });
  return result;
}
export function validateRoute(route) {
  if(!route || !Array.isArray(route.moves) || !route.moves.length || route.moves.length>500 || !route.alg || !route.initial_holds?.R || !route.initial_holds?.L)throw Error('alg / moves / initial_holds が必要です');
  if(!Number.isFinite(route.cost)||!Number.isFinite(route.t_end)||route.t_end<0||!route.lanes||!route.end_state)throw Error('cost / t_end / lanes / end_state が必要です');
  const span=e=>Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.start>=0&&e.end>=e.start;
  if(route.moves.some((m,i)=>!m.action_id||!span(m)||m.end>route.t_end||m.i!==i))throw Error('moves の時刻または i が不正です（i は0開始）');
  if(Object.entries(route.lanes).some(([r,l])=>!Array.isArray(l)||l.some(e=>!span(e)||!['stroke','recovery','wait','regrip','preparation','startup','carry','manual'].includes(e.kind))))throw Error('lanes の形式が不正です');
  if((route.regrips||[]).some(r=>!span(r)||!['R','L'].includes(r.hand)||!r.hold_from||!r.hold_to))throw Error('regrips の形式が不正です');
  if(!route.model_version?.params||!route.model_version?.legal||!route.model_version?.actions)throw Error('model_version に params / legal / actions のハッシュが必要です');
  return route;
}
// Old saved display schedules rewrote only t; they cannot safely seed physics.
export function continuationState(route){
  if(route?.time_warped&&route.continuation_state_version!==1)throw Error('旧版の表示スケジュールは引き継げません。「探索」で更新してください。');
  return route?.end_state??null;
}
export function filterRoutes(routes, constraints=[], exclude=[]) {
  const matches=(r,need)=>typeof need==='object'&&need!==null&&r.hand===need.hand&&(r.hold_to??r.hold_after)===need.to_hold;
  return routes.filter(p=>constraints.every(c=>{
    const before=(p.regrips||[]).filter(r=>r.after_pos===c.pos-1),after=(p.regrips||[]).filter(r=>r.after_pos===c.pos);
    return (!c.action_id||[p.moves[c.pos]?.action_id,p.moves[c.pos]?.key].includes(c.action_id))
      &&(!c.no_regrip_before||!before.length)&&(!c.regrip_before||before.some(r=>matches(r,c.regrip_before)))
      &&(!('regrip_after' in c)||(typeof c.regrip_after==='boolean'?Boolean(after.length)===c.regrip_after:after.some(r=>matches(r,c.regrip_after))));
  })&&exclude.every(c=>![p.moves[c.pos]?.action_id,p.moves[c.pos]?.key].includes(c.action_id)));
}
export function diverse(routes, count=5) {
  const seen=new Set();return routes.filter(r=>{const key=r.moves.map(m=>`${m.row.hand}.${m.row.finger}`).join('/');if(seen.has(key))return false;seen.add(key);return true;}).slice(0,count);
}
export function formatScore(route, ascii=false) {
  const names={index:'i',middle:'m',ring:'r',thumb:'t',pinky:'p',wrist:'w'};
  return [...route.moves.map(m=>({start:m.start,text:`${m.row.move}[${ascii?m.hand+(names[m.row.finger]||m.row.finger):tag(m.row)}]{${m.hand}:${m.hold_before}>${m.hold_after}}`})),...(route.regrips||[]).map(r=>({start:r.start,text:`RG:${r.hand}:${r.hold_from}>${r.hold_to}`}))].sort((a,b)=>a.start-b.start).map(e=>e.text).join(' ');
}
/* ── 入力の手順の正規化 ──
   ワイド表記 `Rw Lw Uw Dw Fw Bw`（`'` `2` `2'` 付き）をエンジンが読む小文字 `r l u d f b` に直す。
   大文字＋w の1トークンだけを見るので、`R w` のように離れているものや `x'` `M` `E` `S` は触らない。 */
const WIDE_MOVE=/^([RLUDFB])w(2'|2|')?$/;
export function normalizeInput(alg){
  return String(alg ?? '').split(/(\s+)/).map(token=>{
    const m=WIDE_MOVE.exec(token);
    return m?m[1].toLowerCase()+(m[2]||''):token;
  }).join('');
}
/* ── 手送りのカーソル ──
   cursor は「次に › が再生する手」の番号。selected は「いま選ばれている手」。
   next だけが再生する（play にその番号が入る）。prev / first / last / select は移動だけ。 */
export function stepTarget(action, cursor, count, selected=cursor){
  const last=Math.max(0,(count|0)-1);
  const clamp=n=>Math.max(0,Math.min(last,Number.isFinite(n)?n:0));
  if(action==='next'){const play=clamp(cursor);return {play,cursor:clamp(play+1),selected:play};}
  if(action==='prev'){const to=clamp(clamp(cursor)-1);return {play:null,cursor:to,selected:to};}
  if(action==='first')return {play:null,cursor:0,selected:0};
  if(action==='last')return {play:null,cursor:last,selected:last};
  if(action==='select'){const to=clamp(selected);return {play:null,cursor:to,selected:to};}
  return {play:null,cursor:clamp(cursor),selected:clamp(selected)};
}
/* ── 登録ケースの手順の頭にある全体回転を落とす ──
   `y y' y2 y2'` が先頭に並んでいるぶんだけ取り除く。盤面の向きを合わせるためだけの回転で、
   指使いを見るうえでは邪魔になるため。途中の y は手順の一部なので触らない。 */
const LEAD_Y=/^\s*(?:y(?:2'|2|')?(?:\s+|$))+/;
export function stripLeadingY(alg){
  return String(alg ?? '').replace(LEAD_Y,'').trim();
}
/* API はブラウザ内 WASM 専用。旧 URL・保存設定による HTTP 推論は無効。 */
// Read text explicitly so JSON decoding errors retain their source in WebViews.
export async function readJSON(response,source){
  const label=source||response.url||'JSON';
  const text=await response.text();
  try{return JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){
    const kind=/^\s*</.test(text)?'JSON の代わりに HTML が返されました':`JSON を解析できません（${text.length}文字）`;
    throw new Error(`${label}: ${kind} [HTTP ${response.status}, ${response.headers.get('content-type')||'Content-Type 不明'}] ${error.message}`);
  }
}
export const ENGINE_KEY='fingerweight.ui-v5.engine';
export const ENGINE_MODES=['wasm'];
export function engineMode(){return 'wasm';}
let enginePromise=null,engineBackend={backend:'loading'};
export function engineStatus(){return {...engineBackend};}
function makeEngine(){
  return import('/engine/releases/b085f498da8f32959316285f686a3fe95b1df10980f7397e71b24fef8f06a7d4/ui/engine.js')
    .then(module=>module.createEngineFetch())
    .then(engineFetch=>{
      engineBackend={backend:'wasm'};
      return engineFetch;
    },error=>{
      engineBackend={backend:'error',fallbackReason:String(error?.message||error)};
      throw error;
    });
}
function readyEngineFetch(){
  if(!enginePromise){
    const pending=makeEngine().catch(error=>{if(enginePromise===pending)enginePromise=null;throw error;});
    enginePromise=pending;
  }
  const pending=enginePromise;
  return pending.then(engineFetch=>{
    if(engineFetch.disposed){if(enginePromise===pending)enginePromise=null;return readyEngineFetch();}
    return engineFetch;
  });
}
export function engineReady(){return readyEngineFetch().then(engineStatus,engineStatus);}
export function apiFetch(url,init){return readyEngineFetch().then(engineFetch=>engineFetch(url,init));}

/* ── 共有リンク（#y=） ──
   リンクに入れるのは動作表の番号列だけ。名前は説明文に書き、手順は経路から復元する。
   中身はビット列を base64url にしたもの。上から順に：
     4 bit      形式番号（いま 2。旧版1も復元可能）
     5 bit      動作IDのビット幅。追加で幅が増えても旧リンクの読み方は変わらない
     3 bit ×2   開始ホールドの指定 R・L（0=自動、1〜5=HOLDS の並び）
     3 bit ×2   初期ホールド R・L（1〜5）
     1 bit      手順の文字列を添えるか。経路から復元した記法（U2' → U2、R3 → R' など）と違うときだけ 1
     8 bit      経路の長さ n（1〜255）
     w bit ×n   追加専用の永続ID。w = 登録済みID数に必要なビット数（286件なら 9）
     残り       添えるときだけ、バイト境界まで詰めて手順の UTF-8
   14手＋持ち替え2回で 22 バイト ≒ 30 文字。 */
export const SHARE_KEY='y';
const SHARE_VERSION=2;
// Permanent share IDs: append only. Never reorder, delete or reuse a slot.
// Missing catalog actions retain their slot and produce an explicit unavailable error.
const SHARE_ACTION_KEYS = Object.freeze([
  "BOTH_X",
  "BOTH_X_2_CCW",
  "BOTH_X_2_CW",
  "BOTH_X_PRIME",
  "BOTH_Y",
  "BOTH_Y_2_CCW",
  "BOTH_Y_2_CW",
  "BOTH_Y_PRIME",
  "BOTH_Z",
  "BOTH_Z_2_CCW",
  "BOTH_Z_2_CW",
  "BOTH_Z_PRIME",
  "L__B2_R_INDEX_MIDDLE__FROM_U",
  "L__B2_R_RING_PINKY__FROM_D",
  "L__B_PRIME_R_INDEX_PUSH__FROM_U",
  "L__B_PRIME_R_RING_PULL__FROM_D",
  "L__B_PRIME_R_WRIST_ASSIST__FROM_F",
  "L__B_R_INDEX_PULL__FROM_U",
  "L__B_R_RING_PUSH__FROM_D",
  "L__B_R_WRIST_ASSIST__FROM_F",
  "L__D2_R_RING_PINKY__FROM_F",
  "L__D_PRIME_R_RING_PULL__FROM_F",
  "L__D_R_RING_PUSH__FROM_F",
  "L__Dw_PRIME_R_RING_PULL__FROM_F",
  "L__E2_R_INDEX_MIDDLE__FROM_F",
  "L__E_PRIME_R_INDEX_PULL__FROM_U",
  "L__E_PRIME_R_MIDDLE_PULL__FROM_F",
  "L__E_R_MIDDLE_PUSH__FROM_F",
  "L__F2_R_INDEX_MIDDLE__FROM_D",
  "L__F2_R_RING_PINKY__FROM_U",
  "L__F_PRIME_R_INDEX_PUSH__FROM_D",
  "L__F_PRIME_R_INDEX_PUSH__FROM_F",
  "L__F_PRIME_R_RING_PULL__FROM_U",
  "L__F_PRIME_R_THUMB_PUSH__FROM_D",
  "L__F_PRIME_R_THUMB_PUSH__FROM_F",
  "L__F_R_INDEX_PULL__FROM_D",
  "L__F_R_INDEX_PULL__FROM_F",
  "L__F_R_RING_PULL__FROM_U",
  "L__F_R_THUMB_PUSH__FROM_F",
  "L__Fw2_R_INDEX_MIDDLE__FROM_D",
  "L__Fw_PRIME_R_INDEX_PUSH__FROM_D",
  "L__Fw_PRIME_R_INDEX_PUSH__FROM_F",
  "L__Fw_PRIME_R_MIDDLE_PUSH__FROM_D",
  "L__Fw_R_INDEX_PULL__FROM_D",
  "L__Fw_R_INDEX_PULL__FROM_F",
  "L__Fw_R_MIDDLE_PULL__FROM_D",
  "L__M2_R_INDEX_MIDDLE_PULL__FROM_D",
  "L__M2_R_RING_MIDDLE__FROM_F",
  "L__M2_R_SLICE_1__FROM_D",
  "L__M2_R_SLICE_1__FROM_F",
  "L__M2_R_SLICE_1__FROM_U",
  "L__M2_R_SLICE_REVERSE_HALF__FROM_F",
  "L__M2_R_SYNC_RING_THEN_WIDE__FROM_F",
  "L__M2_R_SYNC_RING_THEN_WIDE__FROM_U",
  "L__M2_R_WIDE_THEN_SYNC_RING__FROM_D",
  "L__M2_R_WIDE_THEN_SYNC_RING__FROM_F",
  "L__M_PRIME_R_INDEX_PUSH__FROM_F",
  "L__M_PRIME_R_RING_PULL__FROM_D",
  "L__M_PRIME_R_RING_PULL__FROM_F",
  "L__M_PRIME_R_RING_PULL__FROM_U",
  "L__M_PRIME_R_SLICE_1__FROM_D",
  "L__M_PRIME_R_SLICE_1__FROM_F",
  "L__M_PRIME_R_SLICE_2__FROM_F",
  "L__M_PRIME_R_SLICE_2__FROM_U",
  "L__M_R_INDEX_PULL__FROM_D",
  "L__M_R_INDEX_PULL__FROM_F",
  "L__M_R_RING_PUSH__FROM_F",
  "L__M_R_SLICE_1__FROM_F",
  "L__M_R_SLICE_1__FROM_U",
  "L__M_R_SLICE_2__FROM_D",
  "L__M_R_SLICE_2__FROM_F",
  "L__R2_R_WRIST_CCW_CCW__FROM_B_CW",
  "L__R2_R_WRIST_CCW_CCW__FROM_F",
  "L__R2_R_WRIST_CCW_CCW__FROM_U",
  "L__R2_R_WRIST_CW_CW__FROM_B_CCW",
  "L__R2_R_WRIST_CW_CW__FROM_D",
  "L__R2_R_WRIST_CW_CW__FROM_F",
  "L__R3_PRIME_R_WRIST_CCW_CCW__FROM_B_CW",
  "L__R3_PRIME_R_WRIST_CCW_CCW__FROM_U",
  "L__R3_R_WRIST_CW_CW__FROM_B_CCW",
  "L__R3_R_WRIST_CW_CW__FROM_D",
  "L__REGRIP_R_B_CCW_TO_B_CW__FROM_B_CCW",
  "L__REGRIP_R_B_CCW_TO_D__FROM_B_CCW",
  "L__REGRIP_R_B_CCW_TO_F__FROM_B_CCW",
  "L__REGRIP_R_B_CCW_TO_U__FROM_B_CCW",
  "L__REGRIP_R_B_CW_TO_B_CCW__FROM_B_CW",
  "L__REGRIP_R_B_CW_TO_D__FROM_B_CW",
  "L__REGRIP_R_B_CW_TO_F__FROM_B_CW",
  "L__REGRIP_R_B_CW_TO_U__FROM_B_CW",
  "L__REGRIP_R_D_TO_B_CCW__FROM_D",
  "L__REGRIP_R_D_TO_B_CW__FROM_D",
  "L__REGRIP_R_D_TO_F__FROM_D",
  "L__REGRIP_R_D_TO_U__FROM_D",
  "L__REGRIP_R_F_TO_B_CCW__FROM_F",
  "L__REGRIP_R_F_TO_B_CW__FROM_F",
  "L__REGRIP_R_F_TO_D__FROM_F",
  "L__REGRIP_R_F_TO_U__FROM_F",
  "L__REGRIP_R_U_TO_B_CCW__FROM_U",
  "L__REGRIP_R_U_TO_B_CW__FROM_U",
  "L__REGRIP_R_U_TO_D__FROM_U",
  "L__REGRIP_R_U_TO_F__FROM_U",
  "L__R_PRIME_R_WRIST_CCW__FROM_B_CW",
  "L__R_PRIME_R_WRIST_CCW__FROM_D",
  "L__R_PRIME_R_WRIST_CCW__FROM_F",
  "L__R_PRIME_R_WRIST_CCW__FROM_U",
  "L__R_R2_MIDDLE_RING_PULL_CW__FROM_F",
  "L__R_R_RING_PULL_CW__FROM_F",
  "L__R_R_WRIST_CW__FROM_B_CCW",
  "L__R_R_WRIST_CW__FROM_D",
  "L__R_R_WRIST_CW__FROM_F",
  "L__R_R_WRIST_CW__FROM_U",
  "L__S2_R_INDEX_MIDDLE_1__FROM_U",
  "L__S2_R_INDEX_MIDDLE_2__FROM_D",
  "L__S_PRIME_R_INDEX_PUSH__FROM_F",
  "L__S_PRIME_R_MIDDLE_PULL_1__FROM_U",
  "L__S_PRIME_R_MIDDLE_PULL_2__FROM_D",
  "L__S_R_INDEX_PULL__FROM_F",
  "L__S_R_MIDDLE_PUSH_1__FROM_U",
  "L__S_R_MIDDLE_PUSH_2__FROM_D",
  "L__U2_R_INDEX_INDEX__FROM_F",
  "L__U2_R_INDEX_MIDDLE__FROM_F",
  "L__U_PRIME_R_INDEX_PUSH__FROM_F",
  "L__U_R_INDEX_FLICK__FROM_F",
  "L__U_R_INDEX_FLICK__FROM_U",
  "L__U_R_MIDDLE_FLICK__FROM_F",
  "L__U_R_MIDDLE_SLIDE__FROM_D",
  "L__Uw2_R_INDEX_MIDDLE__FROM_F",
  "L__Uw_PRIME_R_INDEX_PUSH__FROM_F",
  "L__Uw_PRIME_R_MIDDLE_PUSH__FROM_F",
  "L__Uw_R_INDEX_FLICK__FROM_F",
  "L__Uw_R_INDEX_FLICK__FROM_U",
  "L__Uw_R_MIDDLE_PULL__FROM_F",
  "L__r2_R_WRIST_CCW_CCW__FROM_B_CW",
  "L__r2_R_WRIST_CCW_CCW__FROM_F",
  "L__r2_R_WRIST_CCW_CCW__FROM_U",
  "L__r2_R_WRIST_CW_CW__FROM_B_CCW",
  "L__r2_R_WRIST_CW_CW__FROM_D",
  "L__r2_R_WRIST_CW_CW__FROM_F",
  "L__r_PRIME_R_WRIST_CCW__FROM_B_CW",
  "L__r_PRIME_R_WRIST_CCW__FROM_D",
  "L__r_PRIME_R_WRIST_CCW__FROM_F",
  "L__r_PRIME_R_WRIST_CCW__FROM_U",
  "L__r_R_WRIST_CW__FROM_B_CCW",
  "L__r_R_WRIST_CW__FROM_D",
  "L__r_R_WRIST_CW__FROM_F",
  "L__r_R_WRIST_CW__FROM_U",
  "R__B2_R_INDEX_MIDDLE__FROM_U",
  "R__B2_R_RING_PINKY__FROM_D",
  "R__B_PRIME_R_INDEX_PUSH__FROM_U",
  "R__B_PRIME_R_RING_PULL__FROM_D",
  "R__B_PRIME_R_WRIST_ASSIST__FROM_F",
  "R__B_R_INDEX_PULL__FROM_U",
  "R__B_R_RING_PUSH__FROM_D",
  "R__B_R_WRIST_ASSIST__FROM_F",
  "R__D2_R_RING_PINKY__FROM_F",
  "R__D_PRIME_R_RING_PULL__FROM_F",
  "R__D_R_RING_PUSH__FROM_F",
  "R__Dw_PRIME_R_RING_PULL__FROM_F",
  "R__E2_R_INDEX_MIDDLE__FROM_F",
  "R__E_PRIME_R_INDEX_PULL__FROM_U",
  "R__E_PRIME_R_MIDDLE_PULL__FROM_F",
  "R__E_R_MIDDLE_PUSH__FROM_F",
  "R__F2_R_INDEX_MIDDLE__FROM_D",
  "R__F2_R_RING_PINKY__FROM_U",
  "R__F_PRIME_R_INDEX_PUSH__FROM_D",
  "R__F_PRIME_R_INDEX_PUSH__FROM_F",
  "R__F_PRIME_R_RING_PULL__FROM_U",
  "R__F_PRIME_R_THUMB_PUSH__FROM_D",
  "R__F_PRIME_R_THUMB_PUSH__FROM_F",
  "R__F_R_INDEX_PULL__FROM_D",
  "R__F_R_INDEX_PULL__FROM_F",
  "R__F_R_RING_PULL__FROM_U",
  "R__F_R_THUMB_PUSH__FROM_F",
  "R__Fw2_R_INDEX_MIDDLE__FROM_D",
  "R__Fw_PRIME_R_INDEX_PUSH__FROM_D",
  "R__Fw_PRIME_R_INDEX_PUSH__FROM_F",
  "R__Fw_PRIME_R_MIDDLE_PUSH__FROM_D",
  "R__Fw_R_INDEX_PULL__FROM_D",
  "R__Fw_R_INDEX_PULL__FROM_F",
  "R__Fw_R_MIDDLE_PULL__FROM_D",
  "R__M2_R_INDEX_MIDDLE_PULL__FROM_D",
  "R__M2_R_RING_MIDDLE__FROM_F",
  "R__M2_R_SLICE_1__FROM_D",
  "R__M2_R_SLICE_1__FROM_F",
  "R__M2_R_SLICE_1__FROM_U",
  "R__M2_R_SLICE_REVERSE_HALF__FROM_F",
  "R__M2_R_SYNC_RING_THEN_WIDE__FROM_F",
  "R__M2_R_SYNC_RING_THEN_WIDE__FROM_U",
  "R__M2_R_WIDE_THEN_SYNC_RING__FROM_D",
  "R__M2_R_WIDE_THEN_SYNC_RING__FROM_F",
  "R__M_PRIME_R_INDEX_PUSH__FROM_F",
  "R__M_PRIME_R_RING_PULL__FROM_D",
  "R__M_PRIME_R_RING_PULL__FROM_F",
  "R__M_PRIME_R_RING_PULL__FROM_U",
  "R__M_PRIME_R_SLICE_1__FROM_D",
  "R__M_PRIME_R_SLICE_1__FROM_F",
  "R__M_PRIME_R_SLICE_2__FROM_F",
  "R__M_PRIME_R_SLICE_2__FROM_U",
  "R__M_R_INDEX_PULL__FROM_D",
  "R__M_R_INDEX_PULL__FROM_F",
  "R__M_R_RING_PUSH__FROM_F",
  "R__M_R_SLICE_1__FROM_F",
  "R__M_R_SLICE_1__FROM_U",
  "R__M_R_SLICE_2__FROM_D",
  "R__M_R_SLICE_2__FROM_F",
  "R__R2_R_WRIST_CCW_CCW__FROM_B_CW",
  "R__R2_R_WRIST_CCW_CCW__FROM_F",
  "R__R2_R_WRIST_CCW_CCW__FROM_U",
  "R__R2_R_WRIST_CW_CW__FROM_B_CCW",
  "R__R2_R_WRIST_CW_CW__FROM_D",
  "R__R2_R_WRIST_CW_CW__FROM_F",
  "R__R3_PRIME_R_WRIST_CCW_CCW__FROM_B_CW",
  "R__R3_PRIME_R_WRIST_CCW_CCW__FROM_U",
  "R__R3_R_WRIST_CW_CW__FROM_B_CCW",
  "R__R3_R_WRIST_CW_CW__FROM_D",
  "R__REGRIP_R_B_CCW_TO_B_CW__FROM_B_CCW",
  "R__REGRIP_R_B_CCW_TO_D__FROM_B_CCW",
  "R__REGRIP_R_B_CCW_TO_F__FROM_B_CCW",
  "R__REGRIP_R_B_CCW_TO_U__FROM_B_CCW",
  "R__REGRIP_R_B_CW_TO_B_CCW__FROM_B_CW",
  "R__REGRIP_R_B_CW_TO_D__FROM_B_CW",
  "R__REGRIP_R_B_CW_TO_F__FROM_B_CW",
  "R__REGRIP_R_B_CW_TO_U__FROM_B_CW",
  "R__REGRIP_R_D_TO_B_CCW__FROM_D",
  "R__REGRIP_R_D_TO_B_CW__FROM_D",
  "R__REGRIP_R_D_TO_F__FROM_D",
  "R__REGRIP_R_D_TO_U__FROM_D",
  "R__REGRIP_R_F_TO_B_CCW__FROM_F",
  "R__REGRIP_R_F_TO_B_CW__FROM_F",
  "R__REGRIP_R_F_TO_D__FROM_F",
  "R__REGRIP_R_F_TO_U__FROM_F",
  "R__REGRIP_R_U_TO_B_CCW__FROM_U",
  "R__REGRIP_R_U_TO_B_CW__FROM_U",
  "R__REGRIP_R_U_TO_D__FROM_U",
  "R__REGRIP_R_U_TO_F__FROM_U",
  "R__R_PRIME_R_WRIST_CCW__FROM_B_CW",
  "R__R_PRIME_R_WRIST_CCW__FROM_D",
  "R__R_PRIME_R_WRIST_CCW__FROM_F",
  "R__R_PRIME_R_WRIST_CCW__FROM_U",
  "R__R_R2_MIDDLE_RING_PULL_CW__FROM_F",
  "R__R_R_RING_PULL_CW__FROM_F",
  "R__R_R_WRIST_CW__FROM_B_CCW",
  "R__R_R_WRIST_CW__FROM_D",
  "R__R_R_WRIST_CW__FROM_F",
  "R__R_R_WRIST_CW__FROM_U",
  "R__S2_R_INDEX_MIDDLE_1__FROM_U",
  "R__S2_R_INDEX_MIDDLE_2__FROM_D",
  "R__S_PRIME_R_INDEX_PUSH__FROM_F",
  "R__S_PRIME_R_MIDDLE_PULL_1__FROM_U",
  "R__S_PRIME_R_MIDDLE_PULL_2__FROM_D",
  "R__S_R_INDEX_PULL__FROM_F",
  "R__S_R_MIDDLE_PUSH_1__FROM_U",
  "R__S_R_MIDDLE_PUSH_2__FROM_D",
  "R__U2_R_INDEX_INDEX__FROM_F",
  "R__U2_R_INDEX_MIDDLE__FROM_F",
  "R__U_PRIME_R_INDEX_PUSH__FROM_F",
  "R__U_R_INDEX_FLICK__FROM_F",
  "R__U_R_INDEX_FLICK__FROM_U",
  "R__U_R_MIDDLE_FLICK__FROM_F",
  "R__U_R_MIDDLE_SLIDE__FROM_D",
  "R__Uw2_R_INDEX_MIDDLE__FROM_F",
  "R__Uw_PRIME_R_INDEX_PUSH__FROM_F",
  "R__Uw_PRIME_R_MIDDLE_PUSH__FROM_F",
  "R__Uw_R_INDEX_FLICK__FROM_F",
  "R__Uw_R_INDEX_FLICK__FROM_U",
  "R__Uw_R_MIDDLE_PULL__FROM_F",
  "R__r2_R_WRIST_CCW_CCW__FROM_B_CW",
  "R__r2_R_WRIST_CCW_CCW__FROM_F",
  "R__r2_R_WRIST_CCW_CCW__FROM_U",
  "R__r2_R_WRIST_CW_CW__FROM_B_CCW",
  "R__r2_R_WRIST_CW_CW__FROM_D",
  "R__r2_R_WRIST_CW_CW__FROM_F",
  "R__r_PRIME_R_WRIST_CCW__FROM_B_CW",
  "R__r_PRIME_R_WRIST_CCW__FROM_D",
  "R__r_PRIME_R_WRIST_CCW__FROM_F",
  "R__r_PRIME_R_WRIST_CCW__FROM_U",
  "R__r_R_WRIST_CW__FROM_B_CCW",
  "R__r_R_WRIST_CW__FROM_D",
  "R__r_R_WRIST_CW__FROM_F",
  "R__r_R_WRIST_CW__FROM_U",
  "L__M_R_MIDDLE_PULL__FROM_D",
  "L__U_PRIME_R_INDEX_FLICK__FROM_F",
  "L__U_PRIME_R_RING_PULL__FROM_B_CCW",
  "R__M_R_MIDDLE_PULL__FROM_D",
  "R__U_PRIME_R_INDEX_FLICK__FROM_F",
  "R__U_PRIME_R_RING_PULL__FROM_B_CCW"
]);
// Published v1 tables used sorted keys. Preserve both historical snapshots.
const LEGACY_SHARE_SIZES = [280, 286];
const shareFingerprint=keys=>{
  let h=0x811c9dc5;for(const ch of keys.join('\n')){h^=ch.charCodeAt(0);h=Math.imul(h,0x01000193)>>>0;}
  return h&0xffff;
};
const LEGACY_SHARE_TABLES=LEGACY_SHARE_SIZES.map(size=>{
  const keys=SHARE_ACTION_KEYS.slice(0,size).sort();
  return {keys,fingerprint:shareFingerprint(keys),bits:Math.ceil(Math.log2(keys.length))};
});
if(new Set(LEGACY_SHARE_TABLES.map(t=>t.fingerprint)).size!==LEGACY_SHARE_TABLES.length)throw Error('Duplicate legacy share fingerprint');

const HOLDS=['auto','F','U','D','B_CW','B_CCW'];
const holdCode=v=>Math.max(0,HOLDS.indexOf(v));
const SHARE_BROKEN='共有リンクが壊れています。リンクを最後までコピーできているか確認してください。';

class BitWriter{
  constructor(){this.bytes=[];this.acc=0;this.n=0;}
  write(value,bits){for(let i=bits-1;i>=0;i--){this.acc=(this.acc<<1)|((value>>i)&1);if(++this.n===8){this.bytes.push(this.acc);this.acc=0;this.n=0;}}return this;}
  align(){while(this.n)this.write(0,1);return this;}
  finish(){this.align();return Uint8Array.from(this.bytes);}
}
class BitReader{
  constructor(bytes){this.bytes=bytes;this.pos=0;}
  read(bits){let v=0;for(let i=0;i<bits;i++){const byte=this.bytes[this.pos>>3];if(byte===undefined)throw Error(SHARE_BROKEN);v=(v<<1)|((byte>>(7-(this.pos&7)))&1);this.pos++;}return v;}
  rest(){this.pos=(this.pos+7)&~7;return this.bytes.subarray(this.pos>>3);}
}
const toB64u=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromB64u=text=>{if(!/^[A-Za-z0-9_-]+$/.test(text))throw Error(SHARE_BROKEN);try{return Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}catch{throw Error(SHARE_BROKEN);}};

/* 動作表。catalog.rows から作り、番号 ⇄ engine_key と指紋を持つ。 */
export function shareTable(rows){
  const keys=SHARE_ACTION_KEYS;
  const rowByKey=new Map(rows.map(r=>[r.engine_key,r]));
  return {keys,index:new Map(keys.map((k,i)=>[k,i])),rowByKey,bits:Math.max(1,Math.ceil(Math.log2(keys.length)))};
}
/* 経路から手順の記法を復元する（持ち替えを除いた row.move の並び）。 */
export function algFromPath(path,table){return path.map(k=>table.rowByKey.get(k)).filter(r=>r&&r.move!=='REGRIP').map(r=>r.move).join(' ');}

export function encodeShareCode({path,initial_holds,start_holds,alg},table){
  if(!path?.length||path.length>255)throw Error('この経路は共有リンクにできません。');
  const unknown=path.find(k=>!table.index.has(k)||!table.rowByKey.has(k));if(unknown)throw Error(`動作表にない動作があります：${unknown}`);
  if(table.bits>16)throw Error('共有動作IDの上限を超えています。');
  const withAlg=alg!==algFromPath(path,table);
  const w=new BitWriter().write(SHARE_VERSION,4).write(table.bits,5)
    .write(holdCode(start_holds?.R),3).write(holdCode(start_holds?.L),3)
    .write(holdCode(initial_holds?.R),3).write(holdCode(initial_holds?.L),3)
    .write(withAlg?1:0,1).write(path.length,8);
  for(const key of path)w.write(table.index.get(key),table.bits);
  const head=w.finish();
  return toB64u(withAlg?Uint8Array.from([...head,...new TextEncoder().encode(alg)]):head);
}
export function decodeShareCode(code,table){
  const r=new BitReader(fromB64u(String(code||'').trim()));
  const version=r.read(4);let keys=table.keys,bits;
  if(version===1){
    const fingerprint=r.read(16),legacy=LEGACY_SHARE_TABLES.find(t=>t.fingerprint===fingerprint);
    if(!legacy)throw Error('この共有リンクの動作表を確認できません。作成元でリンクを作り直してください。');
    ({keys,bits}=legacy);
  }else if(version===SHARE_VERSION){
    bits=r.read(5);if(bits<1||bits>16)throw Error(SHARE_BROKEN);
  }else throw Error('このリンクは新しい版の YUBI GUI で作られています。ページを再読み込みしてください。');
  const start_holds={R:HOLDS[r.read(3)],L:HOLDS[r.read(3)]};
  const initial_holds={R:HOLDS[r.read(3)],L:HOLDS[r.read(3)]};
  if(!start_holds.R||!start_holds.L||!initial_holds.R||initial_holds.R==='auto'||!initial_holds.L||initial_holds.L==='auto')throw Error(SHARE_BROKEN);
  const withAlg=r.read(1)===1,n=r.read(8);if(!n)throw Error(SHARE_BROKEN);
  const path=[];for(let i=0;i<n;i++){const key=keys[r.read(bits)];if(!key)throw Error(SHARE_BROKEN);if(!table.rowByKey.has(key))throw Error('この共有リンクに含まれる動作は現在利用できません：'+key);path.push(key);}
  const alg=withAlg?new TextDecoder().decode(r.rest()).trim():algFromPath(path,table);
  if(!alg)throw Error(SHARE_BROKEN);
  return {path,initial_holds,start_holds,alg};
}
export function shareCodeFrom(hash){
  const m=new RegExp(`(?:^#|&)${SHARE_KEY}=([^&]+)`).exec(String(hash||''));
  return m?decodeURIComponent(m[1]):null;
}
/* Exact replay uses refresh-schedule; the final regrip is part of the path. */
export function shareRequest({path,initial_holds,alg},isRegrip){
  if(!path.some(k=>!isRegrip(k)))throw Error('共有リンクに回転が含まれていません。');
  return {alg,path:clone(path),initial_holds:clone(initial_holds),origin:0};
}

/* ── コミュテータ記法の展開と、隣り合う同じ面の手のまとめ ──
   [A, B] → A B A' B'、[A: B] → A B A'、(A B)2 や [A]' のような繰り返し・逆手順も読む。入れ子可。
   まとめは「隣り合う、同じ記号（大文字小文字も同じ）の手」だけ：U U' → 消す、U U → U2、U2 U → U'。
   別の面を飛び越えて並べ替えることはしない（U D U のような可換な組も触らない）。 */
const MOVE_RE=/^([URFDLBurfdlbMESxyz])([23]'?|'[23]?|)?$/;
const quarterTurns=suffix=>({'':1,"'":3,'2':2,"2'":2,"'2":2,'3':3,"3'":1,"'3":1}[suffix||'']);
const moveOf=(letter,turns)=>turns%4===0?null:letter+({1:'',2:'2',3:"'"}[turns%4]);
export function invertMoves(tokens){return [...tokens].reverse().map(t=>{
  const m=MOVE_RE.exec(t);if(!m)throw Error(`読めない記号があります：${t}`);
  const suffix=m[2]||'';
  if(suffix.includes('3'))return m[1]+(suffix.includes("'")?'3':"3'");
  // An unhinted half turn stays unhinted, matching the engine's inverse.
  if(suffix.includes('2'))return m[1]+'2';
  return m[1]+(suffix==="'"?'':"'");
});}
// Same matching contract as Rust Catalog::Action::matches; geometry alone
// must not erase authored 270-degree strokes or inverse half-turn direction.
export function actionMatchesToken(row,token){
  const equivalent=m=>m.includes('3')?m[0]+(m.endsWith("'")?'':"'"):m.endsWith("2'")?m.slice(0,-1):m;
  return !!row&&MOVE_RE.test(token)&&equivalent(row.move)===equivalent(token)
    &&(!token.includes('3')||row.authored_move===token)&&(!token.endsWith("2'")||row.direction===-1);
}
export const ALG_LIMITS=Object.freeze({bytes:65536,depth:32,moves:500});
function repeatMoves(tokens,count,inverse=false){
  if(!Number.isSafeInteger(count)||count<0||count>ALG_LIMITS.moves)throw Error('繰り返し回数は500以下にしてください');
  if(tokens.length*count>ALG_LIMITS.moves)throw Error('展開後の手数は500手以下にしてください');
  const base=inverse?invertMoves(tokens):tokens,out=[];
  for(let n=0;n<count;n++)for(const token of base)out.push(token);
  return out;
}
/* Consume every character before expansion; allocation and nesting are bounded.
   Group inverse/repeat suffixes remain a UI preprocessing extension. */
export function expandAlg(text){
  const input=String(text||'');
  if(input.length>ALG_LIMITS.bytes||new TextEncoder().encode(input).length>ALG_LIMITS.bytes)throw Error('手順の入力は65536バイト以下にしてください');
  const src=Array.from(input.replace(/[’′]/g,"'"));let i=0;
  const space=c=>c!==undefined&&/[\s\u001c-\u001f]/u.test(c);
  const digit=c=>c!==undefined&&/\p{Nd}/u.test(c);
  const value=c=>{let n=c.codePointAt(0),start=n;while(start>0&&digit(String.fromCodePoint(start-1)))start--;return (n-start)%10;};
  const append=(out,items)=>{if(out.length+items.length>ALG_LIMITS.moves)throw Error('展開後の手数は500手以下にしてください');for(const item of items)out.push(item);};
  const seq=(stop,depth)=>{
    const out=[];
    while(i<src.length){
      if(space(src[i])){i++;continue;}
      if(stop.includes(src[i]))break;
      const at=i,t=src[i++];
      if(t==='['||t==='('){
        if(depth>=ALG_LIMITS.depth)throw Error('括弧の深さは32以下にしてください');
        const close=t==='['?']':')',a=seq(t==='['?[',',':',close]:[close],depth+1);let items=[...a];
        if(t==='['&&(src[i]===','||src[i]===':')){
          const op=src[i++],b=seq([close],depth+1);append(items,b);append(items,invertMoves(a));if(op===',')append(items,invertMoves(b));
        }
        if(src[i]!==close)throw Error(`括弧が閉じていません：${t}`);i++;
        let count=0,hasCount=false;
        while(digit(src[i])){hasCount=true;count=Math.min(ALG_LIMITS.moves+1,count*10+value(src[i++]));}
        const inverse=src[i]==="'";if(inverse)i++;
        append(out,repeatMoves(items,hasCount?count:1,inverse));
      }else if(']),:'.includes(t))throw Error(`括弧の対応が取れません：${t}`);
      else{
        if(!'URFDLBurfdlbMESxyz'.includes(t))throw Error(`読めない記号があります：${t}（位置 ${at}）`);
        let letter=t,suffix='';
        if(src[i]==='w'||src[i]==='W'){if(!'URFDLB'.includes(t))throw Error(`読めない記号があります：${t}${src[i]}（位置 ${at}）`);letter=t.toLowerCase();i++;}
        if(src[i]&&"23'".includes(src[i])){
          suffix=src[i++];
          if(src[i]&&((suffix==="'"&&'23'.includes(src[i]))||(suffix!=="'"&&src[i]==="'")))suffix+=src[i++];
          if(suffix.startsWith("'")&&suffix.length===2)suffix=suffix[1]+"'";
        }
        if(suffix.includes('3')&&!'RL'.includes(letter))throw Error('270度の指定はR/Lだけに使用できます');
        append(out,[letter+suffix]);
      }
    }
    return out;
  };
  return seq([],0);
}
/* 手をまとめる。
   同じ軸の層はどう並べても結果が同じ（R・L・M・r・l・x は x 軸、U・D・E・u・d・y は y 軸、F・B・S・f・b・z は z 軸）ので、
   同じ軸の手が続く区間の中では、同じ記号の手を1つに足し合わせる（U D U D → U2 D2、U U' → 消える）。
   違う記号どうしは足さない（r と R、R と M はそのまま）。区間の中の並びは最初に出た順を保つ。
   区間が消えて別の区間が隣り合ったら、もう一度まとめる（R U U' R → R2）。変化が無くなるまで繰り返す。 */
const AXIS_OF={R:'x',L:'x',M:'x',r:'x',l:'x',x:'x',U:'y',D:'y',E:'y',u:'y',d:'y',y:'y',F:'z',B:'z',S:'z',f:'z',b:'z',z:'z'};
export const moveAxis=token=>{const m=MOVE_RE.exec(token);return m?AXIS_OF[m[1]]:null;};
function mergeOnce(tokens){
  const out=[];let i=0;
  while(i<tokens.length){
    const axis=moveAxis(tokens[i]);
    if(!axis){out.push(tokens[i++]);continue;}
    const order=[],turns=new Map(),seen=new Map();
    while(i<tokens.length&&moveAxis(tokens[i])===axis){
      const token=tokens[i++],m=MOVE_RE.exec(token);
      if(!turns.has(m[1])){turns.set(m[1],0);order.push(m[1]);seen.set(m[1],[]);}
      turns.set(m[1],(turns.get(m[1])+quarterTurns(m[2]))%4);seen.get(m[1]).push(token);
    }
    /* 1つしか無かった手は書かれたまま残す（U2' や R3 の書き方は指遣いの指定なので変えない）。 */
    for(const letter of order){const list=seen.get(letter);if(list.length===1){out.push(list[0]);continue;}const move=moveOf(letter,turns.get(letter));if(move)out.push(move);}
  }
  return out;
}
export function simplifyMoves(tokens){
  let current=[...tokens];
  for(let guard=0;guard<tokens.length+1;guard++){
    const next=mergeOnce(current);
    if(next.length===current.length&&next.every((t,k)=>t===current[k]))return next;
    current=next;
  }
  return current;
}
export function expandAndSimplify(text){return simplifyMoves(expandAlg(text));}

// Move one existing regrip to a move boundary without changing other actions.
export function relocatedPath(path,from,boundary,isRegrip){
  const count=path.filter(key=>!isRegrip(key)).length;
  if(!Number.isInteger(from)||from<0||from>=path.length||!isRegrip(path[from])||!Number.isInteger(boundary)||boundary<0||boundary>count)throw Error('持ち替えの移動先が不正です。');
  const next=[...path],item=next.splice(from,1)[0];let seen=0,at=next.length;
  for(let i=0;i<next.length;i++)if(!isRegrip(next[i])){if(seen===boundary){at=i;break;}seen++;}
  next.splice(at,0,item);return next;
}
