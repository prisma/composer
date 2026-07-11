import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): only its runnable, src/server.ts, built to
// dist/server.mjs. The Prisma App wrapper (bundling src/service.ts to main.js,
// as an independent module instance) is no longer built here — `prisma-app
// deploy` assembles it via `@prisma/app-node/control`. @prisma/* and arktype
// (the contract evaluates type() at import time) are inlined (node_modules
// isn't shipped); `bun` is a Compute runtime built-in.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@prisma\//, /^arktype/],
  dts: false,
  sourcemap: false,
  clean: true,
});
