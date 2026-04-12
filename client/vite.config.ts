import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 3100,
    strictPort: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3101',
        ws: true,
      },
    },
  },
});
