import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@lzwme/m3u8-dl/contract': resolve(import.meta.dirname, '../../src/types/contract.ts') } },
  build: { outDir: resolve(import.meta.dirname, '../../client'), emptyOutDir: false },
  publicDir: false,
  server: { host: '0.0.0.0', port: 5173, proxy: {
    '/api': 'http://localhost:6600', '/ws': { target: 'ws://localhost:6600', ws: true },
  } },
});
