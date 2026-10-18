# basic

白い床の上にキャラを1人立たせる例です。ドラッグでカメラを回し、ホイールで寄ったり引いたりできます。

```bash
npm install
npm run example
```

http://localhost:5192 を開きます。

- モデルは `public/models/aoi-school.vrm` です。
- 待機モーションの FBX は使わず、`configureAssets({ idleMotion: null })` で腕を下ろした姿勢にしています。
- 床は `registerEnvironment` で登録した3D の背景（`builtin:white-floor`）です。
