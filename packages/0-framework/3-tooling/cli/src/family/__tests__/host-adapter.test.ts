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
 * So these tests run through `runComposerCli` and a fake host, on commands that
 * declare a config section — the path that was broken. The existing coverage
 * used `--version`, which declares none and therefore never asks the Runtime
 * for config at all.
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
    version: 'v24.0.0',
    versions: { node: '24.0.0' },
    platform: 'linux',
    arch: 'x64',
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
 * `dev` is the cheapest command that declares a config section: it is
 * credential-free, and a failing fixture settles it immediately without
 * starting a session or spawning a converge.
 */
function refusingOperations() {
  return createControlDouble({
    dev: notOk(new CliStructuredError('DEV.REFUSED', 'Nothing to run.')),
  });
}

describe('runComposerCli() — the real Runtime, on a command that needs config', () => {
  /**
   * The regression this file exists for. With the Runtime's config seam
   * misspelled, this run settles CLI.INTERNAL_ERROR instead of reaching the
   * section validator at all.
   */
  test('a run with no config file is refused by the section validator, not the Runtime', async () => {
    const double = refusingOperations();
    const host = fakeHost(emptyDir());

    const exitCode = await runComposerCli(['dev', 'src/service.ts'], host, {
      version: VERSION,
      operations: double.operations,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(host.out.join(''))).toMatchObject({
      envelope: {
        error: { code: 'CLI.CONFIG_SECTION_INVALID' },
        diagnostics: [{ code: 'CONFIG.SECTION_MISSING' }],
      },
    });
    expect(double.calls.dev).toEqual([]);
  });

  /**
   * `--config` end to end: the flag is the engine's, but the path only reaches
   * the loader because composer's Runtime forwards it. A Runtime that dropped
   * the argument would quietly read prisma.config.ts from cwd, find nothing,
   * and run — so the missing named file is what proves the forwarding.
   */
  test('--config reaches the loader, which refuses a file that is not there', async () => {
    const double = refusingOperations();
    const dir = emptyDir();
    const host = fakeHost(dir);

    const exitCode = await runComposerCli(
      ['dev', 'src/service.ts', '--config', 'not-here.config.ts'],
      host,
      { version: VERSION, operations: double.operations },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(host.out.join(''))).toMatchObject({
      envelope: {
        error: {
          code: 'CLI.CONFIG_NOT_FOUND',
          where: { path: path.join(dir, 'not-here.config.ts') },
        },
      },
    });
    expect(double.calls.dev).toEqual([]);
  });

  /** The same flag, satisfied: a real file on disk is read, and its composer section reaches the handler. */
  test('--config reads the file it names, whose section reaches the command', async () => {
    const double = refusingOperations();
    const dir = emptyDir();
    const configFile = path.join(dir, 'custom.config.ts');
    fs.writeFileSync(
      configFile,
      [
        'export default {',
        '  $prismaConfig: 1,',
        "  composer: { extensions: [{ id: 'ext-a', nodes: {} }], state: { extension: 'ext-a', create: () => undefined } },",
        '};',
        '',
      ].join('\n'),
    );

    const exitCode = await runComposerCli(
      ['dev', 'src/service.ts', '--config', 'custom.config.ts'],
      fakeHost(dir),
      { version: VERSION, operations: double.operations },
    );

    expect(exitCode).toBe(2);
    expect(double.calls.dev).toHaveLength(1);
    // The section and the file that declared it, which the loader realpaths.
    expect(double.calls.dev[0]?.config).toEqual({
      value: {
        extensions: [{ id: 'ext-a', nodes: {} }],
        state: { extension: 'ext-a', create: expect.any(Function) },
      },
      file: path.join(fs.realpathSync(dir), 'custom.config.ts'),
    });
  });

  test('an old prisma-composer.config.ts beside the declaring file fails the section before the operation', async () => {
    const double = refusingOperations();
    const dir = emptyDir();
    fs.writeFileSync(
      path.join(dir, 'prisma.config.ts'),
      [
        'export default {',
        '  $prismaConfig: 1,',
        "  composer: { extensions: [{ id: 'ext-a', nodes: {} }], state: { extension: 'ext-a', create: () => undefined } },",
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'prisma-composer.config.ts'), 'export default {};\n');

    const host = fakeHost(dir);
    const exitCode = await runComposerCli(['dev', 'src/service.ts'], host, {
      version: VERSION,
      operations: double.operations,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(host.out.join(''))).toMatchObject({
      envelope: {
        error: { code: 'CLI.CONFIG_SECTION_INVALID' },
        diagnostics: [
          {
            code: 'CONFIG.FILE_RETIRED',
            summary: `${path.join(fs.realpathSync(dir), 'prisma-composer.config.ts')} is no longer read.`,
          },
        ],
      },
    });
    expect(double.calls.dev).toEqual([]);
  });
});
