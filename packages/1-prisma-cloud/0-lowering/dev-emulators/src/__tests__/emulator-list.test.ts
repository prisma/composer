/** The emulator listing with nothing running, and with an emulator running. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { computeClient } from '../client.ts';
import { stopDaemon } from '../daemon.ts';
import { listEmulators } from '../emulator-list.ts';
import { ensureFreshDaemon, tempDir } from './helpers.ts';

let registryRoot: string;

beforeEach(() => {
  registryRoot = tempDir('emulator-list-registry');
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

test('with nothing running, every emulator is listed as not running, with no instances', async () => {
  const result = await listEmulators({ registryRoot });

  expect(result).toMatchObject({
    ok: true,
    value: {
      emulators: [
        { kind: 'service', running: false, instances: [] },
        { kind: 'database', running: false, instances: [] },
        { kind: 'bucket', running: false, instances: [] },
      ],
    },
  });
});

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
  });
});
