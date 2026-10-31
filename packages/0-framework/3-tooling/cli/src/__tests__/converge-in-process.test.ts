/**
 * The in-process converge against Alchemy's real plan and apply engine, with
 * an in-memory state store and a fake extension whose one resource node
 * creates nothing on any platform.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Contract, module, resource } from '@internal/core';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import { type DeploymentResult, type LowerOptions, lower } from '@internal/core/deploy';
import * as Alchemist from 'alchemy/Alchemist';
import * as Interaction from 'alchemy/Interaction';
import * as State from 'alchemy/State';
import { InMemoryService } from 'alchemy/State/InMemoryState';
import * as Cause from 'effect/Cause';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  type ConvergeEvent,
  type ConvergeRequest,
  convergeInProcess,
  failureReasons,
  toConvergeEvent,
} from '../converge-in-process.ts';
import { deployWithDeps } from '../operations/deploy.ts';

const thingContract: Contract<'fake/thing', unknown> = Object.freeze({
  kind: 'fake/thing',
  __cmp: {},
  satisfies: (required: Contract<'fake/thing', unknown>) => required.kind === 'fake/thing',
});

const app = () =>
  module('shop', {}, (h) => {
    h.provision(resource({ name: 'thing', extension: 'test/pack', provides: thingContract }), {
      id: 'thing',
    });
    return {};
  });

interface Fixture {
  readonly config: PrismaAppConfig;
  /** True once the state store's scope has closed, which is when a remote store releases its lease. */
  readonly released: () => boolean;
}

function fixture(lowerThing: ExtensionDescriptor['nodes'][string]): Fixture {
  let released = false;
  const state = Layer.effect(
    State.State,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released = true;
        }),
      );
      return InMemoryService({});
    }),
  );
  const extension: ExtensionDescriptor = { id: 'test/pack', nodes: { 'fake/thing': lowerThing } };
  return {
    config: { extensions: [extension], state: { extension: 'test/pack', create: () => state } },
    released: () => released,
  };
}

const reportsThing = Object.assign(
  () =>
    Effect.succeed({
      outputs: {},
      entities: [{ kind: 'thing', id: 'thing-1', url: 'https://thing.example' }],
    }),
  { kind: 'resource' as const },
);

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-converge-')));
}

function request(
  config: PrismaAppConfig,
  extra: Partial<LowerOptions> = {},
  overrides: Partial<ConvergeRequest> = {},
): ConvergeRequest {
  return {
    operation: 'deploy',
    stack: lower(app(), config, {
      name: 'shop',
      bundles: {},
      containers: new Map(),
      preflight: new Map(),
      ...extra,
    }),
    stage: 'test',
    cwd: tmpDir(),
    env: {},
    ...overrides,
  };
}

describe('convergeInProcess', () => {
  test('plans and applies in this process, and the report hook hands back the deployment as a value', async () => {
    const { config, released } = fixture(reportsThing);
    let reported: DeploymentResult | undefined;
    const events: ConvergeEvent[] = [];

    const outcome = await convergeInProcess(
      request(
        config,
        {
          report: (result) => {
            reported = result;
          },
        },
        { onEvent: (event) => events.push(event) },
      ),
    );

    expect(outcome).toEqual({ kind: 'applied' });
    expect(reported?.nodes.map((node) => [node.address, node.entities])).toEqual([
      ['shop.thing', [{ kind: 'thing', id: 'thing-1', url: 'https://thing.example' }]],
    ]);
    expect(released()).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'resource',
        fqn: 'composer-deployment-report',
        phase: 'done',
      }),
    );
  });

  const observing = (
    seen: { token?: string | undefined; cwd?: string },
    end: Effect.Effect<never, unknown> | undefined,
  ) =>
    fixture(
      Object.assign(
        () =>
          Effect.sync(() => {
            seen.token = process.env['COMPOSER_TEST_TOKEN'];
            seen.cwd = process.cwd();
          }).pipe(Effect.andThen(end ?? Effect.succeed({ outputs: {}, entities: [] }))),
        { kind: 'resource' as const },
      ),
    );

  test('restores the environment and working directory after a failed or interrupted run, and when it cannot change directory', async () => {
    const before = process.cwd();
    process.env['COMPOSER_TEST_KEEP'] = 'shell';
    const env = { COMPOSER_TEST_TOKEN: 'tok', COMPOSER_TEST_KEEP: undefined };
    const controller = new AbortController();
    const failedSeen: { token?: string | undefined; cwd?: string } = {};
    const failing = observing(
      failedSeen,
      Effect.fail(new Error('no')) as Effect.Effect<never, unknown>,
    );
    const interrupting = observing(
      {},
      Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.never)),
    );
    const cwd = tmpDir();

    const failed = await convergeInProcess(request(failing.config, {}, { cwd, env }));
    const interrupted = await convergeInProcess(
      request(interrupting.config, {}, { cwd, env, signal: controller.signal }),
    );
    const missingDir = await convergeInProcess(
      request(failing.config, {}, { cwd: path.join(cwd, 'gone'), env }),
    );

    expect(failedSeen).toEqual({ token: 'tok', cwd });
    expect(failed.kind).toBe('failed');
    expect(interrupted.kind).toBe('interrupted');
    expect(missingDir.kind).toBe('failed');
    expect(process.env['COMPOSER_TEST_TOKEN']).toBeUndefined();
    expect(process.env['COMPOSER_TEST_KEEP']).toBe('shell');
    expect(process.cwd()).toBe(before);
    delete process.env['COMPOSER_TEST_KEEP'];
  });

  test('refuses a second converge while one runs, and runs again once it ends', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { config } = observing(
      {},
      Effect.sync(() => started()).pipe(Effect.andThen(Effect.never)),
    );

    const first = convergeInProcess(request(config, {}, { signal: controller.signal }));
    await running;
    const second = await convergeInProcess(request(fixture(reportsThing).config));
    controller.abort();
    await first;
    const third = await convergeInProcess(request(fixture(reportsThing).config));

    expect(second).toEqual({ kind: 'refused', reason: 'already-running' });
    expect(third).toEqual({ kind: 'applied' });
  });

  test("Alchemy's interaction output goes to stderr, never stdout", async () => {
    const { config } = fixture(
      Object.assign(
        () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction.Interaction;
            yield* interaction.output.info('state store bootstrapped');
            return { outputs: {}, entities: [] };
          }),
        { kind: 'resource' as const },
      ),
    );
    const stdout = spyOn(process.stdout, 'write');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await convergeInProcess(request(config))).toEqual({ kind: 'applied' });
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
        'state store bootstrapped',
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  test('one converge per process holds across two copies of the module', async () => {
    const copy: typeof import('../converge-in-process.ts') = await import(
      `../converge-in-process.ts?copy=${String(Date.now())}`
    );
    expect(copy.convergeInProcess).not.toBe(convergeInProcess);
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { config } = observing(
      {},
      Effect.sync(() => started()).pipe(Effect.andThen(Effect.never)),
    );

    const first = convergeInProcess(request(config, {}, { signal: controller.signal }));
    await running;
    const second = await copy.convergeInProcess(request(fixture(reportsThing).config));
    controller.abort();
    await first;

    expect(second).toEqual({ kind: 'refused', reason: 'already-running' });
  });

  test('restores the environment even when the working directory cannot be restored', async () => {
    const before = process.cwd();
    const doomed = tmpDir();
    process.chdir(doomed);
    const cwd = tmpDir();
    const { config } = fixture(
      Object.assign(
        () =>
          Effect.sync(() => {
            fs.rmSync(doomed, { recursive: true, force: true });
            return { outputs: {}, entities: [] };
          }),
        { kind: 'resource' as const },
      ),
    );
    try {
      const outcome = await convergeInProcess(
        request(config, {}, { cwd, env: { COMPOSER_TEST_TOKEN: 'tok' } }),
      );

      expect(outcome.kind).toBe('failed');
      expect(process.env['COMPOSER_TEST_TOKEN']).toBeUndefined();
    } finally {
      process.chdir(before);
    }
    expect(await convergeInProcess(request(fixture(reportsThing).config))).toEqual({
      kind: 'applied',
    });
  });

  test('a converge whose Alchemy services cannot be built fails, and leaves the next one free to run', async () => {
    const layer = spyOn(Alchemist, 'layer').mockImplementation(() => {
      throw new Error('alchemy without Alchemist.layer');
    });
    let outcome: Awaited<ReturnType<typeof convergeInProcess>>;
    try {
      outcome = await convergeInProcess(request(fixture(reportsThing).config));
    } finally {
      layer.mockRestore();
    }

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [{ tag: 'Error', message: 'alchemy without Alchemist.layer' }],
    });
    expect(await convergeInProcess(request(fixture(reportsThing).config))).toEqual({
      kind: 'applied',
    });
  });

  test('sets the requested environment and working directory only while it runs', async () => {
    const seen: { token?: string | undefined; cwd?: string } = {};
    const { config } = fixture(
      Object.assign(
        () =>
          Effect.sync(() => {
            seen.token = process.env['COMPOSER_TEST_TOKEN'];
            seen.cwd = process.cwd();
            return { outputs: {}, entities: [] };
          }),
        { kind: 'resource' as const },
      ),
    );
    const cwd = tmpDir();
    const before = process.cwd();

    await convergeInProcess(request(config, {}, { cwd, env: { COMPOSER_TEST_TOKEN: 'tok' } }));

    expect(seen).toEqual({ token: 'tok', cwd });
    expect(process.env['COMPOSER_TEST_TOKEN']).toBeUndefined();
    expect(process.cwd()).toBe(before);
  });

  test('a failing resource comes back as a failed outcome naming the error', async () => {
    class ThingRefused extends Data.TaggedError('ThingRefused')<{ readonly message: string }> {}
    const { config, released } = fixture(
      Object.assign(() => Effect.fail(new ThingRefused({ message: 'the platform said no' })), {
        kind: 'resource' as const,
      }),
    );

    const outcome = await convergeInProcess(request(config));

    expect(outcome).toEqual({
      kind: 'failed',
      reasons: [{ tag: 'ThingRefused', message: 'the platform said no' }],
    });
    expect(released()).toBe(true);
  });

  test('an abort interrupts the plan, and the state store scope still closes', async () => {
    const controller = new AbortController();
    const { config, released } = fixture(
      Object.assign(
        () =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(Effect.never),
          ) as Effect.Effect<never>,
        { kind: 'resource' as const },
      ),
    );

    const outcome = await convergeInProcess(request(config, {}, { signal: controller.signal }));

    expect(outcome).toEqual({ kind: 'interrupted' });
    expect(released()).toBe(true);
  });
});

const coreIndex = path.resolve(import.meta.dir, '../../../../1-core/core/src/exports/index.ts');

describe('deploy with the real in-process converge', () => {
  test('returns the summary as a value, writes no stack file and needs no alchemy bin', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'prisma.config.ts'), 'export default {};\n');
    const entry = path.join(dir, 'module.ts');
    fs.writeFileSync(
      entry,
      [
        `import { module, service } from ${JSON.stringify(coreIndex)};`,
        "export default module('shop', {}, (h) => {",
        '  h.provision(',
        "    service({ name: 'api', extension: 'test/pack', type: 'fake/service', inputs: {}, params: {},",
        "      build: { extension: 'test/build', type: 'node', module: import.meta.url, entry: 'server.js' } }),",
        "    { id: 'api' },",
        '  );',
        '  return {};',
        '});',
        '',
      ].join('\n'),
    );
    const config: PrismaAppConfig = {
      extensions: [
        {
          id: 'test/pack',
          nodes: {
            'fake/service': {
              kind: 'service',
              provision: () => Effect.succeed(undefined),
              serialize: () => Effect.succeed(undefined),
              package: () => Effect.succeed({ path: 'artifact.tgz', sha256: 'none' }),
              deploy: () =>
                Effect.succeed({
                  outputs: {},
                  entities: [{ kind: 'service', id: 'svc-1', url: 'https://api.example' }],
                }),
            },
          },
        },
        {
          id: 'test/build',
          nodes: {
            node: {
              kind: 'build',
              assemble: () => {
                throw new Error('the test assembler stands in');
              },
            },
          },
        },
      ],
      state: fixture(reportsThing).config.state,
    };

    const result = await deployWithDeps(
      {
        config: { value: config, file: path.join(dir, 'prisma.config.ts') },
        entry,
        environment: 'test',
        cwd: dir,
      },
      {
        runAssembler: async () => ({ dir, entry: 'server.js' }),
        converge: { lower, converge: convergeInProcess },
        credentials: { workspaceId: 'ws_1', client: {}, serviceToken: 'tok' },
      },
    );

    if (!result.ok) throw result.failure;
    expect(result.value.summary).toEqual({
      app: 'shop',
      nodes: [
        {
          address: 'shop.api',
          entities: [{ kind: 'service', id: 'svc-1', url: 'https://api.example' }],
        },
      ],
    });
    expect(fs.existsSync(path.join(dir, '.prisma-composer', 'alchemy.run.ts'))).toBe(false);
  });
});

describe('toConvergeEvent', () => {
  const status = (value: string) =>
    toConvergeEvent({
      type: 'apply.resource.status',
      fqn: 'shop.api',
      id: 'api',
      resourceType: 'Prisma.Deployment',
      status: value as never,
    });

  test("a resource's status becomes a phase: pending, running, done or failed", () => {
    expect(status('pending')).toMatchObject({ phase: 'pending' });
    expect(status('creating')).toMatchObject({ phase: 'running', status: 'creating' });
    expect(status('replacing')).toMatchObject({ phase: 'running' });
    expect(status('created')).toMatchObject({ phase: 'done', fqn: 'shop.api' });
    expect(status('skipped')).toMatchObject({ phase: 'done' });
    expect(status('fail')).toMatchObject({ phase: 'failed' });
  });

  test('a note becomes a log line, and plan progress is not shown', () => {
    expect(
      toConvergeEvent({ type: 'apply.resource.note', fqn: 'shop.api', id: 'api', message: 'hi' }),
    ).toEqual({ kind: 'log', severity: 'info', text: 'shop.api: hi' });
    expect(
      toConvergeEvent({
        type: 'apply.resource.note',
        fqn: 'shop.api',
        id: 'api',
        message: 'npm ci',
        kind: 'output',
      }),
    ).toMatchObject({ severity: 'verbose' });
    expect(toConvergeEvent({ type: 'plan.phase', phase: 'computing-plan' })).toBeUndefined();
  });
});

describe('failureReasons', () => {
  test('one reason per distinct error, each with its tag', () => {
    class Refused extends Data.TaggedError('Refused')<{ readonly message: string }> {}
    const cause = Cause.combine(
      Cause.fail(new Refused({ message: 'quota exceeded' })),
      Cause.combine(
        Cause.die(new Error('boom')),
        Cause.fail(new Refused({ message: 'quota exceeded' })),
      ),
    );

    expect(failureReasons(cause)).toEqual([
      { tag: 'Refused', message: 'quota exceeded' },
      { tag: 'Error', message: 'boom' },
    ]);
  });

  test('a non-error failure is kept as text', () => {
    expect(failureReasons(Cause.fail('plain'))).toEqual([{ tag: 'Unknown', message: 'plain' }]);
  });
});
