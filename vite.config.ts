import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { contentManifest } from './plugins/content-manifest';

export default defineConfig({
  base: './',
  plugins: [react(), contentManifest('src/content')],
  build: {
    // Mermaid, highlight.js and every content page are already dynamically
    // imported, so Rollup code-splits them automatically. Hand-rolled
    // manualChunks here caused cross-chunk circular imports and a TDZ crash.
    chunkSizeWarningLimit: 3200,
  },
  server: {
    port: 5173,
    open: true,
  },
});
