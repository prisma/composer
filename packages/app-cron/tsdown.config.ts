import { baseConfig } from '@prisma/app-tsdown';
import { defineConfig } from 'tsdown';

// Two SEPARATE builds, not one multi-entry build (mirrors @prisma/app-node's
// own two-build split, control.ts): a single build would fold the shared
// authoring code (schedule.ts/scheduler.ts) into a chunk both entries import.
// scheduler-entry.mjs must stand alone — @prisma/app-node's `assemble()`
// copies a built `entry` out of its directory by itself, with no sibling
// chunk file, when it assembles an app that uses cronScheduler().
export default defineConfig([
  { ...baseConfig, entry: { index: 'src/index.ts' }, clean: true },
  { ...baseConfig, entry: { 'scheduler-entry': 'src/scheduler-entry.ts' }, clean: false },
]);
