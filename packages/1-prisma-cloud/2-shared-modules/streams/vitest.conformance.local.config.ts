import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['conformance/local.vitest.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
