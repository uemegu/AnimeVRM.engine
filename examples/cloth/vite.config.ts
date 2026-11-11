import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// モデルは basic の例のもの（examples/basic/public）を使う
export default defineConfig({
  root,
  publicDir: resolve(root, '../basic/public'),
  base: process.env.EXAMPLE_BASE ?? '/',
  server: { port: 5193 },
  build: {
    outDir: resolve(root, '../../dist/example-cloth'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
