/**
 * `deploy` driven end to end through the engine — real grammar, real
 * argument validation, the real credential check, the real settlement rules —
 * with the published operations double standing in for alchemy.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok } from '@internal/foundation/result';
import type { TestCli } from '@prisma/cli-engine/testing';
import { createTestCli, mintTestJwt } from '@prisma/cli-engine/testing';
import { createOperationsDouble, type OperationsDouble } from '../../testing/operations-double.ts';
import { createComposerFamily } from '../family.ts';
import { commandAt } from './command-at.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

type Fixtures = Parameters<typeof createOperationsDouble>[0];

const CWD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-family-')));

/** A credential that is signed in and nowhere near expiry. */
function activeCredential(workspaceId = 'ws_1') {
  return {
    token: mintTestJwt({
      sub: 'user_1',
      workspace_id: workspaceId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refreshToken: undefined,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

interface Harness {
  readonly cli: TestCli;
  readonly double: OperationsDouble;
}

/** Composer's family mounted at the top level of a test CLI, as the `prisma` host mounts it. */
function composerCli(
  spec: {
    readonly fixtures?: Fixtures;
    /** How the run is signed in: a service token in the environment (the default), a `prisma login` session, or not at all. */
    readonly signedIn?: 'environment' | 'session' | 'both' | false;
  } = {},
): Harness {
  const double = createOperationsDouble(spec.fixtures ?? {});
  const family = createComposerFamily({ operations: double.operations });
  const cli = createTestCli({
    commandFamilies: [family],
    // The two product verbs, at the root. `dev url` and `dev stop` mount
    // beneath `dev`, which needs an engine that lets a command also be a
    // group; their own tests mount them alone.
    commands: { deploy: commandAt(family, 'deploy'), dev: commandAt(family, 'dev') },
    config: { composer: validComposerSection() },
    ...(spec.signedIn === false
      ? {}
      : spec.signedIn === 'session'
        ? { credential: activeCredential() }
        : spec.signedIn === 'both'
          ? {
              credential: activeCredential('ws_session'),
              environmentCredential: activeCredential('ws_env'),
            }
          : { environmentCredential: activeCredential() }),
  });
  return { cli, double };
}

/** Human-rendered output is what a user in a terminal sees; the framing is the json mode's business. */
const AS_TTY = { isTty: { stdout: true, stderr: true }, cwd: CWD } as const;

/** A real terminal gets styled output; the assertions here are about the words, not the escape codes. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

describe('argument validation', () => {
  test('a leftover positional entry is refused by the grammar and never reaches the handler', async () => {
    for (const command of ['deploy', 'dev']) {
      const { cli, double } = composerCli();
      const result = await cli.run([command, 'module.ts'], AS_TTY);

      expect(result.exitCode).toBe(2);
      expect(plain(result.stderr)).toContain(
        '[CLI.INVALID_ARGUMENTS] Too many arguments, expected 0 but encountered "module.ts"',
      );
      expect(double.calls.deploy).toEqual([]);
      expect(double.calls.dev).toEqual([]);
    }
  });

  test('deploy without --entry leaves the entry to the config', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(double.calls.deploy[0]?.entry).toBeUndefined();
  });

  test('an unknown flag is refused, naming the flag', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy', '--entry', 'src/service.ts', '--nope'], AS_TTY);

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
    const result = await cli.run(['deploy', '--entry', 'src/service.ts', '--production'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('--production');
  });

  test('without --environment, deploy targets production', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(double.calls.deploy[0]?.environment).toBe('production');
  });

  test('--stage is retired: the run fails with CLI.COMMAND_MOVED naming --environment', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(
      ['deploy', '--entry', 'src/service.ts', '--stage', 'staging', '--json'],
      AS_TTY,
    );

    expect(result.exitCode).toBe(2);
    const last = result.json.at(-1);
    if (last?.kind !== 'result' || last.envelope.ok) throw new Error('expected an errored result');
    expect(last.envelope.error.code).toBe('CLI.COMMAND_MOVED');
    expect(last.envelope.error.summary).toBe('`--stage` on `deploy` has been replaced');
    expect(last.envelope.nextActions).toEqual([
      expect.objectContaining({ command: expect.stringContaining('deploy --environment <name>') }),
    ]);
    expect(double.calls.deploy).toEqual([]);
  });

  test('deploy passes entry, --name and --environment through to the operation verbatim', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(
      ['deploy', '--entry', 'src/service.ts', '--name', 'shop', '--environment', 'feat-auth'],
      AS_TTY,
    );

    expect(result.exitCode).toBe(0);
    expect(double.calls.deploy).toEqual([
      {
        entry: 'src/service.ts',
        config: {
          value: {
            extensions: [{ id: 'ext-a', nodes: {} }],
            state: { extension: 'ext-a', create: expect.any(Function) },
          },
          file: path.join(CWD, 'prisma.config.ts'),
        },
        name: 'shop',
        environment: 'feat-auth',
        cwd: CWD,
        onEvent: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    ]);
  });
});

/** `--json` runs the command, and the terminal frame on stdout is the machine surface. */
describe('--json', () => {
  for (const argv of [['deploy', '--entry', 'src/service.ts']]) {
    test(`\`${argv[0]} --json\` runs and emits one result frame`, async () => {
      const { cli, double } = composerCli();
      const result = await cli.run([...argv, '--json'], AS_TTY);

      expect(result.exitCode).toBe(0);
      expect(double.calls.deploy).toHaveLength(1);
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
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('CLI.CREDENTIALS_REQUIRED');
    expect(double.calls.deploy).toEqual([]);
  });

  test('a `prisma login` session reaches the operation with no service token, so the operation refuses it', async () => {
    const { cli, double } = composerCli({ signedIn: 'session' });
    await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    const credentials = double.calls.deps.deploy[0]?.credentials;
    expect(credentials?.workspaceId).toBe('ws_1');
    expect(credentials?.serviceToken).toBeUndefined();
  });

  /**
   * Alchemy runs in this process and reads its credential from
   * `process.env`, so the handler hands the operation the environment token
   * and that token's workspace, for the operation to set there for the apply.
   */
  test('an environment token reaches the operation with its own workspace, and no child is spawned', async () => {
    const { cli, double } = composerCli();
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(result.spawns).toEqual([]);
    const credentials = double.calls.deps.deploy[0]?.credentials;
    expect(credentials?.serviceToken).toEqual(expect.any(String));
    expect(credentials?.workspaceId).toBe('ws_1');
    expect(double.calls.deploy[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('with both a session and an environment token, the token and the workspace come from one credential', async () => {
    const { cli, double } = composerCli({ signedIn: 'both' });
    await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    const credentials = double.calls.deps.deploy[0]?.credentials;
    expect(
      credentials?.serviceToken === undefined
        ? credentials?.workspaceId
        : `${credentials.workspaceId} with a token`,
    ).toBeOneOf(['ws_session', 'ws_env with a token']);
  });

  test("a provider's console.log during the operation goes to stderr, and console is restored after", async () => {
    const log = console.log;
    const stdoutWrite = spyOn(process.stdout, 'write');
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const operations = createOperationsDouble({});
    const deploy = operations.operations.deploy;
    try {
      const family = createComposerFamily({
        operations: {
          ...operations.operations,
          deploy: async (input, deps) => {
            console.log('provider chatter');
            console.table([{ a: 1 }]);
            return deploy(input, deps);
          },
        },
      });
      const probe = createTestCli({
        commands: { deploy: commandAt(family, 'deploy') },
        config: { composer: validComposerSection() },
        environmentCredential: activeCredential(),
      });
      await probe.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(consoleError.mock.calls.map((call) => call[0])).toContain('provider chatter');
    } finally {
      stdoutWrite.mockRestore();
      consoleError.mockRestore();
    }
    expect(console.log).toBe(log);
  });
});

describe('settlement', () => {
  test('a failed converge renders the normal envelope and exits 2', async () => {
    const { cli } = composerCli({
      fixtures: {
        deploy: notOk(
          new CliStructuredError(
            'DEPLOY.ENGINE_FAILED',
            'Alchemy could not deploy the app.\nPrismaApiError: quota exceeded',
          ),
        ),
      },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(2);
    expect(plain(result.stderr)).toContain('DEPLOY.ENGINE_FAILED');
    expect(plain(result.stderr)).toContain('PrismaApiError: quota exceeded');
    expect(plain(result.stderr)).not.toContain('to reproduce this');
  });

  /**
   * A structured failure gets the ordinary envelope — and composer's `fix` prose has to survive
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
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

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
          durationMs: 575_000,
        }),
      },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(plain(result.stderr)).toContain('Deployed shop to production in 9m 35s.');
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
      durationMs: 575_000,
    });
  });

  test('piped, prints one line per deployed entity: address, kind, id and URL, and none for a node without entities', async () => {
    const { cli } = composerCli({
      fixtures: {
        deploy: ok({
          summary: {
            app: 'shop',
            nodes: [
              {
                address: 'catalog.service',
                entities: [
                  {
                    kind: 'compute-service',
                    id: 'svc_1',
                    url: 'https://catalog.example.com',
                  },
                ],
              },
              {
                address: 'catalog.database',
                entities: [{ kind: 'postgres-database', id: 'db_1' }],
              },
              { address: 'catalog.credentials', entities: [] },
            ],
          },
          durationMs: 575_000,
        }),
      },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'catalog.service\tcompute-service\tsvc_1\thttps://catalog.example.com\n' +
        'catalog.database\tpostgres-database\tdb_1\t\n',
    );
  });

  test('a deploy whose child wrote no report still reports success', async () => {
    const { cli } = composerCli({
      fixtures: { deploy: ok({ summary: undefined, durationMs: 850 }) },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(plain(result.stderr)).toContain('Deployed to production in 850ms.');
    expect(result.presented?.data).toEqual({ summary: null, durationMs: 850 });
  });

  test('piped, a deploy whose child wrote no report prints no data lines', async () => {
    const { cli } = composerCli({
      fixtures: { deploy: ok({ summary: undefined, durationMs: 850 }) },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('step events', () => {
  const deployEvents: NonNullable<Fixtures>['deployEvents'] = [
    { kind: 'step-started', step: { name: 'assemble' } },
    { kind: 'step-started', step: { name: 'assemble-service', address: 'console' } },
    {
      kind: 'step-finished',
      step: { name: 'assemble-service', address: 'console' },
      outcome: 'ok',
      durationMs: 221_780,
      data: { strategy: 'traced', filesTraced: 975 },
    },
    { kind: 'step-finished', step: { name: 'assemble' }, outcome: 'ok', durationMs: 222_380 },
    { kind: 'step-started', step: { name: 'preflight' } },
    {
      kind: 'step-finished',
      step: { name: 'preflight' },
      outcome: 'ok',
      durationMs: 38_170,
      data: { checked: 53, filled: 0, missing: 0 },
    },
    { kind: 'step-started', step: { name: 'record' } },
    { kind: 'step-finished', step: { name: 'record' }, outcome: 'failed', durationMs: 850 },
  ];
  const deploy = ok({
    summary: {
      app: 'shop',
      nodes: [
        {
          address: 'console',
          entities: [
            { kind: 'compute-service', id: 'cps_1', url: 'https://console.ewr.prisma.build' },
          ],
        },
        { address: 'db', entities: [{ kind: 'postgres', id: 'db_1' }] },
      ],
    },
    durationMs: 12_300,
  });

  test('a person sees each step start and finish with its duration, then the URLs and the total', async () => {
    const { cli } = composerCli({ fixtures: { deploy, deployEvents } });
    const result = await cli.run(
      ['deploy', '--entry', 'src/service.ts', '--environment', 'pr-7'],
      AS_TTY,
    );

    expect(result.exitCode).toBe(0);
    const lines = plain(result.stderr).split('\n');
    const expected = [
      '▸ assemble services',
      '▸ assemble console',
      '✔ assemble console (3m 42s)',
      '✔ assemble services (3m 42s)',
      '▸ check environment variables',
      '✔ check environment variables (38.2s)',
      '▸ record result',
      '✘ record result (850ms)',
      'console: https://console.ewr.prisma.build',
    ];
    expect(lines.filter((line) => expected.includes(line))).toEqual(expected);
    expect(plain(result.stderr)).toContain('Deployed shop to pr-7 in 12.3s.');
  });

  test("each resource Alchemy applies is a step under apply, and Alchemy's log lines are messages", async () => {
    const step = {
      name: 'apply-resource',
      fqn: 'shop.api',
      resourceType: 'Prisma.Deployment',
    } as const;
    const { cli } = composerCli({
      fixtures: {
        deploy,
        deployEvents: [
          { kind: 'step-started', step: { name: 'apply' } },
          { kind: 'step-started', step: { ...step, status: 'creating' } },
          { kind: 'message', severity: 'info', text: 'shop.api: uploading 3 files' },
          {
            kind: 'step-finished',
            step: { ...step, status: 'created' },
            outcome: 'ok',
            durationMs: 1_200,
          },
        ],
      },
    });
    const human = await cli.run(['deploy', '--entry', 'src/service.ts'], AS_TTY);
    const json = await composerCli({
      fixtures: {
        deploy,
        deployEvents: [{ kind: 'step-started', step: { ...step, status: 'creating' } }],
      },
    }).cli.run(['deploy', '--entry', 'src/service.ts', '--json'], AS_TTY);

    const lines = plain(human.stderr).split('\n');
    expect(lines).toContain('▸ creating shop.api');
    expect(lines).toContain('shop.api: uploading 3 files');
    expect(lines).toContain('✔ created shop.api (1.2s)');
    expect(json.json[0]).toMatchObject({
      kind: 'step-started',
      step: 'creating shop.api',
      id: 'deploy.apply.shop.api',
      parentId: 'deploy.apply',
      data: { resourceType: 'Prisma.Deployment' },
    });
  });

  test("a finished step's durationMs is the measured one, even when the adapter reported its own", async () => {
    const { cli } = composerCli({
      fixtures: {
        deploy,
        deployEvents: [
          { kind: 'step-started', step: { name: 'assemble-service', address: 'console' } },
          {
            kind: 'step-finished',
            step: { name: 'assemble-service', address: 'console' },
            outcome: 'ok',
            durationMs: 500,
            data: { durationMs: 1, filesTraced: 3 },
          },
        ],
      },
    });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts', '--json'], AS_TTY);

    expect(result.json[1]).toMatchObject({ data: { durationMs: 500, filesTraced: 3 } });
  });

  test('json mode streams each step with its id, parent and data, then the endpoints and the result', async () => {
    const { cli } = composerCli({ fixtures: { deploy, deployEvents } });
    const result = await cli.run(['deploy', '--entry', 'src/service.ts', '--json'], AS_TTY);

    expect(result.exitCode).toBe(0);
    expect(result.json.map((frame) => frame.kind)).toEqual([
      'step-started',
      'step-started',
      'step-finished',
      'step-finished',
      'step-started',
      'step-finished',
      'step-started',
      'step-finished',
      'endpoint',
      'result',
    ]);
    expect(result.json[1]).toMatchObject({
      kind: 'step-started',
      step: 'assemble console',
      id: 'deploy.assemble.console',
      parentId: 'deploy.assemble',
    });
    expect(result.json[2]).toMatchObject({
      kind: 'step-finished',
      id: 'deploy.assemble.console',
      outcome: 'ok',
      data: { durationMs: 221_780, strategy: 'traced', filesTraced: 975 },
    });
    expect(result.json[5]).toMatchObject({
      id: 'deploy.preflight',
      data: { durationMs: 38_170, checked: 53, filled: 0, missing: 0 },
    });
    expect(result.json[8]).toMatchObject({
      kind: 'endpoint',
      name: 'console',
      url: 'https://console.ewr.prisma.build',
    });
    expect(result.json[9]).toMatchObject({
      kind: 'result',
      envelope: { ok: true, result: { summary: { app: 'shop' }, durationMs: 12_300 } },
    });
  });
});
