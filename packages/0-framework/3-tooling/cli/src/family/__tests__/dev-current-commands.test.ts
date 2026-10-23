/**
 * `dev url`, `dev stop` and `dev logs` through the engine, over the
 * operations double: the URL and log lines as human data lines, the JSON
 * results and frames, and failures carrying their code and fix.
 */
import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok } from '@internal/foundation/result';
import { createTestCli } from '@prisma/cli-engine/testing';
import {
  createOperationsDouble,
  type OperationsDoubleFixtures,
} from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';

function composerConfig() {
  return {
    extensions: [{ id: 'ext-a', nodes: {}, providers: () => 'layer' }],
    state: { extension: 'ext-a', create: () => 'state' },
  };
}

function cliWith(fixtures: OperationsDoubleFixtures = {}) {
  const double = createOperationsDouble(fixtures);
  const family = createComposerFamily({ operations: double.operations });
  const cli = createTestCli({
    commandFamilies: [family],
    commands: {
      'dev url': commandAt(family, 'dev url'),
      'dev stop': commandAt(family, 'dev stop'),
      'dev logs': commandAt(family, 'dev logs'),
    },
    groups: { dev: { brief: 'Run the app on this machine.' } },
    config: { composer: composerConfig() },
  });
  return { cli, calls: double.calls };
}

describe('dev url', () => {
  test('prints the URL alone on stdout in human format', async () => {
    const { cli, calls } = cliWith();

    const result = await cli.run(['dev', 'url', 'gateway', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('http://localhost:3000\n');
    expect(calls.devUrl.map((input) => input.address)).toEqual(['gateway']);
  });

  test('escapes a backslash and a tab in the URL', async () => {
    const { cli } = cliWith({
      devUrl: ok({
        address: 'catalog',
        kind: 'database',
        url: 'postgres://app:p\\w\td@localhost:5432/app',
        state: 'running',
      }),
    });

    const result = await cli.run(['dev', 'url', 'catalog', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('postgres://app:p\\\\w\\td@localhost:5432/app\n');
  });

  test('returns address, kind, url and state as the JSON result', async () => {
    const { cli } = cliWith({
      devUrl: {
        ok: true,
        value: { address: 'catalog', kind: 'database', url: 'postgres://x', state: 'running' },
      } as never,
    });

    const result = await cli.run(['dev', 'url', 'catalog', '--json']);

    expect(result.json.at(-1)).toMatchObject({
      kind: 'result',
      envelope: {
        ok: true,
        result: { address: 'catalog', kind: 'database', url: 'postgres://x', state: 'running' },
      },
    });
  });

  test('a failure keeps its code, and its fix becomes the next action', async () => {
    const { cli } = cliWith({
      devUrl: notOk(
        new CliStructuredError('DEV.ADDRESS_UNKNOWN', 'no node at "quotes".', {
          fix: 'Pass one of those addresses.',
        }),
      ),
    });

    const result = await cli.run(['dev', 'url', 'quotes', '--json']);

    expect(result.exitCode).not.toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: {
        ok: false,
        error: { code: 'DEV.ADDRESS_UNKNOWN' },
        nextActions: [{ kind: 'user-choice', label: 'Pass one of those addresses.' }],
      },
    });
  });
});

describe('dev stop', () => {
  test('returns what it stopped as the JSON result', async () => {
    const stopped = { app: 'shop', stopped: [{ address: 'gateway', kind: 'service' }] };
    const { cli } = cliWith({ devStop: { ok: true, value: stopped } as never });

    const result = await cli.run(['dev', 'stop', '--json']);

    expect(result.json.at(-1)).toMatchObject({ envelope: { ok: true, result: stopped } });
  });

  test('piped, prints one line per stopped node: its address and kind', async () => {
    const { cli } = cliWith({
      devStop: ok({
        app: 'orm-demo',
        stopped: [
          { address: 'database', kind: 'database' },
          { address: 'api', kind: 'service' },
        ],
      }),
    });

    const result = await cli.run(['dev', 'stop']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('database\tdatabase\napi\tservice\n');
  });

  test('piped, prints nothing when nothing was running', async () => {
    const { cli } = cliWith({ devStop: ok({ app: 'orm-demo', stopped: [] }) });

    const result = await cli.run(['dev', 'stop']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('names what it stopped in a table of addresses and kinds', async () => {
    const { cli } = cliWith({
      devStop: ok({
        app: 'orm-demo',
        stopped: [
          { address: 'database', kind: 'database' },
          { address: 'api', kind: 'service' },
        ],
      }),
    });

    const result = await cli.run(['dev', 'stop', '--format', 'human']);

    expect(result.stderr).toContain('Stopped orm-demo.');
    expect(result.stderr).toMatch(/Address\s+Kind/);
    expect(result.stderr).toMatch(/api\s+service/);
  });

  test('says nothing was running when there was nothing to stop, and still succeeds', async () => {
    const { cli } = cliWith({ devStop: ok({ app: 'orm-demo', stopped: [] }) });

    const result = await cli.run(['dev', 'stop', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Nothing of orm-demo was running.');
    expect(result.stderr).not.toContain('Stopped orm-demo');
  });
});

describe('dev logs', () => {
  const devLogLines = [
    { service: 'catalog', line: 'catalog ready' },
    { service: 'gateway', line: 'GET / 200' },
    { service: 'gateway', line: 'GET /health 200' },
  ];

  test("prints every service's lines on stdout, each labelled with its service", async () => {
    const { cli, calls } = cliWith({ devLogLines });

    const result = await cli.run(['dev', 'logs', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      '[catalog] catalog ready\n[gateway] GET / 200\n[gateway] GET /health 200\n',
    );
    expect(calls.devLogs).toHaveLength(1);
    expect(calls.devLogs[0]).toMatchObject({ address: undefined, tail: undefined, follow: false });
  });

  test("one service's lines are printed bare, and --tail and --follow reach the operation", async () => {
    const { cli, calls } = cliWith({ devLogLines });

    const result = await cli.run([
      'dev',
      'logs',
      'gateway',
      '--tail',
      '20',
      '--follow',
      '--format',
      'human',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('GET / 200\nGET /health 200\n');
    expect(calls.devLogs[0]).toMatchObject({ address: 'gateway', tail: 20, follow: true });
    expect(calls.devLogs[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('with --json, each line is an output frame carrying its service', async () => {
    const { cli } = cliWith({ devLogLines });

    const result = await cli.run(['dev', 'logs', 'gateway', '--json']);

    const frames = result.json.filter((frame) => frame.kind === 'output');
    expect(frames).toEqual([
      expect.objectContaining({
        channel: 'data',
        line: 'GET / 200',
        data: { service: 'gateway', line: 'GET / 200' },
      }),
      expect.objectContaining({
        channel: 'data',
        line: 'GET /health 200',
        data: { service: 'gateway', line: 'GET /health 200' },
      }),
    ]);
    expect(result.json.at(-1)).toMatchObject({ kind: 'result', envelope: { ok: true } });
  });

  test('an app with no services says so on stderr and prints nothing on stdout', async () => {
    const { cli } = cliWith();

    const result = await cli.run(['dev', 'logs', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('app has no services');
  });

  test('a failure keeps its code, and its fix becomes the next action', async () => {
    const { cli } = cliWith({
      devLogs: notOk(
        new CliStructuredError(
          'DEV.NO_LOGS',
          '"catalog" is a database, and only services have logs.',
          {
            fix: 'Pass the address of a service, or no address for every service.',
          },
        ),
      ),
    });

    const result = await cli.run(['dev', 'logs', 'catalog', '--json']);

    expect(result.exitCode).not.toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: {
        ok: false,
        error: { code: 'DEV.NO_LOGS' },
        nextActions: [
          {
            kind: 'user-choice',
            label: 'Pass the address of a service, or no address for every service.',
          },
        ],
      },
    });
  });
});
