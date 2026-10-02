import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Due entry: il popup (HTML) e il service worker. I nomi di output sono fissi
// perché manifest.json li referenzia direttamente.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
