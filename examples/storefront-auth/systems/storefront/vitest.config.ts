import { configDefaults, defineConfig } from 'vitest/config';

// page.tsx relies on Next's automatic JSX runtime (no `import React` in
// scope) and its own tsconfig sets `jsx: "preserve"` for Next's own
// compiler — vite's oxc transform needs an explicit override so it doesn't
// inherit that setting.
//
// *.integration.test.ts runs under `bun test` instead (see that file) — it
// needs `Bun.serve` and the H3 teardown decision rests on bun-test's
// per-file process isolation — so vitest must not also pick it up.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
