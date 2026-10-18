import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// 素材（モデル）は examples/basic/public に置いてある。
// GitHub Pages ではリポジトリ名の下に置かれるので、ビルドの base は EXAMPLE_BASE で渡す
export default defineConfig({
  root,
  base: process.env.EXAMPLE_BASE ?? '/',
  server: { port: 5192 },
  build: {
    outDir: resolve(root, '../../dist/example'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
