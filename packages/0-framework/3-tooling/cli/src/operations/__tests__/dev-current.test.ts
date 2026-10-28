/**
 * `devUrl` and `devStop` against a fake local target: how the operations
 * turn what a target recorded into results and structured failures.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrismaAppConfig } from '@internal/core/config';
import type {
  LocalNodeLocation,
  LocalTargetCurrentApp,
  LocalTargetCurrentInput,
  LocalTargetDescriptor,
} from '@internal/core/local-target';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import * as Layer from 'effect/Layer';
import { devStop, devUrl } from '../dev-current.ts';

const unused = () => {
  throw new Error('not used by devUrl or devStop');
};

let cwd: string;
let stopped: string[];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-current-'));
  fs.writeFileSync(path.join(cwd, 'prisma.config.ts'), '');
  stopped = [];
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function recordedApp(locations: readonly LocalNodeLocation[]): LocalTargetCurrentApp {
  return {
    app: 'shop',
    addresses: locations.map((l) => l.address),
    locate: async (address) => locations.find((l) => l.address === address),
    stop: async () => {
      stopped.push('shop');
      return locations.map(({ address, kind }) => ({ address, kind }));
    },
  };
}

const VALID_MODULE = path.join(
  import.meta.dir,
  '..',
  '..',
  '__tests__',
  'fixtures',
  'valid-module.ts',
);

function configWith(current: LocalTargetDescriptor['current'], entry?: string): PrismaAppConfig {
  const descriptor: LocalTargetDescriptor = {
    providers: () => Layer.empty,
    container: {
      ensure: unused,
      locate: unused,
      remove: unused,
      deserialize: unused,
    },
    attach: unused,
    ...(current !== undefined ? { current } : {}),
  };
  return {
    extensions: [
      {
        id: 'fixture',
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
      },
    ],
    state: { extension: 'fixture', create: unused },
    ...(entry !== undefined ? { entry } : {}),
  };
}

function config(current: LocalTargetDescriptor['current'], entry?: string) {
  return { value: configWith(current, entry), file: 'prisma.config.ts' };
}

/** A target that records what it was asked for and answers with `app`. */
function asked(app: LocalTargetCurrentApp | undefined) {
  const inputs: LocalTargetCurrentInput[] = [];
  const current = async (input: LocalTargetCurrentInput) => {
    inputs.push(input);
    return app;
  };
  return { inputs, current };
}

const running: LocalNodeLocation[] = [
  {
    address: 'gateway',
    kind: 'service',
    emulator: 'running',
    url: 'http://localhost:3001',
    state: 'running',
    condition: 'running',
  },
  {
    address: 'catalog',
    kind: 'database',
    emulator: 'running',
    url: 'postgres://x',
    state: 'stopped',
    condition: 'stopped',
  },
  {
    address: 'quotes',
    kind: 'service',
    emulator: 'running',
    url: 'http://localhost:3002',
    state: 'backoff',
    condition: 'crashing',
    logPath: '/logs/quotes.log',
  },
  {
    address: 'orders',
    kind: 'service',
    emulator: 'running',
    state: 'missing',
    condition: 'missing',
  },
  { address: 'uploads', kind: 'bucket', emulator: 'not-running' },
];

describe.skipIf(process.platform === 'win32')('devUrl', () => {
  test("returns a running node's URL, kind and state", async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'gateway',
      cwd,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        address: 'gateway',
        kind: 'service',
        url: 'http://localhost:3001',
        state: 'running',
      },
    });
  });

  test('says what a service runs: its artifact, or its dev server (ADR-0056); a database runs neither', async () => {
    const located: LocalNodeLocation[] = [
      ...running,
      {
        address: 'web',
        kind: 'service',
        emulator: 'running',
        url: 'http://localhost:3003',
        state: 'running',
        condition: 'running',
        command: ['/app/node_modules/next/dist/bin/next', 'dev', '-p', '3003', '-H', '0.0.0.0'],
      },
      {
        address: 'pages',
        kind: 'database',
        emulator: 'running',
        url: 'postgres://y',
        state: 'running',
        condition: 'running',
      },
    ];
    const runs = async (address: string) => {
      const result = await devUrl({
        config: config(async () => recordedApp(located)),
        address,
        cwd,
      });
      return result.ok ? result.value.runs : result.failure.code;
    };

    expect(await runs('gateway')).toBe('artifact');
    expect(await runs('web')).toBe('dev-server');
    expect(await runs('pages')).toBeUndefined();
  });

  test("reads the app from the address and the environment's folder, dev unless another is named, without importing the entry", async () => {
    const target = asked(
      recordedApp([
        {
          address: 'shop.gateway',
          kind: 'service',
          emulator: 'running',
          url: 'http://localhost:3001',
          state: 'running',
          condition: 'running',
        },
      ]),
    );
    const missingEntry = path.join(cwd, 'does-not-exist.ts');

    const inDev = await devUrl({
      config: config(target.current, missingEntry),
      address: 'shop.gateway',
      cwd,
    });
    await devUrl({
      config: config(target.current, missingEntry),
      address: 'shop.gateway',
      environment: 'feature/x',
      cwd,
    });

    expect(inDev.ok).toBe(true);
    expect(target.inputs).toEqual([
      { devDir: path.join(cwd, '.prisma-composer', 'dev', 'dev'), app: 'shop', environment: 'dev' },
      {
        devDir: path.join(cwd, '.prisma-composer', 'dev', 'feature%2Fx'),
        app: 'shop',
        environment: 'feature/x',
      },
    ]);
  });

  test('an app with nothing recorded in the environment fails with DEV.NOT_STARTED_HERE, naming both', async () => {
    const result = await devUrl({
      config: config(async () => undefined),
      address: 'shop.gateway',
      environment: 'test',
      cwd,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'DEV.NOT_STARTED_HERE', meta: { app: 'shop', environment: 'test' } },
    });
    if (!result.ok) {
      expect(result.failure.message).toContain('shop in the environment test');
      expect(result.failure.fix).toContain('`prisma dev --environment test`');
    }
  });

  test('an environment name git would refuse fails before any target is asked', async () => {
    const target = asked(recordedApp(running));

    const result = await devUrl({
      config: config(target.current),
      address: 'shop.gateway',
      environment: 'bad..name',
      cwd,
    });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEPLOY.ENVIRONMENT_INVALID' } });
    expect(target.inputs).toEqual([]);
  });

  test('a target that records nothing counts as nothing recorded', async () => {
    const result = await devUrl({ config: config(undefined), address: 'gateway', cwd });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.NOT_STARTED_HERE' } });
  });

  test('an address the app does not have fails with DEV.ADDRESS_UNKNOWN, listing the known ones', async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'reviews',
      cwd,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'DEV.ADDRESS_UNKNOWN',
        meta: { known: ['catalog', 'gateway', 'orders', 'quotes', 'uploads'] },
      },
    });
  });

  test('a node whose emulator is not running fails with DEV.EMULATOR_UNREACHABLE', async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'uploads',
      cwd,
    });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.EMULATOR_UNREACHABLE' } });
  });

  test('a stopped node fails with DEV.NOT_RUNNING, saying what stops a node and how it is started again', async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'catalog',
      cwd,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'DEV.NOT_RUNNING', meta: { state: 'stopped' } },
    });
    if (!result.ok) {
      expect(result.failure.message).toBe('The database "catalog" is stopped.');
      expect(result.failure.why).toContain('`prisma dev stop`');
      expect(result.failure.why).toContain('`prisma dev` ending');
      expect(result.failure.why).not.toContain('another app');
      expect(result.failure.fix).toContain('prisma dev');
    }
  });

  test('a crash-looping service says so and points at its log, not at `prisma dev`', async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'quotes',
      cwd,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'DEV.NOT_RUNNING', meta: { state: 'backoff', logPath: '/logs/quotes.log' } },
    });
    if (!result.ok) {
      expect(result.failure.why).toContain('restarted');
      expect(result.failure.fix).toContain('/logs/quotes.log');
      expect(result.failure.fix).not.toContain('prisma dev');
    }
  });

  test('a node its emulator lost says so, and that `prisma dev` creates it again', async () => {
    const result = await devUrl({
      config: config(async () => recordedApp(running)),
      address: 'orders',
      cwd,
    });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.NOT_RUNNING' } });
    if (!result.ok) {
      expect(result.failure.why).toContain('no longer has it');
      expect(result.failure.fix).toContain('creates the service again');
    }
  });

  test("a target's failure with no code becomes DEV.EMULATOR_FAILED, and a coded one keeps its code", async () => {
    const plain = await devUrl({
      config: config(async () => ({
        ...recordedApp(running),
        locate: async () => {
          throw new Error('request to the local dev emulator failed (500)');
        },
      })),
      address: 'gateway',
      cwd,
    });
    const coded = await devUrl({
      config: config(async () => {
        throw new CliStructuredError('DEV.EMULATORS_DIR_INVALID', 'not absolute');
      }),
      address: 'gateway',
      cwd,
    });

    expect(plain).toMatchObject({ ok: false, failure: { code: 'DEV.EMULATOR_FAILED' } });
    expect(coded).toMatchObject({ ok: false, failure: { code: 'DEV.EMULATORS_DIR_INVALID' } });
  });

  test('a target that reports a running node with no URL is a bug, not a failure with a code', async () => {
    const promise = devUrl({
      config: config(async () =>
        recordedApp([
          {
            address: 'gateway',
            kind: 'service',
            emulator: 'running',
            state: 'running',
            condition: 'running',
          },
        ]),
      ),
      address: 'gateway',
      cwd,
    });

    await expect(promise).rejects.toBeInstanceOf(InternalError);
  });

  test('a target that cannot locate an address it recorded is a bug, not a failure with a code', async () => {
    const promise = devUrl({
      config: config(async () => ({ ...recordedApp(running), locate: async () => undefined })),
      address: 'gateway',
      cwd,
    });

    await expect(promise).rejects.toBeInstanceOf(InternalError);
  });
});

describe.skipIf(process.platform === 'win32')('devStop', () => {
  test("stops the config entry's app in dev and returns what it stopped", async () => {
    const target = asked(recordedApp(running));

    const result = await devStop({ config: config(target.current, VALID_MODULE), cwd });

    expect(stopped).toEqual(['shop']);
    expect(target.inputs).toEqual([
      {
        devDir: path.join(cwd, '.prisma-composer', 'dev', 'dev'),
        app: 'fixture-module',
        environment: 'dev',
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        app: 'fixture-module',
        environment: 'dev',
        stopped: running.map(({ address, kind }) => ({ address, kind })),
      },
    });
  });

  test('--name and --environment select another app and environment', async () => {
    const target = asked(recordedApp(running));

    const result = await devStop({
      config: config(target.current, VALID_MODULE),
      name: 'other',
      environment: 'test',
      cwd,
    });

    expect(target.inputs).toEqual([
      {
        devDir: path.join(cwd, '.prisma-composer', 'dev', 'test'),
        app: 'other',
        environment: 'test',
      },
    ]);
    expect(result).toMatchObject({ ok: true, value: { app: 'other', environment: 'test' } });
  });

  test('an app and environment with nothing recorded fails with DEV.NOT_STARTED_HERE, naming both', async () => {
    const result = await devStop({
      config: config(async () => undefined, VALID_MODULE),
      environment: 'test',
      cwd,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'DEV.NOT_STARTED_HERE',
        meta: { app: 'fixture-module', environment: 'test' },
      },
    });
    expect(stopped).toEqual([]);
  });
});
