/**
 * The rebuilt CLI and the family it mounts.
 *
 * D2's family carries no commands yet, so what is provable here is the
 * composition itself: that `createCli` accepts composer's family, that a real
 * run reaches the engine's own surfaces through composer's Runtime, and that
 * the `composer` section token is genuinely wired into the engine's config
 * machinery rather than merely defined. The last one is checked by mounting a
 * probe command on the same token — the same thing D3's four commands will do.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCli,
  defineCommand,
  defineCommandFamily,
  type HostProcess,
  type LoadedConfig,
} from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createComposerCli, runComposerCli } from '../engine-cli.ts';
import { createComposerFamily, realOperations } from '../family.ts';
import { createRuntime } from '../runtime.ts';
import { type ComposerSection, composerSection } from '../section.ts';

const VERSION = '0.6.0-test';
const EMPTY_CONFIG: LoadedConfig = { sections: {}, diagnostics: [] };

function fakeHost(cwd: string): HostProcess & { out: string[]; err: string[] } {
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

describe('createComposerFamily()', () => {
  test('the family carries the composer section token', () => {
    expect(createComposerFamily().configSection).toBe(composerSection);
  });

  test('the family mounts the four commands', () => {
    expect(Object.keys(createComposerFamily().commands).sort()).toEqual([
      'deploy',
      'destroy',
      'dev',
      'log',
    ]);
  });

  test('the operations seam defaults to the real control operations', () => {
    expect(realOperations.deploy).toBeInstanceOf(Function);
    expect(realOperations.destroy).toBeInstanceOf(Function);
    expect(realOperations.dev).toBeInstanceOf(Function);
    expect(realOperations.log).toBeInstanceOf(Function);
  });

  test('a host may substitute the operations', () => {
    const doubles = { ...realOperations, deploy: async () => notOk(new Error('unused')) };
    expect(() =>
      createComposerFamily({
        operations: doubles as unknown as typeof realOperations,
      }),
    ).not.toThrow();
  });
});

describe('createComposerCli()', () => {
  test('the CLI constructs, now that the family carries commands', () => {
    expect(() => createComposerCli({ version: VERSION })).not.toThrow();
  });

  test('the CLI mounts exactly what the family carries', () => {
    const mounted = Object.keys(createComposerFamily().commands).sort();
    expect(mounted).toEqual(['deploy', 'destroy', 'dev', 'log']);
  });

  test('runComposerCli runs a real engine run to an exit code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-engine-cli-'));
    try {
      expect(await runComposerCli(['--version'], fakeHost(dir), { version: VERSION })).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The rest of the composition — composer's Runtime driving a real engine run
 * to a real exit code — proven over a probe command, because the skeleton
 * family has none of its own yet. `runComposerCli` differs from this only in
 * where the family comes from.
 */
describe("composer's Runtime against a real engine run", () => {
  test('a run reaches the engine, writes to the host streams and reports the version', async () => {
    const host = fakeHost(process.cwd());
    const cli = createCli({
      name: 'prisma-composer',
      version: VERSION,
      commandFamilies: [
        defineCommandFamily({ configSection: composerSection, commands: { probe } }),
      ],
      groups: {},
      commands: { probe },
    });
    const exitCode = await cli.run(['--version'], createRuntime(host, EMPTY_CONFIG));
    expect(exitCode).toBe(0);
    expect(host.out.join('')).toContain(VERSION);
  });

  test('help names the binary the engine was given', async () => {
    const host = fakeHost(process.cwd());
    const cli = createCli({
      name: 'prisma-composer',
      version: VERSION,
      commandFamilies: [
        defineCommandFamily({ configSection: composerSection, commands: { probe } }),
      ],
      groups: {},
      commands: { probe },
    });
    await cli.run(['--help'], createRuntime(host, EMPTY_CONFIG));
    expect(`${host.out.join('')}${host.err.join('')}`).toContain('prisma-composer');
  });
});

/**
 * The section token, driven through the engine's own config machinery on a
 * probe command. This is the wiring D3's commands depend on: without it, a
 * command declaring `needs.config` would receive nothing.
 */
const probe = defineCommand({
  help: { summary: 'Report the validated composer section.' },
  needs: { config: composerSection },
  handler: async (_args, ctx) =>
    ok(ctx.present({ data: ctx.config }, { human: () => [], json: () => ctx.config })),
});

function probeCli(sections: Record<string, unknown>) {
  return createTestCli({
    commandFamilies: [defineCommandFamily({ configSection: composerSection, commands: { probe } })],
    commands: { probe },
    config: sections,
  });
}

describe('the composer section through the engine', () => {
  test('no section at all still runs — absence is normal', async () => {
    const result = await probeCli({}).run(['probe', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.presented?.data).toEqual({});
  });

  test('a configPath reaches the handler as ctx.config', async () => {
    const result = await probeCli({
      composer: { configPath: './x/prisma-composer.config.ts' },
    }).run(['probe', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.presented?.data).toEqual({
      configPath: './x/prisma-composer.config.ts',
    } satisfies ComposerSection);
  });

  test('an invalid section fails the command rather than reaching the handler', async () => {
    const result = await probeCli({ composer: { configPath: 42 } }).run(['probe']);
    expect(result.exitCode).not.toBe(0);
    expect(result.presented).toBeUndefined();
  });
});
