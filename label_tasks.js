import {uiText,uiHTML} from './i18n.js';
import {escapeHTML as esc, stripLeadingY, apiFetch} from './core.js';

/* tribox 手順票のスイッチ。false のあいだは出どころの切り替えも行も出さず、
   localStorage に残っている label-source-v1 も見ない（登録ケース扱い）。
   true に戻すだけで UI ごと復活する。表と build_tribox.mjs・test_tribox.mjs・tribox/*.txt は残す。 */
const TRIBOX_ENABLED=false;

// TRIBOX BEGIN — build_tribox.mjs が tribox/*.txt から生成する。手で直さない。
const TRIBOX_TASKS=[
{family:'f2l',id:'tribox:f2l:1',name:'F2L 1',alg:"U R U' R'"},
{family:'f2l',id:'tribox:f2l:2',name:'F2L 2',alg:"U' L' U L"},
{family:'f2l',id:'tribox:f2l:3',name:'F2L 3',alg:"U L' U' L"},
{family:'f2l',id:'tribox:f2l:4',name:'F2L 4',alg:"U' R U R'"},
{family:'f2l',id:'tribox:f2l:5',name:'F2L 5',alg:"U2 R U R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:6',name:'F2L 6',alg:"U2 L' U' L U2 L' U L"},
{family:'f2l',id:'tribox:f2l:7',name:'F2L 7',alg:"U R U2 R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:8',name:'F2L 8',alg:"U' L' U2 L U2 L' U L"},
{family:'f2l',id:'tribox:f2l:9',name:'F2L 9',alg:"L' U L U L' U' L"},
{family:'f2l',id:'tribox:f2l:10',name:'F2L 10',alg:"R U' R' U' R U R'"},
{family:'f2l',id:'tribox:f2l:11',name:'F2L 11',alg:"U' L' U L U' L' U L U2 L' U L"},
{family:'f2l',id:'tribox:f2l:12',name:'F2L 12',alg:"U R U' R' U R U' R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:13',name:'F2L 13',alg:"U L' U L U' L' U' L"},
{family:'f2l',id:'tribox:f2l:14',name:'F2L 14',alg:"U' R U' R' U R U R'"},
{family:'f2l',id:'tribox:f2l:15',name:'F2L 15',alg:"U R U' R' U2 R U' R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:16',name:'F2L 16',alg:"U' L' U' L U2 L' U L U' L' U L"},
{family:'f2l',id:'tribox:f2l:17',name:'F2L 17',alg:"R U2 R' U' R U R'"},
{family:'f2l',id:'tribox:f2l:18',name:'F2L 18',alg:"L' U2 L U L' U' L"},
{family:'f2l',id:'tribox:f2l:19',name:'F2L 19',alg:"R U2 R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:20',name:'F2L 20',alg:"L' U2 L U' L' U L"},
{family:'f2l',id:'tribox:f2l:21',name:'F2L 21',alg:"R U R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:22',name:'F2L 22',alg:"L' U' L U' L' U L"},
{family:'f2l',id:'tribox:f2l:23',name:'F2L 23',alg:"U2 R U' R' U' R U' R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:24',name:'F2L 24',alg:"U2 L' U L U L' U L U' L' U L"},
{family:'f2l',id:'tribox:f2l:25',name:'F2L 25',alg:"U' F' R U R' U' R' F R"},
{family:'f2l',id:'tribox:f2l:26',name:'F2L 26',alg:"r U r' U' r' F r F'"},
{family:'f2l',id:'tribox:f2l:27',name:'F2L 27',alg:"R U' R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:28',name:'F2L 28',alg:"L' U L U' L' U L"},
{family:'f2l',id:'tribox:f2l:29',name:'F2L 29',alg:"L' U' L U L' U' L"},
{family:'f2l',id:'tribox:f2l:30',name:'F2L 30',alg:"R U R' U' R U R'"},
{family:'f2l',id:'tribox:f2l:31',name:'F2L 31',alg:"U' R' F R F' R U' R'"},
{family:'f2l',id:'tribox:f2l:32',name:'F2L 32',alg:"U R U' R' U R U' R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:33',name:'F2L 33',alg:"U' R U' R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:34',name:'F2L 34',alg:"U R' D' R U' R' D R"},
{family:'f2l',id:'tribox:f2l:35',name:'F2L 35',alg:"U' R U R' U y' R' U' R"},
{family:'f2l',id:'tribox:f2l:36',name:'F2L 36',alg:"U F' U' F U' R U R'"},
{family:'f2l',id:'tribox:f2l:37',name:'F2L 37',alg:"R' F R F' R U' R' U R U' R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:38',name:'F2L 38',alg:"R U' R' U' R U R' U2 R U' R'"},
{family:'f2l',id:'tribox:f2l:39',name:'F2L 39',alg:"R U' R' U R U2 R' U R U' R'"},
{family:'f2l',id:'tribox:f2l:40',name:'F2L 40',alg:"r U' r' U2 r U r' R U R'"},
{family:'f2l',id:'tribox:f2l:41',name:'F2L 41',alg:"R U' R' r U' r' U2 r U r'"},
{family:'oll',id:'tribox:oll:1',name:'OLL 1',alg:"R U2 R2 F R F' U2 R' F R F'"},
{family:'oll',id:'tribox:oll:2',name:'OLL 2',alg:"F R U R' U' F' f R U R' U' f'"},
{family:'oll',id:'tribox:oll:3',name:'OLL 3',alg:"r' R2 U R' U r U2 r' U M'"},
{family:'oll',id:'tribox:oll:4',name:'OLL 4',alg:"r' R U' r U2 r' U' R U' R2 r"},
{family:'oll',id:'tribox:oll:5',name:'OLL 5',alg:"r' U2 R U R' U r"},
{family:'oll',id:'tribox:oll:6',name:'OLL 6',alg:"r U2 R' U' R U' r'"},
{family:'oll',id:'tribox:oll:7',name:'OLL 7',alg:"r U R' U R U2 r'"},
{family:'oll',id:'tribox:oll:8',name:'OLL 8',alg:"r' U' R U' R' U2 r"},
{family:'oll',id:'tribox:oll:9',name:'OLL 9',alg:"R U R' U' R' F R2 U R' U' F'"},
{family:'oll',id:'tribox:oll:10',name:'OLL 10',alg:"R U R' U R' F R F' R U2 R'"},
{family:'oll',id:'tribox:oll:11',name:'OLL 11',alg:"r' R2 U R' U R U2 R' U M'"},
{family:'oll',id:'tribox:oll:12',name:'OLL 12',alg:"F R U R' U' F' y F R U R' U' F'"},
{family:'oll',id:'tribox:oll:13',name:'OLL 13',alg:"F U R U' R2 F' R U R U' R'"},
{family:'oll',id:'tribox:oll:14',name:'OLL 14',alg:"R' F R U R' F' R F U' F'"},
{family:'oll',id:'tribox:oll:15',name:'OLL 15',alg:"r' U' r R' U' R U r' U r"},
{family:'oll',id:'tribox:oll:16',name:'OLL 16',alg:"l U l' L U L' U' l U' l'"},
{family:'oll',id:'tribox:oll:17',name:'OLL 17',alg:"R U R' U R' F R F' U2 R' F R F'"},
{family:'oll',id:'tribox:oll:18',name:'OLL 18',alg:"R U2 R2 F R F' U2 r R' U R U' r'"},
{family:'oll',id:'tribox:oll:19',name:'OLL 19',alg:"r' R U R U R' U' r R2 F R F'"},
{family:'oll',id:'tribox:oll:20',name:'OLL 20',alg:"M U R U R' U' M2 U R U' r'"},
{family:'oll',id:'tribox:oll:21',name:'OLL 21',alg:"R U2 R' U' R U R' U' R U' R'"},
{family:'oll',id:'tribox:oll:22',name:'OLL 22',alg:"R U2 R2 U' R2 U' R2 U2 R"},
{family:'oll',id:'tribox:oll:23',name:'OLL 23',alg:"R2 D' R U2 R' D R U2 R"},
{family:'oll',id:'tribox:oll:24',name:'OLL 24',alg:"r U R' U' r' F R F'"},
{family:'oll',id:'tribox:oll:25',name:'OLL 25',alg:"r U2 R2 F R F' R U2 r'"},
{family:'oll',id:'tribox:oll:26',name:'OLL 26',alg:"R' U' R U' R' U2 R"},
{family:'oll',id:'tribox:oll:27',name:'OLL 27',alg:"R U R' U R U2 R'"},
{family:'oll',id:'tribox:oll:28',name:'OLL 28',alg:"r U R' U' r' R U R U' R'"},
{family:'oll',id:'tribox:oll:29',name:'OLL 29',alg:"R U R' U' R U' R' F' U' F R U R'"},
{family:'oll',id:'tribox:oll:30',name:'OLL 30',alg:"F R' F R2 U' R' U' R U R' F2"},
{family:'oll',id:'tribox:oll:31',name:'OLL 31',alg:"R' U' F U R U' R' F' R"},
{family:'oll',id:'tribox:oll:32',name:'OLL 32',alg:"R U B' U' R' U R B R'"},
{family:'oll',id:'tribox:oll:33',name:'OLL 33',alg:"R U R' U' R' F R F'"},
{family:'oll',id:'tribox:oll:34',name:'OLL 34',alg:"R U R2 U' R' F R U R U' F'"},
{family:'oll',id:'tribox:oll:35',name:'OLL 35',alg:"R U2 R2 F R F' R U2 R'"},
{family:'oll',id:'tribox:oll:36',name:'OLL 36',alg:"R' U' R U' R' U R U R B' R' B"},
{family:'oll',id:'tribox:oll:37',name:'OLL 37',alg:"F R U' R' U' R U R' F'"},
{family:'oll',id:'tribox:oll:38',name:'OLL 38',alg:"R U R' U R U' R' U' R' F R F'"},
{family:'oll',id:'tribox:oll:39',name:'OLL 39',alg:"L F' L' U' L U F U' L'"},
{family:'oll',id:'tribox:oll:40',name:'OLL 40',alg:"R' F R U R' U' F' U R"},
{family:'oll',id:'tribox:oll:41',name:'OLL 41',alg:"R U R' U R U2 R' F R U R' U' F'"},
{family:'oll',id:'tribox:oll:42',name:'OLL 42',alg:"R' U R U2 R' U' F' U F U R"},
{family:'oll',id:'tribox:oll:43',name:'OLL 43',alg:"R' U' F' U F R"},
{family:'oll',id:'tribox:oll:44',name:'OLL 44',alg:"f R U R' U' f'"},
{family:'oll',id:'tribox:oll:45',name:'OLL 45',alg:"F R U R' U' F'"},
{family:'oll',id:'tribox:oll:46',name:'OLL 46',alg:"R' U' R' F R F' U R"},
{family:'oll',id:'tribox:oll:47',name:'OLL 47',alg:"F' L' U' L U L' U' L U F"},
{family:'oll',id:'tribox:oll:48',name:'OLL 48',alg:"F R U R' U' R U R' U' F'"},
{family:'oll',id:'tribox:oll:49',name:'OLL 49',alg:"R B' R2 F R2 B R2 F' R"},
{family:'oll',id:'tribox:oll:50',name:'OLL 50',alg:"L' B L2 F' L2 B' L2 F L'"},
{family:'oll',id:'tribox:oll:51',name:'OLL 51',alg:"f R U R' U' R U R' U' f'"},
{family:'oll',id:'tribox:oll:52',name:'OLL 52',alg:"R' U' R U' R' U y' R' U R B"},
{family:'oll',id:'tribox:oll:53',name:'OLL 53',alg:"r' U2 R U R' U' R U R' U r"},
{family:'oll',id:'tribox:oll:54',name:'OLL 54',alg:"r U R' U R U' R' U R U2 r'"},
{family:'oll',id:'tribox:oll:55',name:'OLL 55',alg:"r U2 R2 F R F' U2 r' F R F'"},
{family:'oll',id:'tribox:oll:56',name:'OLL 56',alg:"F R U R' U' R F' r U R' U' r'"},
{family:'oll',id:'tribox:oll:57',name:'OLL 57',alg:"R U R' U' M' U R U' r'"},
{family:'pll',id:'tribox:pll:Aa',name:'PLL Aa',alg:"l' U R' D2 R U' R' D2 R l"},
{family:'pll',id:'tribox:pll:Ab',name:'PLL Ab',alg:"l' R' D2 R U R' D2 R U' l"},
{family:'pll',id:'tribox:pll:E',name:'PLL E',alg:"R' U' R' D' R U' R' D R U R' D' R U R' D R2"},
{family:'pll',id:'tribox:pll:F',name:'PLL F',alg:"R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R"},
{family:'pll',id:'tribox:pll:Ga',name:'PLL Ga',alg:"R2 U R' U R' U' R U' R2 U' D R' U R D'"},
{family:'pll',id:'tribox:pll:Gb',name:'PLL Gb',alg:"R' U' R U D' R2 U R' U R U' R U' R2 D"},
{family:'pll',id:'tribox:pll:Gc',name:'PLL Gc',alg:"R2 U' R U' R U R' U R2 U D' R U' R' D"},
{family:'pll',id:'tribox:pll:Gd',name:'PLL Gd',alg:"R U R' U' D R2 U' R U' R' U R' U R2 D'"},
{family:'pll',id:'tribox:pll:H',name:'PLL H',alg:"M2 U' M2 U2 M2 U' M2"},
{family:'pll',id:'tribox:pll:Ja',name:'PLL Ja',alg:"r R2 F R F' R U2 r' U r U2 r'"},
{family:'pll',id:'tribox:pll:Jb',name:'PLL Jb',alg:"R U R' F' R U R' U' R' F R2 U' R'"},
{family:'pll',id:'tribox:pll:Na',name:'PLL Na',alg:"R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'"},
{family:'pll',id:'tribox:pll:Nb',name:'PLL Nb',alg:"R' U R U' R' F' U' F R U R' U' R U' f R f'"},
{family:'pll',id:'tribox:pll:Ra',name:'PLL Ra',alg:"U R U' R' U' R U R D R' U' R D' R' U2 R'"},
{family:'pll',id:'tribox:pll:Rb',name:'PLL Rb',alg:"R' U2 R' D' R U' R' D R U R U' R' U' R"},
{family:'pll',id:'tribox:pll:T',name:'PLL T',alg:"R U R' U' R' F R2 U' R' U' R U R' F'"},
{family:'pll',id:'tribox:pll:Ua',name:'PLL Ua',alg:"R U R' U R' U' R2 U' R' U R' U R"},
{family:'pll',id:'tribox:pll:Ub',name:'PLL Ub',alg:"R' U R' U' R3 U' R' U R U R2"},
{family:'pll',id:'tribox:pll:V',name:'PLL V',alg:"R' U R U' R' f' U' R U2 R' U' R U' R' f R"},
{family:'pll',id:'tribox:pll:Y',name:'PLL Y',alg:"F R U' R' U' R U R' F' R U R' U' R' F R F'"},
{family:'pll',id:'tribox:pll:Z',name:'PLL Z',alg:"M' U' M2 U' M2 U' M' U2 M2"}
];
// TRIBOX END

/* F2L・OLL・PLL は名前（なければID）の中の最初の整数で並べる。"OLL 2" が "OLL 19" より前に来るようにする。
   3style（エッジ・コーナー・パリティ）は交換の並びに意味があるのでデータセットの順を保つ。 */
const NUMBERED=['f2l','oll','pll'];
/* 名前・IDの先頭にある種類名（F2L の 2 など）は番号ではないので落としてから最初の整数を読む。 */
const withoutFamily=value=>String(value??'').replace(/^\s*(?:f2l|oll|pll)[\s:_-]*/i,'');
export function caseNumber(task) {
  const hit=withoutFamily(task?.name).match(/\d+/)||withoutFamily(task?.id).match(/\d+/);
  return hit?Number(hit[0]):Number.POSITIVE_INFINITY;
}
export function orderTasks(tasks) {
  const groups=new Map();
  for(const t of tasks){const key=t.family??'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);}
  const out=[];
  for(const [family,list] of groups){
    if(NUMBERED.includes(family))list.sort((a,b)=>caseNumber(a)-caseNumber(b)||String(a.name??'').localeCompare(String(b.name??''),'ja'));
    out.push(...list);
  }
  return out;
}
/* 登録ケースの F2L・OLL・PLL は、盤面合わせの先頭 y を落として見せる（3style には触らない）。 */
const STRIP_Y_FAMILIES=['f2l','oll','pll'];
export function withoutLeadingY(task) {
  if(!task||!STRIP_Y_FAMILIES.includes(task.family))return task;
  const alg=stripLeadingY(task.alg);
  return alg===task.alg?task:{...task,alg};
}
export function filterTasks(tasks, family='', query='', status='all') {
  const words=query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return orderTasks(tasks.filter(t=>(status==='all'||(status==='mapped'?t.done:!t.done))&&(!family||t.family===family||(family==='ll'&&['oll','pll','parity'].includes(t.family))||(family==='bld'&&['edge','corner','parity'].includes(t.family)))&&words.every(w=>(t.name+' '+t.id+' '+t.alg).toUpperCase().includes(w))));
}

export function shuffledIds(tasks, random=Math.random) {
  const ids=tasks.map(t=>t.id);
  for(let i=ids.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}
  return ids;
}
export function nextTask(tasks,current,family='',query='') {
  const eligible=new Set(filterTasks(tasks,family,query,'pending').map(t=>t.id));
  const start=tasks.findIndex(t=>t.id===current);
  for(let step=1;step<=tasks.length;step++){
    const t=tasks[(start+step)%tasks.length];
    if(t.id!==current&&eligible.has(t.id))return t;
  }
  return null;
}

if(typeof document!=='undefined') {
  const $=id=>document.getElementById(id),scope=new URLSearchParams(location.search).get('test')==='1'?'ui-tests':'model';
  let data=null,shown=[],busy=false,generation=0;
  const familyKey='label-family-v1',sourceKey='label-source-v1';
  const labels={edge:'エッジ',corner:'コーナー',parity:'パリティ',oll:'OLL',pll:'PLL',f2l:'F2L'};
  /* 出どころ。'registered' は登録ケース（/api/label-tasks）、'tribox' は手順票（TRIBOX_TASKS）。 */
  let source='registered';
  if(TRIBOX_ENABLED){try{const saved=localStorage.getItem(sourceKey);if(saved==='tribox'||saved==='registered')source=saved;}catch{}}
  else $('label-source').hidden=true;
  const FAMILY_OPTIONS={
    registered:[['f2l','F2L'],['oll','OLL'],['pll','PLL'],['edge','エッジ（3style）'],['corner','コーナー（3style）'],['parity','パリティ'],['','すべて']],
    tribox:[['f2l','F2L'],['oll','OLL'],['pll','PLL'],['','すべて']],
  };
  function fillFamilies(){
    const box=$('label-family'),want=box.value;
    uiHTML(box,FAMILY_OPTIONS[source].map(([v,text])=>`<option value="${v}">${text}</option>`).join(''));
    box.value=[...box.options].some(o=>o.value===want)?want:FAMILY_OPTIONS[source][0][0];
  }
  fillFamilies();
  try{const saved=localStorage.getItem(familyKey);if(saved!==null&&[...$('label-family').options].some(o=>o.value===saved))$('label-family').value=saved;}catch{}
  const activeTasks=()=>source==='tribox'?TRIBOX_TASKS:(data?.tasks||[]).map(withoutLeadingY);
  /* 手順票の行は支持数も登録済みの印も持たないので、無い前提で組み立てる。 */
  function rowTitle(t){
    if(!t.alg)return esc(t.id)+'&#10;手順が空のため開けません（盤面合わせの回転だけのケース）';
    if(source==='tribox')return esc(t.id)+'&#10;'+esc(t.alg)+'&#10;tribox 手順票 · モデル探索で指使いを出します';
    const known=['oll','pll','f2l'].includes(t.family);
    const note=Number.isFinite(t.support)
      ?(known?'SpeedCubeDB · '+t.support+'票 · 盤面条件検証済み':'Manmade Top1 · 採用者 '+t.support+' 人 · 交換検証済み')
      :(known?'SpeedCubeDB':'Manmade Top1');
    return esc(t.id)+'&#10;'+esc(t.alg)+'&#10;'+note;
  }
  function render(){
    if(source!=='tribox'&&!data)return;
    shown=filterTasks(activeTasks(),$('label-family').value,$('label-query').value);
    uiText($('label-tab-count'),source==='tribox'?TRIBOX_TASKS.length:(data?.total??data?.tasks?.length??''));
    uiText($('label-count'),`表示 ${shown.length} 件`);
    uiHTML($('label-list'),shown.map((t,i)=>`<button class="row" data-label-index="${i}" ${busy||!t.alg?'disabled':''} title="${rowTitle(t)}"><span class="fam">${esc(labels[t.family]||t.family)}</span><span class="nm" translate="no">${esc(t.name)}</span><span class="alg">${esc(t.alg)}</span></button>`).join('')||'<p class="saved-empty">条件に一致するケースがありません。</p>');
    for(const b of document.querySelectorAll('#label-source button'))b.classList.toggle('on',b.dataset.source===source);
    $('label-family').disabled=busy;
    $('label-query').disabled=busy;
  }
  async function refresh(){
    if(source==='tribox'){render();uiText($('label-status'),'tribox の手順票です。選ぶとモデルで指使いを探索します。');return;}
    const g=++generation;uiText($('label-status'),'ケース一覧を読み込み中…');
    try{
      const r=await apiFetch('/api/label-tasks?scope='+scope);const result=await r.json();if(!r.ok)throw Error(result.error||'読み込み失敗');
      if(g!==generation)return;data=result;render();
      uiText($('label-status'),'ケースを選ぶ → 指使いを調整 → 上部の「保存」で端末に保存');
    }catch(e){if(g===generation){data=null;uiText($('label-status'),e.message+'。パネルを開き直すと再試行します。');uiText($('label-count'),'');}}
  }
  async function open(task){
    if(busy)return;
    busy=true;render();uiHTML($('label-status'),`<span translate="no">${esc(task.name)}</span> の指使いを探索中…`);
    try{
      await new Promise((resolve,reject)=>window.dispatchEvent(new CustomEvent('open-label-task',{detail:{task,resolve,reject}})));
      $('tab-search').click();$('label-current').scrollIntoView({block:'nearest'});
      uiText($('label-status'),'読み込みました。指使いを調整して「保存」で端末に保存できます。');
    }catch(e){uiText($('label-status'),e.message);}
    finally{busy=false;render();}
  }
  $('label-list').onclick=e=>{const b=e.target.closest('[data-label-index]');if(b&&!b.disabled)open(shown[Number(b.dataset.labelIndex)]);};
  $('label-family').onchange=()=>{try{localStorage.setItem(familyKey,$('label-family').value);}catch{}render();};
  $('label-source').onclick=e=>{
    const b=e.target.closest('[data-source]');if(!TRIBOX_ENABLED||!b||busy||b.dataset.source===source)return;
    source=b.dataset.source;try{localStorage.setItem(sourceKey,source);}catch{}
    fillFamilies();refresh();
  };
  $('label-query').oninput=render;
  $('label-back').onclick=()=>$('tab-label').click();
  window.addEventListener('label-tasks-open',()=>{if(source==='tribox'||!data)refresh();});
  refresh();
}
