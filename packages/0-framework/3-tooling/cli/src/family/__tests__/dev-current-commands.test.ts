/**
 * `dev url` and `dev stop` through the engine, over the operations double:
 * the URL as the human data line, the JSON results, and failures carrying
 * their code and fix.
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
