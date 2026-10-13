/** The emulator listing: nothing running, an emulator running, and emulators that cannot be listed. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { computeClient } from '../client.ts';
import { registryFilePath, stopDaemon } from '../daemon.ts';
import { listEmulators } from '../emulator-list.ts';
import { ensureFreshDaemon, tempDir } from './helpers.ts';

const FAKE_VERSION = 'fake-registration';
let registryRoot: string;

beforeEach(() => {
  registryRoot = tempDir('emulator-list-registry');
});

afterEach(async () => {
  // A fake registration names this test's own process; stopping it would end the run.
  for (const name of ['compute', 'buckets'] as const) {
    const file = registryFilePath(registryRoot, name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(FAKE_VERSION))
      fs.rmSync(file);
  }
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

/** A port nothing listens on: bound once to pick it, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Registers an emulator as running at `port`, with this test's own live process as its PID. */
function register(name: 'compute' | 'buckets', port: number): void {
  fs.mkdirSync(registryRoot, { recursive: true });
  fs.writeFileSync(
    registryFilePath(registryRoot, name),
    JSON.stringify({ pid: process.pid, port, version: FAKE_VERSION, logPath: '/dev/null' }),
  );
}

test('with nothing running, every emulator is listed as not running, with no instances', async () => {
  const result = await listEmulators({ registryRoot });

  if (!result.ok) throw new Error(result.failure.message);
  expect(result.value).toEqual({
    emulators: [
      { kind: 'service', running: false, url: null, instances: [], error: null },
      { kind: 'database', running: false, url: null, instances: [], error: null },
      { kind: 'bucket', running: false, url: null, instances: [], error: null },
    ],
  });
});

test('an emulator that does not answer is reported in its own entry, and the others are still listed', async () => {
  const port = await closedPort();
  register('compute', port);

  const result = await listEmulators({ registryRoot });

  if (!result.ok) throw new Error(result.failure.message);
  expect(result.value.emulators).toEqual([
    {
      kind: 'service',
      running: true,
      url: `http://127.0.0.1:${port}`,
      instances: [],
      error: { code: 'DEV.EMULATOR_UNREACHABLE', message: expect.any(String) },
    },
    { kind: 'database', running: false, url: null, instances: [], error: null },
    { kind: 'bucket', running: false, url: null, instances: [], error: null },
  ]);
});

test('an emulator that answers with an error is reported as DEV.EMULATOR_FAILED in its own entry', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  const port = server.port;
  if (port === undefined) throw new Error('the server has no port');
  try {
    register('buckets', port);

    const result = await listEmulators({ registryRoot });

    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.emulators[2]).toEqual({
      kind: 'bucket',
      running: true,
      url: `http://127.0.0.1:${port}`,
      instances: [],
      error: { code: 'DEV.EMULATOR_FAILED', message: expect.stringContaining('500') },
    });
  } finally {
    await server.stop(true);
  }
});

test('an emulators directory that is not absolute fails the whole listing', async () => {
  const saved = process.env['PRISMA_COMPOSER_EMULATORS_DIR'];
  process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = 'relative/emulators';
  try {
    const result = await listEmulators();

    expect(result).toMatchObject({ ok: false, failure: { code: 'DEV.EMULATORS_DIR_INVALID' } });
  } finally {
    if (saved === undefined) delete process.env['PRISMA_COMPOSER_EMULATORS_DIR'];
    else process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = saved;
  }
});

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')('with a real emulator', () => {
  test("a running emulator is listed with its admin URL and its instances' labels", async () => {
    await ensureFreshDaemon('compute', registryRoot);
    const client = computeClient({ registryRoot });
    const instance = await client.createInstance({ labels: { 'composer.address': 'gateway' } });

    const result = await listEmulators({ registryRoot });

    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.emulators[0]).toEqual({
      kind: 'service',
      running: true,
      url: client.baseUrl,
      instances: [
        {
          id: instance.id,
          kind: 'service',
          url: instance.url,
          state: 'stopped',
          labels: { 'composer.address': 'gateway' },
        },
      ],
      error: null,
    });
  });
});
