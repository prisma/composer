/**
 * The in-process converge against Alchemy's real plan and apply engine, with
 * an in-memory state store and a fake extension whose one resource node
 * creates nothing on any platform.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Contract, module, resource } from '@internal/core';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import { type DeploymentResult, type LowerOptions, lower } from '@internal/core/deploy';
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
  failureText,
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
    stack: lower(app(), config, { name: 'shop', bundles: {}, ...extra }),
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

    expect(outcome).toEqual({ kind: 'failed', cause: 'ThingRefused: the platform said no' });
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
      { runAssembler: async () => ({ dir, entry: 'server.js' }) },
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

describe('failureText', () => {
  test('one line per distinct error, each with its tag', () => {
    class Refused extends Data.TaggedError('Refused')<{ readonly message: string }> {}
    const cause = Cause.combine(
      Cause.fail(new Refused({ message: 'quota exceeded' })),
      Cause.combine(
        Cause.die(new Error('boom')),
        Cause.fail(new Refused({ message: 'quota exceeded' })),
      ),
    );

    expect(failureText(cause)).toBe('Refused: quota exceeded\nboom');
  });

  test('a non-error failure is printed as text', () => {
    expect(failureText(Cause.fail('plain'))).toBe('plain');
  });
});
