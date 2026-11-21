# AnimeVRM engine

VRM のキャラクターをアニメ調に描画する、Three.js / @pixiv/three-vrm 用のライブラリです。

- トゥーンシェーダー（顔の陰影、髪の影、輪郭線）
- ポストプロセス（光のにじみ、光条、被写界深度、色調）
- 感情の演出（赤面、涙、汗、漫画風の文字、集中線）
- 時間帯ごとの光と空、背景の絵、3D の背景
- 複数のキャラの配置、カメラの構図と動き、ボイスに合わせた口の動き

## 例

[examples/basic](examples/basic) は、グレーの床の上にキャラを1人立たせ、マウスでカメラを回せる例です。VRM ファイルをドロップすると差し替わります。

ブラウザで開く：https://uemegu.github.io/AnimeVRM.engine/

手元で動かすとき：

```bash
npm install
npm run example
```

http://localhost:5192 を開きます。

## 基本の使い方

```ts
import { StageManager } from '@anime-vrm/engine/stage/StageManager';

const stage = new StageManager({
  canvas,
  presets: { timeOfDay: { day }, locations: { room } },
  initialTimeOfDay: 'day',
  initialLocationId: 'room',
});
stage.resize(canvas.clientWidth, canvas.clientHeight);

await stage.setCast([
  { id: 'aoi', modelUrl: '/models/aoi.vrm', slot: 'center', expression: 'neutral', expressionWeight: 1, motionLoop: true },
]);
stage.setCameraShot('wide', 'aoi');
```

- `presets.timeOfDay` は時間帯ごとの光・ポストプロセスの設定、`presets.locations` は場所ごとの背景の設定です。項目は `src/schema/visual.ts` にあります。`examples/basic/day.json` が昼の設定の例です。
- `setCast` に渡すキャラの項目（立ち位置、表情、モーション、視線、演出など）は `src/schema/stage.ts` の `StageCastMember` です。
- カメラの構図は `setCameraShot(構図, 寄る相手, 肩越しの手前の人)`（`wide` / `medium` / `speaker` / `close` / `face` / `side` / `ots`）で選びます。`face` は肩口から頭までの顔アップです。`ots` は肩越しで、手前の人を省くと、寄る相手が見ている人（いなければ話者、それもいなければ一番近い人）になります。`close`・`face` は寄る相手が誰かを見ていれば、顔を斜め前から撮ります（回り込む割合は場所の設定 `camera.close.orbit`・`camera.face.orbit`）。構図を変えるとカメラはその場で切り替わり（カット）、滑らかに動かすのはタイムラインで秒数を指定したときだけです。手で動かすときは `setFreeCamera(true)` にして `viewCamera` を操作します。
- 構図ごとにレンズが変わります。`close`・`face` は望遠（遠くから狭い画角で撮り、背景が詰まってぼける）、`wide` は広角です。倍率は場所の設定 `camera.<構図>.lens` で変えられます。基準の画角は、場所を見せる構図（`wide` / `medium` / `side`）では場所の画角、顔を撮る構図（`speaker` / `close` / `face` / `ots`）では標準の画角（32°）なので、画角の広い場所でも顔の寄り具合は変わりません。
- 話者は声に合わせて首・眉・目が動きます。強めた音節（声の山が平均より大きい所。声の大きさは `getSpeakerMouthOpen`）で軽くうなずき、文ごとに首の傾きを変えます。カットの `speechTone`（`calm` / `excited` / `question` / `hesitant` / `surprised` / `shy`）で芝居が変わり、勢いは目を見開いて強くうなずく、問いかけは文の終わりで首をかしげる、ためらいは伏し目でうつむく、照れは目を細める、驚きは言い出しで大きく見開きます。乱数で決めるのは首を傾ける向きと大きさの揺らぎだけです。眉・目は VRoid のシェイプキー（`Fcl_BRW_Surprised`・`Fcl_EYE_Surprised`・`Fcl_EYE_Joy`・`Fcl_EYE_Sorrow`）があるモデルだけで、感情の表情を付けている間は動かしません。ボイスのないセリフでは動きません。
- `presets.motions` にモーションごとの `fadeIn`（前のモーションからつなぐ秒数）を書くと、驚きは鋭く、待機への戻りはゆっくりつなげます。

## スカートを布として動かす

`quality: { skirtCloth: true }`（`StageManager` のオプション、または `setQuality`）で、スカートを揺れものの骨の代わりに布として動かします（`src/cloth`）。既定は切です。

布の部分（`src/cloth`）は engine のほかの部分に依存しておらず、単独でも使えます。VRM でない骨つきモデルや、骨のない部品に分かれただけのモデルへの使い方は [src/cloth/README.md](src/cloth/README.md)、単独の例は `npm run example:cloth` です。

- モデルは骨・材質・輪郭線ともそのままで、スカートの部品のジオメトリだけを細かく分割したものに差し替え、頂点を毎フレーム書き換えます。
- 布になるのは、腰から生えた揺れもの（スプリングボーン）の骨に付いた頂点です。袖や髪の揺れものはそのままです。ワンピースの裾も布になります。揺れものの付いていないスカートは布になりません（そのまま）。
- モデルの形は重力で垂れた後の形として扱い、読み込み時にその分を補正します（補正しないと長いスカートは裾が狭まります）。読み込みが 0.3〜0.5 秒ほど延びます。
- 確かめたモデルは `aoi-school.vrm`（スカート）と `emili-private.vrm`（ワンピース）です。
- スカートの下の体を骨ごと（腰・背骨・太もも・すね）の部品に分けて当たり判定にするので、上げた脚が布を押します。
- 計算は CPU で、ソルバーだけなら 1 人あたり 1 フレーム 3〜5ms です（`aoi-school.vrm`、布 1097 点）。PC の負荷が高いと描画ループの中で 12〜14ms かかり、60fps を割ることがありました。
- 椅子や床は当たり判定にありません。座ると、布は太ももの上に乗りますが、後ろの裾は座面を通り抜けて垂れます。
- カットや立ち位置の変更で腰が 1 フレームに 40cm 以上動く・1 ラジアン以上回ると、布を今の姿勢へ置き直します。
- 場所の風（`wind`）は布にも効きます（強さ 0.1 を 2m/s として扱います）。

例：`npm run example` で http://localhost:5192/?cloth=1 を開きます。

## 素材の置き場所

```ts
import { configureAssets } from '@anime-vrm/engine/utils/path';

configureAssets({
  base: '/',                                        // 素材のパスの前に付ける基準（省略時は Vite の BASE_URL）
  motionUrl: (name) => `/animations/${name}.fbx`,   // モーション名から FBX の URL を作る
  idleMotion: 'Standing Idle',                      // モーションの指定がないときの待機モーション
});
```

`idleMotion: null` にすると、待機モーションの FBX を読まず、腕を下ろした姿勢で立ちます。

## 背景・小物の登録

場所や小物は、使う側で登録します。

- 3D の背景：`registerEnvironment(name, { load, dispose })`（`src/stage/environments.ts`）。場所の `environment.model` に `builtin:<name>` と書くと使われます。
- 手に持つ小物：`registerHeldItem(id, spec)`（`src/avatar/heldItem.ts`）。

## 口の動き

ボイスの口の形の解析（AudioWorklet と WASM）は同梱しています。WASM を作り直すときは `npm run build:wasm` を実行します（ソースは `assembly/`）。
