import { defineConfig } from '@internal/tsdown-config';

// Library entries only — the cron module moved to @internal/cron (ADR-0028).
// The pure connection-resilience helpers (FT-5226) ship as the `./connection`
// subpath (object key `connection` mapping `pg-connection.ts`) so bun-runnable
// services (the storage store) reuse one implementation without pulling this
// package's heavy control barrel.
export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    control: 'src/exports/control.ts',
    'local-target': 'src/exports/local-target.ts',
    'prisma-next': 'src/exports/prisma-next.ts',
    testing: 'src/exports/testing.ts',
    connection: 'src/exports/pg-connection.ts',
  },
});
