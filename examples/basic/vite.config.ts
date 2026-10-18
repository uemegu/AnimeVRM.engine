import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 素材（モデル）は examples/basic/public に置いてある
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  server: { port: 5192 },
});
