import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): only its runnable, src/server.ts, built to
// dist/server.mjs. `prisma-compose deploy` assembles the wrapper (bootstrap +
// main.js from service.ts) via @prisma/compose/node/control. node_modules isn't
// shipped, so everything the server touches at runtime must be inlined:
// @prisma/*, and — because the Prisma Next typed client rides node-postgres,
// not a Compute built-in — @prisma-next/* and `pg` too. `bun` (Bun.serve) is a
// Compute runtime built-in, left external.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  noExternal: [/^@prisma\//, /^@prisma-next\//, /^pg$/, /^pg-/, /^pathe$/],
  dts: false,
  sourcemap: false,
  clean: true,
});
