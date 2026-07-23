/** Tiny shared helper for the `prisma dev` child-process calls in `postgres.ts` and `teardown.ts`. */
import type { SpawnSyncReturns } from 'node:child_process';

/** stdout + stderr of a `spawnSync` result, for parsing/error reporting. */
export function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`;
}
