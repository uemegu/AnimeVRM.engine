# basic

何もない空間（時間帯の空だけ）にアバター（アオイ）を1人立たせるだけの例。

```bash
npm run example
```

http://localhost:5192 を開く。

モデル（`/models/aoi/aoi-school.vrm`）と待機モーション（`/animations/Standing Idle.fbx`）はこのリポジトリに含まない。既定では AnimeVRM の `assets/`（このリポジトリを `packages/engine` に置いたときの `../../assets`）から読む。別の場所から読むときは `ASSETS_DIR=/path/to/assets npm run example` とし、`main.ts` の `modelUrl` を手元の VRM に変える。
