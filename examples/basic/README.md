# basic

白い床だけの空間にアバター（アオイ）を1人立たせる例。マウスのドラッグでカメラを回し、ホイールで寄る・引く。

```bash
npm install
npm run example
```

http://localhost:5192 を開く。

- モデルは `public/models/aoi-school.vrm`（このリポジトリに同梱）。
- 待機モーションの FBX は使わず、`configureAssets({ idleMotion: null })` で腕を下ろした姿勢で立たせる。
- 床は `registerEnvironment` で登録した3D背景（`builtin:white-floor`）。
