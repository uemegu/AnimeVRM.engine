import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// モデル・モーションの置き場所。既定は AnimeVRM（packages/engine をサブモジュールにしているリポジトリ）の assets/
const assets = process.env.ASSETS_DIR ?? resolve(here, '../../../../assets');

export default defineConfig({
  root: here,
  publicDir: assets,
  server: { port: 5192 },
});
