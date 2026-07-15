import { configDefaults, defineConfig } from 'vitest/config';

// page.tsx relies on Next's automatic JSX runtime (no `import React` in
// scope) and its own tsconfig sets `jsx: "preserve"` for Next's own
// compiler — vite's oxc transform needs an explicit override so it doesn't
// inherit that setting.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
