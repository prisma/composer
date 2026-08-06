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
import { CliError } from '../../cli-error.ts';
import { DEPLOYMENT_RESULT_FILE_ENV, type DeploymentSummary } from '../../deployment-summary.ts';
import type { AppIdentity } from '../../pipeline.ts';
import type { RunAlchemyInput } from '../../run-alchemy.ts';
import { deploy } from '../deploy.ts';
import { destroy } from '../destroy.ts';
import { dev } from '../dev.ts';
import { type LogLine, log } from '../log.ts';

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
): { dir: string; entryPath: string; resultFilePath: string } {
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
  return {
    dir,
    entryPath,
    resultFilePath: path.join(dir, '.prisma-composer', 'deployment-result.json'),
  };
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
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            calls.push(input);
            const file = input.env?.[DEPLOYMENT_RESULT_FILE_ENV];
            if (typeof file === 'string') fs.writeFileSync(file, JSON.stringify(summaryFixture));
            return 0;
          },
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.[DEPLOYMENT_RESULT_FILE_ENV]).toBe(app.resultFilePath);
    expect(result).toEqual({ outcome: 'deployed', summary: summaryFixture });
  });

  test('a deploy whose child wrote no result file still succeeds, with an undefined summary', async () => {
    const app = makeAppDir('hello-ops');

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 0 },
      }),
    );

    expect(result).toEqual({ outcome: 'deployed', summary: undefined });
  });

  test('a malformed result file is treated as absent, never a deploy failure', async () => {
    const app = makeAppDir('hello-ops');

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: (input) => {
            const file = input.env?.[DEPLOYMENT_RESULT_FILE_ENV];
            if (typeof file === 'string') fs.writeFileSync(file, '{"app": 42, "nodes": "nope"');
            return 0;
          },
        },
      }),
    );

    expect(result).toEqual({ outcome: 'deployed', summary: undefined });
  });

  test("a previous run's stale result file is removed before alchemy spawns", async () => {
    const app = makeAppDir('hello-ops');
    fs.mkdirSync(path.dirname(app.resultFilePath), { recursive: true });
    fs.writeFileSync(app.resultFilePath, JSON.stringify(summaryFixture));
    let existedAtSpawn: boolean | undefined;

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => {
            existedAtSpawn = fs.existsSync(app.resultFilePath);
            return 0;
          },
        },
      }),
    );

    expect(existedAtSpawn).toBe(false);
    expect(result).toEqual({ outcome: 'deployed', summary: undefined });
  });

  test('an invalid stage ref is an invalid-input failure, before any container call', async () => {
    const app = makeAppDir();
    const containerCalls: ContainerCall[] = [];

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'bad..ref',
        cwd: app.dir,
        deps: {
          config: fakeConfig({}, { calls: containerCalls }),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        },
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure).toMatchObject({ kind: 'invalid-input' });
    expect(result.failure.message).toContain('Invalid --stage');
    expect(result.failure.cause).toBeInstanceOf(CliError);
    expect(containerCalls).toEqual([]);
  });

  test('a missing prisma-composer.config.ts is a pipeline failure naming the filename', async () => {
    const app = makeAppDir('no-config', { config: false });

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        cwd: app.dir,
        deps: { runAssembler: fakeAssembler, alchemy: () => 0 },
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toContain('prisma-composer.config.ts');
    expect(result.failure.cause).toBeInstanceOf(CliError);
  });

  test('an extension-preflight throw is a pipeline failure — alchemy never runs, no stack file is written', async () => {
    const app = makeAppDir('hello-preflight-fail');
    let alchemyRan = false;

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: {
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
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toContain('SECRET_X is not provisioned');
    expect(alchemyRan).toBe(false);
    expect(fs.existsSync(path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'))).toBe(false);
  });

  test('an alchemy exit 42 is an execution failure carrying the exit code and both hint fields', async () => {
    const app = makeAppDir();

    const result = await silently(() =>
      deploy({
        entry: app.entryPath,
        stage: 'ci-7',
        cwd: app.dir,
        deps: { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 42 },
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure).toEqual({
      kind: 'execution',
      message: 'alchemy deploy exited with status 42.',
      diagnostics: {
        exitCode: 42,
        stackFilePath: path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'),
        reproduceCommand: `alchemy deploy ${path.join('.prisma-composer', 'alchemy.run.ts')} --yes --stage ci-7`,
        cwd: app.dir,
      },
    });
  });

  test('a broken effect tree is a pipeline failure naming the mismatch — the executor cannot load, the host stays alive', () => {
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
    const probePath = path.join(dir, 'probe.ts');
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      probePath,
      `import { deploy } from ${JSON.stringify(operationsPath)};\n` +
        `const result = await deploy({ entry: 'service.ts', cwd: ${JSON.stringify(dir)} });\n` +
        'await Bun.write(\n' +
        `  ${JSON.stringify(resultPath)},\n` +
        '  JSON.stringify(result, (_key, value) =>\n' +
        '    value instanceof Error ? { name: value.name, message: value.message } : value,\n' +
        '  ),\n' +
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
      outcome: string;
      failure: { kind: string; message: string; cause: { name: string; message: string } };
    };
    expect(result.outcome).toBe('failed');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toContain('alchemy resolves effect@4.0.0-beta.102');
    expect(result.failure.cause).toEqual({
      name: 'Error',
      message: 'Schedule.either is not a function',
    });
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
        destroy({
          entry: app.entryPath,
          target,
          cwd: app.dir,
          deps: {
            config: fakeConfig({}, { calls: containerCalls, alchemyStage: 'br_x' }),
            runAssembler: fakeAssembler,
            alchemy: () => 0,
          },
        }),
      );

      expect(result).toEqual({ outcome: 'destroyed' });
      expect(containerCalls[0]).toEqual({
        op: 'locate',
        input: { appName: 'fixture-app', stage: expectedStage },
      });
    }
  });

  test('locate returning undefined is a pipeline failure naming the app and stage', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');

    const result = await silently(() =>
      destroy({
        entry: app.entryPath,
        target: { kind: 'stage', stage: 'staging' },
        cwd: app.dir,
        deps: {
          config: fakeConfig({}, { notFound: true }),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        },
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toBe(
      'Nothing deployed for fixture-app/staging — deploy it first.',
    );
  });

  test('a successful destroy runs alchemy, then every teardown, then every container removal', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const order: string[] = [];

    const result = await silently(() =>
      destroy({
        entry: app.entryPath,
        target: { kind: 'stage', stage: 'staging' },
        cwd: app.dir,
        deps: {
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
      }),
    );

    expect(result).toEqual({ outcome: 'destroyed' });
    expect(order).toEqual(['alchemy', 'teardown', 'remove']);
  });

  test('the no-local-deploy-state event fires before the pipeline runs', async () => {
    const app = makeAppDir();
    const order: string[] = [];

    const result = await silently(() =>
      destroy({
        entry: app.entryPath,
        target: { kind: 'stage', stage: 'staging' },
        cwd: app.dir,
        onEvent: (event) => void order.push(event.kind),
        deps: {
          config: fakeConfig(),
          runAssembler: async (node) => {
            order.push('assemble');
            return fakeAssembler(node);
          },
          alchemy: () => 0,
        },
      }),
    );

    expect(result).toEqual({ outcome: 'destroyed' });
    expect(order).toEqual(['no-local-deploy-state', 'assemble']);
  });

  test('no event fires when .alchemy holds state', async () => {
    const app = makeAppDir();
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const events: string[] = [];

    await silently(() =>
      destroy({
        entry: app.entryPath,
        target: { kind: 'stage', stage: 'staging' },
        cwd: app.dir,
        onEvent: (event) => void events.push(event.kind),
        deps: { config: fakeConfig(), runAssembler: fakeAssembler, alchemy: () => 0 },
      }),
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

describe('dev()', () => {
  test('a throw after services start (endpoint merge) is a pipeline failure, not a rejection', async () => {
    const app = makeAppDir('hello-dev');
    const attachment: LocalTargetAttachment = {
      startServices: () => Promise.resolve(),
      stopServices: () => Promise.resolve(),
      endpoints: () => Promise.reject(new Error('emulator admin refused the connection')),
      logs: async function* () {},
    };
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
    const config: PrismaAppConfig = {
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

    const result = await silently(() =>
      dev({
        entry: app.entryPath,
        cwd: app.dir,
        deps: { config, runAssembler: fakeAssembler, alchemy: () => 0 },
      }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toBe('emulator admin refused the connection');
  }, 15_000);
});

describe('log()', () => {
  test('merges every attachment into one stream and reports the running services', async () => {
    const attachments = [
      linesAttachment([{ address: 'a', url: 'http://a' }], [{ service: 'a', line: 'from-a' }]),
      linesAttachment([{ address: 'b', url: 'http://b' }], [{ service: 'b', line: 'from-b' }]),
    ];

    const result = await silently(() =>
      log({ entry: 'service.ts', deps: { identity: identityFor(attachments) } }),
    );

    expect(result.outcome).toBe('attached');
    if (result.outcome !== 'attached') throw new Error('unreachable');
    expect(result.appName).toBe('app');
    expect([...result.services].sort((x, y) => x.address.localeCompare(y.address))).toEqual([
      { address: 'a', url: 'http://a' },
      { address: 'b', url: 'http://b' },
    ]);
    const lines = await collect(result.lines);
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
      log({ entry: 'service.ts', address: 'a', deps: { identity: identityFor(attachments) } }),
    );

    if (result.outcome !== 'attached') throw new Error('expected attached');
    expect(await collect(result.lines)).toEqual([{ service: 'a', line: 'from-a' }]);
  });

  test('an unknown address is an invalid-input failure naming the running services', async () => {
    const attachments = [linesAttachment([{ address: 'a', url: 'http://a' }], [])];

    const result = await silently(() =>
      log({ entry: 'service.ts', address: 'nope', deps: { identity: identityFor(attachments) } }),
    );

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('invalid-input');
    expect(result.failure.message).toBe('no service "nope" in "app" — running services: a.');
  });

  test('zero running services is a valid attached result with an already-finished stream', async () => {
    const attachments = [linesAttachment([], [])];

    const result = await silently(() =>
      log({ entry: 'service.ts', deps: { identity: identityFor(attachments) } }),
    );

    expect(result.outcome).toBe('attached');
    if (result.outcome !== 'attached') throw new Error('unreachable');
    expect(result.appName).toBe('app');
    expect(result.services).toEqual([]);
    expect(await collect(result.lines)).toEqual([]);
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
      log({
        entry: 'service.ts',
        signal: controller.signal,
        deps: { identity: identityFor([live]) },
      }),
    );

    if (result.outcome !== 'attached') throw new Error('expected attached');
    const seen: string[] = [];
    for await (const { line } of result.lines) {
      seen.push(line);
      controller.abort();
    }
    expect(seen).toEqual(['one']);
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
      log({
        entry: 'service.ts',
        onEvent: (event) => void events.push(event.message),
        deps: { identity: identityFor([failing, healthy]) },
      }),
    );

    if (result.outcome !== 'attached') throw new Error('expected attached');
    const lines = await collect(result.lines);
    expect(lines).toContainEqual({ service: 'a', line: 'before-crash' });
    expect(lines).toContainEqual({ service: 'b', line: 'still-here' });
    expect(events).toEqual(['daemon went away']);
  });
});
