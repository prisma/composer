import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): only its runnable, src/router-entry.ts,
// built to dist/router-entry.mjs. @prisma/*, arktype, and @cron/worker (the
// contract import) are inlined (node_modules isn't shipped); `bun` is a
// Compute runtime built-in.
export default defineConfig({
  entry: { 'router-entry': 'src/router-entry.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@prisma\//, /^arktype/, /^@cron\//],
  dts: false,
  sourcemap: false,
  clean: true,
});
