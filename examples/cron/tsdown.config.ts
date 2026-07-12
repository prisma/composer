import { defineConfig } from 'tsdown';

// The app's own build (ADR-0005): two SEPARATE builds, one per service, each
// into its own dist/ subdir — not one multi-entry build, which would split
// the code the two entries share (workerContract) into a chunk neither
// entry's own subdir contains, and @prisma/compose-node's assemble() copies only
// the entry file into the deployed bundle (ADR-0004). Each build here is
// fully self-contained. `@prisma/*` and `arktype` are inlined (node_modules
// isn't shipped); `bun` is a Compute runtime built-in.
export default defineConfig([
  {
    entry: { server: 'src/worker/server.ts' },
    outDir: 'dist/worker',
    format: 'esm',
    platform: 'node',
    external: ['bun'],
    noExternal: [/^@prisma\//, /^arktype/],
    dts: false,
    sourcemap: false,
    clean: true,
  },
  {
    entry: { server: 'src/runner/server.ts' },
    outDir: 'dist/runner',
    format: 'esm',
    platform: 'node',
    external: ['bun'],
    noExternal: [/^@prisma\//, /^arktype/],
    dts: false,
    sourcemap: false,
    clean: true,
  },
]);
