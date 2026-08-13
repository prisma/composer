/**
 * `runComposerCli` — composer's REAL host adapter, driven end to end.
 *
 * Every other suite here builds its CLI with the engine's test harness, which
 * composes its own Runtime and so never touches `createRuntime`. That left the
 * host adapter uncovered, and an engine upgrade proved it: `Runtime.config`
 * became `Runtime.loadConfig`, composer kept supplying the old field, and every
 * real invocation died with "runtime.loadConfig is not a function" while all
 * 207 unit tests still passed. Only the integration suite noticed.
 *
 * So these tests run through `runComposerCli` and a fake host. In particular,
 * they pin the precedence between Composer's own config and the consolidated
 * prisma.config.ts fallback at the real command boundary.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk } from '@internal/foundation/result';
import type { HostProcess } from '@prisma/cli-engine';
import { createControlDouble } from '../../testing/control-double.ts';
import { runComposerCli } from '../engine-cli.ts';

const VERSION = '0.6.0-test';

interface FakeHost extends HostProcess {
  readonly out: string[];
  readonly err: string[];
}

function fakeHost(cwd: string): FakeHost {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    argv: [],
    env: {},
    cwd: () => cwd,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    stdin: {
      [Symbol.asyncIterator]: async function* () {
        // No input.
      },
    },
    on: () => undefined,
    off: () => undefined,
    exit: (code: number) => {
      throw new Error(`exit(${String(code)})`);
    },
  };
}

/** An empty directory, so nothing is discovered that the test did not put there. */
const emptyDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'composer-host-'));

/**
 * `dev` is credential-free, and a failing fixture settles it immediately
 * without starting a session or spawning a converge.
 */
function refusingOperations() {
  return createControlDouble({
    dev: notOk(new CliStructuredError('DEV.REFUSED', 'Nothing to run.')),
  });
}

describe('runComposerCli() — Composer config precedence through the real host', () => {
  /**
   * With neither config file, the consolidated fallback is absent and
   * Composer's operation remains responsible for its normal missing-config
   * diagnosis.
   */
  test('a run with no config file reaches the handler — absence is normal', async () => {
    const double = refusingOperations();
    const host = fakeHost(emptyDir());

    const exitCode = await runComposerCli(['dev', 'src/service.ts'], host, {
      version: VERSION,
      operations: double.operations,
    });

    expect(host.err.join('')).not.toContain('CLI.INTERNAL_ERROR');
    expect(double.calls.dev).toHaveLength(1);
    expect(exitCode).toBe(2);
    expect(host.err.join('')).toContain('DEV.REFUSED');
  });

  test('a discovered Composer config prevents prisma.config.ts from being evaluated', async () => {
    const double = refusingOperations();
    const dir = emptyDir();
    fs.writeFileSync(
      path.join(dir, 'prisma.config.ts'),
      [
        'const env = (name: string): string => { throw new Error(name + " is required"); };',
        'export default { datasource: { url: env("DATABASE_URL") } };',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'prisma-composer.config.ts'), 'export default {};\n');

    const exitCode = await runComposerCli(['dev', 'src/service.ts'], fakeHost(dir), {
      version: VERSION,
      operations: double.operations,
    });

    expect(exitCode).toBe(2);
    expect(double.calls.dev).toHaveLength(1);
    expect(double.calls.deps.dev[0]?.configPath).toBeUndefined();
  });

  test('without a Composer config, prisma.config.ts remains the fallback', async () => {
    const double = refusingOperations();
    const dir = emptyDir();
    fs.writeFileSync(
      path.join(dir, 'prisma.config.ts'),
      'export default { $prismaConfig: 1, composer: { configPath: "custom" } };\n',
    );

    const exitCode = await runComposerCli(['dev', 'src/service.ts'], fakeHost(dir), {
      version: VERSION,
      operations: double.operations,
    });

    expect(exitCode).toBe(2);
    expect(double.calls.dev).toHaveLength(1);
    expect(double.calls.deps.dev[0]?.configPath).toBe('custom');
  });
});
