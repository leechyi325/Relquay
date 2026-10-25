import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { proxy: {
    '/api': 'http://127.0.0.1:3080', '/preview': 'http://127.0.0.1:3080',
    '/ws': { target: 'ws://127.0.0.1:3080', ws: true },
  } },
  build: { rollupOptions: { output: { manualChunks: {
    terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
    markdown: ['react-markdown'], react: ['react', 'react-dom'],
  } } } },
});
