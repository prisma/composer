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

function configWith(current: LocalTargetDescriptor['current']): PrismaAppConfig {
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
  };
}

function config(current: LocalTargetDescriptor['current']) {
  return { value: configWith(current), file: 'prisma.config.ts' };
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

  test('a directory where `prisma dev` never ran fails with DEV.NOT_STARTED_HERE', async () => {
    const result = await devUrl({ config: config(async () => undefined), address: 'gateway', cwd });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.NOT_STARTED_HERE' } });
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

  test('a stopped node fails with DEV.NOT_RUNNING, saying it was stopped and how it is started again', async () => {
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
      expect(result.failure.message).toBe('The database "catalog" was stopped.');
      expect(result.failure.why).toContain('`prisma dev stop`');
      expect(result.failure.why).toContain('`prisma dev` ending');
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
  test('stops the recorded app and returns what it stopped', async () => {
    const result = await devStop({ config: config(async () => recordedApp(running)), cwd });

    expect(stopped).toEqual(['shop']);
    expect(result).toMatchObject({
      ok: true,
      value: {
        app: 'shop',
        stopped: running.map(({ address, kind }) => ({ address, kind })),
      },
    });
  });

  test('a directory where `prisma dev` never ran fails with DEV.NOT_STARTED_HERE', async () => {
    const result = await devStop({ config: config(async () => undefined), cwd });

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.NOT_STARTED_HERE' } });
  });
});
