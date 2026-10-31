/**
 * Drives the programmatic operations (deploy/destroy/log) end to end with the
 * same fakes run.test.ts uses at the RunDeps seams — no argv, no console, no
 * exit codes. Every operation call runs inside `silently()`, which fails the
 * test if the operation itself writes to the console: rendering belongs to
 * the host.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceNode } from '@internal/core';
import type {
  ContainerDescriptor,
  ContainerInstance,
  ExtensionDescriptor,
  LocateContainerInput,
  PrismaAppConfig,
  RunOutcome,
} from '@internal/core/config';
import type {
  LocalTargetAttachment,
  LocalTargetCurrentApp,
  LocalTargetDescriptor,
} from '@internal/core/local-target';
import { CliStructuredError } from '@internal/foundation/errors';
import * as Layer from 'effect/Layer';
import type { ComposerConfigSource } from '../../composer-config.ts';
import { dotenv } from '../../config-adapters.ts';
import type { Converge, ConvergeOutcome, ConvergeRequest } from '../../converge-in-process.ts';
import { DEPLOYMENT_RESULT_FILE_ENV, engineFailureFilePath } from '../../deployment-summary.ts';
import type { AppIdentity } from '../../pipeline.ts';
import { RUN_REPORT_VERSION } from '../../run-report.ts';
import { type DeployEvent, deployWithDeps } from '../deploy.ts';
import { type DestroyInput, destroyWithDeps } from '../destroy.ts';
import { type DevEvent, devWithDeps } from '../dev.ts';
import { devStop, devUrl } from '../dev-current.ts';
import { LOG_QUEUE_LIMIT } from '../execute-log.ts';
import { type LogLine, logWithDeps } from '../log.ts';
import { executionDiagnostics, executorLoadFailure } from '../shared.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs an operation and asserts it wrote NOTHING to the console — structured results only. */
async function silently<T>(run: () => Promise<T>): Promise<T> {
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  let calls = 0;
  try {
    return await run();
  } finally {
    calls = logSpy.mock.calls.length + errorSpy.mock.calls.length + warnSpy.mock.calls.length;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    expect(calls).toBe(0);
  }
}

const unused = () => {
  throw new Error('descriptor body must not run inside an operation — only coverage is checked');
};

interface ContainerCall {
  readonly op: 'ensure' | 'locate' | 'remove';
  readonly input: LocateContainerInput;
}

function makeFakeContainer(input: LocateContainerInput, alchemyStage?: string): ContainerInstance {
  return {
    input,
    ...(alchemyStage !== undefined ? { alchemyStage } : {}),
    serialize: () => JSON.stringify({ input }),
  };
}

function fakeContainerDescriptor(
  opts: {
    readonly calls?: ContainerCall[];
    readonly notFound?: boolean;
    readonly onRemove?: () => void;
    readonly alchemyStage?: string;
  } = {},
): ContainerDescriptor {
  const calls = opts.calls ?? [];
  return {
    ensure: async (input) => {
      calls.push({ op: 'ensure', input });
      return makeFakeContainer(input, opts.alchemyStage);
    },
    locate: async (input) => {
      calls.push({ op: 'locate', input });
      if (opts.notFound === true) return undefined;
      return makeFakeContainer(input, opts.alchemyStage);
    },
    remove: async (instance) => {
      calls.push({ op: 'remove', input: instance.input });
      opts.onRemove?.();
    },
    deserialize: (serialized) => {
      const parsed = JSON.parse(serialized) as { input: LocateContainerInput };
      return makeFakeContainer(parsed.input);
    },
  };
}

function fakeConfig(
  hooks: Partial<Pick<ExtensionDescriptor, 'teardown' | 'preflight' | 'reporter'>> = {},
  containerOpts: Parameters<typeof fakeContainerDescriptor>[0] = {},
): PrismaAppConfig {
  return {
    extensions: [
      {
        id: 'fixture-extension',
        nodes: {
          'fixture/compute': {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
        container: fakeContainerDescriptor(containerOpts),
        ...(hooks.teardown !== undefined ? { teardown: hooks.teardown } : {}),
        ...(hooks.preflight !== undefined ? { preflight: hooks.preflight } : {}),
        ...(hooks.reporter !== undefined ? { reporter: hooks.reporter } : {}),
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: unused } } },
    ],
    // lower() builds the stack value eagerly; nothing here ever plans it.
    state: { extension: 'fixture-extension', create: () => Layer.empty as never },
  };
}

/** The config input an operation takes; `makeAppDir` writes the file, which these tests never evaluate. */
function composerConfig(value: PrismaAppConfig): ComposerConfigSource {
  return { value, file: 'prisma.config.ts' };
}

const coreIndex = path.resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  '1-core',
  'core',
  'src',
  'exports',
  'index.ts',
);

function makeAppDir(name = 'fixture-app'): { dir: string; entryPath: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-ops-')));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  fs.writeFileSync(path.join(dir, 'prisma.config.ts'), 'export default { composer: {} };\n');
  const entryPath = path.join(dir, 'service.ts');
  fs.writeFileSync(
    entryPath,
    [
      `import { module, service } from ${JSON.stringify(coreIndex)};`,
      '',
      `export default module(${JSON.stringify(name)}, {}, ({ provision }) => {`,
      '  provision(',
      '    service({',
      "      name: 'app',",
      "      extension: 'fixture-extension',",
      "      type: 'fixture/compute',",
      '      inputs: {},',
      '      params: {},',
      "      build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' },",
      '    }),',
      "    { id: 'app' },",
      '  );',
      '  return {};',
      '});',
      '',
    ].join('\n'),
  );
  return { dir, entryPath };
}

const fakeAssembler = async (node: ServiceNode) => ({
  dir: path.join(path.dirname(fileURLToPath(node.build.module)), 'dist', 'bundle'),
  entry: 'server.js',
});

const APPLIED: ConvergeOutcome = { kind: 'applied' };

/** Stands in for Alchemy's plan and apply: deploy tests never run the real engine here. */
const applied: Converge = async () => APPLIED;

function recordingConverge(
  requests: ConvergeRequest[],
  outcome: ConvergeOutcome = APPLIED,
): Converge {
  return async (request) => {
    requests.push(request);
    return outcome;
  };
}

describe('deploy()', () => {
  test('a successful deploy converges the lowered app in this process: no stack file, no child', async () => {
    const app = makeAppDir('hello-ops');
    const requests: ConvergeRequest[] = [];
    let spawned = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: recordingConverge(requests),
          alchemy: async () => {
            spawned = true;
            return { exitCode: 0, signal: null };
          },
          convergeEnv: { PRISMA_SERVICE_TOKEN: 'token-from-the-handler' },
        },
      ),
    );

    if (!result.ok) throw result.failure;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      stage: 'ci-7',
      cwd: app.dir,
      env: { PRISMA_SERVICE_TOKEN: 'token-from-the-handler' },
    });
    expect(requests[0]?.stack.stackName).toBe('hello-ops');
    expect(spawned).toBe(false);
    expect(fs.existsSync(path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'))).toBe(false);
    expect(result.value.summary).toBeUndefined();
  });

  test("the config's entry resolves against the config file's directory, not cwd", async () => {
    const app = makeAppDir('hello-ops');
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'composer-elsewhere-')),
    );
    tmpDirs.push(elsewhere);
    let ran = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          config: {
            value: { ...fakeConfig(), entry: './service.ts' },
            file: path.join(app.dir, 'prisma.config.ts'),
          },
          environment: 'ci-7',
          cwd: elsewhere,
        },
        {
          runAssembler: fakeAssembler,
          converge: async () => {
            ran = true;
            return APPLIED;
          },
        },
      ),
    );

    if (!result.ok) throw result.failure;
    expect(ran).toBe(true);
  });

  test('an entry that cannot be loaded names where its path came from', async () => {
    const app = makeAppDir('hello-ops');
    const configFile = path.join(app.dir, 'prisma.config.ts');
    const deployFrom = (input: { entry?: string; configEntry?: string }) =>
      silently(() =>
        deployWithDeps(
          {
            config: {
              value: {
                ...fakeConfig(),
                ...(input.configEntry === undefined ? {} : { entry: input.configEntry }),
              },
              file: configFile,
            },
            ...(input.entry === undefined ? {} : { entry: input.entry }),
            cwd: app.dir,
          },
          { runAssembler: fakeAssembler, converge: applied },
        ),
      );

    const fromConfig = await deployFrom({ configEntry: './missing.ts' });
    if (fromConfig.ok) throw new Error('expected a failure');
    expect(fromConfig.failure).toMatchObject({
      code: 'COMPOSE.ENTRY_UNLOADABLE',
      fix: `Check \`entry: "./missing.ts"\` in ${configFile}. It is relative to that file's directory.`,
      where: { path: path.join(app.dir, 'missing.ts') },
    });

    const fromOverride = await deployFrom({ entry: 'gone.ts', configEntry: './service.ts' });
    if (fromOverride.ok) throw new Error('expected a failure');
    expect(fromOverride.failure).toMatchObject({
      code: 'COMPOSE.ENTRY_UNLOADABLE',
      fix:
        'Check the `--entry` path (the `entry` input when calling @prisma/composer/control) "gone.ts". ' +
        `It is relative to the current directory, ${app.dir}.`,
      where: { path: path.join(app.dir, 'gone.ts') },
    });
  });

  test('without an entry in the config or the input, deploy fails with CONFIG.ENTRY_MISSING before any work', async () => {
    const app = makeAppDir('hello-ops');
    let ran = false;

    const result = await silently(() =>
      deployWithDeps(
        { config: composerConfig(fakeConfig()), cwd: app.dir },
        {
          runAssembler: fakeAssembler,
          converge: async () => {
            ran = true;
            return APPLIED;
          },
        },
      ),
    );

    if (result.ok) throw new Error('expected a failure');
    expect(result.failure).toMatchObject({
      code: 'CONFIG.ENTRY_MISSING',
      fix: "Set `entry: './module.ts'` in the `composer` section of prisma.config.ts, or pass `--entry <path>` (the `entry` input when calling @prisma/composer/control).",
    });
    expect(ran).toBe(false);
  });

  test('without an environment, deploy targets production and runs Alchemy under that name when the container pins no stage', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];
    const requests: ConvergeRequest[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig({}, { calls: containerCalls })),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: recordingConverge(requests),
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(containerCalls[0]).toEqual({
      op: 'ensure',
      input: { appName: 'fixture-app', environment: 'production' },
    });
    expect(requests[0]?.stage).toBe('production');
  });

  test('an invalid environment name is an invalid-input failure, before any container call', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig({}, { calls: containerCalls })),
          entry: app.entryPath,
          environment: 'bad..ref',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.ENVIRONMENT_INVALID');
    expect(result.failure.message).toContain('Invalid --environment');
    expect(containerCalls).toEqual([]);
  });

  test('a --name that cannot be an app name fails before anything is assembled or any container call', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];
    let assembled = false;
    let convergeRan = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig({}, { calls: containerCalls })),
          entry: app.entryPath,
          name: 'acme.shop',
          cwd: app.dir,
        },
        {
          runAssembler: async (node) => {
            assembled = true;
            return fakeAssembler(node);
          },
          converge: async () => {
            convergeRan = true;
            return APPLIED;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toContain('The app name "acme.shop" is not valid.');
    expect(assembled).toBe(false);
    expect(convergeRan).toBe(false);
    expect(containerCalls).toEqual([]);
  });

  describe('a config the CLI would refuse is refused before any container call', () => {
    async function deployWith(
      app: { dir: string; entryPath: string },
      config: ComposerConfigSource,
    ) {
      let convergeRan = false;
      const result = await silently(() =>
        deployWithDeps(
          { config, entry: app.entryPath, cwd: app.dir },
          {
            runAssembler: fakeAssembler,
            converge: async () => {
              convergeRan = true;
              return APPLIED;
            },
          },
        ),
      );
      if (result.ok) throw new Error('expected a failure');
      return { failure: result.failure, convergeRan };
    }

    test('the whole prisma.config.ts export in place of its composer property', async () => {
      const app = makeAppDir();
      const containerCalls: ContainerCall[] = [];
      const wholeExport = { $prismaConfig: 1, composer: fakeConfig({}, { calls: containerCalls }) };

      const { failure, convergeRan } = await deployWith(app, {
        value: wholeExport as unknown as PrismaAppConfig,
        file: 'prisma.config.ts',
      });

      expect(failure).toMatchObject({
        code: 'CONFIG.FIELD_UNKNOWN',
        fix: 'Pass the `composer` property of the prisma.config.ts export, not the whole export. The section takes only `entry`, `extensions`, `state`, `config` and `secrets`.',
        where: { path: path.join(app.dir, 'prisma.config.ts') },
      });
      expect(containerCalls).toEqual([]);
      expect(convergeRan).toBe(false);
    });

    test('an old prisma-composer.config.ts beside config.file', async () => {
      const app = makeAppDir();
      const containerCalls: ContainerCall[] = [];
      fs.writeFileSync(path.join(app.dir, 'prisma-composer.config.ts'), 'export default {};\n');

      const { failure, convergeRan } = await deployWith(
        app,
        composerConfig(fakeConfig({}, { calls: containerCalls })),
      );

      expect(failure).toMatchObject({
        code: 'CONFIG.FILE_RETIRED',
        message: `${path.join(app.dir, 'prisma-composer.config.ts')} is no longer read.`,
      });
      expect(containerCalls).toEqual([]);
      expect(convergeRan).toBe(false);
    });

    test('every finding, in the order the CLI reports them', async () => {
      const app = makeAppDir();
      fs.writeFileSync(path.join(app.dir, 'prisma-composer.config.ts'), 'export default {};\n');

      const { failure } = await deployWith(app, {
        value: { extensions: [] } as unknown as PrismaAppConfig,
        file: 'prisma.config.ts',
      });

      expect(failure.code).toBe('CONFIG.FILE_RETIRED');
      expect(failure.meta).toMatchObject({
        findings: [{ code: 'CONFIG.FILE_RETIRED' }, { code: 'CONFIG.FIELD_INVALID' }],
      });
    });

    test('a symlinked config.file is checked beside the file it links to', async () => {
      const app = makeAppDir();
      const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-real-config-')));
      tmpDirs.push(real);
      fs.writeFileSync(path.join(real, 'prisma.config.ts'), 'export default {};\n');
      fs.writeFileSync(path.join(real, 'prisma-composer.config.ts'), 'export default {};\n');
      fs.symlinkSync(path.join(real, 'prisma.config.ts'), path.join(app.dir, 'linked.config.ts'));

      const { failure } = await deployWith(app, {
        value: fakeConfig(),
        file: 'linked.config.ts',
      });

      expect(failure).toMatchObject({
        code: 'CONFIG.FILE_RETIRED',
        where: { path: path.join(real, 'prisma-composer.config.ts') },
      });
    });

    test('a config.file that does not exist', async () => {
      const app = makeAppDir();
      const containerCalls: ContainerCall[] = [];

      const { failure } = await deployWith(app, {
        value: fakeConfig({}, { calls: containerCalls }),
        file: 'missing.config.ts',
      });

      expect(failure).toMatchObject({
        code: 'CONFIG.FILE_MISSING',
        message: `${path.join(app.dir, 'missing.config.ts')} does not exist.`,
      });
      expect(containerCalls).toEqual([]);
    });
  });

  test('an extension-preflight throw is a pipeline failure — alchemy never runs', async () => {
    const app = makeAppDir('hello-preflight-fail');
    let convergeRan = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(
            fakeConfig({
              preflight: async () => {
                throw new Error('SECRET_X is not provisioned');
              },
            }),
          ),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: async () => {
            convergeRan = true;
            return APPLIED;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.PREFLIGHT_FAILED');
    expect(result.failure.message).toContain('SECRET_X is not provisioned');
    expect(convergeRan).toBe(false);
  });

  test("a failed converge is DEPLOY.ENGINE_FAILED carrying Alchemy's cause, with Composer's advice in place of the Alchemy CLI's", async () => {
    const app = makeAppDir();

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: async () => ({
            kind: 'failed',
            cause:
              'PrismaApiError: the bucket is held by another app. Re-run with `--adopt` (or wrap the effect in `adopt(true)`) to take it over.',
          }),
        },
      ),
    );

    if (result.ok) throw new Error('expected a failure');
    const cause =
      'PrismaApiError: the bucket is held by another app. Something other than this app holds it. Remove that resource, then deploy again.';
    expect(result.failure.code).toBe('DEPLOY.ENGINE_FAILED');
    expect(result.failure.message).toBe(`Alchemy could not deploy the app.\n${cause}`);
    expect(result.failure.meta?.['engineCause']).toBe(cause);
    expect(executionDiagnostics(result.failure)).toBeUndefined();
  });

  test('an engine failure cause never carries a value the pools read from a dotenv file', async () => {
    const app = makeAppDir();
    const onlyInDotenvFile = 'dotenv-only-SENTINEL-4f1c';
    const inBothPools = 'shared-name-SENTINEL-77ab';
    const secretNamedConfigValue = 'secret-named-SENTINEL-90cd';
    fs.writeFileSync(
      path.join(app.dir, '.env.ci-7.local'),
      `SIGNING_SALT=${onlyInDotenvFile}\nWEBHOOK_SIG=${inBothPools}\n`,
    );

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          config: {
            value: {
              ...fakeConfig(),
              config: [() => ({ WEBHOOK_SIG: inBothPools, STRIPE_KEY: secretNamedConfigValue })],
              secrets: [dotenv()],
            },
            file: path.join(app.dir, 'prisma.config.ts'),
          },
        },
        {
          runAssembler: fakeAssembler,
          converge: async () => ({
            kind: 'failed',
            cause: `error: rejected ${onlyInDotenvFile}, ${inBothPools} and ${secretNamedConfigValue}`,
          }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.meta?.['engineCause']).toBe(
      'error: rejected [redacted], [redacted] and [redacted]',
    );
    expect(JSON.stringify(result.failure)).not.toContain('SENTINEL');
  });

  test('an interrupted converge is DEPLOY.INTERRUPTED, and the apply step closes as failed', async () => {
    const app = makeAppDir();
    const events: DeployEvent[] = [];
    const controller = new AbortController();
    const requests: ConvergeRequest[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          config: composerConfig(fakeConfig()),
          onEvent: (event) => events.push(event),
          signal: controller.signal,
        },
        {
          runAssembler: fakeAssembler,
          converge: recordingConverge(requests, { kind: 'interrupted' }),
        },
      ),
    );

    if (result.ok) throw new Error('expected a failure');
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(result.failure.code).toBe('DEPLOY.INTERRUPTED');
    expect(result.failure.meta?.['engineCause']).toBeUndefined();
    expect(events.map(stepLine)).toContain('finished apply failed');
  });

  test('an executor that cannot load is a structured failure carrying the import error — the host stays alive', () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-ops-executor-')),
    );
    tmpDirs.push(dir);

    // In a broken tree the executor's own import of alchemy throws. The repo's
    // tree is healthy, so a fresh bun process reproduces that throw with a
    // plugin that fails the executor's load; deploy() must return a structured
    // failure — silent stdio, exit 0.
    const operationsPath = fileURLToPath(new URL('../deploy.ts', import.meta.url));
    const breakerPath = path.join(dir, 'break-executor.ts');
    fs.writeFileSync(
      breakerPath,
      'Bun.plugin({\n' +
        "  name: 'break-executor',\n" +
        '  setup(build) {\n' +
        '    build.onLoad({ filter: /execute-deploy-destroy\\.ts$/ }, () => {\n' +
        "      throw new Error('Schedule.either is not a function');\n" +
        '    });\n' +
        '  },\n' +
        '});\n',
    );
    // A Result is in-process only (frozen, getter-backed — not
    // JSON-serializable), so the probe serializes the failure's envelope plus
    // a {name, message} projection of its cause.
    const probePath = path.join(dir, 'probe.ts');
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      probePath,
      `import { deploy } from ${JSON.stringify(operationsPath)};\n` +
        `const result = await deploy({ entry: 'service.ts', cwd: ${JSON.stringify(dir)}, config: { value: { extensions: [], state: { extension: 'x', create: () => undefined } }, file: 'prisma.config.ts' } });\n` +
        "if (result.ok) throw new Error('expected a failure');\n" +
        'const cause = result.failure.cause;\n' +
        'await Bun.write(\n' +
        `  ${JSON.stringify(resultPath)},\n` +
        '  JSON.stringify({\n' +
        '    envelope: result.failure.toEnvelope(),\n' +
        '    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause,\n' +
        '  }),\n' +
        ');\n',
    );

    const probe = spawnSync(process.execPath, ['--preload', breakerPath, probePath], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(probe.error).toBeUndefined();
    expect(probe.stdout).toBe('');
    expect(probe.stderr).toBe('');
    expect(probe.status).toBe(0);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
      envelope: { code: string; summary: string };
      cause: { name: string; message: string };
    };
    expect(result.envelope.code).toBe('DEPS.EXECUTOR_UNLOADABLE');
    expect(result.envelope.summary).toBe(
      'Could not load the deploy executor: Schedule.either is not a function',
    );
    expect(result.cause).toEqual({
      name: 'Error',
      message: 'Schedule.either is not a function',
    });
  });
});

/** Each event as `kind name[:address] outcome`, for asserting order without timings. */
function stepLine(event: DeployEvent): string {
  if (event.kind === 'message') return `message ${event.text}`;
  const name =
    event.step.name === 'assemble-service'
      ? `assemble-service:${event.step.address}`
      : event.step.name === 'apply-resource'
        ? `apply-resource:${event.step.fqn}`
        : event.step.name;
  return event.kind === 'step-started' ? `started ${name}` : `finished ${name} ${event.outcome}`;
}

describe('deploy() step events', () => {
  test('a successful deploy reports every step in order, each with a duration and its data', async () => {
    const app = makeAppDir('hello-steps');
    const events: DeployEvent[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(
            fakeConfig({
              preflight: async (input) => {
                input.report?.({ checked: 3, filled: 1, missing: 0 });
                return undefined;
              },
            }),
          ),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: (event) => events.push(event),
        },
        {
          runAssembler: async (node, _address, _cwd, report) => {
            report?.({ strategy: 'traced', filesTraced: 975 });
            report?.({ bytes: 4096 });
            return fakeAssembler(node);
          },
          converge: applied,
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(events.map(stepLine)).toEqual([
      'started prepare',
      'finished prepare ok',
      'started assemble',
      'started assemble-service:hello-steps.app',
      'finished assemble-service:hello-steps.app ok',
      'finished assemble ok',
      'started connect',
      'finished connect ok',
      'started preflight',
      'finished preflight ok',
      'started apply',
      'finished apply ok',
      'started record',
      'finished record ok',
    ]);
    for (const event of events) {
      if (event.kind === 'step-finished') expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    const finished = (name: string) =>
      events.find((event) => event.kind === 'step-finished' && event.step.name === name);
    expect(finished('assemble-service')).toMatchObject({
      data: { strategy: 'traced', filesTraced: 975, bytes: 4096 },
    });
    expect(finished('preflight')).toMatchObject({ data: { checked: 3, filled: 1, missing: 0 } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("Alchemy's progress becomes one step per resource inside apply, and its log lines become messages", async () => {
    const app = makeAppDir('hello-resources');
    const events: DeployEvent[] = [];
    const resource = (status: string, phase: 'pending' | 'running' | 'done' | 'failed') =>
      ({
        kind: 'resource',
        fqn: 'hello-resources.app',
        resourceType: 'Prisma.Deployment',
        status,
        phase,
      }) as const;

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: (event) => events.push(event),
        },
        {
          runAssembler: fakeAssembler,
          converge: async (request) => {
            request.onEvent?.(resource('pending', 'pending'));
            request.onEvent?.(resource('creating', 'running'));
            request.onEvent?.({ kind: 'log', severity: 'info', text: 'uploading 3 files' });
            request.onEvent?.(resource('created', 'done'));
            return APPLIED;
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    const applyEvents = events.slice(
      events.findIndex((event) => event.kind === 'step-started' && event.step.name === 'apply'),
    );
    expect(applyEvents.map(stepLine).slice(0, 5)).toEqual([
      'started apply',
      'started apply-resource:hello-resources.app',
      'message uploading 3 files',
      'finished apply-resource:hello-resources.app ok',
      'finished apply ok',
    ]);
    expect(applyEvents[1]).toMatchObject({ step: { status: 'creating' } });
    expect(applyEvents[3]).toMatchObject({ step: { status: 'created' } });
  });

  test('a resource Alchemy failed closes its step as failed and reports the reason', async () => {
    const app = makeAppDir('hello-resource-fail');
    const events: DeployEvent[] = [];

    await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: (event) => events.push(event),
        },
        {
          runAssembler: fakeAssembler,
          converge: async (request) => {
            request.onEvent?.({
              kind: 'resource',
              fqn: 'site',
              resourceType: 'Prisma.CustomDomain',
              status: 'fail',
              phase: 'failed',
              message: 'domain-ownership-required',
            });
            return { kind: 'failed', cause: 'PrismaApiError: domain-ownership-required' };
          },
        },
      ),
    );

    expect(events.map(stepLine)).toContain('finished apply-resource:site failed');
    expect(events).toContainEqual({
      kind: 'message',
      severity: 'warn',
      text: 'site: domain-ownership-required',
    });
    expect(events.map(stepLine)).toContain('finished apply failed');
  });

  test('a thrown defect closes the open steps as failed and still records the result', async () => {
    const app = makeAppDir('hello-steps-defect');
    const events: DeployEvent[] = [];
    const brokenContainer: ContainerDescriptor = {
      ...fakeContainerDescriptor(),
      ensure: async (input) => ({
        input,
        get alchemyStage(): string {
          throw new Error('container bug');
        },
        serialize: () => JSON.stringify({ input }),
      }),
    };
    const config = fakeConfig();
    const extension = config.extensions[0];
    if (extension === undefined) throw new Error('unreachable');

    const outcome = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig({
            ...config,
            extensions: [
              { ...extension, container: brokenContainer },
              ...config.extensions.slice(1),
            ],
          }),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: (event) => events.push(event),
        },
        { runAssembler: fakeAssembler, converge: applied },
      ).catch((error: unknown) => error),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(events.map(stepLine)).toEqual([
      'started prepare',
      'finished prepare ok',
      'started assemble',
      'started assemble-service:hello-steps-defect.app',
      'finished assemble-service:hello-steps-defect.app ok',
      'finished assemble ok',
      'started connect',
      'finished connect failed',
      'started record',
      'finished record ok',
    ]);
  });

  test('a failed step and every step around it close as failed, and the result is still recorded', async () => {
    const app = makeAppDir('hello-steps-fail');
    const events: DeployEvent[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: (event) => events.push(event),
        },
        {
          runAssembler: async () => {
            throw new Error('no built entry');
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(events.map(stepLine)).toEqual([
      'started prepare',
      'finished prepare ok',
      'started assemble',
      'started assemble-service:hello-steps-fail.app',
      'finished assemble-service:hello-steps-fail.app failed',
      'finished assemble failed',
      'started record',
      'finished record ok',
    ]);
  });

  test('an unwritable run report fails the record step but not the deploy', async () => {
    const app = makeAppDir('hello-steps-report');
    const events: DeployEvent[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof deployWithDeps>>;
    try {
      result = await deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          // A path under a regular file can never be created.
          reportPath: path.join(app.dir, 'package.json', 'report.json'),
          onEvent: (event) => events.push(event),
        },
        { runAssembler: fakeAssembler, converge: applied },
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    expect(events.map(stepLine).slice(-2)).toEqual(['started record', 'finished record failed']);
  });

  test('an onEvent that throws cannot fail the deploy', async () => {
    const app = makeAppDir('hello-steps-throw');

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          onEvent: () => {
            throw new Error('renderer bug');
          },
        },
        { runAssembler: fakeAssembler, converge: applied },
      ),
    );

    expect(result.ok).toBe(true);
  });
});

describe('executorLoadFailure()', () => {
  test("a load failure names the failing operation in DEPS.EXECUTOR_UNLOADABLE's summary and why", () => {
    for (const operation of ['deploy', 'destroy', 'dev', 'log'] as const) {
      const failure = executorLoadFailure(operation, new Error('import blew up'));
      expect(failure.code).toBe('DEPS.EXECUTOR_UNLOADABLE');
      expect(failure.message).toBe(`Could not load the ${operation} executor: import blew up`);
      expect(failure.why).toContain(`The ${operation} operation's executor`);
    }
  });
});

describe('destroy()', () => {
  test('destroy passes the environment into runPipeline, so Load resolves values over environment.name', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    fs.writeFileSync(
      app.entryPath,
      [
        `import { module, resolve, service } from ${JSON.stringify(coreIndex)};`,
        '',
        "export default module('fixture-app', ({ environment, provision }) => {",
        '  const label = resolve([environment.name], ([name]) => {',
        '    globalThis.resolvedEnvironments.push(name);',
        '    return name;',
        '  });',
        '  provision(',
        '    service({',
        "      name: 'app',",
        "      extension: 'fixture-extension',",
        "      type: 'fixture/compute',",
        '      inputs: {},',
        '      params: {},',
        "      input: { '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value }) } },",
        "      build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' },",
        '    }),',
        "    { id: 'app', input: { environment: label } },",
        '  );',
        '});',
        '',
      ].join('\n'),
    );
    const seen: string[] = [];
    Object.assign(globalThis, { resolvedEnvironments: seen });

    try {
      const result = await silently(() =>
        destroyWithDeps(
          {
            config: composerConfig(fakeConfig()),
            entry: app.entryPath,
            environment: 'staging',
            cwd: app.dir,
          },
          {
            runAssembler: fakeAssembler,
            alchemy: async () => ({ exitCode: 0, signal: null }),
          },
        ),
      );

      expect(result.ok).toBe(true);
      expect(seen).toEqual(['staging']);
    } finally {
      Reflect.deleteProperty(globalThis, 'resolvedEnvironments');
    }
  });

  test('destroy locates the container for the environment it names', async () => {
    for (const environment of ['staging', 'production']) {
      const app = makeAppDir();
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
      const containerCalls: ContainerCall[] = [];

      const result = await silently(() =>
        destroyWithDeps(
          {
            config: composerConfig(fakeConfig({}, { calls: containerCalls, alchemyStage: 'br_x' })),
            entry: app.entryPath,
            environment,
            cwd: app.dir,
          },
          {
            runAssembler: fakeAssembler,
            alchemy: async () => ({ exitCode: 0, signal: null }),
          },
        ),
      );

      expect(result.ok).toBe(true);
      expect(containerCalls[0]).toEqual({
        op: 'locate',
        input: { appName: 'fixture-app', environment },
      });
    }
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'a %s environment fails with DEPLOY.ENVIRONMENT_REQUIRED before any work',
    async (_label, environment) => {
      const app = makeAppDir();
      const containerCalls: ContainerCall[] = [];
      const input = {
        config: composerConfig(fakeConfig({}, { calls: containerCalls })),
        entry: app.entryPath,
        environment,
        cwd: app.dir,
      };

      const result = await silently(() =>
        destroyWithDeps(input as DestroyInput, {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('DEPLOY.ENVIRONMENT_REQUIRED');
      expect(containerCalls).toEqual([]);
    },
  );

  test('locate returning undefined is a structured failure naming the app and environment', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');

    const result = await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig(fakeConfig({}, { notFound: true })),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.TARGET_NOT_FOUND');
    expect(result.failure.message).toBe(
      'Nothing deployed for fixture-app in the environment staging.',
    );
    expect(result.failure.fix).toBe('Deploy it first.');
  });

  /** Behaves like the released 0.35.0 extension: it keeps the input it is given, but its `deserialize` rebuilds only `{ appName, stage }`. */
  function releasedExtensionContainer(): ContainerDescriptor {
    const instance = (input: LocateContainerInput): ContainerInstance => ({
      input,
      serialize: () => JSON.stringify({ input }),
    });
    return {
      ensure: async (input) => instance(input),
      locate: async (input) => instance(input),
      remove: async () => {
        throw new Error('remove must not run');
      },
      deserialize: (serialized) => {
        const parsed = JSON.parse(serialized) as { input: { appName: string; stage?: string } };
        const { appName, stage } = parsed.input;
        return instance({ appName, stage } as unknown as LocateContainerInput);
      },
    };
  }

  function withContainer(config: PrismaAppConfig, container: ContainerDescriptor): PrismaAppConfig {
    const [extension, ...rest] = config.extensions;
    if (extension === undefined) throw new Error('unreachable');
    return { ...config, extensions: [{ ...extension, container }, ...rest] };
  }

  async function runAgainst(action: 'deploy' | 'destroy', config: PrismaAppConfig) {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const ran: string[] = [];
    const input = {
      config: composerConfig(config),
      entry: app.entryPath,
      environment: 'staging',
      cwd: app.dir,
    };
    const deps = {
      runAssembler: fakeAssembler,
      alchemy: async () => {
        ran.push('alchemy');
        return { exitCode: 0, signal: null };
      },
      converge: async () => {
        ran.push('alchemy');
        return APPLIED;
      },
    };
    const result =
      action === 'deploy'
        ? await silently(() => deployWithDeps(input, deps))
        : await silently(() => destroyWithDeps(input, deps));
    return { result, ran };
  }

  const recordingHooks = (ran: string[]) => ({
    preflight: async () => {
      ran.push('preflight');
      return undefined;
    },
    teardown: async () => void ran.push('teardown'),
  });

  test.each(['deploy', 'destroy'] as const)(
    '%s refuses an extension older than this Composer, before preflight, Alchemy, teardown or removal',
    async (action) => {
      const hookRuns: string[] = [];
      const config = withContainer(
        fakeConfig(recordingHooks(hookRuns)),
        releasedExtensionContainer(),
      );

      const { result, ran } = await runAgainst(action, config);

      if (result.ok) throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        code: 'DEPS.EXTENSION_INCOMPATIBLE',
        message: `The extension fixture-extension is older than the Composer running this ${action}, so it would not resolve the environment staging.`,
        fix: `Install the same Composer version of fixture-extension as the Composer that runs the ${action}.`,
      });
      expect([...ran, ...hookRuns]).toEqual([]);
    },
  );

  test.each(['deploy', 'destroy'] as const)(
    '%s refuses an extension whose deserialize throws on its own container',
    async (action) => {
      const config = withContainer(fakeConfig(), {
        ...releasedExtensionContainer(),
        deserialize: () => {
          throw new Error('unknown payload');
        },
      });

      const { result, ran } = await runAgainst(action, config);

      if (result.ok) throw new Error('expected a failure');
      expect(result.failure.code).toBe('DEPS.EXTENSION_INCOMPATIBLE');
      expect(ran).toEqual([]);
    },
  );

  test.each(['deploy', 'destroy'] as const)(
    '%s accepts an extension of the same Composer version',
    async (action) => {
      const hookRuns: string[] = [];

      const { result, ran } = await runAgainst(action, fakeConfig(recordingHooks(hookRuns)));

      expect(result.ok).toBe(true);
      expect(ran).toEqual(['alchemy']);
    },
  );

  test('a failed destroy carries the cause the child recorded, like deploy', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');

    const result = await silently(() =>
      destroyWithDeps(
        {
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
          config: composerConfig(fakeConfig({}, { alchemyStage: 'br_x' })),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async (input) => {
            const resultFile = input.env[DEPLOYMENT_RESULT_FILE_ENV];
            if (resultFile === undefined) throw new Error('the result-file env var must be set');
            fs.writeFileSync(engineFailureFilePath(resultFile), '[db] fail — timed out');
            return { exitCode: 1, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.ENGINE_FAILED');
    expect(result.failure.message).toBe(
      'alchemy destroy exited with status 1.\n[db] fail — timed out',
    );
  });

  test('a successful destroy runs alchemy, then every teardown, then every container removal', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const order: string[] = [];

    const result = await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig(
            fakeConfig(
              { teardown: async () => void order.push('teardown') },
              { onRemove: () => void order.push('remove') },
            ),
          ),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            order.push('alchemy');
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(order).toEqual(['alchemy', 'teardown', 'remove']);
  });

  test('the no-local-deploy-state event fires before the pipeline runs', async () => {
    const app = makeAppDir();
    const order: string[] = [];

    const result = await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
          onEvent: (event) => void order.push(event.kind),
        },
        {
          runAssembler: async (node) => {
            order.push('assemble');
            return fakeAssembler(node);
          },
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(order).toEqual(['no-local-deploy-state', 'assemble']);
  });

  test('no event fires when .alchemy holds state', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const events: string[] = [];

    await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(events).toEqual([]);
  });
});

interface Endpoint {
  readonly address: string;
  readonly url: string;
}

function localContainer(environment = 'dev'): ContainerInstance {
  return { input: { appName: 'app', environment }, serialize: () => environment };
}

function fakeAttachment(
  endpoints: readonly Endpoint[],
  logs: LocalTargetAttachment['logs'],
): LocalTargetAttachment {
  return {
    startServices: () => Promise.resolve(),
    stopApp: () => Promise.resolve(),
    endpoints: () => Promise.resolve(endpoints),
    logs,
  };
}

function linesAttachment(
  endpoints: readonly Endpoint[],
  lines: readonly LogLine[],
): LocalTargetAttachment {
  return fakeAttachment(endpoints, async function* () {
    for (const l of lines) yield l;
  });
}

function configWith(attachments: readonly LocalTargetAttachment[]): PrismaAppConfig {
  return {
    extensions: attachments.map((attachment, index) => {
      const descriptor: LocalTargetDescriptor = {
        providers: () => Layer.empty,
        container: {
          ensure: () => Promise.resolve(localContainer()),
          locate: () => Promise.resolve(undefined),
          remove: () => Promise.resolve(),
          deserialize: () => localContainer(),
        },
        attach: () => Promise.resolve(attachment),
      };
      return {
        id: `x${String(index)}`,
        nodes: {
          svc: {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
        localTarget: () => Promise.resolve(descriptor),
      };
    }),
    state: { extension: 'x0', create: unused },
  };
}

function identityFor(attachments: readonly LocalTargetAttachment[]): AppIdentity {
  return { config: configWith(attachments), name: 'app' };
}

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
  const out: LogLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** A config whose one extension both deploys the fixture nodes and offers a local target — what dev() needs end to end. */
function devConfigWith(
  attachment: LocalTargetAttachment,
  environments: string[] = [],
  deserialize: (serialized: string) => ContainerInstance = localContainer,
  preflight?: LocalTargetDescriptor['preflight'],
): PrismaAppConfig {
  const descriptor: LocalTargetDescriptor = {
    providers: () => Layer.empty,
    teardown: (input) => {
      environments.push(`teardown:${input.environment}`);
      return Promise.resolve();
    },
    preflight: (input) => {
      environments.push(`preflight:${input.environment}`);
      return preflight?.(input) ?? Promise.resolve(undefined);
    },
    emulators: (input) => {
      environments.push(`emulators:${input.devDir}`);
      return Promise.resolve();
    },
    container: {
      ensure: (input) => {
        environments.push(`ensure:${input.environment}`);
        return Promise.resolve(localContainer(input.environment));
      },
      locate: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(),
      deserialize,
    },
    attach: (input) => {
      environments.push(`attach:${input.devDir}`);
      return Promise.resolve(attachment);
    },
  };
  return {
    extensions: [
      {
        id: 'fixture-extension',
        nodes: {
          'fixture/compute': {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
        localTarget: () => Promise.resolve(descriptor),
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: unused } } },
    ],
    state: { extension: 'fixture-extension', create: unused },
  };
}

describe.skipIf(process.platform !== 'win32')('local operations on Windows', () => {
  test('dev and log return their platform refusal before touching the pipeline', async () => {
    const devResult = await silently(() =>
      devWithDeps({ entry: 'service.ts', config: composerConfig(fakeConfig()) }, {}),
    );
    const logResult = await silently(() =>
      logWithDeps({ entry: 'service.ts', config: composerConfig(fakeConfig()) }, {}),
    );

    expect(devResult.ok).toBe(false);
    if (devResult.ok) throw new Error('unreachable');
    expect(devResult.failure.code).toBe('DEV.PLATFORM_UNSUPPORTED');

    expect(logResult.ok).toBe(false);
    if (logResult.ok) throw new Error('unreachable');
    expect(logResult.failure.code).toBe('LOG.PLATFORM_UNSUPPORTED');
  });
});

describe.skipIf(process.platform === 'win32')('dev()', () => {
  const runningAttachment: LocalTargetAttachment = {
    startServices: () => Promise.resolve(),
    stopApp: () => Promise.resolve(),
    endpoints: () => Promise.resolve([]),
    logs: async function* () {},
  };

  async function childEnvOfDev(
    preflight: LocalTargetDescriptor['preflight'],
  ): Promise<Readonly<Record<string, string | undefined>>> {
    const app = makeAppDir('hello-dev');
    let childEnv: Readonly<Record<string, string | undefined>> = {};
    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(runningAttachment, [], localContainer, preflight)),
          entry: app.entryPath,
          cwd: app.dir,
          detach: true,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async (invocation) => {
            childEnv = invocation.env;
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );
    expect(result.ok).toBe(true);
    return childEnv;
  }

  test("the dev preflight's payload reaches the alchemy process", async () => {
    const env = await childEnvOfDev(() => Promise.resolve('dev:{"absentSecrets":[]}'));

    expect(env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_EXTENSION']).toBe('dev:{"absentSecrets":[]}');
  }, 15_000);

  test('a stale payload in the shell is blanked for every configured extension', async () => {
    const saved = {
      own: process.env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_EXTENSION'],
      build: process.env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_BUILD'],
    };
    process.env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_EXTENSION'] = 'stale';
    process.env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_BUILD'] = 'stale';
    try {
      const env = await childEnvOfDev(() => Promise.resolve(undefined));

      expect(env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_EXTENSION']).toBe('');
      expect(env['PRISMA_COMPOSER_PREFLIGHT_FIXTURE_BUILD']).toBe('');
    } finally {
      for (const [key, name] of [
        ['own', 'PRISMA_COMPOSER_PREFLIGHT_FIXTURE_EXTENSION'],
        ['build', 'PRISMA_COMPOSER_PREFLIGHT_FIXTURE_BUILD'],
      ] as const) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
    }
  }, 15_000);

  test('a throw after services start (endpoint merge) is a pipeline failure, and the started services are stopped again', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.reject(new Error('emulator admin refused the connection')),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.ATTACH_FAILED');
    expect(result.failure.message).toBe('emulator admin refused the connection');
    expect(stops).toBe(1);
  }, 15_000);

  test('dev hands the local target the environment dev, and runs Alchemy under the stage dev', async () => {
    const app = makeAppDir('hello-dev');
    const environments: string[] = [];
    const stages: string[] = [];

    await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(linesAttachment([], []), environments)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async (input) => {
            stages.push(input.stage);
            return { exitCode: 1, signal: null };
          },
        },
      ),
    );

    const devDir = path.join(app.dir, '.prisma-composer', 'dev', 'dev');
    expect(environments).toEqual([
      'ensure:dev',
      'preflight:dev',
      `emulators:${devDir}`,
      `attach:${devDir}`,
    ]);
    expect(stages).toEqual(['dev']);
    expect(fs.readFileSync(path.join(devDir, 'environment-name'), 'utf8')).toBe('dev\n');
  }, 15_000);

  test('an environment whose folder records another name, as Dev and dev share one on macOS, fails with DEV.ENVIRONMENT_NAME_MISMATCH before teardown', async () => {
    const app = makeAppDir('hello-dev');
    const environments: string[] = [];
    const devDir = path.join(app.dir, '.prisma-composer', 'dev', 'Dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'environment-name'), 'dev\n');

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(linesAttachment([], []), environments)),
          entry: app.entryPath,
          environment: 'Dev',
          fresh: true,
          cwd: app.dir,
        },
        { runAssembler: fakeAssembler, alchemy: async () => ({ exitCode: 0, signal: null }) },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'DEV.ENVIRONMENT_NAME_MISMATCH',
        meta: { recorded: 'dev', environment: 'Dev' },
      },
    });
    expect(environments).toEqual(['ensure:Dev']);
  }, 15_000);

  test("--environment runs that environment's copy: its own folder, stack file and Alchemy stage, and --fresh tears down only it", async () => {
    const app = makeAppDir('hello-dev');
    const environments: string[] = [];
    const runs: { stage: string; stack: string }[] = [];

    await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(linesAttachment([], []), environments)),
          entry: app.entryPath,
          environment: 'feature/x',
          fresh: true,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async (input) => {
            runs.push({ stage: input.stage, stack: input.stackFileRelativePath });
            return { exitCode: 1, signal: null };
          },
        },
      ),
    );

    const devDir = path.join(app.dir, '.prisma-composer', 'dev', 'feature%2Fx');
    expect(environments).toEqual([
      'ensure:feature/x',
      'teardown:feature/x',
      'preflight:feature/x',
      `emulators:${devDir}`,
      `attach:${devDir}`,
    ]);
    expect(runs).toEqual([
      {
        stage: 'feature/x',
        stack: path.join('.prisma-composer', 'dev', 'feature%2Fx', 'alchemy.run.ts'),
      },
    ]);
    expect(fs.existsSync(path.join(devDir, 'alchemy.run.ts'))).toBe(true);
  }, 15_000);

  test.each([
    ['resolves another environment', () => localContainer('production')],
    [
      'cannot read its own container',
      () => {
        throw new Error('unknown payload');
      },
    ],
  ])(
    'refuses a local target extension that %s with DEPS.EXTENSION_INCOMPATIBLE, before teardown, preflight, emulators or Alchemy',
    async (_case, deserialize) => {
      const app = makeAppDir('hello-dev');
      const environments: string[] = [];
      let converged = false;

      const result = await silently(() =>
        devWithDeps(
          {
            config: composerConfig(
              devConfigWith(linesAttachment([], []), environments, deserialize),
            ),
            entry: app.entryPath,
            environment: 'test',
            fresh: true,
            cwd: app.dir,
          },
          {
            runAssembler: fakeAssembler,
            alchemy: async () => {
              converged = true;
              return { exitCode: 0, signal: null };
            },
          },
        ),
      );

      if (result.ok) throw new Error('expected a failure');
      expect(result.failure).toMatchObject({
        code: 'DEPS.EXTENSION_INCOMPATIBLE',
        message:
          'The extension fixture-extension is older than the Composer running `prisma dev`, so it would not resolve the environment test.',
        fix: 'Install the same Composer version of fixture-extension as the Composer that runs `prisma dev`.',
      });
      expect(environments).toEqual(['ensure:test']);
      expect(converged).toBe(false);
    },
    15_000,
  );

  test('a failed first converge stops the services it started before returning DEV.CONVERGE_FAILED', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 1, signal: null }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.CONVERGE_FAILED');
    expect(stops).toBe(1);
  }, 15_000);

  test('a converge that cannot be spawned still stops the app services', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            throw new Error('spawn failed');
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.CONVERGE_FAILED');
    expect(stops).toBe(1);
  }, 15_000);

  test('a startServices that throws mid-start is rolled back: the partially-started attachment is stopped again', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      // Models a partial start: some services came up before the throw, so
      // the rollback must stop this attachment even though startServices
      // never returned.
      startServices: () => Promise.reject(new Error('service two failed to bind its port')),
      stopApp: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.SERVICE_START_FAILED');
    expect(result.failure.message).toBe('service two failed to bind its port');
    expect(stops).toBe(1);
  }, 15_000);

  /**
   * The session keeps the config it started with, while each rebuild's child
   * would import prisma.config.ts from disk. So an edit is reported, and
   * rebuilds stop until the user restarts dev, rather than mixing the two.
   */
  test('an edit to prisma.config.ts is reported, and rebuilds stop until dev restarts', async () => {
    const app = makeAppDir('hello-dev');
    const buildOutput = path.join(app.dir, 'built.txt');
    fs.writeFileSync(buildOutput, 'v1');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    const events: DevEvent[] = [];
    let converges = 0;
    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const configChanges = () => events.filter((event) => event.kind === 'config-changed');

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event),
        },
        {
          runAssembler: async (node: ServiceNode) => ({
            ...(await fakeAssembler(node)),
            watch: [buildOutput],
          }),
          alchemy: async () => {
            converges += 1;
            return { exitCode: 0, signal: null };
          },
        },
      );
      if (!start.ok) throw new Error('expected a started session');

      fs.writeFileSync(path.join(app.dir, 'prisma.config.ts'), 'export default { composer: 1 };\n');
      await until(() => configChanges().length >= 1);

      fs.writeFileSync(buildOutput, 'v2');
      await until(() => configChanges().length >= 2);

      await start.value.stop();
      await start.value.closed;
    });

    expect(configChanges()[0]).toEqual({
      kind: 'config-changed',
      file: path.join(app.dir, 'prisma.config.ts'),
    });
    expect(configChanges()).toHaveLength(2);
    expect(converges).toBe(1);
  }, 20_000);

  /**
   * A rebuild re-assembles every service's artifact directory, and the
   * converge child reads those directories. A second rebuild starting while
   * the first child is still running rewrites them underneath it.
   */
  test('a build change during a rebuild waits for it, and later changes coalesce into one rebuild', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    let buildChange: () => void = () => undefined;
    let converges = 0;
    let running = 0;
    let mostRunning = 0;
    const releases: (() => void)[] = [];
    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 5_000; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: async (node: ServiceNode) => ({
            ...(await fakeAssembler(node)),
            watch: [path.join(app.dir, 'built.txt')],
          }),
          alchemy: async () => {
            converges += 1;
            running += 1;
            mostRunning = Math.max(mostRunning, running);
            if (converges > 1) await new Promise<void>((resolve) => releases.push(resolve));
            running -= 1;
            return { exitCode: 0, signal: null };
          },
          watch: (targets, onChange) => {
            if (!targets.some((t) => t.paths.includes(path.join(app.dir, 'prisma.config.ts')))) {
              buildChange = onChange;
            }
            return { ready: Promise.resolve(), stop: () => undefined };
          },
        },
      );
      if (!start.ok) throw new Error('expected a started session');

      buildChange();
      await until(() => converges === 2);
      buildChange();
      buildChange();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(converges).toBe(2);

      releases.shift()?.();
      await until(() => converges === 3);
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(converges).toBe(3);
      expect(mostRunning).toBe(1);
      await start.value.stop();
    });
  }, 15_000);

  describe('the prisma.config.ts watch', () => {
    const quietAttachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 5_000; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    /** A dev session whose watchers are handed to the test instead of chokidar. */
    async function devWithFakeWatchers(app: { dir: string; entryPath: string }) {
      const events: DevEvent[] = [];
      const watchers: {
        paths: readonly string[];
        onChange: () => void;
        onError: ((error: unknown) => void) | undefined;
      }[] = [];
      let converges = 0;
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(quietAttachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event),
        },
        {
          runAssembler: async (node: ServiceNode) => ({
            ...(await fakeAssembler(node)),
            watch: [path.join(app.dir, 'built.txt')],
          }),
          alchemy: async () => {
            converges += 1;
            return { exitCode: 0, signal: null };
          },
          watch: (targets, onChange, onError) => {
            watchers.push({ paths: targets.flatMap((t) => t.paths), onChange, onError });
            return { ready: Promise.resolve(), stop: () => undefined };
          },
        },
      );
      if (!start.ok) throw new Error('expected a started session');
      const configFile = path.join(app.dir, 'prisma.config.ts');
      const configWatcher = watchers.find((w) => w.paths.includes(configFile));
      const buildWatcher = watchers.find((w) => !w.paths.includes(configFile));
      if (configWatcher === undefined || buildWatcher === undefined) {
        throw new Error('expected a config watcher and a build watcher');
      }
      return {
        session: start.value,
        events,
        configWatcher,
        buildWatcher,
        converges: () => converges,
        configFile,
      };
    }

    test('a save that leaves prisma.config.ts unchanged is ignored', async () => {
      const app = makeAppDir('hello-dev');
      await silently(async () => {
        const dev = await devWithFakeWatchers(app);
        fs.writeFileSync(dev.configFile, fs.readFileSync(dev.configFile));
        dev.configWatcher.onChange();
        dev.buildWatcher.onChange();
        await until(() => dev.converges() >= 2);

        expect(dev.events.filter((e) => e.kind === 'config-changed')).toEqual([]);
        expect(dev.converges()).toBe(2);
        await dev.session.stop();
      });
    }, 15_000);

    test('a failing config watcher is reported as a watch-error and dev keeps running', async () => {
      const app = makeAppDir('hello-dev');
      await silently(async () => {
        const dev = await devWithFakeWatchers(app);
        dev.configWatcher.onError?.(new Error('EMFILE: too many open files'));
        dev.buildWatcher.onChange();
        await until(() => dev.converges() >= 2);

        expect(dev.events).toContainEqual({
          kind: 'watch-error',
          message: 'EMFILE: too many open files',
        });
        expect(dev.converges()).toBe(2);
        await dev.session.stop();
      });
    }, 15_000);

    /**
     * A build watch on a directory that contains prisma.config.ts can fire
     * before the config watcher does. The rebuild must still see the edit.
     */
    test('a rebuild that fires before the config watcher still sees the edit and pauses', async () => {
      const app = makeAppDir('hello-dev');
      await silently(async () => {
        const dev = await devWithFakeWatchers(app);
        fs.writeFileSync(dev.configFile, 'export default { composer: 2 };\n');
        dev.buildWatcher.onChange();

        expect(dev.events.filter((e) => e.kind === 'config-changed')).toEqual([
          { kind: 'config-changed', file: dev.configFile },
        ]);
        expect(dev.converges()).toBe(1);
        await dev.session.stop();
      });
    }, 15_000);
  });

  test('stop() surfaces a service that refuses to stop as a stop-error event, and still finishes', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.reject(new Error('service pid 123 will not die')),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    const events: string[] = [];

    const result = await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      );
      if (!start.ok) throw new Error('expected a started session');
      await start.value.stop();
      await start.value.closed;
      return start;
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(['ready', 'unwatchable', 'stopping', 'stop-error', 'stopped']);
  }, 15_000);

  test('the DevSession contract: closed settles only via stop(), stop() is idempotent, and no process signal handler is ever registered', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([{ address: 'app', url: 'http://localhost:3000' }]),
      logs: async function* () {},
    };
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const events: string[] = [];

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      );
      if (!start.ok) throw new Error('expected a started session');
      expect(start.value.endpoints).toEqual([{ address: 'app', url: 'http://localhost:3000' }]);

      let settled = false;
      void start.value.closed.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      const firstStop = start.value.stop();
      const secondStop = start.value.stop();
      await firstStop;
      await secondStop;
      await start.value.closed;
      expect(settled).toBe(true);
    });

    expect(events.filter((kind) => kind === 'stopping')).toHaveLength(1);
    expect(events.filter((kind) => kind === 'stopped')).toHaveLength(1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  }, 15_000);

  test('a detached session is ready, watches nothing, is already closed, and stopping it stops nothing', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.resolve([{ address: 'app', url: 'http://localhost:3000' }]),
      logs: async function* () {},
    };
    const events: string[] = [];
    let watches = 0;

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          detach: true,
          onEvent: (event) => void events.push(event.kind),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
          watch: () => {
            watches += 1;
            throw new Error('a detached session must not watch');
          },
        },
      );
      if (!start.ok) throw new Error('expected a started session');
      expect(start.value.endpoints).toEqual([{ address: 'app', url: 'http://localhost:3000' }]);
      await start.value.closed;
      await start.value.stop();
    });

    expect(watches).toBe(0);
    expect(stops).toBe(0);
    expect(events).toEqual(['ready']);
  }, 15_000);

  test('a host onEvent that throws cannot prevent closed from settling', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: () => {
            throw new Error('host renderer blew up');
          },
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      );
      if (!start.ok) throw new Error('expected a started session');
      await start.value.stop();
      await start.value.closed;
      return start;
    });

    expect(result.ok).toBe(true);
  }, 15_000);

  test('.prisma-composer existing as a FILE is a pipeline failure, not a rejection', async () => {
    const app = makeAppDir('hello-dev');
    fs.writeFileSync(path.join(app.dir, '.prisma-composer'), 'not a directory');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    let convergeRan = false;

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            convergeRan = true;
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.STACK_WRITE_FAILED');
    expect(convergeRan).toBe(false);
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('log()', () => {
  test('a config the CLI would refuse is refused before the entry is loaded', async () => {
    const app = makeAppDir();
    const result = await silently(() =>
      logWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
          config: { value: {} as PrismaAppConfig, file: 'prisma.config.ts' },
        },
        {},
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toMatchObject({
      code: 'CONFIG.FIELD_INVALID',
      meta: { field: 'extensions' },
    });
  });

  test('merges every attachment into one stream and reports the running services', async () => {
    const attachments = [
      linesAttachment([{ address: 'a', url: 'http://a' }], [{ service: 'a', line: 'from-a' }]),
      linesAttachment([{ address: 'b', url: 'http://b' }], [{ service: 'b', line: 'from-b' }]),
    ];

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', config: composerConfig(fakeConfig()) },
        { identity: identityFor(attachments) },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.appName).toBe('app');
    expect([...result.value.services].sort((x, y) => x.address.localeCompare(y.address))).toEqual([
      { address: 'a', url: 'http://a' },
      { address: 'b', url: 'http://b' },
    ]);
    const lines = await collect(result.value.lines);
    expect(lines).toContainEqual({ service: 'a', line: 'from-a' });
    expect(lines).toContainEqual({ service: 'b', line: 'from-b' });
  });

  test('an address filter keeps only that service', async () => {
    const attachments = [
      linesAttachment(
        [
          { address: 'a', url: 'http://a' },
          { address: 'b', url: 'http://b' },
        ],
        [
          { service: 'a', line: 'from-a' },
          { service: 'b', line: 'from-b' },
        ],
      ),
    ];

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', address: 'a', config: composerConfig(fakeConfig()) },
        { identity: identityFor(attachments) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    expect(await collect(result.value.lines)).toEqual([{ service: 'a', line: 'from-a' }]);
  });

  test('an unknown address is an invalid-input failure naming the running services', async () => {
    const attachments = [linesAttachment([{ address: 'a', url: 'http://a' }], [])];

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', address: 'nope', config: composerConfig(fakeConfig()) },
        { identity: identityFor(attachments) },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('LOG.ADDRESS_UNKNOWN');
    expect(result.failure.message).toBe('no service "nope" in "app" — running services: a.');
  });

  test('zero running services is a valid attached result with an already-finished stream', async () => {
    const attachments = [linesAttachment([], [])];

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', config: composerConfig(fakeConfig()) },
        { identity: identityFor(attachments) },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.appName).toBe('app');
    expect(result.value.services).toEqual([]);
    expect(await collect(result.value.lines)).toEqual([]);
  });

  test('aborting the signal ends the merged iterable while a source is still live', async () => {
    const live = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* (signal) {
      yield { service: 'a', line: 'one' };
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const controller = new AbortController();

    const result = await silently(() =>
      logWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: 'service.ts',
          signal: controller.signal,
        },
        { identity: identityFor([live]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const seen: string[] = [];
    for await (const { line } of result.value.lines) {
      seen.push(line);
      controller.abort();
    }
    expect(seen).toEqual(['one']);
  });

  test('a transient endpoints() refusal right after a converge is retried, not a failure', async () => {
    let attempts = 0;
    const flaky: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(
            new CliStructuredError('DEV.EMULATOR_UNREACHABLE', 'connect ECONNREFUSED'),
          );
        }
        return Promise.resolve([{ address: 'a', url: 'http://a' }]);
      },
      logs: async function* () {},
    };

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', config: composerConfig(fakeConfig()) },
        { identity: identityFor([flaky]) },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.services).toEqual([{ address: 'a', url: 'http://a' }]);
    expect(attempts).toBe(2);
  }, 10_000);

  test('breaking out of the merged stream returns promptly even when a source ignores the signal', async () => {
    const stubborn = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      yield { service: 'a', line: 'one' };
      await new Promise<void>(() => undefined);
    });

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', config: composerConfig(fakeConfig()) },
        { identity: identityFor([stubborn]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const seen: string[] = [];
    for await (const { line } of result.value.lines) {
      seen.push(line);
      break;
    }
    expect(seen).toEqual(['one']);
  }, 5_000);

  test('lines.return() ends the stream promptly without aborting first', async () => {
    const stubborn = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      yield { service: 'a', line: 'one' };
      await new Promise<void>(() => undefined);
    });

    const result = await silently(() =>
      logWithDeps(
        { entry: 'service.ts', config: composerConfig(fakeConfig()) },
        { identity: identityFor([stubborn]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const iterator = result.value.lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ service: 'a', line: 'one' });
    expect(await iterator.return?.(undefined)).toEqual({ done: true, value: undefined });
  }, 5_000);

  test('a consumer that falls behind gets a bounded queue: oldest lines drop, a lines-dropped event says how many', async () => {
    const TOTAL = LOG_QUEUE_LIMIT * 2;
    const flood = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      for (let i = 0; i < TOTAL; i += 1) yield { service: 'a', line: String(i) };
    });
    const droppedCounts: number[] = [];

    const result = await silently(() =>
      logWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: 'service.ts',
          onEvent: (event) => {
            if (event.kind === 'lines-dropped') droppedCounts.push(event.count);
          },
        },
        { identity: identityFor([flood]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const seen: LogLine[] = [];
    for await (const line of result.value.lines) {
      seen.push(line);
      if (seen.length === 1) {
        // Stall once so the pump floods the queue past its bound.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const droppedTotal = droppedCounts.reduce((sum, count) => sum + count, 0);
    expect(droppedTotal).toBeGreaterThan(0);
    expect(seen.length + droppedTotal).toBe(TOTAL);
  }, 15_000);

  test('no event is delivered after the merged iterable has ended', async () => {
    let failLate: (() => void) | undefined;
    const lateFailer = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      yield { service: 'a', line: 'one' };
      await new Promise<void>((_resolve, reject) => {
        failLate = () => reject(new Error('daemon went away late'));
      });
    });
    const events: string[] = [];

    const result = await silently(() =>
      logWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: 'service.ts',
          onEvent: (event) => void events.push(event.kind),
        },
        { identity: identityFor([lateFailer]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    for await (const line of result.value.lines) {
      void line;
      break;
    }
    expect(failLate).toBeDefined();
    failLate?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);
  }, 5_000);

  test('a host onEvent that throws does not end the stream or reject a pump', async () => {
    const failing = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      yield { service: 'a', line: 'before-crash' };
      throw new Error('daemon went away');
    });
    const healthy = linesAttachment(
      [{ address: 'b', url: 'http://b' }],
      [{ service: 'b', line: 'still-here' }],
    );

    const result = await silently(() =>
      logWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: 'service.ts',
          onEvent: () => {
            throw new Error('host renderer blew up');
          },
        },
        { identity: identityFor([failing, healthy]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const lines = await collect(result.value.lines);
    expect(lines).toContainEqual({ service: 'a', line: 'before-crash' });
    expect(lines).toContainEqual({ service: 'b', line: 'still-here' });
  });

  test("one stream's failure raises a stream-failed event and leaves the other streams running", async () => {
    const failing = fakeAttachment([{ address: 'a', url: 'http://a' }], async function* () {
      yield { service: 'a', line: 'before-crash' };
      throw new Error('daemon went away');
    });
    const healthy = linesAttachment(
      [{ address: 'b', url: 'http://b' }],
      [{ service: 'b', line: 'still-here' }],
    );
    const events: string[] = [];

    const result = await silently(() =>
      logWithDeps(
        {
          config: composerConfig(fakeConfig()),
          entry: 'service.ts',
          onEvent: (event) => {
            if (event.kind === 'stream-failed') events.push(event.message);
          },
        },
        { identity: identityFor([failing, healthy]) },
      ),
    );

    if (!result.ok) throw new Error('expected attached');
    const lines = await collect(result.value.lines);
    expect(lines).toContainEqual({ service: 'a', line: 'before-crash' });
    expect(lines).toContainEqual({ service: 'b', line: 'still-here' });
    expect(events).toEqual(['daemon went away']);
  });
});

describe('deploy-run reporting', () => {
  interface ReporterLog {
    readonly events: string[];
    readonly reporter: NonNullable<ExtensionDescriptor['reporter']>;
  }

  /** Records the lifecycle the operations drive, and optionally fails at one of its steps. */
  function recordingReporter(
    opts: { readonly throwOn?: 'begin' | 'attach' | 'finish'; readonly none?: boolean } = {},
  ): ReporterLog {
    const events: string[] = [];
    const fail = (step: string) => {
      if (opts.throwOn === step) throw new Error(`reporting broke at ${step}`);
    };
    return {
      events,
      reporter: {
        begin: async (input) => {
          events.push(
            `begin:${input.appName}:${input.environment}:${input.reportId ?? 'no-id'}:` +
              `${input.credentials === undefined ? 'no-credentials' : 'credentials'}`,
          );
          fail('begin');
          if (opts.none === true) return undefined;
          return {
            childEnv: () => ({ FAKE_BUILD_ID: 'bld_1' }),
            attach: async (attachInput) => {
              events.push(`attach:${attachInput.container === undefined ? 'none' : 'container'}`);
              fail('attach');
            },
            finish: async (outcome) => {
              events.push(
                outcome.ok
                  ? 'finish:ok'
                  : outcome.cancelled
                    ? 'finish:cancelled'
                    : `finish:failed:${outcome.failingStep ?? 'unnamed'}`,
              );
              fail('finish');
            },
          };
        },
      },
    };
  }

  /** The reporting wrappers warn on a broken reporter, so these do not run inside silently(). */
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return await run();
    } finally {
      warnSpy.mockRestore();
    }
  };

  test('a successful deploy is begun, attached, and finished, and its build reaches the apply', async () => {
    const app = makeAppDir('reported-app');
    const log = recordingReporter();
    const requests: ConvergeRequest[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-1',
          cwd: app.dir,
          config: composerConfig(fakeConfig({ reporter: log.reporter })),
        },
        {
          runAssembler: fakeAssembler,
          converge: recordingConverge(requests),
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(log.events).toEqual([
      'begin:reported-app:ci-1:no-id:no-credentials',
      'attach:container',
      'finish:ok',
    ]);
    expect(requests[0]?.env['FAKE_BUILD_ID']).toBe('bld_1');
  });

  test('the engine credentials and the --build-id both reach begin', async () => {
    const app = makeAppDir('threaded-app');
    const log = recordingReporter({ none: true });

    await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-2',
          cwd: app.dir,
          reportId: 'bld_from_ci',
          config: composerConfig(fakeConfig({ reporter: log.reporter })),
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
          credentials: { workspaceId: 'ws-1', client: {} },
        },
      ),
    );

    expect(log.events).toEqual(['begin:threaded-app:ci-2:bld_from_ci:credentials']);
  });

  test('a container failure is still reported — the session opens before containers', async () => {
    const app = makeAppDir();
    const log = recordingReporter();
    const config = fakeConfig({ reporter: log.reporter });
    const extension = config.extensions[0];
    if (extension?.container === undefined) throw new Error('fixture must declare a container');
    const refusing: PrismaAppConfig = {
      ...config,
      extensions: [
        {
          ...extension,
          container: {
            ...extension.container,
            ensure: () => Promise.reject(new Error('the platform refused to create the project')),
          },
        },
        ...config.extensions.slice(1),
      ],
    };

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-3',
          cwd: app.dir,
          config: composerConfig(refusing),
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(log.events).toEqual([
      'begin:fixture-app:ci-3:no-id:no-credentials',
      'finish:failed:DEPLOY.CONTAINER_FAILED',
    ]);
  });

  test('an interrupted converge finishes the session as cancelled, not failed', async () => {
    const app = makeAppDir();
    const log = recordingReporter();

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-4',
          cwd: app.dir,
          config: composerConfig(fakeConfig({ reporter: log.reporter })),
        },
        {
          runAssembler: fakeAssembler,
          converge: async () => ({ kind: 'interrupted' }),
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(log.events.at(-1)).toBe('finish:cancelled');
  });

  test('the build report of a failed converge names the step and carries the engine cause in its message', async () => {
    const app = makeAppDir();
    const outcomes: RunOutcome[] = [];
    const config = fakeConfig({
      reporter: {
        begin: async () => ({
          childEnv: () => ({}),
          attach: async () => {},
          finish: async (outcome) => {
            outcomes.push(outcome);
          },
        }),
      },
    });

    await silently(() =>
      deployWithDeps(
        { entry: app.entryPath, environment: 'ci-6', cwd: app.dir, config: composerConfig(config) },
        {
          runAssembler: fakeAssembler,
          converge: async () => ({ kind: 'failed', cause: 'PrismaApiError: 409 Conflict' }),
        },
      ),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.failingStep).toBe('DEPLOY.ENGINE_FAILED');
    expect(outcomes[0]?.errorMessage).toBe(
      'Alchemy could not deploy the app.\nPrismaApiError: 409 Conflict',
    );
  });

  test('a reporter that throws at any step never fails the deploy', async () => {
    for (const step of ['begin', 'attach', 'finish'] as const) {
      const app = makeAppDir();
      const log = recordingReporter({ throwOn: step });

      const result = await quietly(() =>
        deployWithDeps(
          {
            entry: app.entryPath,
            environment: 'ci-5',
            cwd: app.dir,
            config: composerConfig(fakeConfig({ reporter: log.reporter })),
          },
          {
            runAssembler: fakeAssembler,
            converge: applied,
          },
        ),
      );

      expect({ step, ok: result.ok }).toEqual({ step, ok: true });
    }
  });

  test('destroy is not reported', async () => {
    const app = makeAppDir();
    const log = recordingReporter();

    await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig(fakeConfig({ reporter: log.reporter })),
          entry: app.entryPath,
          environment: 'staging',
          onEvent: undefined,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => ({ exitCode: 0, signal: null }),
        },
      ),
    );

    expect(log.events).toEqual([]);
  });

  test('--report writes the outcome, on success and on failure', async () => {
    const app = makeAppDir('reported-json');
    const target = path.join(app.dir, 'out', 'run.json');

    const ok = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-6',
          cwd: app.dir,
          reportPath: target,
          config: composerConfig(fakeConfig()),
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
        },
      ),
    );
    expect(ok.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({
      version: RUN_REPORT_VERSION,
      outcome: 'succeeded',
      environment: 'ci-6',
      failure: null,
    });

    const failedTarget = path.join(app.dir, 'failed.json');
    const failed = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          environment: 'ci-7',
          cwd: app.dir,
          reportPath: failedTarget,
          config: composerConfig(
            fakeConfig({
              preflight: () => Promise.reject(new Error('STRIPE_KEY is missing')),
            }),
          ),
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
        },
      ),
    );
    expect(failed.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(failedTarget, 'utf8'))).toMatchObject({
      outcome: 'failed',
      failure: { code: 'DEPLOY.PREFLIGHT_FAILED' },
    });
  });
});

/** `devConfigWith`, with the fixture build adapter declaring a dev server and the service descriptor able (or not) to reserve. */
function devServerConfigWith(
  attachment: LocalTargetAttachment,
  opts: { readonly reserve?: boolean } = {},
): PrismaAppConfig {
  const base = devConfigWith(attachment);
  const [target] = base.extensions;
  if (target === undefined) throw new Error('unreachable');
  return {
    ...base,
    extensions: [
      {
        ...target,
        nodes: {
          'fixture/compute': {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
            ...(opts.reserve === false ? {} : { reserve: unused }),
          },
        },
      },
      {
        id: 'fixture-build',
        nodes: {
          node: {
            kind: 'build',
            assemble: unused,
            serve: async () => ({
              cwd: '/app/web',
              argv: ({ port, host }) => ['next', 'dev', '-p', String(port), '-H', host],
              display: 'next dev',
            }),
          },
        },
      },
    ],
  };
}

describe.skipIf(process.platform === 'win32')('dev() — dev servers (ADR-0056)', () => {
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done() && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  test('a service with a dev server is announced before the converge, not assembled, lowered unassembled, served after resume, and its output streamed', async () => {
    const app = makeAppDir('hello-dev');
    const order: string[] = [];
    const served: { address: string; display: string; argv: readonly string[] }[] = [];
    const followed: (readonly string[] | undefined)[] = [];
    const attachment: LocalTargetAttachment = {
      startServices: async () => void order.push('startServices'),
      stopApp: () => Promise.resolve(),
      endpoints: async () => {
        order.push('endpoints');
        return [{ address: 'hello-dev.app', url: 'http://localhost:3001' }];
      },
      logs: async function* (_signal, opts) {
        followed.push(opts?.addresses);
        yield { service: 'hello-dev.app', line: '✓ Ready in 1.2s' };
      },
      serve: async ({ address, server }) => {
        order.push('serve');
        served.push({
          address,
          display: server.display,
          argv: server.argv({ port: 3001, host: '0.0.0.0' }),
        });
        return { restarted: true };
      },
    };
    const events: DevEvent[] = [];
    let stackFile = '';

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devServerConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event),
        },
        {
          runAssembler: () =>
            Promise.reject(new Error('a service with a dev server is not assembled')),
          alchemy: async () => {
            order.push('converge');
            stackFile = fs.readFileSync(
              path.join(app.dir, '.prisma-composer', 'dev', 'dev', 'alchemy.run.ts'),
              'utf8',
            );
            return { exitCode: 0, signal: null };
          },
        },
      );
      if (!start.ok) throw new Error(`expected a started session: ${start.failure.message}`);
      await until(() => events.some((event) => event.kind === 'dev-server-output'));
      expect(start.value.endpoints).toEqual([
        { address: 'hello-dev.app', url: 'http://localhost:3001', devServer: 'next dev' },
      ]);
      await start.value.stop();
    });

    expect(events[0]).toEqual({
      kind: 'dev-server',
      address: 'hello-dev.app',
      command: 'next dev',
      cwd: '/app/web',
    });
    expect(order).toEqual(['converge', 'startServices', 'serve', 'endpoints']);
    expect(stackFile).toContain('unassembled: ["hello-dev.app"],');
    expect(served).toEqual([
      {
        address: 'hello-dev.app',
        display: 'next dev',
        argv: ['next', 'dev', '-p', '3001', '-H', '0.0.0.0'],
      },
    ]);
    expect(followed).toEqual([['hello-dev.app']]);
    expect(events).toContainEqual({
      kind: 'dev-server-output',
      address: 'hello-dev.app',
      line: '✓ Ready in 1.2s',
    });
  }, 15_000);

  test('an edit to the entry module reconverges and serves again; a restart is reported', async () => {
    const app = makeAppDir('hello-dev');
    let serves = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
      serve: async () => {
        serves += 1;
        return { restarted: serves > 1 };
      },
    };
    const events: DevEvent[] = [];
    let converges = 0;

    await silently(async () => {
      const start = await devWithDeps(
        {
          config: composerConfig(devServerConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event),
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            converges += 1;
            return { exitCode: 0, signal: null };
          },
        },
      );
      if (!start.ok) throw new Error(`expected a started session: ${start.failure.message}`);

      fs.appendFileSync(app.entryPath, '// a topology edit\n');
      await until(() => events.some((event) => event.kind === 'dev-server-restarted'));
      await start.value.stop();
    });

    expect(converges).toBe(2);
    expect(serves).toBe(2);
    expect(events).toContainEqual({
      kind: 'dev-server-restarted',
      address: 'hello-dev.app',
      command: 'next dev',
    });
  }, 20_000);

  test('a service descriptor without reserve is DEV.DEV_SERVER_UNSUPPORTED before anything converges', async () => {
    const app = makeAppDir('hello-dev');
    let converges = 0;
    const attachment = fakeAttachment([], async function* () {});

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(
            devServerConfigWith({ ...attachment, serve: unused }, { reserve: false }),
          ),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            converges += 1;
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.DEV_SERVER_UNSUPPORTED');
    expect(result.failure.message).toBe(
      'service "hello-dev.app" runs a dev server but its descriptor (fixture-extension/fixture/compute) has no `reserve` step — update fixture-extension',
    );
    expect(converges).toBe(0);
  }, 15_000);

  test('a target whose attachment has no serve is DEV.DEV_SERVER_UNSUPPORTED before anything converges', async () => {
    const app = makeAppDir('hello-dev');
    let converges = 0;

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devServerConfigWith(fakeAttachment([], async function* () {}))),
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            converges += 1;
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.DEV_SERVER_UNSUPPORTED');
    expect(result.failure.message).toBe(
      'service "hello-dev.app" runs a dev server but its target\'s local attachment has no `serve` — update fixture-extension',
    );
    expect(converges).toBe(0);
  }, 15_000);

  test('a dev server that fails to start is DEV.SERVICE_START_FAILED, and the started services are stopped again', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: async () => {
        stops += 1;
      },
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
      serve: () =>
        Promise.reject(
          new Error(
            'service "app" exited (code 1) before it accepted connections on its port 3001. A dev server must listen on the port in its PORT variable.',
          ),
        ),
    };

    const result = await silently(() =>
      devWithDeps(
        {
          config: composerConfig(devServerConfigWith(attachment)),
          entry: app.entryPath,
          cwd: app.dir,
        },
        { runAssembler: fakeAssembler, alchemy: async () => ({ exitCode: 0, signal: null }) },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.SERVICE_START_FAILED');
    expect(result.failure.message).toContain(
      'A dev server must listen on the port in its PORT variable.',
    );
    expect(stops).toBe(1);
  }, 15_000);
});

const arktypeEntry = Bun.resolveSync('arktype', path.resolve(path.dirname(coreIndex), '..', '..'));

/** An app whose root declares `input: type({ GREETING: 'string' })` and forwards it to the service as `greeting`. */
function makeInputAppDir(): { dir: string; entryPath: string } {
  const app = makeAppDir('hello-input');
  fs.writeFileSync(
    app.entryPath,
    [
      `import { module, service } from ${JSON.stringify(coreIndex)};`,
      `import { type } from ${JSON.stringify(arktypeEntry)};`,
      '',
      'const app = service({',
      "  name: 'app',",
      "  extension: 'fixture-extension',",
      "  type: 'fixture/compute',",
      '  inputs: {},',
      '  params: {},',
      "  input: { '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value }) } },",
      "  build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' },",
      '});',
      '',
      "export default module('hello-input', { input: type({ GREETING: 'string' }) }, ({ input, provision }) => {",
      "  provision(app, { id: 'app', input: { greeting: input.GREETING } });",
      '});',
      '',
    ].join('\n'),
  );
  return app;
}

const throwingAdapter = (message: string) => () => {
  throw new Error(message);
};

describe('the operations read the pools from the config adapters', () => {
  test("deploy fills the root's input from the config adapters", async () => {
    const app = makeInputAppDir();
    const bindings: unknown[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig({
            ...fakeConfig({
              preflight: async (input) => {
                bindings.push(input.graph.inputBindings[0]?.binding);
                return undefined;
              },
            }),
            config: [() => ({ GREETING: 'from-adapter' })],
          }),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          converge: applied,
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(bindings).toEqual([{ greeting: 'from-adapter' }]);
  });

  test("deploy hands every extension's preflight both pools", async () => {
    const app = makeAppDir();
    const seen: unknown[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig({
            ...fakeConfig({
              preflight: async (input) => {
                seen.push(input.pools);
                return undefined;
              },
            }),
            config: [() => ({ A: 'a', B: 'b' }), () => ({ B: 'later' })],
            secrets: [() => ({ S: 's' })],
          }),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        { runAssembler: fakeAssembler, converge: applied },
      ),
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ config: { A: 'a', B: 'later' }, secrets: { S: 's' } }]);
  });

  test('destroy reads no secrets', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    let convergeRan = false;

    const result = await silently(() =>
      destroyWithDeps(
        {
          config: composerConfig({
            ...fakeConfig(),
            secrets: [throwingAdapter('destroy must not read secrets')],
          }),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        {
          runAssembler: fakeAssembler,
          alchemy: async () => {
            convergeRan = true;
            return { exitCode: 0, signal: null };
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(convergeRan).toBe(true);
  });

  test('a secrets pool value appears in no event, result or report', async () => {
    const app = makeAppDir();
    const sentinel = 'never-printed-7f3a';
    const events: DeployEvent[] = [];
    const received: string[] = [];
    const reportPath = path.join(app.dir, 'run.json');

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig({
            ...fakeConfig({
              preflight: async (input) => {
                const value = input.pools.secrets['S4_SENTINEL'];
                if (value !== undefined) received.push(value);
                input.report?.({ checked: 1, filled: 1, missing: 0 });
                return undefined;
              },
            }),
            secrets: [() => ({ S4_SENTINEL: sentinel })],
          }),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
          reportPath,
          onEvent: (event) => events.push(event),
        },
        { runAssembler: fakeAssembler, converge: applied },
      ),
    );

    expect(result.ok).toBe(true);
    expect(received).toEqual([sentinel]);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(JSON.stringify(event)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(fs.readFileSync(reportPath, 'utf8')).not.toContain(sentinel);
  });

  test('an adapter that fails stops deploy with CONFIG.ADAPTER_FAILED before any container is resolved', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          config: composerConfig({
            ...fakeConfig({}, { calls: containerCalls }),
            config: [throwingAdapter('vault down')],
          }),
          entry: app.entryPath,
          environment: 'staging',
          cwd: app.dir,
        },
        { runAssembler: fakeAssembler, converge: applied },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('CONFIG.ADAPTER_FAILED');
    expect(containerCalls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')(
  'the local operations and the config adapters',
  () => {
    const throwingLists = {
      config: [throwingAdapter('config must not be read')],
      secrets: [throwingAdapter('secrets must not be read')],
    };

    test('log, devUrl and devStop run no adapter', async () => {
      const app = makeAppDir('app');
      const attachment = linesAttachment([{ address: 'a', url: 'http://a' }], []);
      const recorded: LocalTargetCurrentApp = {
        app: 'app',
        addresses: ['app.app'],
        locate: async () => ({
          address: 'app.app',
          kind: 'service',
          emulator: 'running',
          url: 'http://localhost:3001',
          state: 'running',
          condition: 'running',
        }),
        stop: async () => [{ address: 'app.app', kind: 'service' }],
      };
      const base = configWith([attachment]);
      const [extension] = base.extensions;
      if (extension?.localTarget === undefined) throw new Error('the fixture has a local target');
      const localTarget = extension.localTarget;
      const config: PrismaAppConfig = {
        ...base,
        ...throwingLists,
        extensions: [
          {
            ...extension,
            localTarget: async () => ({ ...(await localTarget()), current: async () => recorded }),
          },
        ],
      };

      const log = await silently(() =>
        logWithDeps({ entry: app.entryPath, cwd: app.dir, config: composerConfig(config) }, {}),
      );
      const url = await devUrl({
        config: composerConfig(config),
        address: 'app.app',
        cwd: app.dir,
      });
      const stop = await devStop({
        config: composerConfig(config),
        entry: app.entryPath,
        cwd: app.dir,
      });

      expect(log.ok).toBe(true);
      expect(url.ok).toBe(true);
      expect(stop.ok).toBe(true);
    });

    const runningAttachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopApp: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    test('dev hands both pools to preflight and to a dev server', async () => {
      const app = makeAppDir('hello-dev');
      const seen: { preflight?: unknown; serve?: unknown } = {};
      const serving: LocalTargetAttachment = {
        ...runningAttachment,
        serve: async ({ pools }) => {
          seen.serve = pools;
          return { restarted: false };
        },
      };
      const base = devServerConfigWith(serving);
      const [extension, build] = base.extensions;
      if (extension?.localTarget === undefined || build === undefined) {
        throw new Error('the fixture has a local target and a build extension');
      }
      const localTarget = extension.localTarget;
      const config: PrismaAppConfig = {
        ...base,
        config: [() => ({ A: 'a' })],
        secrets: [() => ({ S: 's' })],
        extensions: [
          {
            ...extension,
            localTarget: async () => ({
              ...(await localTarget()),
              preflight: async (input) => {
                seen.preflight = input.pools;
                return undefined;
              },
            }),
          },
          build,
        ],
      };

      const result = await silently(() =>
        devWithDeps(
          { config: composerConfig(config), entry: app.entryPath, cwd: app.dir, detach: true },
          { runAssembler: fakeAssembler, alchemy: async () => ({ exitCode: 0, signal: null }) },
        ),
      );

      expect(result.ok).toBe(true);
      const pools = { config: { A: 'a' }, secrets: { S: 's' } };
      expect(seen).toEqual({ preflight: pools, serve: pools });
    }, 15_000);

    test('a value an adapter returns differently at a rebuild is reported, and rebuilds stop until dev restarts', async () => {
      const app = makeAppDir('hello-dev');
      const buildOutput = path.join(app.dir, 'built.txt');
      fs.writeFileSync(buildOutput, 'v1');
      const stackFile = path.join(app.dir, '.prisma-composer', 'dev', 'dev', 'alchemy.run.ts');
      const events: DevEvent[] = [];
      let converges = 0;
      let assembles = 0;
      let value = 'v1';
      const until = async (done: () => boolean) => {
        for (let waited = 0; !done() && waited < 5_000; waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const valuesChanges = () => events.filter((event) => event.kind === 'values-changed');

      await silently(async () => {
        const start = await devWithDeps(
          {
            config: composerConfig({
              ...devConfigWith(runningAttachment),
              config: [() => ({ VALUE: value })],
            }),
            entry: app.entryPath,
            cwd: app.dir,
            onEvent: (event) => void events.push(event),
          },
          {
            runAssembler: async (node: ServiceNode) => {
              assembles += 1;
              return { ...(await fakeAssembler(node)), watch: [buildOutput] };
            },
            alchemy: async () => {
              converges += 1;
              return { exitCode: 0, signal: null };
            },
          },
        );
        if (!start.ok) throw new Error('expected a started session');
        fs.rmSync(stackFile);

        value = 'v2';
        fs.writeFileSync(buildOutput, 'v2');
        await until(() => valuesChanges().length >= 1);
        const assemblesAfterPause = assembles;

        fs.writeFileSync(buildOutput, 'v3');
        await new Promise((resolve) => setTimeout(resolve, 500));

        await start.value.stop();
        await start.value.closed;
        expect(assembles).toBe(assemblesAfterPause);
      });

      expect(valuesChanges()).toEqual([{ kind: 'values-changed' }]);
      expect(fs.existsSync(stackFile)).toBe(false);
      expect(converges).toBe(1);
    }, 20_000);
  },
);
