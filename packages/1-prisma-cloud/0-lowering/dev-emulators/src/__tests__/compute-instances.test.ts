/**
 * Compute instances: ids the emulator generates, labels it stores without
 * reading, ports held from creation until delete, and isolation between
 * instances whose labels are identical.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import getPort, { portNumbers } from 'get-port';
import { type ComputeClient, computeClient } from '../client.ts';
import { daemonStateDir, ensureDaemon, stopDaemon } from '../daemon.ts';
import {
  ensureFreshDaemon,
  entryFor,
  SERVING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  tempDir,
  waitForHttp,
  writeBootstrap,
} from './helpers.ts';

let registryRoot: string;
let client: ComputeClient;

beforeEach(async () => {
  registryRoot = tempDir('compute-instances-registry');
  await ensureFreshDaemon('compute', registryRoot);
  client = computeClient({ registryRoot });
  await skipContendedServicePorts(client);
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const path = process.env['PATH'];
  if (!path) throw new Error('PATH is not set in this shell');
  return { PATH: path, ...extra };
}

async function deployServing(id: string, port: number, body: string): Promise<void> {
  await client.putDeployment(id, {
    artifactDir: writeBootstrap(SERVING_BOOTSTRAP),
    artifactHash: body,
    env: baseEnv({ PORT: String(port), ...servingBootstrapEnv(body) }),
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await client.getInstance(id))?.status;
}

describe('creating and listing instances', () => {
  test('the emulator generates distinct ids and returns the labels verbatim', async () => {
    const labels = { 'composer.app': 'My App', 'free form': 'any value: /with/slashes' };
    const one = await client.createInstance({ labels });
    const two = await client.createInstance({ labels });

    expect(one.id).toMatch(/^svc_[0-9a-f]{16}$/);
    expect(two.id).not.toBe(one.id);
    expect(one.labels).toEqual(labels);
    expect(one.status).toBe('stopped');
    expect(one.url).toBe(`http://localhost:${String(one.port)}`);

    const listed = await client.listInstances();
    expect(listed.find((i) => i.id === one.id)?.labels).toEqual(labels);
    expect(listed.find((i) => i.id === two.id)?.labels).toEqual(labels);
  });

  test('getting an unknown instance returns nothing', async () => {
    expect(await client.getInstance('svc_0000000000000000')).toBeUndefined();
  });

  test('a start or stop naming an unknown instance fails and names it', async () => {
    const known = await client.createInstance({ labels: {} });
    await expect(client.startInstances([known.id, 'svc_0000000000000000'])).rejects.toThrow(
      '"svc_0000000000000000"',
    );
    await expect(client.stopInstances(['svc_0000000000000000'])).rejects.toThrow('(404)');
  });

  test('a malformed instance id is rejected with 400', async () => {
    const res = await fetch(`${client.baseUrl}/instances/web`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('"web"');
  });

  test('labels that are not all strings are rejected with 400', async () => {
    const res = await fetch(`${client.baseUrl}/instances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: { count: 1 } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('ports', () => {
  test('two instances get distinct ports, both at or above 3000', async () => {
    const one = await client.createInstance({ labels: {} });
    const two = await client.createInstance({ labels: {} });

    expect(one.port).not.toBe(two.port);
    expect(one.port).toBeGreaterThanOrEqual(3000);
    expect(two.port).toBeGreaterThanOrEqual(3000);
  });

  test('a requested port that is free is given', async () => {
    const requested = await getPort({ port: portNumbers(20_000, 21_000) });

    const created = await client.createInstance({ labels: {}, port: requested });

    expect(created.port).toBe(requested);
  });

  test('a requested port another instance holds gives the lowest free port instead', async () => {
    const holder = await client.createInstance({ labels: {} });

    const created = await client.createInstance({ labels: {}, port: holder.port });
    await client.deleteInstance(created.id);
    const unrequested = await client.createInstance({ labels: {} });

    expect(created.port).not.toBe(holder.port);
    expect(created.port).toBe(unrequested.port);
  });

  test('a requested port a process outside the emulator has bound gives another port', async () => {
    const requested = await getPort({ port: portNumbers(21_000, 22_000) });
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(requested, resolve));
    try {
      const created = await client.createInstance({ labels: {}, port: requested });
      expect(created.port).not.toBe(requested);
      expect(created.port).toBeGreaterThanOrEqual(3000);
    } finally {
      squatter.close();
    }
  });

  test('a stopped instance keeps its port, and no new instance is given it', async () => {
    const one = await client.createInstance({ labels: {} });
    await deployServing(one.id, one.port, 'one');
    await client.stopInstances([one.id]);

    const created = await client.createInstance({ labels: {}, port: one.port });

    expect((await client.getInstance(one.id))?.port).toBe(one.port);
    expect(created.port).not.toBe(one.port);
  }, 15_000);

  test("a deleted instance's port can be requested again", async () => {
    const one = await client.createInstance({ labels: {} });
    await client.deleteInstance(one.id);

    const again = await client.createInstance({ labels: {}, port: one.port });

    expect(again.port).toBe(one.port);
    expect(again.id).not.toBe(one.id);
  });
});

describe('isolation between instances with the same labels', () => {
  const labels = { 'composer.app': 'same-app', 'composer.address': 'web' };

  test('both serve on their own ports', async () => {
    const one = await client.createInstance({ labels });
    const two = await client.createInstance({ labels });

    await deployServing(one.id, one.port, 'from one');
    await deployServing(two.id, two.port, 'from two');

    expect(await (await waitForHttp(`http://127.0.0.1:${String(one.port)}`, 3000)).text()).toBe(
      'from one',
    );
    expect(await (await waitForHttp(`http://127.0.0.1:${String(two.port)}`, 3000)).text()).toBe(
      'from two',
    );
  }, 15_000);

  test('stopping one leaves the other running', async () => {
    const one = await client.createInstance({ labels });
    const two = await client.createInstance({ labels });
    await deployServing(one.id, one.port, 'one');
    await deployServing(two.id, two.port, 'two');

    await client.stopInstances([one.id]);

    expect(await statusOf(one.id)).toBe('stopped');
    expect(await statusOf(two.id)).toBe('running');
  }, 15_000);

  test('deleting one leaves the other', async () => {
    const one = await client.createInstance({ labels });
    const two = await client.createInstance({ labels });

    await client.deleteInstance(one.id);

    expect(await client.getInstance(one.id)).toBeUndefined();
    expect((await client.getInstance(two.id))?.labels).toEqual(labels);
  });
});

describe('persisted state', () => {
  test('instances, their labels and their ports survive an emulator restart', async () => {
    const created = await client.createInstance({ labels: { note: 'kept' } });

    await stopDaemon('compute', { registryRoot });
    await ensureDaemon('compute', entryFor('compute'), { registryRoot });

    const reloaded = await computeClient({ registryRoot }).getInstance(created.id);
    expect(reloaded?.labels).toEqual({ note: 'kept' });
    expect(reloaded?.port).toBe(created.port);
  });

  test('state written by an earlier version, keyed by app, is discarded on load', async () => {
    await stopDaemon('compute', { registryRoot });
    const stateDir = daemonStateDir(registryRoot, 'compute');
    fs.rmSync(path.join(stateDir, 'instances.json'), { force: true });
    const legacyLogDir = path.join(stateDir, 'logs', 'legacy-app');
    fs.mkdirSync(legacyLogDir, { recursive: true });
    fs.writeFileSync(path.join(legacyLogDir, 'web.log'), 'old\n');
    fs.writeFileSync(
      path.join(stateDir, 'apps.json'),
      JSON.stringify({
        'legacy-app': {
          services: {
            web: { id: 'web', address: 'web', port: 3000, status: 'stopped', logPath: '/x' },
          },
        },
      }),
    );

    await ensureDaemon('compute', entryFor('compute'), { registryRoot });

    expect(await computeClient({ registryRoot }).listInstances()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'apps.json'))).toBe(false);
    expect(fs.existsSync(legacyLogDir)).toBe(false);
  });
});

/**
 * The emulator knows nothing about Composer: an app name, a node address or
 * a project directory may reach it only as label values. These checks fail
 * when the emulator's code names one of those concepts, or when one of them
 * ends up in its state or files anywhere other than inside labels.
 */
describe('the emulator stores Composer names only in labels', () => {
  const markers = {
    'composer.app': 'zz-app-marker',
    'composer.address': 'zz-address-marker',
    'composer.directory': '/zz-directory-marker/project',
  };
  const markerValues = Object.values(markers);

  function withoutLabels(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutLabels);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'labels')
        .map(([key, field]) => [key, withoutLabels(field)]),
    );
  }

  function filesUnder(dir: string): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true, recursive: true })
      .map((entry) => path.join(entry.parentPath, entry.name));
  }

  test('state, file names and listings hold the label values only inside labels', async () => {
    const created = await client.createInstance({ labels: markers });
    await deployServing(created.id, created.port, 'marker test');
    await client.stopInstances([created.id]);

    const stateDir = daemonStateDir(registryRoot, 'compute');
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'instances.json'), 'utf8'),
    );
    const listed: unknown = await (await fetch(`${client.baseUrl}/instances`)).json();

    for (const marker of markerValues) {
      expect(JSON.stringify(state)).toContain(marker);
      expect(JSON.stringify(withoutLabels(state))).not.toContain(marker);
      expect(JSON.stringify(withoutLabels(listed))).not.toContain(marker);
      for (const file of filesUnder(stateDir)) expect(file).not.toContain(marker);
    }
  }, 15_000);

  test("the emulator's code names no app, address, directory or Composer concept", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../compute-main.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\b(apps?|appName|address(es)?|directory|composer)\b/i);
  });
});
