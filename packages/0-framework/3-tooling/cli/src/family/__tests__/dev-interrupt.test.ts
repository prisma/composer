/**
 * `dev`'s interrupt path: Ctrl-C during the session settles 130, and the
 * session is stopped before it does.
 *
 * The exit code is the engine's to state, not the handler's. `dev` stops the
 * session and returns `ok(undefined)` — an ordinary success — and the engine
 * settles the run at 128 + the signal it recorded. That arrangement is only
 * safe if the engine actually honours it, so this test pins the number: a
 * handler that went back to stating its own exit code, and an engine that
 * settled a cleanly-returned session at 0, both fail here.
 */
import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createControlDouble } from '../../testing/control-double.ts';
import { createComposerFamily } from '../family.ts';

const AS_TTY = { isTty: { stdout: true, stderr: true } } as const;

const STOP_STEP = "Stopping the app's services — emulators and data stay up";

describe('dev, interrupted', () => {
  test('Ctrl-C settles 130, with the session stopped first', async () => {
    const double = createControlDouble({});
    const family = createComposerFamily({ operations: double.operations });
    const cli = createTestCli({
      commandFamilies: [family],
      commands: { ...family.commands },
      config: {},
    });

    // The interrupt lands once the session is up, which is the moment a user
    // could press Ctrl-C: the handler is parked on ctx.signal by then.
    const interrupt = new AbortController();
    const result = await cli.run(['dev', 'src/service.ts'], {
      ...AS_TTY,
      abort: interrupt.signal,
      onEvent: (event: EngineEvent) => {
        if (event.kind === 'status' && event.subject === 'dev' && event.status === 'ready') {
          interrupt.abort();
        }
      },
    });

    expect(result.exitCode).toBe(130);
    expect(result.events).toContainEqual({
      kind: 'step-finished',
      step: STOP_STEP,
      id: 'dev-stop',
      outcome: 'ok',
    });
    expect(double.calls.dev).toHaveLength(1);
  });
});
