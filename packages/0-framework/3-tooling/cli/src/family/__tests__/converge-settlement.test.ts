/**
 * The one settlement rule no real deploy or destroy run can demonstrate: what
 * `settleConverge` does when the operation SUCCEEDED and its child was killed
 * by a signal.
 *
 * Composer's own operations never produce that pair — deploy, destroy and dev
 * each report a signal-killed converge as a failure — so the rule is stated
 * here against a probe command that produces it deliberately. Composer used to
 * settle this as an abort and present nothing; it now presents the result it
 * has, while the engine still ends the run at 130 from its own record of the
 * interrupt.
 */
import { describe, expect, test } from 'bun:test';
import { ok } from '@internal/foundation/result';
import { defineCommand, defineCommandFamily } from '@prisma/cli-engine';
import { createTestCli } from '@prisma/cli-engine/testing';
import { settleConverge } from '../converge.ts';

const AS_TTY = { isTty: { stdout: true, stderr: true } } as const;

/** Runs a child, then settles a SUCCESSFUL converge over however that child ended. */
const converged = defineCommand({
  help: { summary: 'Settle a successful converge over the child that just ran.' },
  maySpawn: true,
  handler: async (_args, ctx) => {
    await ctx.spawn({ command: 'alchemy' });
    return settleConverge(ok({ app: 'shop' }), ctx, (value) =>
      ctx.present(
        { data: value },
        { human: () => [{ kind: 'summary', status: 'ok', text: `Deployed ${value.app}.` }] },
      ),
    );
  },
});

const family = defineCommandFamily({ commands: { converged } });

describe('a converge that succeeded and was then interrupted', () => {
  test('presents its result, and the engine still ends the run at 130', async () => {
    // Ctrl-C reaches the whole process group: the child dies of the signal and
    // the engine records that same signal, which is what aborting from inside
    // the scripted child models.
    const interrupt = new AbortController();
    const cli = createTestCli({
      commandFamilies: [family],
      commands: { ...family.commands },
      spawnScript: () => {
        interrupt.abort();
        return { exitCode: null, signal: 'SIGINT' };
      },
    });

    const result = await cli.run(['converged'], { ...AS_TTY, abort: interrupt.signal });

    expect(result.exitCode).toBe(130);
    expect(result.presented?.data).toEqual({ app: 'shop' });
  });
});
