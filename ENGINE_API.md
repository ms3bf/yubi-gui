# YUBI エンジン API

ルービックキューブの手順を受け取り、左右の手のどの指でどう回すか（指遣い・ホールド・持ち替え）の候補を探して評価するエンジンです。Rust で書かれ、WebAssembly としてブラウザや Node でそのまま動きます。サーバーは要りません。

- 配布物: `engine/releases/<hash>/dist/` の 3 ファイル
  - `yubi_engine.js` — wasm-bindgen が生成した読み込み用 JS（ES module）
  - `yubi_engine_bg.wasm` — エンジン本体
  - `bundle.json` — 合法手カタログ、学習済みモデルの重み、固定データ
- ソース: `engine-src/`（ビルド方法は末尾）
- Worker で動かす薄いラッパー: `engine/releases/<hash>/ui/engine.js`, `engine.worker.js`（`fetch('/api/…')` と同じ形で呼べる）

## 使い方

```js
import init, {Engine} from './engine/releases/<hash>/dist/yubi_engine.js';

await init();                                    // ブラウザ。Node では init({module_or_path: wasmのバイト列})
const bundle = await (await fetch('./engine/releases/<hash>/dist/bundle.json')).text();
const engine = new Engine(bundle);               // 一度だけ（約 0.2 秒）

const result = JSON.parse(engine.search(JSON.stringify({
  alg: "R U R' U' R' F R2 U' R' U' R U R' F'",
})));
console.log(result.routes[0].preference_score);  // 1.08882474899292
console.log(result.routes[0].path);              // 1 位の指遣い（動作 ID の列）
```

すべての関数は JSON 文字列を受け取り JSON 文字列を返す同期関数です。入力が不正なときは `Error` を投げます（メッセージは日本語。例: `手順は展開後1〜100手で入力してください`）。計算は端末内で完結し、ファイル・時計・乱数・ネットワークを使いません。同じ入力には常に同じ出力を返します。

## 関数一覧

| 関数 | 入力 | 出力 |
|---|---|---|
| `new Engine(bundle_json)` | `bundle.json` の中身 | エンジン |
| `search(request)` | 手順と条件 | 指遣いの候補（最大 8） |
| `normalize(request)` | `{"alg": "..."}` | `{"alg": "r U l' R U R U", "moves": [...]}` |
| `refresh_schedule(request)` | `{"alg", "path", "initial_holds"}` | 指定した指遣いの時刻表（候補 1 件と同じ形） |
| `display_schedule(request)` | `{"alg", "path", "initial_holds"}` | 表示用に時間を補正した時刻表 `{display, adjustments, teacher_score, …}` |
| `catalog_json()` | なし | 合法配置 286 件 `{rows, count, hashes, holds}` |
| `action_lanes_json()` | なし | 全指使い一覧の表示用データ |
| `label_tasks_json()` | なし | 登録ケース 958 件 `{tasks, counts, …}` |

## search の入力

```json
{
  "alg": "R U R' U'",
  "start_holds": {"R": "auto", "L": "F"},
  "constraints": [{"pos": 0, "action_id": "R_R_WRIST_CW"}],
  "prefix": null,
  "initial_state": null
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `alg` | ○ | 手順。展開後 1〜100 手。`R U R' U2`、ワイド（`Rw` = `r`）、スライス `M E S`、全体回転 `x y z`、`U2'`、括弧と繰り返し `(R U)2`、コミュテータ `[R, U]` と共役 `[R: U]` を受け付ける |
| `start_holds` | | 開始ホールド `{"R": h, "L": h}`。`h` は `auto`（自由）か `B_CW` `U` `F` `D` `B_CCW`。`auto` は全ホールドを試すので遅くなる |
| `constraints` | | 固定条件の配列。`pos` は 0 始まりの手番号。<br>`{"pos", "action_id"}` その手の指遣いを固定<br>`{"pos", "regrip_before": {"hand": "R", "to_hold": "U"}}` 直前に持ち替えを入れる<br>`{"pos", "no_regrip_before": true}` 直前の持ち替えを禁止<br>`{"pos", "regrip_after": true｜false}` 直後の持ち替えを入れる／禁止 |
| `prefix` | | `{"path", "initial_holds"}`。先頭部分の指遣いを固定し、後ろだけ探索し直す |
| `initial_state` | | 前の手順の結果の `end_state`。手の姿勢とホールドを引き継いで手順をつなげる |
| `exclude` | | `[{"pos", "action_id"}]`。除外する指遣い（使うと候補を最大 32 件まで広げてから除外） |

## search の出力

```json
{
  "alg": "R U R' U' R' F R2 U' R' U' R U R' F'",
  "routes": [ { ...候補... } ],
  "model": "fast_teacher_S0_972_beam64",
  "model_version": { "...": "モデルとカタログのハッシュ" },
  "search_method": "fast_teacher_S0_972_beam64",
  "reason": "",
  "exclusion_policy": null
}
```

`routes` は評価の良い順（`preference_score` が小さい順）に最大 8 件。0 件のときは `reason` に理由が入ります。

### 候補（routes[i]）の主なキー

| キー | 内容 |
|---|---|
| `path` | 各手に使う動作の ID（`<手>__<動作>__FROM_<ホールド>`）の列。持ち替えも含む |
| `initial_holds` | 開始ホールド `{"L": "F", "R": "F"}` |
| `preference_score` | 評価値（学習済みモデルによる相対エネルギー）。小さいほど良い |
| `cost` / `physical_cost` | 所要時間（相対時間。`u_flick` を 1 とする単位） |
| `t_end` | 最後の動作の終了時刻 |
| `moves` | 手ごとの情報（下表） |
| `regrips` | 持ち替え（`hand`, `hold_before` → `hold_after`, `start`, `end`, `after_pos`, `initial_setup`（開始ホールドを作るための準備）…） |
| `lanes` | 指ごとの時刻表。キーは `R.thumb` `R.index` `R.middle` `R.ring` `R.pinky` `R.wrist`（左も同様）。各イベントは `kind`（`stroke` 駆動／`recovery` 回復／`regrip` 持ち替え など）, `start`, `end`, `role`, `clip` … |
| `end_state` | 終了状態。次の `search` の `initial_state` にそのまま渡せる |
| `id` | 候補の識別子（経路とモデル版のハッシュ） |
| `pose_bindings`, `clip_hashes`, `playback_start` | 3D アニメーション用 |

### 手（moves[i]）の主なキー

| キー | 内容 |
|---|---|
| `move` / `input_move` | 回転記号（正規化後／入力どおり） |
| `hand`, `action_id`, `key` | 回す手と動作 |
| `hold_before`, `hold_after`, `holds_before`, `holds_after` | その手の前後のホールド（片手／両手） |
| `start`, `end` | 開始・終了時刻 |
| `wait`, `wait_cause` | キューブが止まっていた時間と、その原因になった資源（`finger:R.thumb`、`cube`、`startup` など） |
| `resources`, `roles` | 使う指と役割（駆動・支持など） |
| `cube_segments` | キューブの回転区間（軸・層・角度・時刻） |
| `d_class` | 動作の時間クラス |

## 速さの目安

2 コア Xeon 2.1GHz の Node で、T パーム（14 手、開始ホールド自由）が約 0.6 秒、開始ホールドを指定すると約 0.5 秒、`R U R' U'` が約 0.18 秒。手数にほぼ比例します。初回のみエンジン生成に約 0.2 秒。大量の手順を評価する用途では、候補を絞ってから呼ぶのが現実的です。

## ソースからビルド

```sh
cd engine-src
cargo build --release              # ネイティブ（golden_runner: bundle.json と JSONL を読む CLI）
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --release --target web   # pkg/ に yubi_engine.js と yubi_engine_bg.wasm
```

`golden_runner` は 1 行 1 リクエストで計算します:

```sh
echo '{"id":"t","module":"search","input":{"alg":"R U R'"'"' U'"'"'"}}' | ./target/release/golden_runner ../engine/releases/<hash>/dist/bundle.json
```

開発用の一致検証テスト（Python 参照実装との比較、データ約 400MB）はこのリポジトリに含めていません。
