import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts'],
    // Shared-only: no DOM, no Three, just deterministic TS.
    environment: 'node',
    globals: false,
  },
});
