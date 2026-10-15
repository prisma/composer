import { defineConfig } from 'vitest/config';

// Type tests ONLY. Runtime suites stay on `bun test` (see the `test` script);
// vitest's `include` is scoped to nothing runnable so it never picks up the
// bun-owned `*.test.ts` files, and `typecheck.include` runs the `*.test-d.ts`
// files through tsc via the package tsconfig.
export default defineConfig({
  test: {
    include: [],
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
});
