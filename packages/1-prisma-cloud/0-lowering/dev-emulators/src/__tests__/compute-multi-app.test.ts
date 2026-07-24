/**
 * Multi-app isolation on the Compute emulator (local-dev spec § 2): two
 * different apps with the SAME service name must get distinct, non-colliding
 * ports, and each other's admin operations must not cross-affect. Also
 * covers the shared path-segment hygiene rule.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { computeClient } from '../client.ts';
import { ensureDaemon, stopDaemon } from '../daemon.ts';
import {
  ensureFreshDaemon,
  entryFor,
  SERVING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  tempDir,
  waitFor,
  waitForHttp,
  writeBootstrap,
} from './helpers.ts';

let registryRoot: string;

beforeEach(async () => {
  registryRoot = tempDir('compute-multi-app-registry');
  await ensureFreshDaemon('compute', registryRoot);
  // The "serving" tests actually bind their reserved port (Bun.serve) —
  // steer past any low service port a process outside this test's control
  // already holds, the same class of shared-machine contention the
  // daemon-port retry feature addresses one layer down.
  await skipContendedServicePorts(computeClient({ registryRoot }));
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const path = process.env['PATH'];
  if (!path) throw new Error('PATH is not set in this shell');
  return { PATH: path, ...extra };
}

test('two apps with the same service id get distinct ports, both ≥ 3000', async () => {
  const client = computeClient({ registryRoot });
  const one = await client.ensureService('tenant-one', 'web');
  const two = await client.ensureService('tenant-two', 'web');

  expect(one.port).not.toBe(two.port);
  expect(one.port).toBeGreaterThanOrEqual(3000);
  expect(two.port).toBeGreaterThanOrEqual(3000);
});

test('deploying and serving the same service id under two apps never collides', async () => {
  const client = computeClient({ registryRoot });
  const oneDir = writeBootstrap(SERVING_BOOTSTRAP);
  const twoDir = writeBootstrap(SERVING_BOOTSTRAP);

  const one = await client.ensureService('tenant-one', 'web');
  const two = await client.ensureService('tenant-two', 'web');

  await client.putDeployment('tenant-one', 'web', {
    address: 'tenant-one.web',
    artifactDir: oneDir,
    artifactHash: 'h1',
    env: baseEnv({ PORT: String(one.port), ...servingBootstrapEnv('from tenant one') }),
    port: one.port,
  });
  await client.putDeployment('tenant-two', 'web', {
    address: 'tenant-two.web',
    artifactDir: twoDir,
    artifactHash: 'h1',
    env: baseEnv({ PORT: String(two.port), ...servingBootstrapEnv('from tenant two') }),
    port: two.port,
  });

  const resOne = await waitForHttp(`http://127.0.0.1:${String(one.port)}`, 3000);
  const resTwo = await waitForHttp(`http://127.0.0.1:${String(two.port)}`, 3000);
  expect(await resOne.text()).toBe('from tenant one');
  expect(await resTwo.text()).toBe('from tenant two');
});

test("stopping one app's services leaves the other app's services running", async () => {
  const client = computeClient({ registryRoot });
  const oneDir = writeBootstrap(SERVING_BOOTSTRAP);
  const twoDir = writeBootstrap(SERVING_BOOTSTRAP);
  const one = await client.ensureService('tenant-one', 'web');
  const two = await client.ensureService('tenant-two', 'web');

  await client.putDeployment('tenant-one', 'web', {
    address: 'tenant-one.web',
    artifactDir: oneDir,
    artifactHash: 'h',
    env: baseEnv({ PORT: String(one.port), ...servingBootstrapEnv('one') }),
    port: one.port,
  });
  await client.putDeployment('tenant-two', 'web', {
    address: 'tenant-two.web',
    artifactDir: twoDir,
    artifactHash: 'h',
    env: baseEnv({ PORT: String(two.port), ...servingBootstrapEnv('two') }),
    port: two.port,
  });
  await waitFor(async () => {
    const listOne = await client.listServices('tenant-one');
    const listTwo = await client.listServices('tenant-two');
    return listOne[0]?.status === 'running' && listTwo[0]?.status === 'running';
  }, 5000);

  await client.stopApp('tenant-one');

  await waitFor(
    async () => (await client.listServices('tenant-one'))[0]?.status === 'stopped',
    5000,
  );
  const twoList = await client.listServices('tenant-two');
  expect(twoList[0]?.status).toBe('running');
});

test('deleting one app leaves the other app registered', async () => {
  const client = computeClient({ registryRoot });
  await client.ensureService('tenant-one', 'web');
  await client.ensureService('tenant-two', 'web');

  await client.deleteApp('tenant-one');

  expect(await client.listServices('tenant-one')).toEqual([]);
  const twoList = await client.listServices('tenant-two');
  expect(twoList).toHaveLength(1);
});

describe('path-segment hygiene', () => {
  test('an app name with an uppercase letter is rejected with 400', async () => {
    const { url } = await ensureDaemon('compute', entryFor('compute'), { registryRoot });
    const res = await fetch(`${url}/apps/BadApp/services/web`, { method: 'PUT' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('BadApp');
  });

  test('a service id over 63 characters is rejected with 400', async () => {
    const { url } = await ensureDaemon('compute', entryFor('compute'), { registryRoot });
    const longId = 'a'.repeat(64);
    const res = await fetch(`${url}/apps/tenant-one/services/${longId}`, { method: 'PUT' });
    expect(res.status).toBe(400);
  });
});
