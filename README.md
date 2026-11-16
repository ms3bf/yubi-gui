# YUBI GUI

ルービックキューブの手順を入力すると、手・指・ホールドの指遣いを探索し、3D の手のアニメーションとチャートで見せる Web アプリです。

- 公開版: https://yubi-gui.vercel.app
- このリポジトリは、公開版で配信している静的ファイル一式そのものです（同一バイト）。

## しくみ

探索エンジン（候補生成・スケジューラ・評価モデル）は Rust で書いて WebAssembly にしたもので、`engine/releases/<hash>/` にあります。すべてブラウザ内で計算し、サーバーへ推論を送りません。3D は three.js、手と動作は `product/` と `assets/` のデータを使います。

## 手元で動かす

任意の静的ファイルサーバで、このフォルダをルートにして配信してください。

```sh
python -m http.server 8000
# → http://localhost:8000/
```

`file://` で直接開くと Worker と WASM が読み込めないため動きません。Vercel では `vercel.json` のヘッダ設定（`*.bin.gz` の `Content-Encoding: gzip`、クリップと WASM の長期キャッシュ）がそのまま使われます。

## クレジット

手モデルは Godot OpenXR Hand Tracking Demo（MIT License）を改変して使用しています。three.js（MIT License）を同梱しています。全文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

[MIT License](LICENSE)。ただし `three/` の three.js と、手モデル（Godot OpenXR Hand Tracking Demo を改変したもの）はそれぞれの著作者の MIT License に従います（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。
