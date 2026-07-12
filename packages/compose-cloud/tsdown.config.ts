import { baseConfig } from '@prisma/compose-tsdown';
import { defineConfig } from 'tsdown';

// Three builds. `exports:false` on all of them — `baseConfig`'s own
// `exports:true` regenerates package.json's manifest from ONE build's own
// entries, so across three separate builds each run would wipe what the
// others wrote; the manifest is hand-maintained here instead.
//
// 1. The library entries (index/control/prisma-next/testing) — normal
//    library treatment, deps external.
//
// 2. cron/index and cron/scheduler-service share code (scheduler.ts,
//    contract.ts, schedule.ts) that only they import. Their own build, with
//    its own `outDir: 'dist/cron'` — not just an entry-key prefix — so ANY
//    chunk this pass emits, including a shared one, lands inside dist/cron/:
//    `cronScheduler()`'s `new URL('./scheduler-service.mjs', import.meta.url)`
//    is evaluated from wherever the bundler puts the code that calls it
//    (which may be a shared chunk, not index.mjs itself), so that code's own
//    directory must be dist/cron/ too.
//
// 3. `scheduler-entrypoint` gets its own self-contained pass (mirrors the
//    deleted `@prisma/compose-cron`'s own split): `assemble()` copies a built
//    `entry` out of its directory by itself, with no sibling chunk file, so a
//    multi-entry build sharing code across entries would leave that chunk
//    behind — `scheduler-entrypoint.mjs` must stand alone.
export default defineConfig([
  {
    ...baseConfig,
    entry: ['src/index.ts', 'src/control.ts', 'src/prisma-next.ts', 'src/testing.ts'],
    exports: false,
    clean: true,
  },
  {
    ...baseConfig,
    entry: {
      index: 'src/cron/index.ts',
      'scheduler-service': 'src/cron/scheduler-service.ts',
    },
    outDir: 'dist/cron',
    exports: false,
    clean: false,
  },
  {
    ...baseConfig,
    entry: { 'scheduler-entrypoint': 'src/cron/scheduler-entrypoint.ts' },
    outDir: 'dist/cron',
    exports: false,
    clean: false,
    // Copied standalone by assemble() (no sibling node_modules) — inline its
    // runtime deps rather than leaving them as bare imports. `noExternal` and
    // `skipNodeModulesBundle` are mutually exclusive in tsdown, so this entry
    // overrides the base config's `skipNodeModulesBundle` instead of
    // composing with it.
    skipNodeModulesBundle: false,
    noExternal: [/^@prisma\//, /^arktype/],
  },
]);
