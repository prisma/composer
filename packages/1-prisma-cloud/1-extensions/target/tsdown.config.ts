import { defineConfig } from '@internal/tsdown-config';

// Library entries only — the cron module moved to @internal/cron (ADR-0028).
// `exports:false`: the manifest's exports map is hand-maintained (conditional
// types/default form for the public packages' dts bundling).
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/control.ts',
    'src/prisma-next.ts',
    'src/testing.ts',
    // The pure connection-resilience helpers (FT-5226), exposed as the
    // `./connection` subpath so bun-runnable services (the storage store) reuse
    // one implementation without pulling this package's heavy control barrel.
    'src/pg-connection.ts',
  ],
  exports: false,
});
