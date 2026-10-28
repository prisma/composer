/** `emulator list` through the engine, over a fake listing, and its place in the published family. */
import { describe, expect, test } from 'bun:test';
import type { EmulatorList } from '@internal/dev-emulators';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok } from '@internal/foundation/result';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createComposerFamily } from '../src/exports/family.ts';

const listing: EmulatorList = {
  emulators: [
    {
      kind: 'service',
      running: true,
      url: 'http://127.0.0.1:4300',
      instances: [
        {
          id: 'svc_0123456789abcdef',
          kind: 'service',
          url: 'http://localhost:3000',
          state: 'running',
          labels: {
            'composer.directory': '/work/shop',
            'composer.app': 'shop',
            'composer.address': 'gateway',
          },
        },
      ],
      error: null,
    },
    { kind: 'database', running: false, url: null, instances: [], error: null },
    {
      kind: 'bucket',
      running: true,
      url: 'http://127.0.0.1:4301',
      instances: [],
      error: { code: 'DEV.EMULATOR_UNREACHABLE', message: 'connection refused' },
    },
  ],
};

function cliWith(list: Parameters<typeof createComposerFamily>[0]) {
  const family = createComposerFamily(list);
  const { deploy, 'deploy list': deployList, 'emulator list': command } = family.commands;
  if (command === undefined || deploy === undefined || deployList === undefined) {
    throw new Error('no emulator list command');
  }
  return createTestCli({
    commandFamilies: [family],
    commands: { deploy, 'deploy list': deployList, 'emulator list': command },
    groups: {
      deploy: { brief: 'Deploy the app.' },
      emulator: { brief: 'The local emulators on this machine.' },
    },
  });
}

describe('emulator list', () => {
  test('the published family ships it beside the framework commands', () => {
    expect(Object.keys(createComposerFamily().commands).sort()).toEqual([
      'deploy',
      'deploy list',
      'dev',
      'dev stop',
      'dev url',
      'emulator list',
    ]);
  });

  test('returns every emulator and its instances as the JSON result, with no config', async () => {
    const cli = cliWith({ listEmulators: async () => ok(listing) });

    const result = await cli.run(['emulator', 'list', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.json.at(-1)).toMatchObject({ envelope: { ok: true, result: listing } });
  });

  test('shows each emulator and, under it, its instances with the node and directory that started them', async () => {
    const cli = cliWith({ listEmulators: async () => ok(listing) });

    const result = await cli.run(['emulator', 'list', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Service emulator at http://127.0.0.1:4300');
    expect(result.stderr).toContain('svc_0123456789abcdef');
    expect(result.stderr).toContain('gateway in /work/shop');
    expect(result.stderr).toContain('Database emulator');
    expect(result.stderr).toContain('not running');
    expect(result.stderr).toContain(
      'Bucket emulator at http://127.0.0.1:4301: could not list its instances (DEV.EMULATOR_UNREACHABLE: connection refused)',
    );
  });

  test('writes one tab-separated line per instance to stdout: emulator kind, id, URL, state, node address and directory, a tab inside a field escaped', async () => {
    const cli = cliWith({
      listEmulators: async () =>
        ok({
          emulators: [
            ...listing.emulators.slice(0, 1),
            {
              kind: 'database',
              running: true,
              url: 'http://127.0.0.1:4302',
              instances: [
                {
                  id: 'db_0123456789abcdef',
                  kind: 'database',
                  url: 'postgres://postgres:postgres@localhost:51300/template1?sslmode=disable',
                  state: 'stopped',
                  labels: {
                    'composer.directory': '/work/shop\tlab',
                    'composer.app': 'shop',
                    'composer.address': 'catalog',
                  },
                },
              ],
              error: null,
            },
            {
              kind: 'bucket',
              running: true,
              url: 'http://127.0.0.1:4301',
              instances: [
                {
                  id: 'bkt-0123456789abcdef',
                  kind: 'bucket',
                  url: 'http://127.0.0.1:4301/bkt-0123456789abcdef',
                  state: 'running',
                  labels: {},
                },
              ],
              error: null,
            },
          ],
        }),
    });

    const result = await cli.run(['emulator', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'service\tsvc_0123456789abcdef\thttp://localhost:3000\trunning\tgateway\t/work/shop\n' +
        'database\tdb_0123456789abcdef\tpostgres://postgres:postgres@localhost:51300/template1?sslmode=disable\tstopped\tcatalog\t/work/shop\\tlab\n' +
        'bucket\tbkt-0123456789abcdef\thttp://127.0.0.1:4301/bkt-0123456789abcdef\trunning\t\t\n',
    );
  });

  test('writes nothing to stdout when no instance exists', async () => {
    const cli = cliWith({
      listEmulators: async () =>
        ok({
          emulators: listing.emulators.map((emulator) => ({ ...emulator, instances: [] })),
        }),
    });

    const result = await cli.run(['emulator', 'list', '--format', 'human']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('a failure keeps its code', async () => {
    const cli = cliWith({
      listEmulators: async () =>
        notOk(
          new CliStructuredError('DEV.EMULATORS_DIR_INVALID', 'not absolute', {
            fix: 'Set it to an absolute path.',
          }),
        ),
    });

    const result = await cli.run(['emulator', 'list', '--json']);

    expect(result.exitCode).not.toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: { ok: false, error: { code: 'DEV.EMULATORS_DIR_INVALID' } },
    });
  });
});
