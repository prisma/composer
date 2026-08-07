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
} from '@internal/core/config';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import * as Layer from 'effect/Layer';
import { DEPLOYMENT_RESULT_FILE_ENV, type DeploymentSummary } from '../../deployment-summary.ts';
import type { AppIdentity } from '../../pipeline.ts';
import type { RunAlchemyInput } from '../../run-alchemy.ts';
import { deployWithDeps } from '../deploy.ts';
import { destroyWithDeps } from '../destroy.ts';
import { devWithDeps } from '../dev.ts';
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
  hooks: Partial<Pick<ExtensionDescriptor, 'teardown' | 'preflight'>> = {},
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
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: unused } } },
    ],
    state: { extension: 'fixture-extension', create: unused },
  };
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

function makeAppDir(
  name = 'fixture-app',
  opts: { config?: boolean } = {},
): { dir: string; entryPath: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-ops-')));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  if (opts.config !== false) {
    fs.writeFileSync(
      path.join(dir, 'prisma-composer.config.ts'),
      '// fixture config — discovery target only; tests inject deps.config instead of evaluating this\nexport default {};\n',
    );
  }
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

const summaryFixture: DeploymentSummary = {
  app: 'hello-ops',
  nodes: [{ address: 'app', entities: [{ kind: 'compute-service', id: 'cps_1' }] }],
};

describe('deploy()', () => {
  test('a successful deploy passes the result-file env var to alchemy and returns the summary the child wrote', async () => {
    const app = makeAppDir('hello-ops');
    const calls: RunAlchemyInput[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            calls.push(input);
            const file = input.env?.[DEPLOYMENT_RESULT_FILE_ENV];
            if (typeof file === 'string') fs.writeFileSync(file, JSON.stringify(summaryFixture));
            return 0;
          },
        },
      ),
    );

    expect(calls).toHaveLength(1);
    const resultFile = calls[0]?.env?.[DEPLOYMENT_RESULT_FILE_ENV];
    expect(resultFile).toStartWith(path.join(app.dir, '.prisma-composer', 'deployment-result-'));
    expect(resultFile).toEndWith('.json');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.summary).toEqual(summaryFixture);
    // Read once, then removed — nothing left for a later run to misread.
    expect(fs.existsSync(resultFile ?? '')).toBe(false);
  });

  test('a deploy whose child wrote no result file still succeeds, with an undefined summary', async () => {
    const app = makeAppDir('hello-ops');

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 0 },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.summary).toBeUndefined();
  });

  test('a malformed result file is treated as absent, never a deploy failure', async () => {
    const app = makeAppDir('hello-ops');

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            const file = input.env?.[DEPLOYMENT_RESULT_FILE_ENV];
            if (typeof file === 'string') fs.writeFileSync(file, '{"app": 42, "nodes": "nope"');
            return 0;
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.summary).toBeUndefined();
  });

  test("each run's result file is its own — a stale file from another run is never read, and two runs never share a path", async () => {
    const app = makeAppDir('hello-ops');
    fs.mkdirSync(path.join(app.dir, '.prisma-composer'), { recursive: true });
    fs.writeFileSync(
      path.join(app.dir, '.prisma-composer', 'deployment-result-99999-stale.json'),
      JSON.stringify(summaryFixture),
    );
    const resultFiles: (string | undefined)[] = [];
    const deps = {
      config: fakeConfig(),
      runAssembler: fakeAssembler,
      alchemy: (input: RunAlchemyInput) => {
        resultFiles.push(input.env?.[DEPLOYMENT_RESULT_FILE_ENV]);
        return 0;
      },
    };

    const first = await silently(() =>
      deployWithDeps({ entry: app.entryPath, stage: 'ci-7', cwd: app.dir }, deps),
    );
    const second = await silently(() =>
      deployWithDeps({ entry: app.entryPath, stage: 'ci-7', cwd: app.dir }, deps),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(resultFiles).toHaveLength(2);
    expect(resultFiles[0]).not.toBe(resultFiles[1]);
  });

  test('a failed deploy removes the result file the child already wrote', async () => {
    const app = makeAppDir('hello-ops');
    let resultFile: string | undefined;

    const result = await silently(() =>
      deployWithDeps(
        { entry: app.entryPath, stage: 'ci-7', cwd: app.dir },
        {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            resultFile = input.env?.[DEPLOYMENT_RESULT_FILE_ENV];
            if (typeof resultFile === 'string') {
              fs.writeFileSync(resultFile, JSON.stringify(summaryFixture));
            }
            return 1;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(resultFile).toBeDefined();
    expect(fs.existsSync(resultFile ?? '')).toBe(false);
  });

  test('the summary round-trips through a real child process writing via the report writer', async () => {
    const app = makeAppDir('hello-ops');
    const writerPath = fileURLToPath(new URL('../../deployment-summary.ts', import.meta.url));
    const childPath = path.join(app.dir, 'report-child.ts');
    fs.writeFileSync(
      childPath,
      `import { writeDeploymentSummaryFile } from ${JSON.stringify(writerPath)};\n` +
        'const result = {\n' +
        "  app: 'hello-ops',\n" +
        "  nodes: [{ address: 'app', node: undefined, entities: [{ kind: 'compute-service', id: 'cps_1' }] }],\n" +
        '} as never;\n' +
        'writeDeploymentSummaryFile(result);\n',
    );

    const result = await silently(() =>
      deployWithDeps(
        { entry: app.entryPath, stage: 'ci-7', cwd: app.dir },
        {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            const child = spawnSync(process.execPath, [childPath], {
              cwd: app.dir,
              env: input.env,
              encoding: 'utf-8',
            });
            expect(child.stderr).toBe('');
            return child.status ?? 1;
          },
        },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.summary).toEqual(summaryFixture);
  }, 15_000);

  test('an invalid stage ref is an invalid-input failure, before any container call', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'bad..ref',
          cwd: app.dir,
        },
        {
          config: fakeConfig({}, { calls: containerCalls }),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.STAGE_INVALID');
    expect(result.failure.message).toContain('Invalid --stage');
    expect(containerCalls).toEqual([]);
  });

  test('a missing prisma-composer.config.ts is a pipeline failure naming the filename', async () => {
    const app = makeAppDir('no-config', { config: false });

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
        },
        { runAssembler: fakeAssembler, alchemy: () => 0 },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('CONFIG.FILE_MISSING');
    expect(result.failure.message).toContain('prisma-composer.config.ts');
  });

  test('an extension-preflight throw is a pipeline failure — alchemy never runs, no stack file is written', async () => {
    const app = makeAppDir('hello-preflight-fail');
    let alchemyRan = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        {
          config: fakeConfig({
            preflight: async () => {
              throw new Error('SECRET_X is not provisioned');
            },
          }),
          runAssembler: fakeAssembler,
          alchemy: () => {
            alchemyRan = true;
            return 0;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.PREFLIGHT_FAILED');
    expect(result.failure.message).toContain('SECRET_X is not provisioned');
    expect(alchemyRan).toBe(false);
    expect(fs.existsSync(path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'))).toBe(false);
  });

  test('an alchemy exit 42 is an execution failure carrying the exit code and both hint fields', async () => {
    const app = makeAppDir();

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 42 },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.ENGINE_FAILED');
    expect(result.failure.message).toBe('alchemy deploy exited with status 42.');
    expect(executionDiagnostics(result.failure)).toEqual({
      exitCode: 42,
      stackFilePath: path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'),
      reproduceCommand: `alchemy deploy ${path.join('.prisma-composer', 'alchemy.run.ts')} --yes --stage ci-7`,
      cwd: app.dir,
    });
  });

  test('.prisma-composer existing as a FILE is a pipeline failure, not a rejection', async () => {
    const app = makeAppDir('hello-ops');
    fs.writeFileSync(path.join(app.dir, '.prisma-composer'), 'not a directory');
    let alchemyRan = false;

    const result = await silently(() =>
      deployWithDeps(
        {
          entry: app.entryPath,
          stage: 'ci-7',
          cwd: app.dir,
        },
        {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => {
            alchemyRan = true;
            return 0;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.STACK_WRITE_FAILED');
    expect(alchemyRan).toBe(false);
  });

  test('a broken effect tree is a structured failure naming the mismatch — the executor cannot load, the host stays alive', () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-ops-effect-')),
    );
    tmpDirs.push(dir);
    const writePackage = (segments: readonly string[], manifest: Record<string, unknown>) => {
      const pkgDir = path.join(dir, ...segments);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ main: 'index.js', ...manifest }),
      );
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');
    };
    writePackage(['node_modules', 'alchemy'], { name: 'alchemy', version: '2.0.0-beta.59' });
    writePackage(['node_modules', 'effect'], { name: 'effect', version: '4.0.0-beta.102' });
    writePackage(['node_modules', '@prisma', 'composer'], {
      name: '@prisma/composer',
      version: '0.0.0',
      dependencies: { effect: '4.0.0-beta.93' },
    });

    // In a broken tree the executor's own import of alchemy throws. The repo's
    // tree is healthy, so a fresh bun process reproduces that throw with a
    // plugin that fails the executor's load; deploy() must diagnose it against
    // `cwd`'s tree and return a structured failure — silent stdio, exit 0.
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
        `const result = await deploy({ entry: 'service.ts', cwd: ${JSON.stringify(dir)} });\n` +
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
    expect(result.envelope.code).toBe('DEPS.EFFECT_VERSION_CONFLICT');
    expect(result.envelope.summary).toContain('alchemy resolves effect@4.0.0-beta.102');
    expect(result.cause).toEqual({
      name: 'Error',
      message: 'Schedule.either is not a function',
    });
  });
});

describe('executorLoadFailure()', () => {
  test("an undiagnosed load failure names the failing operation in DEPS.EXECUTOR_UNLOADABLE's summary and why", () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-ops-load-')),
    );
    tmpDirs.push(dir);

    for (const operation of ['deploy', 'destroy', 'dev', 'log'] as const) {
      const failure = executorLoadFailure(operation, new Error('import blew up'), dir);
      expect(failure.code).toBe('DEPS.EXECUTOR_UNLOADABLE');
      expect(failure.message).toBe(`Could not load the ${operation} executor: import blew up`);
      expect(failure.why).toContain(`The ${operation} operation's executor`);
    }
  });
});

describe('destroy()', () => {
  test('a stage target locates the container with that stage; production locates with stage undefined', async () => {
    for (const [target, expectedStage] of [
      [{ kind: 'stage', stage: 'staging' }, 'staging'],
      [{ kind: 'production' }, undefined],
    ] as const) {
      const app = makeAppDir();
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
      const containerCalls: ContainerCall[] = [];

      const result = await silently(() =>
        destroyWithDeps(
          {
            entry: app.entryPath,
            target,
            cwd: app.dir,
          },
          {
            config: fakeConfig({}, { calls: containerCalls, alchemyStage: 'br_x' }),
            runAssembler: fakeAssembler,
            alchemy: () => 0,
          },
        ),
      );

      expect(result.ok).toBe(true);
      expect(containerCalls[0]).toEqual({
        op: 'locate',
        input: { appName: 'fixture-app', stage: expectedStage },
      });
    }
  });

  test('locate returning undefined is a structured failure naming the app and stage', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');

    const result = await silently(() =>
      destroyWithDeps(
        {
          entry: app.entryPath,
          target: { kind: 'stage', stage: 'staging' },
          cwd: app.dir,
        },
        {
          config: fakeConfig({}, { notFound: true }),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEPLOY.TARGET_NOT_FOUND');
    expect(result.failure.message).toBe('Nothing deployed for fixture-app/staging.');
    expect(result.failure.fix).toBe('Deploy it first.');
  });

  test('a successful destroy runs alchemy, then every teardown, then every container removal', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const order: string[] = [];

    const result = await silently(() =>
      destroyWithDeps(
        {
          entry: app.entryPath,
          target: { kind: 'stage', stage: 'staging' },
          cwd: app.dir,
        },
        {
          config: fakeConfig(
            { teardown: async () => void order.push('teardown') },
            { onRemove: () => void order.push('remove') },
          ),
          runAssembler: fakeAssembler,
          alchemy: () => {
            order.push('alchemy');
            return 0;
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
          entry: app.entryPath,
          target: { kind: 'stage', stage: 'staging' },
          cwd: app.dir,
          onEvent: (event) => void order.push(event.kind),
        },
        {
          config: fakeConfig(),
          runAssembler: async (node) => {
            order.push('assemble');
            return fakeAssembler(node);
          },
          alchemy: () => 0,
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
          entry: app.entryPath,
          target: { kind: 'stage', stage: 'staging' },
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 0 },
      ),
    );

    expect(events).toEqual([]);
  });
});

interface Endpoint {
  readonly address: string;
  readonly url: string;
}

function localContainer(): ContainerInstance {
  return { input: { appName: 'app', stage: undefined }, serialize: () => 'x' };
}

function fakeAttachment(
  endpoints: readonly Endpoint[],
  logs: LocalTargetAttachment['logs'],
): LocalTargetAttachment {
  return {
    startServices: () => Promise.resolve(),
    stopServices: () => Promise.resolve(),
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
  return { configPath: 'c', config: configWith(attachments), name: 'app' };
}

async function collect(lines: AsyncIterable<LogLine>): Promise<LogLine[]> {
  const out: LogLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** A config whose one extension both deploys the fixture nodes and offers a local target — what dev() needs end to end. */
function devConfigWith(attachment: LocalTargetAttachment): PrismaAppConfig {
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

describe('dev()', () => {
  test('a throw after services start (endpoint merge) is a pipeline failure, and the started services are stopped again', async () => {
    const app = makeAppDir('hello-dev');
    let stops = 0;
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopServices: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.reject(new Error('emulator admin refused the connection')),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
        },
        { config: devConfigWith(attachment), runAssembler: fakeAssembler, alchemy: () => 0 },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.ATTACH_FAILED');
    expect(result.failure.message).toBe('emulator admin refused the connection');
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
      stopServices: () => {
        stops += 1;
        return Promise.resolve();
      },
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(() =>
      devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
        },
        { config: devConfigWith(attachment), runAssembler: fakeAssembler, alchemy: () => 0 },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.SERVICE_START_FAILED');
    expect(result.failure.message).toBe('service two failed to bind its port');
    expect(stops).toBe(1);
  }, 15_000);

  test('stop() surfaces a service that refuses to stop as a stop-error event, and still finishes', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopServices: () => Promise.reject(new Error('service pid 123 will not die')),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    const events: string[] = [];

    const result = await silently(async () => {
      const start = await devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        { config: devConfigWith(attachment), runAssembler: fakeAssembler, alchemy: () => 0 },
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
      stopServices: () => Promise.resolve(),
      endpoints: () => Promise.resolve([{ address: 'app', url: 'http://localhost:3000' }]),
      logs: async function* () {},
    };
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const events: string[] = [];

    await silently(async () => {
      const start = await devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: (event) => void events.push(event.kind),
        },
        { config: devConfigWith(attachment), runAssembler: fakeAssembler, alchemy: () => 0 },
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

  test('a host onEvent that throws cannot prevent closed from settling', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopServices: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };

    const result = await silently(async () => {
      const start = await devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
          onEvent: () => {
            throw new Error('host renderer blew up');
          },
        },
        { config: devConfigWith(attachment), runAssembler: fakeAssembler, alchemy: () => 0 },
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
      stopServices: () => Promise.resolve(),
      endpoints: () => Promise.resolve([]),
      logs: async function* () {},
    };
    let alchemyRan = false;

    const result = await silently(() =>
      devWithDeps(
        {
          entry: app.entryPath,
          cwd: app.dir,
        },
        {
          config: devConfigWith(attachment),
          runAssembler: fakeAssembler,
          alchemy: () => {
            alchemyRan = true;
            return 0;
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DEV.STACK_WRITE_FAILED');
    expect(alchemyRan).toBe(false);
  }, 15_000);
});

describe('log()', () => {
  test('merges every attachment into one stream and reports the running services', async () => {
    const attachments = [
      linesAttachment([{ address: 'a', url: 'http://a' }], [{ service: 'a', line: 'from-a' }]),
      linesAttachment([{ address: 'b', url: 'http://b' }], [{ service: 'b', line: 'from-b' }]),
    ];

    const result = await silently(() =>
      logWithDeps({ entry: 'service.ts' }, { identity: identityFor(attachments) }),
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
      logWithDeps({ entry: 'service.ts', address: 'a' }, { identity: identityFor(attachments) }),
    );

    if (!result.ok) throw new Error('expected attached');
    expect(await collect(result.value.lines)).toEqual([{ service: 'a', line: 'from-a' }]);
  });

  test('an unknown address is an invalid-input failure naming the running services', async () => {
    const attachments = [linesAttachment([{ address: 'a', url: 'http://a' }], [])];

    const result = await silently(() =>
      logWithDeps({ entry: 'service.ts', address: 'nope' }, { identity: identityFor(attachments) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('LOG.ADDRESS_UNKNOWN');
    expect(result.failure.message).toBe('no service "nope" in "app" — running services: a.');
  });

  test('zero running services is a valid attached result with an already-finished stream', async () => {
    const attachments = [linesAttachment([], [])];

    const result = await silently(() =>
      logWithDeps({ entry: 'service.ts' }, { identity: identityFor(attachments) }),
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
      stopServices: () => Promise.resolve(),
      endpoints: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve([{ address: 'a', url: 'http://a' }]);
      },
      logs: async function* () {},
    };

    const result = await silently(() =>
      logWithDeps({ entry: 'service.ts' }, { identity: identityFor([flaky]) }),
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
      logWithDeps({ entry: 'service.ts' }, { identity: identityFor([stubborn]) }),
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
      logWithDeps({ entry: 'service.ts' }, { identity: identityFor([stubborn]) }),
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
