# MODEL_FORMAT — モデルスケッチ（Hub）のデータの形

このフォルダは Hub の拡張「モデルスケッチ」の保存先です。Claude はここのファイルを読み書きして、3D の形を直します。
**Claude が書くのは `<名前>.model.json` の `steps`（レシピ）・`params`（数値）・`paint`（塗り）・`parts`（色・材質）だけ**です。
計算（足す・引く・ふたを作る）は Hub の画面が manifold で行い、すぐに表示します。元の 3D ファイルは書き換えません。

## ファイル

| ファイル | 中身 | 誰が書く |
|---|---|---|
| `<名前>.model.json` | 元のファイルの場所・レシピ・ピン・断面 | 画面と Claude |
| `_ai/<名前>.json` | 測った結果: 部品ごとの外枠、ピンの位置、断面の輪郭（数値）、レシピのエラー | 画面（読むだけ） |
| `_ai/<名前>.png` | 4 方向の画像（斜め・前・右・上）。黄色い丸の番号がピン | 画面（読むだけ） |
| `export/` | 書き出した STL / 3MF / GLB | 画面 |

`_ai/` は利用者が「AI に渡す」を押したとき、また Claude が `.model.json` を書き換えて計算し直したときに更新されます（数秒かかる）。

## 座標

- 単位は **mm**、**Z が上**、X が右、Y が奥（「前」の画像は +Y の方向を見ている）
- 元のファイルの形は、**底の中心が原点 (0, 0, 0)** になるように置いてあります（`_ai/<名前>.json` の `parts[].min / max` で確かめられる）
- ゲーム用の書き出し（GLB）は、画面が m・Y が上に直します。レシピは常に mm・Z が上で書いてください

## `<名前>.model.json`

```jsonc
{
  "format": "hub-model/1",
  "purpose": "print",               // "print"（3D プリント）/ "game"（ゲームの素材）
  "source": { "path": "C:\\...\\box.stl", "scale": 1, "upY": false },   // 元のファイル。無ければ null（空から作る）
  "params": {                       // 利用者がスライダーで変えられる数値。steps の中で "$名前" で使う
    "clearance": { "value": 0.2, "min": 0, "max": 1, "step": 0.05, "label": "すき間 (mm)" }
  },
  "steps": [ … ],                   // レシピ（下）
  "parts": { "lid": { "color": "#E5534B", "material": "plastic", "hidden": false } },   // 部品ごとの色・材質・表示（画面でも変えられる）
  "paint": [ { "of": "lid", "color": "#8B5A2B", "where": { "normal": "up" } } ],   // 面の塗り（下の「塗り」）
  "pins": [ { "id": 1, "p": [10.5, -20, 28], "n": [0, -1, 0], "part": "base", "text": "ここに穴" } ],   // 利用者が置いたピン（p は位置、n は面の向き）
  "section": { "on": true, "axis": "z", "at": 15, "flip": false },   // 今見ている断面
  "measure": [ { "axis": "z", "at": 29.5, "of": "base" } ],          // Claude が測ってほしい断面（結果は _ai/<名前>.json の sections）
  "note": "ふたを付けました。すき間はスライダーで変えられます"          // 画面に出すひとこと（任意）
}
```

元のファイルの部品の名前は、1 つだけなら `base`、複数なら部品の名前（または `part1`, `part2` …）。`_ai/<名前>.json` の `parts[].id` を見てください。

## レシピ（`steps`）

上から順に計算します。各手順の結果は `id` の名前で残り、後の手順で使えます。同じ `id` に書けば置き換えです。
数値の所には `"$clearance"` や `"$wall*2+1"` のような式も書けます（`params` の名前と + - * / ( )）。

| op | 書き方 | 中身 |
|---|---|---|
| `box` | `{"op":"box","id":"b1","size":[x,y,z],"at":[x,y,z]}` | 直方体。**at は底の面の中心** |
| `cylinder` | `{"op":"cylinder","id":"h1","d":3,"h":10,"at":[x,y,z],"axis":"z"}` | 円柱（`d2` で円すい）。**at は底の面の中心**、axis が x / y なら +X / +Y の向きに伸びる |
| `sphere` | `{"op":"sphere","id":"s1","d":10,"at":[x,y,z]}` | 球。at は中心 |
| `polygon` | `{"op":"polygon","id":"p1","points":[[x,y],…],"h":5,"z":0}` | XY の多角形を z から高さ h だけ押し出す |
| `union` / `subtract` / `intersect` | `{"op":"subtract","from":"base","with":["h1","h2"]}` | 足す / 引く / 重なり。結果は `id`（省略すると from を置き換え）。with で使った部品は表示から消える（残すなら `"keep":true`） |
| `translate` | `{"op":"translate","of":"lid","by":[x,y,z]}` | 動かす |
| `rotate` | `{"op":"rotate","of":"lid","deg":[x,y,z],"about":[x,y,z]}` | 回す（度。X→Y→Z の順） |
| `scale` / `mirror` | `{"op":"scale","of":"a","by":1.5}` / `{"op":"mirror","of":"a","normal":[1,0,0]}` | 大きさ / 鏡 |
| `copy` | `{"op":"copy","of":"a","id":"a2"}` | 写し |
| `place` | `{"op":"place","of":"a","at":[x,y]}` | 底を z=0 に置く |
| `cut` | `{"op":"cut","of":"base","axis":"z","at":15,"ids":["bottom","top"]}` | 平面で 2 つに切る（ids は [小さい側, 大きい側]） |
| `lid` | `{"op":"lid","of":"base","id":"lid","clearance":0.2,"top":2,"lip_depth":4,"lip_wall":1.5}` | **箱の口に合うふた**。口の輪郭は上の縁から 0.5mm 下の断面から自動で取る（`rim` で高さを指定できる）。`"layout":"print"` で裏返して箱の横に置く |
| `hide` | `{"op":"hide","of":["a","b"]}` | 表示と書き出しから外す |

どの手順にも `"skip": true` を書くと飛ばします。エラーは画面と `_ai/<名前>.json` の `errors` に「手順 N: …」で出ます。

### 例: 箱にふたと、ふたのつまみ

```json
"params": { "clearance": { "value": 0.2, "min": 0, "max": 0.8, "step": 0.05, "label": "すき間 (mm)" } },
"steps": [
  { "op": "lid", "of": "base", "id": "lid", "clearance": "$clearance" },
  { "op": "cylinder", "id": "knob", "d": 10, "h": 6, "at": [0, 0, 32] },
  { "op": "union", "from": "lid", "with": ["knob"] }
]
```

## 塗り（`paint`）と材質

部品の一部の面に色を塗ります。**上から順に当てて、後の物が上書き**します。形を計算し直しても、塗りは手順として当て直されます。

```jsonc
"paint": [
  { "of": "table", "color": "#8B5A2B" },                                      // 部品全体
  { "of": "table", "color": "#C8A27A", "where": { "normal": "up", "angle": 20 } },   // 上を向いた面（"down" / "side" / [x,y,z] も可）
  { "of": "table", "color": "#2E3238", "where": { "box": [[-300,-200,0],[300,200,400]] } },   // 三角形の中心が箱の中
  { "of": "table", "color": "#E5534B", "where": { "face": { "p": [0, 0, 440], "n": [0, 0, 1] }, "tol": 12 } },   // p の面から、つながった平らな面
  { "of": "table", "color": "#F4F1EA", "where": { "points": [[10,0,440],[20,0,440]], "radius": 3 } },   // 筆（点から radius 以内）
  { "of": "table", "color": null, "where": { "normal": "down" } }              // null = 部品の色に戻す（消しゴム）
]
```

- `of` を省くと全部の部品。`of` には `_ai/<名前>.json` の `parts[].id` を使う
- 色は `#RRGGBB`。ローポリ向きの落ち着いた色が合う（例: 木 `#8B5A2B`、葉 `#57AB5A`、石 `#7A808A`）
- 材質は `parts.<id>.material`: `"plastic"`（既定）/ `"matte"` / `"gloss"` / `"metal"`
- ゲーム用の GLB では、使った色を小さなパレット画像に並べ、各面がそのマスを指す（UV）。Unity・Godot・three.js の普通の材質でそのまま色が出る
- 塗れるのは面の単位。細かい模様（文字・顔）は、面が細かくないと塗れない

## 進め方のこつ

1. まず `_ai/<名前>.json`（寸法・ピン・断面）と `_ai/<名前>.png`（見た目）を読む。ピンの `text` が利用者の頼みごと
2. 寸法が足りなければ、`measure` に断面を足して保存 → 数秒後に `_ai/<名前>.json` の `sections` を読む
3. `steps` を書き換えて保存 → 画面が計算する。`_ai/<名前>.json` の `errors` が空か、`parts` の寸法が狙いどおりかを確かめる
4. 利用者が調整しそうな値（すき間・厚み・直径）は `params` にして、スライダーで変えられるようにする
5. 3D プリント: すき間は 0.15〜0.3mm が目安。壁は 1.2mm 以上。ふたは `"layout":"print"` で裏返すと印刷しやすい
6. ゲーム: 部品ごとの色は `parts.<id>.color`、面ごとの色は `paint`、質感は `parts.<id>.material`。三角形の数は `_ai/<名前>.json` の `parts[].triangles`

できないこと: 元の形の面を変形する（角を丸める・肉厚を変える）、有機的な形（キャラクターなど）。元の形が閉じていない（穴がある）と、足す・引くはエラーになります（表示・断面・ピンは使えます）。
