import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared/src'),
    },
  },
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts'],
    // Pure-logic tests: no DOM, no Three, no Rapier, deterministic TS.
    environment: 'node',
    globals: false,
  },
});
