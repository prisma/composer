import { defineConfig } from '@internal/tsdown-config';

// Library entries only — the cron module moved to @internal/cron (ADR-0028).
// `exports:false`: the manifest's exports map is hand-maintained (conditional
// types/default form for the public packages' dts bundling).
export default defineConfig({
  entry: ['src/index.ts', 'src/control.ts', 'src/prisma-next.ts', 'src/testing.ts'],
  exports: false,
});
