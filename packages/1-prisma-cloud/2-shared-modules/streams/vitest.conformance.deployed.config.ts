import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['conformance/deployed.vitest.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
