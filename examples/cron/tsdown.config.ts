import { prismaTsDownConfig } from '@prisma/compose/tsdown';

// The app's own build (ADR-0005): two SEPARATE builds, one per service, each
// into its own dist/ subdir — not one multi-entry build, which would split the
// code the two entries share (workerContract) into a chunk neither entry's own
// dist contains. `prismaTsDownConfig` makes each build self-contained (inline
// everything except runtime built-ins).
export default [
  prismaTsDownConfig({ entry: { server: 'src/worker/server.ts' }, outDir: 'dist/worker' }),
  prismaTsDownConfig({ entry: { server: 'src/runner/server.ts' }, outDir: 'dist/runner' }),
];
