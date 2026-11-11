# basic

グレーの床の上にキャラを1人立たせる例です。ドラッグでカメラを回し、ホイールで寄ったり引いたりできます。VRM ファイルを画面にドロップすると、そのモデルに差し替わります。

```bash
npm install
npm run example
```

http://localhost:5192 を開きます。

- モデルは `public/models/aoi-school.vrm` です。
- 待機モーションの FBX は使わず、`configureAssets({ idleMotion: null })` で腕を下ろした姿勢にしています。
- 床は `registerEnvironment` で登録した3D の背景（`builtin:floor`）です。
- `?cloth=1` を付けると、スカートを布として動かします（`src/cloth`。`StageManager` の `quality: { skirtCloth: true }`）。
- `?model=<URL>` で読み込む VRM を変えられます。
- `?motion=Walking` のように付けると、`public/animations/Walking.fbx` のモーションを繰り返します（FBX は同梱していません）。
