import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): the jobs service's runnable, built to a
// SINGLE self-contained dist/jobs/server.mjs. @prisma/composer/node's
// assemble() copies only the entry file into the deployed bundle (ADR-0004),
// so no sibling chunks are allowed — outputOptions.inlineDynamicImports
// collapses shared helpers into the one file. Everything is inlined
// (node_modules isn't shipped to Compute — PRO-213) EXCEPT `bun` (a Compute
// runtime built-in) and `node:` builtins (provided by the runtime).
export default defineConfig({
  entry: { server: 'src/jobs/server.ts' },
  outDir: 'dist/jobs',
  format: 'esm',
  platform: 'node',
  external: [/^bun$/, /^bun:/, /^node:/],
  noExternal: [/.*/],
  outputOptions: { inlineDynamicImports: true },
  dts: false,
  sourcemap: false,
  clean: true,
});
