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
- カメラの構図は `setCameraShot`（`wide` / `medium` / `speaker` / `close` / `side`）で選びます。構図を変えるとカメラはその場で切り替わり（カット）、滑らかに動かすのはタイムラインで秒数を指定したときだけです。手で動かすときは `setFreeCamera(true)` にして `viewCamera` を操作します。
- 構図ごとにレンズが変わります。`close` は望遠（遠くから狭い画角で撮り、背景が詰まってぼける）、`wide` は広角です。倍率は場所の設定 `camera.<構図>.lens` で変えられ、1 にすると場所の画角のままになります。
- `presets.motions` にモーションごとの `fadeIn`（前のモーションからつなぐ秒数）を書くと、驚きは鋭く、待機への戻りはゆっくりつなげます。

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
- 雨で濡れた服の絵柄：`registerWetTexture(pattern, url)`（`src/shader/WetCloth.ts`）。マテリアル名が `pattern` に合う服に使われます。

## 口の動き

ボイスの口の形の解析（AudioWorklet と WASM）は同梱しています。WASM を作り直すときは `npm run build:wasm` を実行します（ソースは `assembly/`）。
