/**
 * `deploy` and `destroy` driven end to end through the engine — real grammar,
 * real argument validation, the real credential check, the real settlement
 * rules — with the published control double standing in for alchemy.
 *
 * This is the semantic half of the CLI's end-to-end coverage. It replaces the
 * old suite that drove a bespoke runner's `run()` and asserted on
 * `console.log` spies: everything those tests reached around, the engine now
 * owns, so the only honest way to cover it is to run a real invocation and
 * look at the exit code and the rendered output.
 *
 * The harness names its binary `prisma-test`, not `prisma-composer` — the
 * binary name belongs to the process, so it is pinned by the process-level
 * test (test/integration/test/cli.engine-shell.test.ts) instead.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, okVoid } from '@internal/foundation/result';
import type { ScriptedChildProgram, TestCli } from '@prisma/cli-engine/testing';
import { createTestCli, mintTestJwt } from '@prisma/cli-engine/testing';
import { type ControlDouble, createControlDouble } from '../../testing/control-double.ts';
import { createComposerFamily } from '../family.ts';

type Fixtures = Parameters<typeof createControlDouble>[0];

/**
 * A real directory with an `alchemy` binary installed, because the handler's
 * spawn adapter resolves the app's own alchemy before handing the terminal
 * over — the same resolution a real run does. The binary is never executed:
 * the engine's scripted fake child stands in for the process.
 */
const CWD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-family-'));
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'alchemy'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const alchemyBin = path.join(dir, 'node_modules', 'alchemy', 'bin');
  fs.mkdirSync(alchemyBin, { recursive: true });
  fs.writeFileSync(path.join(alchemyBin, 'alchemy.js'), '');
  return dir;
})();

/** A credential that is signed in and nowhere near expiry. */
function activeCredential() {
  return {
    token: mintTestJwt({
      sub: 'user_1',
      workspace_id: 'ws_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refreshToken: undefined,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

interface Harness {
  readonly cli: TestCli;
  readonly double: ControlDouble;
}

/**
 * Composer's family mounted at the top level of a test CLI, exactly as
 * `createComposerCli` mounts it — the same family, the same commands, only the
 * process around it replaced.
 */
function composerCli(
  spec: {
    readonly fixtures?: Fixtures;
    readonly signedIn?: boolean;
    readonly spawnScript?: ScriptedChildProgram;
  } = {},
): Harness {
  const double = createControlDouble(spec.fixtures ?? {});
  const family = createComposerFamily({ operations: double.operations });
  const cli = createTestCli({
    commandFamilies: [family],
    commands: { ...family.commands },
    config: {},
    ...(spec.signedIn === false ? {} : { credential: activeCredential() }),
    ...(spec.spawnScript === undefined ? {} : { spawnScript: spec.spawnScript }),
  });
  return { cli, double };
}

/** Human-rendered output is what a user in a terminal sees; the framing is the json mode's business. */
const AS_TTY = { isTty: { stdout: true, stderr: true }, cwd: CWD } as const;

/** A real terminal gets styled output; the assertions here are about the words, not the escape codes. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

const childExiting = (status: number): ScriptedChildProgram =>
  function scriptedExit() {
    return { exitCode: status, signal: null };
  };

const childKilledBy = (signal: 'SIGINT' | 'SIGTERM'): ScriptedChildProgram =>
  function scriptedSignal() {
    return { exitCode: null, signal };
  };

describe('argument validation', () => {
  test('deploy without an entry fails on the grammar and never reaches the handler', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('CLI.INVALID_ARGUMENTS');
    expect(plain(result.stderr)).toContain('Expected argument for entry');
    expect(double.calls.deploy).toEqual([]);
  });

  test('destroy without an entry fails the same way', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['destroy', '--production'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('Expected argument for entry');
    expect(double.calls.destroy).toEqual([]);
  });

  test('an unknown flag is refused, naming the flag', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy', 'src/service.ts', '--nope'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('CLI.INVALID_ARGUMENTS');
    expect(plain(result.stderr)).toContain('--nope');
    expect(double.calls.deploy).toEqual([]);
  });

  /**
   * `deploy --production` used to parse and then always fail with "only valid
   * with destroy", so no invocation using it could ever have succeeded. It is
   * not deploy's flag any more, and the grammar says so.
   */
  test('deploy has no --production flag at all', async () => {
    const { cli } = composerCli();
    const result = await cli.run(['deploy', 'src/service.ts', '--production'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('--production');
  });

  test('destroy demands a target, and says which two flags provide one', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['destroy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('DEPLOY.TARGET_MISSING');
    expect(plain(result.stderr)).toContain('--stage <name>');
    expect(plain(result.stderr)).toContain('--production');
    expect(double.calls.destroy).toEqual([]);
  });

  test('destroy refuses both targets at once', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['destroy', 'src/service.ts', '--stage', 'x', '--production'], {
      ...AS_TTY,
    });

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('DEPLOY.TARGET_CONFLICT');
    expect(double.calls.destroy).toEqual([]);
  });

  test('deploy passes entry, --name and --stage through to the operation verbatim', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(
      ['deploy', 'src/service.ts', '--name', 'shop', '--stage', 'feat-auth'],
      AS_TTY,
    );

    expect(result.exitCode).toBe(0);
    expect(double.calls.deploy).toEqual([
      { entry: 'src/service.ts', name: 'shop', stage: 'feat-auth', cwd: CWD },
    ]);
  });

  test('destroy --stage and --production become the operation’s two targets', async () => {
    const staged = composerCli();
    await staged.cli.run(['destroy', 'src/service.ts', '--stage', 'feat-auth'], AS_TTY);
    expect(staged.double.calls.destroy[0]?.target).toEqual({ kind: 'stage', stage: 'feat-auth' });

    const production = composerCli();
    await production.cli.run(['destroy', 'src/service.ts', '--production'], AS_TTY);
    expect(production.double.calls.destroy[0]?.target).toEqual({ kind: 'production' });
  });
});

/**
 * Engine 0.2.0 (prisma-cli#184): a spawning command uses the engine's normal
 * structured-output contract. `--json` runs the command — the terminal frame
 * on stdout is the machine surface, and the child's own output becomes
 * diagnostics — instead of being refused up front as it was on engine 0.1.1.
 */
describe('--json on a spawning command', () => {
  for (const argv of [
    ['deploy', 'src/service.ts'],
    ['destroy', 'src/service.ts', '--production'],
  ]) {
    test(`\`${argv[0]} --json\` runs and emits one result frame`, async () => {
      const { cli, double } = composerCli();
      const result = await cli.run([...argv, '--json'], AS_TTY);

      expect(result.exitCode).toBe(0);
      expect([...double.calls.deploy, ...double.calls.destroy]).toHaveLength(1);
      const frames = result.json.filter((frame) => frame.kind === 'result');
      expect(frames).toHaveLength(1);
      expect(frames[0]?.envelope).toMatchObject({ ok: true, commandId: argv[0] });
    });

    test(`\`${argv[0]} --format json\` runs the same way`, async () => {
      const { cli } = composerCli();
      const result = await cli.run([...argv, '--format', 'json'], AS_TTY);

      expect(result.exitCode).toBe(0);
      expect(result.json.filter((frame) => frame.kind === 'result')).toHaveLength(1);
    });
  }
});

describe('credentials', () => {
  test('a signed-out deploy is refused before the handler runs — nothing is created anywhere', async () => {
    const { cli, double } = composerCli({ signedIn: false });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('CLI.CREDENTIALS_REQUIRED');
    expect(result.spawns).toEqual([]);
    expect(double.calls.deploy).toEqual([]);
  });

  test('a signed-out destroy is refused the same way', async () => {
    const { cli, double } = composerCli({ signedIn: false });
    const result = await cli.run(['destroy', 'src/service.ts', '--production'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('CLI.CREDENTIALS_REQUIRED');
    expect(double.calls.destroy).toEqual([]);
  });

  /**
   * The child leg: the command declares `needs: { credentials: 'child' }`, so
   * the engine composes the credential into the converge's environment. Only
   * the KEY is observable here — the harness never records a value, so a
   * fixture cannot carry token material.
   */
  test('the converge child is given the credential by the engine', async () => {
    const { cli } = composerCli({ spawnScript: childExiting(0) });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(result.spawns[0]?.envKeys).toContain('PRISMA_SERVICE_TOKEN');
  });
});

/**
 * How a converge settles, which is the whole reason the commands run the
 * child through `ctx.spawn` rather than describing the outcome themselves.
 */
describe('settlement', () => {
  test("a converge that exits non-zero settles with the child's own status, not a collapsed one", async () => {
    const { cli } = composerCli({ spawnScript: childExiting(7) });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(7);
  });

  test('a failed converge renders the reproduce hint and no failure envelope', async () => {
    const { cli } = composerCli({ spawnScript: childExiting(1) });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(1);
    expect(plain(result.stderr)).toContain(
      `Run the converge directly from ${CWD} to reproduce this`,
    );
    expect(plain(result.stderr)).toContain('alchemy deploy .prisma-composer/alchemy.run.ts');
    expect(plain(result.stderr)).not.toContain('✖');
  });

  /**
   * The rule this whole restructure exists for. A signal-killed child is the
   * user aborting, not a deploy that failed: it settles 128 + the signal, and
   * it renders NOTHING — no failure envelope, because nothing failed, and no
   * reproduce hint, because the user stopped it and there is nothing to
   * reproduce. The old CLI collapsed the signal into an exit code and reported
   * a Ctrl-C'd deploy as an engine failure.
   */
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    test(`a deploy whose converge is killed by ${signal} settles ${String(code)} in silence`, async () => {
      const { cli } = composerCli({ spawnScript: childKilledBy(signal) });
      const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

      expect(result.exitCode).toBe(code);
      expect(plain(result.stderr)).toBe('');
      expect(plain(result.stdout)).toBe('');
    });

    test(`a destroy whose converge is killed by ${signal} settles ${String(code)} in silence`, async () => {
      const { cli } = composerCli({ spawnScript: childKilledBy(signal) });
      const result = await cli.run(['destroy', 'src/service.ts', '--production'], AS_TTY);

      expect(result.exitCode).toBe(code);
      expect(plain(result.stderr)).toBe('');
      expect(plain(result.stdout)).toBe('');
    });
  }

  /**
   * A failure that never reached the child is an ordinary structured error, so
   * it gets the ordinary envelope — and composer's `fix` prose has to survive
   * the translation into the engine's `nextActions`, which is the one part of
   * an envelope that changes representation at the family boundary.
   */
  test('a failure before the converge renders the normal envelope, remedy included', async () => {
    const { cli } = composerCli({
      fixtures: {
        deploy: notOk(
          new CliStructuredError(
            'DEPLOY.NO_BUILT_ENTRY',
            'There is no built entry at dist/service.js.',
            { fix: 'Run your build first, then deploy again.' },
          ),
        ),
      },
    });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('DEPLOY.NO_BUILT_ENTRY');
    expect(plain(result.stderr)).toContain('There is no built entry at dist/service.js.');
    expect(plain(result.stderr)).toContain('Run your build first, then deploy again.');
  });
});

describe('what a successful run presents', () => {
  test('deploy reports the app and a row per deployed node', async () => {
    const { cli } = composerCli({
      fixtures: {
        deploy: ok({
          summary: {
            app: 'shop',
            nodes: [
              { address: 'catalog.service', entities: [{ kind: 'Worker', id: 'catalog-worker' }] },
              { address: 'orders.service', entities: [{ kind: 'Worker', id: 'orders-worker' }] },
            ],
          },
        }),
      },
    });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(plain(result.stderr)).toContain('Deployed shop.');
    expect(plain(result.stderr)).toContain('catalog.service');
    expect(plain(result.stderr)).toContain('Worker orders-worker');
    expect(result.presented?.data).toEqual({
      summary: {
        app: 'shop',
        nodes: [
          { address: 'catalog.service', entities: [{ kind: 'Worker', id: 'catalog-worker' }] },
          { address: 'orders.service', entities: [{ kind: 'Worker', id: 'orders-worker' }] },
        ],
      },
    });
  });

  test('a deploy whose child wrote no report still reports success', async () => {
    const { cli } = composerCli({ fixtures: { deploy: ok({ summary: undefined }) } });
    const result = await cli.run(['deploy', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(plain(result.stderr)).toContain('Deployed.');
    expect(result.presented?.data).toEqual({ summary: null });
  });

  test('destroy reports success', async () => {
    const { cli } = composerCli({ fixtures: { destroy: okVoid() } });
    const result = await cli.run(['destroy', 'src/service.ts', '--production'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(plain(result.stderr)).toContain('Destroyed.');
  });

  test("destroy's no-prior-state notice reaches the user as a warning, not a failure", async () => {
    const { cli } = composerCli({
      fixtures: { destroyEvents: [{ kind: 'no-local-deploy-state', cwd: CWD }] },
    });
    const result = await cli.run(['destroy', 'src/service.ts', '--production'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(result.events).toContainEqual({
      kind: 'message',
      severity: 'warn',
      text:
        `No prior deploy state under ${CWD} — if you deployed from a different directory, run ` +
        'destroy from there; otherwise this is a no-op.',
    });
  });
});
