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
 * so merely evaluating a config armed it. alchemy-run/node-utils#6 scopes the
 * hooks to owned locks; it is vendored as a pnpm patch until the release
 * chain delivers it (see patches/ and the alchemy upgrade skill).
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
  const result = spawnSync(process.execPath, [FIXTURE, what], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`the listener fixture failed (${String(result.status)}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe('the engine is the sole signal listener', () => {
  test('config evaluation registers no SIGINT or SIGTERM listener', () => {
    const { before, afterConfigEvaluation } = listenerCounts('alchemy');

    expect(before.SIGINT).toBe(0);
    expect(before.SIGTERM).toBe(0);

    // The whole point: importing the provider tree must leave the signal
    // surface exactly as it found it, so the engine's handler is the only one.
    expect(afterConfigEvaluation.SIGINT).toBe(0);
    expect(afterConfigEvaluation.SIGTERM).toBe(0);
  });

  test("dev and log's local-target resolution registers none either", () => {
    const { afterLocalTargets } = listenerCounts('local-target');

    expect(afterLocalTargets.SIGINT).toBe(0);
    expect(afterLocalTargets.SIGTERM).toBe(0);
    // The exit hook too: it is the single registration that installed all
    // three upstream, so a local-target import that armed only it would slip
    // past a check that looked at the two signals alone.
    expect(afterLocalTargets.exit).toBe(0);
  });

  test('no exit hook is armed either, which is what the upstream fix changed', () => {
    // Not a signal, but the same registration: the module-scope exitHook that
    // installed all three. Asserting it separately says WHICH upstream
    // behavior regressed if this suite ever goes red.
    expect(listenerCounts('alchemy').afterConfigEvaluation.exit).toBe(0);
  });
});
