# AGENTS.md（@anime-vrm/engine）

AI のコーディングエージェントが作業前に読む説明書。パスはこの engine ルートからの相対。人向けの説明は `README.md`。
親リポジトリ（このディレクトリの2つ上。以下「親」）のサブモジュールとして置かれている。親の規則は親の `GEMINI.md`。

## 1. 全体像

| 場所 | 役割 |
| --- | --- |
| `src/stage/` | 舞台の本体。`StageManager.ts`（レンダラー・後処理・光・背景・カメラ・カットの適用・描画ループを1クラスで持つ）、`StageAvatar.ts`（VRM 1体の読み込み・モーション・表情・視線）、`AvatarEffects.ts`（顔・体の演出の束ね役）、`ScreenEffects.ts`（DOM の暗転・瞼・集中線）、`StillImages.ts`（一枚絵・カットイン・雨の 2D）、`cameraMove.ts`、`environments.ts`、`quality.ts` ほか |
| `src/postprocessing/` | 後処理のパスとシェーダー（2章） |
| `src/shader/` | キャラの MToon シェーダーへ差し込む部品（`inject*` 関数）と、髪の深度・レイヤー深度の描画 |
| `src/ToonShader.ts` | `applyToonShader(vrm, scene, options)`。MToon の材質を分類（肌・髪・服）し、`onBeforeCompile` で差し込む。戻り値 `ToonShaderController` |
| `src/effects/` | 感情の演出（顔に重ねる絵・涙・汗・文字演出・集中線・雨・光線・霧・速い動きの残像） |
| `src/avatar/` | キャラの体まわり（手の当たり、布のへこみ、風、持ち物、話すときの顔、足元の影、濡れの滴、表情の追加） |
| `src/cloth/` | 布のシミュレーション。three 以外に依存せず単独で使える（`src/cloth/README.md`、入口 `src/cloth/index.ts`）。舞台からは `StageAvatar.setSkirtCloth` |
| `src/scene/` | 空（`SkyBackground.ts`）、3D背景のセル調の明暗（`celShading.ts`）、小物の影の目印（`castShadows.ts`）、日なたの足し込み（`Daylight.ts`） |
| `src/schema/` | zod のスキーマ。`visual.ts`（時間帯・場所）、`stage.ts`（キャラ・カメラ・演出・カット状態） |
| `src/audio/` | ボイス解析と口の形（`VoiceAnalyser.ts`、`AudioLipSync.ts`、AudioWorklet `lipsync-processor.js`、`lipsync.wasm`） |
| `src/animation/` | `seamlessLoop.ts`（`getSeamlessLoopClip`。ループの継ぎ目をならす） |
| `src/utils/path.ts` | 素材の置き場（`configureAssets`、`motionUrl`、`resolveAssetUrl`、`preloadAssets`） |
| `src/Config.ts` | ToonShader と太陽の演出が使う設定の型（値は時間帯の設定から渡る） |
| `assembly/` | 口の形の解析の WASM のソース（AssemblyScript）。作り直しは `npm run build:wasm` |
| `examples/` | `basic`（`npm run example`、床に1人立たせる）、`cloth`（`npm run example:cloth`、布だけ） |

- `package.json` の exports は `"./*": "./src/*.ts"` の1行。`@anime-vrm/engine/schema/stage` は `src/schema/stage.ts`、`@anime-vrm/engine/stage/StageManager` は `src/stage/StageManager.ts` を指す（ビルドせず TS をそのまま読ませる）。
- `src/stage/types.ts` と `src/stage/visual.ts` は型の再エクスポートだけ。定義は `src/schema/`。
- レイヤー番号：0 = 本描画、1 = `OVERLAY_LAYER`（`src/effects/overlayLayer.ts`）、5 = `HAIR_SHADOW_LAYER`（`src/shader/HairShadow.ts`）、6 = `CHARACTER_LAYER`、7 = `EYE_LAYER`（`src/postprocessing/LightWrap.ts`）、8 = `STATIC_SHADOW_LAYER`（`StageManager.ts`）。メッシュへの割り当ては `applyToonShader`。

## 2. 描画の流れ

毎フレーム（`StageManager.startRenderLoop` の `animate`）：カットの時刻を進める → カメラ（`updateCamera`）→ キャラの更新 → 雨・波ガラス・太陽・ゴッドレイの uniform 更新 → `hairShadow.render`（髪の深度）→ `characterMask.render` / `eyeMask.render`（人物・目の深度）→ `composer.render()`。

`EffectComposer` の的は MSAA なしの HalfFloat。MSAA（4x）はシーンの描画（`SceneRenderPass`）だけ。

コンストラクタで `addPass` している順（上から実行）：

| # | パス（StageManager のフィールド） | 実装 | 役割 | 入切・設定 |
| --- | --- | --- | --- | --- |
| 1 | `renderPass` | `SceneRenderPass.ts` | シーンを MSAA の的に描いて composer へ写す。本描画の深度を `depthTexture` に残す | 常時 |
| 2 | `visibleCharacterMask` | `LightWrap.ts` の `VisibleMaskPass` | 人物の深度マスクから、手前の物に隠れた所を除く | `animate` の `masked` |
| 3 | `visibleEyeMask` | 同上（`EYE_LAYER`） | 目のマスク | `animate` の `needEyeMask` |
| 4 | `characterGlowPass.depthCapture` | `CharacterGlow.ts` | 背景ぼかしの前の深度を写し取る | `applyCharacterLook` |
| 5 | `depthOfFieldPass` | `DepthOfField.ts` | 背景ぼかし | `applyDepthOfField`（場所 `stage.camera.depthOfField` と品質 `depthOfField`）。ピントは毎フレーム `setFocus` |
| 6 | `characterGlowPass` | `CharacterGlow.ts` | 人物の明部を輪郭の外へにじませる、目の光の抑え | `applyCharacterLook`（時間帯 `postProcessing.characterGlow`、場所 `stage.character.eyeCare`） |
| 7 | `rimBloomPass` | `RimBloomPass.ts` | 日差し側のリムライトの帯だけのにじみ | `animate`（品質 `rimBloom` と主光の強さ） |
| 8 | `wetReflectionPass` | `WetReflection.ts` | 雨の地面の映り込み | `updateWetReflection`（`setRain` と品質 `wetGroundSheen`） |
| 9 | `OverlayPass`（無名） | `OverlayPass.ts` | `OVERLAY_LAYER` の物（文字演出・汗）をぼかしの後に重ねる | 重ねる物がないフレームは何もしない |
| 10 | `lightWrapPass` | `LightWrap.ts` の `LightWrapShader` | 背景の光を人物の輪郭の内側へにじませる | `uEnabled`（下の注意）。`uBodyStrength` は `applyCharacterLook` |
| 11 | `transmittedLightPass` | `TransmittedLight.ts` | 透過光。場所に登録した光源の板を光らせ、フレアを人物の上まであふれさせる | `applyTransmittedLight` → `setLights` |
| 12 | `bloomPass` | three の `UnrealBloomPass` | ブルーム | `applyBloom`（`resolveBloomConfig`） |
| 13 | `godRaysPass` | `GodRaysShader.ts` | 光条。光源として拾うのは背景だけ | `setTimeOfDay`（`lighting.sunShafts`）。太陽が見えないフレームは `animate` で切る |
| 14 | `highlightShoulderPass` | `HighlightShoulder.ts` | ブルーム後の明部を色相を保って丸める | `applyBloom`（`bloom.deepGlow.enabled` のときだけ） |
| 15 | `OutputPass`（無名） | three | 表示用の色（sRGB）へ変換 | 常時 |
| 16 | `lensDroplets.pass` | `LensDroplets.ts` | レンズに付く雨粒 | `setRain`（`splash` / `clear`）、毎フレーム `update` |
| 17 | `paraPass` | `Para.ts` | パラ。背景の空気の色を人物の上にグラデーションで重ねる | `setTimeOfDay`（`applyParaParams`、`postProcessing.para`） |
| 18 | `cinematicAnimePass` | `CinematicAnimeShader.ts` | 色収差・ディフュージョン・カラーグレーディング・周辺減光・シャープ・粒子と、人物の仕上げ（逆光リム・明部の上限）を1パスで | `setTimeOfDay`（`postProcessing.cinematic`）、`applyCharacterLook`、`animate` |
| 19 | `fisheyePass` | `FisheyeShader.ts` | 魚眼の歪み | `updateCamera`（カメラの動き `fisheye_in` のときだけ） |
| 20 | `waveGlassPass` | `WaveGlass.ts` | 波ガラス（絵のゆらぎ。水中、回想の場面転換） | `animate`（カットの effects と `memoryRippleTime`） |
| 21 | `smaaPass` | three の `SMAAPass` | 後段のアンチエイリアス | 常時 |

- 1〜14 はリニア空間（HDR）。15 の `OutputPass` より後は表示用の色（sRGB、0〜1）。後段へ渡す色は sRGB の値に直す（`setTimeOfDay` の `convertLinearToSRGB()`）。
- 人物マスク：`CharacterMaskRenderer`（`LightWrap.ts`）が `CHARACTER_LAYER` だけを深度に描く（深度 < 1 が人物）。パスが読むのは `VisibleMaskPass` を通した `visibleCharacterMask.texture`。読むパス：6・7・10・13・17・18・20。目のマスク（`visibleEyeMask.texture`）は 6・7・18。
- 生のマスク `characterMask.texture` は MToon 側の外形リム（`src/shader/SilhouetteRim.ts` の `renderCharacterMaskForRim`）が読むので毎フレーム必ず描く。
- 本描画の深度 `renderPass.depthTexture` を読むパス：2・3・4・5・8・11。5 以降は読み書きの的が入れ替わり、後ろのパスの的には今のフレームの深度がないので、深度が要るパスは必ず `renderPass.depthTexture` を受け取る。
- 髪の深度 `hairShadow.depthTexture`（`HairShadowRenderer`）は、前髪の影（MToon 側）と 10 の髪の判定が読む。
- 注意：`lightWrapPass` の `uEnabled` は初期値 0 で、有効にする `applyLightWrapParams` はどこからも呼ばれていない（2026-11-15 時点）。いまはライトラップは常に切れている。
- 注意：`src/postprocessing/CharacterFinish.ts` の `CharacterFinishShader` は未使用（仕上げは `CinematicAnimeShader` に入っている）。使われているのは型 `CharacterRim` だけ。

## 3. 機能の一覧

設定の置き場の略記：時間帯 = `TimeOfDayPreset`、場所 = `LocationVisualPreset`、effects = カットの `SceneEffects`（`StageManager.setEffects`）、キャスト = `StageCastMember`、カット状態 = `CutState` / `CutAvatarState`（`CutTimeline.stateAt`）、品質 = `StageQuality`。

### 画面・光・背景

| 機能 | 実装 | 設定の置き場 |
| --- | --- | --- |
| 平行光・環境光・地面の影 | `StageManager.applyKeyLight` | 時間帯 `lighting.directional` / `ambient`、場所 `light`（優先）。影は場所 `light.shadow` |
| 3D背景の小物の影（一度だけ描く） | `StageManager.bakeStaticShadow`、`src/scene/castShadows.ts` | 背景側のメッシュの `castShadow` |
| リムライト（補助光） | `StageManager.setTimeOfDay` | 時間帯 `lighting.rim` |
| 空と雲 | `src/scene/SkyBackground.ts` | 時間帯の ID（`setTimeOfDay(id)`） |
| 遠景・中景・近景 | `StageManager.setLocation` / `applyBackdrop` / `updateLayerPlacement` | 場所 `layers`、`stage.backdrop` |
| 3D背景 | `src/stage/environments.ts`、`StageManager.applyEnvironment` | 場所 `environment`（`builtin:<名前>` か glb の URL） |
| 3D背景のセル調の明暗 | `src/scene/celShading.ts`（`applyCelShading`、`setCelLight`） | `applyKeyLight` が光の向き・影色を渡す |
| 流れる背景 | `src/stage/ScrollingBackground.ts` | `setScrollingBackground`（カットの `scrollingBackground`） |
| フォグ | `StageManager.setTimeOfDay` | 時間帯 `fog` |
| 太陽・レンズフレア | `src/postprocessing/SunEffect.ts`（遮蔽判定は `OcclusionRaycaster.ts`） | 時間帯 `lighting.lensFlare` / `sunShafts`、場所 `stage.postProcessing.lensFlare` / `sunShafts` で入切 |
| 光条 | `GodRaysShader.ts` | 時間帯 `lighting.sunShafts`、品質 `godRaysSamples` |
| ブルーム・深い光のにじみ | `UnrealBloomPass`、`HighlightShoulder.ts` | 時間帯 `postProcessing.bloom`、場所 `stage.camera.bloom`（上書き） |
| 背景ぼかし | `DepthOfField.ts`、`StageManager.focusDistance` | 場所 `stage.camera.depthOfField`、品質 `depthOfField` |
| 透過光 | `TransmittedLight.ts` | 場所 `transmittedLight`（光源の板・時間帯の限定）、effects `transmittedLight`（倍率） |
| 波ガラス | `WaveGlass.ts` | effects（項目は `src/schema/stage.ts` の `SceneEffects` を見る） |
| 色調・周辺減光・粒子など | `CinematicAnimeShader.ts` | 時間帯 `postProcessing.cinematic`、場所 `stage.postProcessing.cinematic`（部分上書き。`resolveLocationVisuals`） |
| パラ | `Para.ts` | 時間帯 `postProcessing.para` |
| 人物の明部のにじみ | `CharacterGlow.ts` | 時間帯 `postProcessing.characterGlow` |
| 目の光の抑え・人物の明るさの上限・輪郭のなじませ | `CharacterGlow.ts`、`CinematicAnimeShader.ts`、`LightWrap.ts` | 場所 `stage.character`（`eyeCare`、`highlightCap`、`lightWrapBody`） |
| 特殊な背景からの逆光リム | `CinematicAnimeShader.ts` | 設定なし。背景が `scene.userData.characterRim`（`CharacterRim`）を置く |
| 雨 | `src/effects/RainOverlay.ts`（`StillImages` 経由）、`src/stage/RainGround.ts`、`WetReflection.ts`、`LensDroplets.ts` | `setRain`（カットの `rain`）、品質 `wetGroundSheen` |
| 群衆 | `src/stage/Crowd.ts` | 場所 `stage.crowd`、effects `crowd` |
| 花火など背景固有の効果 | 背景側の `userData.setEffects`（engine には実体なし） | effects `fireworks` |
| 一枚絵・カットイン | `src/stage/StillImages.ts` | `setStills`（カットの `cg` / `cutin`） |
| 2D のデフォルメ画像 | `src/stage/StageSprite.ts` | キャスト `sprite` |
| 場面転換（暗転・瞼・白飛び・回想） | `src/stage/ScreenEffects.ts`（回想の波打ちは `StageManager` の波ガラス） | `CutTimeline.screenTransition` |
| 集中線 | `src/effects/FocusLinesOverlay.ts` | カット状態 `focusLines` |
| 光線 | `src/effects/beam/LightBeam.ts`、`StageManager.updateBeams` | カット状態 `beams` |
| 霧になって消える | `src/effects/mist/MistDissolve.ts`、`StageManager.updateMists` | カット状態 `mistOut` |
| カメラの構図・レンズ | `StageManager.shotFrame` / `shotPose` / `rigPose` | `setCameraShot`、場所 `stage.camera.<構図>`（既定 `DEFAULT_SHOT_RIGS`） |
| カメラの動き | `src/stage/cameraMove.ts` の `applyCameraMove` | カット状態 `camera.move`（`CameraMoveType`） |
| 重さの段階 | `src/stage/quality.ts`（`STAGE_QUALITY_PRESETS`、`FrameRateCheck`） | `StageOptions.quality`、`setQuality`、URL `?quality=low`、localStorage `stage_quality` |

### キャラ

| 機能 | 実装 | 設定の置き場 |
| --- | --- | --- |
| 材質の調子（影色・硬さ・明るい側の調整・境目の色・明るい段） | `src/ToonShader.ts` | 時間帯 `materials.body` / `hair` / `cloth`（`StageAvatar.updateMaterialPreset`） |
| 輪郭線（太さ・強弱・色トレス） | `src/ToonShader.ts`、`src/shader/SmoothNormalHelper.ts` | 時間帯 `outline`（色トレスは `outline.colorTrace`） |
| 顔の SDF 陰影 | `src/shader/FaceSdf.ts` | コード内 `DEFAULT_FACE_SDF_PARAMS`（`setFaceSdfParams`） |
| 前髪の影 | `src/shader/HairShadow.ts` | コード内 `DEFAULT_HAIR_SHADOW_PARAMS` |
| 天使の輪 | `src/shader/HairRing.ts` | 時間帯 `lighting.hairRingTint`、コード内 `DEFAULT_HAIR_RING_PARAMS` |
| 頭頂の毛束の影をならす | `src/shader/HairCrown.ts` | コード内 `HAIR_CROWN_UNIFORMS` |
| 外形だけの日差しのリム | `src/shader/SilhouetteRim.ts` | 主光の向きと強さから自動（`updateSilhouetteRimLight`） |
| 濡れた服 | `src/shader/WetCloth.ts`（絵柄は `registerWetTexture`） | キャスト `wet` |
| 濡れの滴 | `src/avatar/wetDrips.ts` | キャスト `wet` |
| 日なたの明るさ | `src/scene/Daylight.ts` | キャスト `daylight` |
| 頬染め・赤面・怒り・顔の汗 | `src/effects/FaceOverlayEffect.ts`（赤面は瞳も縮める：`eye/IrisShrinkEffect.ts`） | キャスト `look`、カット状態（`blush`、`redface`、`anger`） |
| 涙目・あわあわ口・涙 | `src/effects/eye/WateryEyeEffect.ts`、`cry/CryFaceEffect.ts`、`tears/TearEffect.ts` | キャスト `look`、カット状態（`tearyEyes`、`awawaMouth`、`tears`） |
| 汗（飛ぶ・にじむ）・文字演出 | `src/effects/sweat/SweatEffect.ts`、`src/effects/text/` | カット状態 `oneShots`（`AvatarOneShot`）。その場で出すのは `showOneShot` |
| 速い動きの残像 | `src/effects/motion/` | キャスト `look.fastMotion` |
| 目が泳ぐ | `AvatarEffects.applyEyeWander` | キャスト `look.eyeWander`、カット状態 |
| 表情（追加分・happy の目だけ化） | `src/avatar/shapeKeyExpressions.ts`、`happyEyesOnly.ts` | キャスト `expression`、カット状態 |
| むくれた口の絵（ぷくーの口。元の口を隠し、肌と同じ材質の当て板で唇の赤みを覆う） | `src/effects/pout/PoutMouthEffect.ts` | 表情 `puku` のとき StageManager が出す（`AvatarEffects.setPoutMouth`） |
| 頬を膨らませる・つままれる（形状キーを読み込み時に作る） | `src/avatar/cheekShapes.ts` | キャスト `expression`（`puku` は片頬で怒りマークも付く・`cheekPinch`・`cheekPinchLeft`・`cheekPinchRight`） |
| 自分の手で頬をつまんで引っぱる | `src/avatar/cheekPinch.ts`（頬の形は `cheekShapes.ts`） | キャスト `look.cheekPinch`、カット状態 |
| 口の動き・話すときの首と眉 | `src/audio/`、`src/avatar/talkingFace.ts` | `StageOptions.getSpeakerPhoneme` / `getSpeakerMouthOpen`、`CutTimeline.speechTone` |
| 手が肌で止まる・髪が手を避ける・スカートのへこみ | `src/avatar/handClearance.ts`、`handColliders.ts`、`clothDent.ts`（手の形は `handShape.ts`） | 品質 `handClearance`、`clothDent` |
| スカートを布にする | `src/cloth/` | 品質 `skirtCloth`（既定は切） |
| 風 | `src/avatar/springWind.ts` | 場所 `wind`（雨の間は止まる） |
| 手に持つ小物 | `src/avatar/heldItem.ts`（`registerHeldItem`） | キャスト `heldItem` |
| 足元の接地影 | `src/avatar/footContactShadow.ts` | 設定なし |

## 4. 設定とスキーマ

- `src/schema/visual.ts`：時間帯（`TimeOfDayPreset`、ID は `TIME_OF_DAY_IDS`）と場所（`LocationVisualPreset`）。ファイル全体は `TimeOfDayFile` / `LocationFile`。親の `assets/studio/time-of-day.json` と `assets/studio/locations.json` がこの形。
  - 項目はヘルパーで作る：`num(日本語, 英語, 最小, 最大, 刻み, 既定)`、`color`、`bool`、`group`、`vec3`。`meta` に入る表示名・範囲を、親の `studio/src/components/SchemaForm.tsx` がフォームに使う。ヘルパーを通さない項目（例：`LocationTransmittedLight` の中身）には表示名が付かない。
  - すべて `z.strictObject`。JSON に知らないキーがあると検証で落ちる。既存の JSON を壊さないよう、足す項目は `.optional()` にして既定値はコード側で持つ。
  - 場所が時間帯を上書きする所は関数にまとまっている：`resolveLocationVisuals`（cinematic・光条・レンズフレア）、`resolveBloomConfig`（ブルーム）。
- `src/schema/stage.ts`：`CameraShot`、`CameraShift`、`CameraMoveType` / `CameraMove`、`CameraPose`、`ScreenTransition`、`SceneEffects`、`EffectText`、`SweatMode`、`BeamConfig`、`StageCastMember`、`AvatarLook`、`CutAvatarState`、`CutState`、`CutTimeline`。
  - シナリオのスキーマ（親の `packages/scenario/src/schema.ts`）がここの zod をそのまま取り込む（`effects: SceneEffects.optional()`、`screenTransition: ScreenTransition.optional()`）。
- 新しい設定項目を足すときに触る場所：
  1. スキーマ（`visual.ts` か `stage.ts`）に項目を足す。
  2. `StageManager` の適用メソッドで uniform などへ渡す。時間帯は `setTimeOfDay`、場所は `setLocation` → `applyCameraSettings`（`applyDepthOfField` / `applyBloom` / `applyCharacterLook` / `applyTransmittedLight`）、カットは `applyEffects`。`setLocation` は最後に `setTimeOfDay` を呼び直すので、場所で変わる値も時間帯側の適用で毎回決め直せる。
  3. キャラの材質なら `src/Config.ts` の型と `ToonShader.ts` の `updateMaterialStyle` / `updateOutline`。
  4. カットの項目なら親の `studio/src/views/scenarios/CutInspector.tsx` と表示名 `studio/src/i18n/ja.ts`・`en.ts`。
  5. 重い処理なら `src/stage/quality.ts` の `StageQuality` に項目を足し、low での扱いを決める。

## 5. よくある作業の手順

### 新しい後処理パスを足す

1. `src/postprocessing/<名前>.ts` に作る。1枚で済むならシェーダーのオブジェクトを `ShaderPass` に渡す（例 `FisheyeShader.ts`）。縮小した的やぼかしを持つなら `Pass` を継承して `render(renderer, write, read)`、`setSize`、`dispose` を書く（例 `TransmittedLight.ts`、`RimBloomPass.ts`）。
2. `StageManager` にフィールドを足し、コンストラクタの `addPass` の列に入れる。リニアの値を扱うなら `OutputPass` より前、0〜1 の表示用の色を前提にする合成や画面の歪みは後。人物マスクは `this.visibleCharacterMask.texture`、深度は `this.renderPass.depthTexture` を渡す。
3. 大きさ：`resize()` の `composer.setSize` が各パスの `setSize` を呼ぶ。`ShaderPass` は `setSize` で何もしないので、`uResolution` などの uniform は `resize()` に手で書く。composer の外の的（`hairShadow`、`characterMask`、`eyeMask`、`lensDroplets`）も `resize()` に並んでいる。
4. 破棄：`dispose()` に足す。
5. 毎フレームの値（時刻・カメラ行列・強さの補間）は `startRenderLoop` の `animate` の中、`composer.render()` の前に書く。使わないフレームは `pass.enabled = false` にしてパスごと飛ばす。
6. 人物マスクを読むなら、`animate` の `masked`（目のマスクなら `needEyeMask`）の条件に自分のパスを足す。足さないと、ほかにマスクを使うパスが全部切れている場面で `visibleCharacterMask` が更新されない。
7. 設定を足す（4章）。

### カット単位の効果を足す

1. `src/schema/stage.ts` の `SceneEffects` に項目を足す（`.optional()`）。
2. `StageManager.setEffects` が `this.effects` に入れて `applyEffects` を呼ぶ。切り替え時に1回当てれば済むものは `applyEffects` に書く（例：`applyTransmittedLight`、`crowd.setEnabled`）。なめらかに変えたいものは `animate` で `this.effects` を読み、目標値へ寄せる（例：`waveGlassLevel`）。
3. 3D背景に受け取らせるものは、背景のオブジェクトの `userData.setEffects(effects)` が呼ばれる（`applyEffects`、背景の読み込み後にも呼ばれる）。
4. 呼び出し側は親の `studio/src/stage/StageCanvas.tsx` と `studio/src/player/PlayerStage.tsx`（`setEffects`）。編集画面は `CutInspector.tsx` と i18n。
5. 値は前のカットから引き継がれる（7章）。

### 画面の切り替え演出を足す

1. `src/schema/stage.ts` の `ScreenTransition` に名前を足す。`src/stage/ScreenEffects.ts` の `ScreenTransitionKind` は別に書かれた同じ並びなので、こちらも足す。
2. `ScreenEffects.playTransition(kind, instant, ready)` に分岐を足す。DOM の `blackout`（色と不透明度）と瞼（`setEyelids`）をタイマー（`later`）で動かす作り。`instant`（カットの途中へ飛んだとき）は動きを見せず最終の状態にする。遅れて動かす処理は `transitionId` を見て、次の演出が始まっていたら捨てる。
3. 絵そのものを歪める・光らせる演出は DOM ではできない。`StageManager.setCutTimeline` と `replayScreenTransition` で開始時刻を持ち、`animate` でパスの uniform を動かす（例：`memory` の `memoryRippleTime` と波ガラス）。
4. 親の `CutInspector.tsx` の `SCREEN_TRANSITIONS` と i18n に足す。場所が変わるカットの自動の暗転は親の `packages/scenario/src/stage.ts` の `mergeStageState`。

### キャラのシェーダーを変える

- `src/ToonShader.ts` の `applyToonShader` が、MToon の材質ごとに `material.onBeforeCompile` を重ね、`shader.fragmentShader.replace('<three-vrm のシェーダーの一節>', ...)` で書き換える。部品は `src/shader/` の `injectHairShadow` / `injectHairRing` / `injectHairCrown` / `injectFaceSdf` / `injectWetCloth`。
- 置換元の文字列（例 `'shading *= shadow;'`、`'mix( material.shadeColor, material.diffuseColor, shading )'`、`'gl_FragColor = vec4( col, diffuseColor.a );'`）が three-vrm 側のシェーダーと1文字でも違うと、`replace` は何もせず、エラーも出ないまま効かない。three-vrm を上げたとき・新しい置換を書いたときは、置換後の文字列が入ったかを確かめる（`node_modules/@pixiv/three-vrm` の MToon のシェーダーと突き合わせる）。
- 輪郭線は別の材質（`material.isOutline`）だが同じフラグメントシェーダーを `OUTLINE` 定義つきで通る。輪郭線だけ・本体だけの処理は `#if defined( OUTLINE )` / `#if !defined( OUTLINE )` で分ける。輪郭線は法線が裏返っているので、拡散光は「その画素の影色 × 光の色」になる（色トレスはこれを使っている）。
- 輪郭線の頂点側（太さの強弱、奥へのずらし `OUTLINE_DEPTH_OFFSET`）は `material.isOutline` のときだけ重ねる別の `onBeforeCompile`。
- uniform は `material.userData` か共有オブジェクト（`HAIR_RING_UNIFORMS`、`SILHOUETTE_RIM_UNIFORMS` など）に置き、`onBeforeCompile` の中で `shader.uniforms` へつなぐ。値の更新は `ToonShaderController`（`updateMaterialStyle`、`updateOutline`、`setWetness` など）から行う。
- 材質の分類は名前の正規表現（`DEFAULT_BODY_PATTERN`、`DEFAULT_HAIR_PATTERN`、`DEFAULT_CLOTH_PATTERN`、`isEyeMaterial`）。VRoid の命名を前提にしている。
- 輪郭線・人物マスク・髪の深度は同じ材質やジオメトリで描くので、頂点を動かす変更はそれらにも効く。

## 6. 確かめ方

engine 単体ではなく、親リポジトリのルートで実行する。

| コマンド | 内容 |
| --- | --- |
| `npm run typecheck` | 全ワークスペースの `tsc --noEmit`（engine は `src` と `examples/*/main.ts`） |
| `npm run test` | 全ワークスペースの vitest（engine 自体にテストはない。`packages/scenario`、`packages/motion`、`studio`、`server`） |
| `npm run validate` | シナリオと Studio データ（時間帯・場所の JSON を含む）の検証 |
| `npm run shot -- <種類>/<ID> --scene <ID> --file 下書き.json --no-dialogue --no-hud --settle 4 -o out.png` | カットを撮る（Studio のプレビューと同じ描画。サーバー不要、音は鳴らない） |

`npm run shot`（親の `scripts/shot.ts`）の引数：
- `--scene`：シーン ID か 0 始まりの番号。カンマ区切りで複数。省くと全カットを `scratch/shots/<種類>/<ID>/<番号>_<シーンID>.png` へ。`-o` は1カットのときだけ。
- `--time 秒`：カット内の時刻。`--file`：保存していない JSON を撮る（中の相対パスの基準は `<種類>/<ID>` のディレクトリ）。
- `--no-dialogue`（セリフ枠を消す）、`--no-hud`（左上の場所・時間帯・構図の表示を消す）、`--settle 秒`（読み込み後に待つ時間。既定 1.5）。
- `--width` / `--height`（既定 1280x720）、`--outfit default|private|commute`、`--quality high|low`（既定 high）、`--url`（起動中の Studio を使う）、`--headed`。

ほかに `npm run check:framing`（話者の顔が外れたカットの一覧）、`npm run profile`（`scripts/profile-render.ts`。重さの計測）。
ブラウザでの検証は `npx playwright` を使い、音を鳴らさない（親の `GEMINI.md`「ブラウザ検証・ヘッドレステスト」）。

## 7. 落とし穴

- `npm run shot` は読み込みの途中の絵を撮ることがある（画面に「読み込み中」が出た絵になる）。シェーダーを変えた直後は `--settle 4` 以上にする。
- 下書きシナリオで場面を1つだけ抜き出すと、前のカットから引き継いでいた時間帯（`timeOfDay`）が外れて別の色味になる。比較するカットには `timeOfDay` を明示する。
- カットの `effects` は前のカットから引き継がれる（親の `packages/scenario/src/stage.ts` の `mergeStageState`：`{ ...prev.effects, ...scene.effects }`）。止めるには明示的に off / false / 0 を書く。`timeOfDay`、`rain`、流れる背景も同じく引き継ぐ。
- 場面転換（`screenTransition`）のような一瞬の演出は `npm run shot` に写らない。
- 入・切の比較は、同じ設定で2回撮った差（撮るたびの揺れ）を先に測ってから判断する。
- engine には作品固有の中身（特定のキャラ・場所・背景セット）を入れない。3D背景セットは親の `packages/content/src/sets.ts` の `registerSets` が `registerEnvironment(name, { load, dispose })`（`src/stage/environments.ts`）で登録する。小物は `packages/content/src/props.ts`（`registerHeldItem`）、濡れた服の絵柄は `packages/content/src/wet.ts`（`registerWetTexture`）。入口は `packages/content/src/register.ts`。
- 3D背景との約束は `userData` だけ：`setEffects(effects)`、`configureEnvironment(placement)`（`placeEnvironment` が呼ぶ）、`setSky`（付いた子は非表示にされ、空は `SkyBackground` が描く）。背景が人物の逆光リムを出すときは `scene.userData.characterRim`。
- 作業ツリーには別の作業の変更が同時に入っていることがある。`git stash` や `git checkout -- <file>` で他人の変更を巻き込まない。
- 親のテストには、2026-11-15 時点で `packages/scenario` に失敗が3件ある（`assets/scenarios/.DS_Store` を読もうとする、`locations.json` にない場所 `painted_gym` を参照する、カット状態の期待値に `beams` がない）。新しい失敗かどうかは変更前の状態と比べて判断する。
- 既存の技法（撮影処理など）を取り込むときは、実装の前に「どの場面で何のために使うか」と元の技法の作り方を調べ、作った後は目的が絵で果たせているかを見る。
- ライトの `visible` や `castShadow` を切り替えるとシェーダーが作り直される。切るときは強さを 0 にする（`rimLight`）、変わるときだけ触る（`applyKeyLight`、`bakeStaticShadow`）。
- `resize` に渡す寸法は整数に丸められる（小数の的は全体がぼけて色も崩れる）。パスの中で縮小した的を作るときも整数にする。
- `StageManager` の描画ループ内で `clock.getElapsedTime()` を追加で呼ばない（時計が進み、`delta` が食われる）。読むだけなら `clock.elapsedTime`。
- `setPresets` は時間帯を毎回当て直すが、場所は今の場所の設定が変わったときだけ `setLocation` し直す。
- 表情・顔の演出の絵（`src/effects/textures/`）と眉・目のシェイプキー名（`Fcl_*`）は VRoid のモデルを前提にしている。ないモデルではその部分は動かない。
