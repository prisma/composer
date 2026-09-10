/**
 * THE DETECTOR (S3 design consequence 4).
 *
 * Composer's commands run inside the Prisma CLI engine, and the engine owns
 * the whole signal policy: the first Ctrl-C aborts the command and waits for
 * teardown, a second force-exits. That only holds if the engine is the ONLY
 * thing listening. Anything else that registers a SIGINT/SIGTERM handler and
 * calls process.exit on its own kills the process while the engine's cleanup
 * is still running.
 *
 * alchemy's transitive @alchemy.run/node-utils used to register exactly such
 * a handler at IMPORT time, from a module-scope exit hook in its lockfile —
 * so merely evaluating a config armed it. alchemy-run/node-utils#6 scoped the
 * hooks to owned locks (vendored here as a pnpm patch for a while); since
 * alchemy 2.0.0-beta.74 the lockfile module is gone entirely.
 *
 * This test is the standing check that the property actually holds. By ruling
 * there is NO workaround behind it: nothing in our code strips listeners, so
 * a failure here means the process would really have two signal owners, and
 * the fix is upstream (or the patch has been dropped), never a strip in the
 * handler.
 *
 * It runs in a spawned process because listener counts are process-global and
 * the import must be the first thing that happens.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'signal-listeners.mjs');
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

interface Counts {
  readonly SIGINT: number;
  readonly SIGTERM: number;
  readonly exit: number;
}

function listenerCounts(what: 'alchemy' | 'local-target'): {
  before: Counts;
  afterConfigEvaluation: Counts;
  afterLocalTargets: Counts;
} {
  const result = spawnSync(process.execPath, [FIXTURE, what], {
    encoding: 'utf-8',
    timeout: SUBPROCESS_TEST_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`the listener fixture failed (${String(result.status)}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe('the engine is the sole signal listener', () => {
  test(
    'config evaluation registers no SIGINT, SIGTERM, or exit listener',
    () => {
      const { before, afterConfigEvaluation } = listenerCounts('alchemy');

      expect(before.SIGINT).toBe(0);
      expect(before.SIGTERM).toBe(0);

      expect(afterConfigEvaluation.SIGINT).toBe(0);
      expect(afterConfigEvaluation.SIGTERM).toBe(0);
      expect(afterConfigEvaluation.exit).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "dev and log's local-target resolution registers none either",
    () => {
      const { afterLocalTargets } = listenerCounts('local-target');

      expect(afterLocalTargets.SIGINT).toBe(0);
      expect(afterLocalTargets.SIGTERM).toBe(0);
      expect(afterLocalTargets.exit).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
