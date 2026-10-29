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

  test('a start naming an unknown instance fails, names it, and starts nothing', async () => {
    const known = await client.createInstance({ labels: {} });
    await deployServing(known.id, known.port, 'known');
    await client.stopInstances([known.id]);

    await expect(client.startInstances([known.id, 'svc_0000000000000000'])).rejects.toThrow(
      '"svc_0000000000000000"',
    );
    expect(await statusOf(known.id)).toBe('stopped');
  }, 15_000);

  test('a stop skips an unknown instance and stops the others', async () => {
    const known = await client.createInstance({ labels: {} });
    await deployServing(known.id, known.port, 'known');

    await client.stopInstances([known.id, 'svc_0000000000000000']);

    expect(await statusOf(known.id)).toBe('stopped');
  }, 15_000);

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
 * The emulator never interprets Composer's data. An app name, a node address
 * or a project directory reaches it only as label values and inside the
 * opaque deployment payload (the artifact directory and the env), which it
 * stores verbatim. These checks fail when the emulator's code names one of
 * those concepts, or when one of them shows up anywhere else: a route, a
 * state key, a file name or a field the emulator generates.
 */
describe('the emulator never interprets Composer data', () => {
  const app = 'zzappmarker';
  const address = 'zzaddressmarker';
  const directory = path.join(tempDir('marker-project'), 'zzdirectorymarker');
  const markers = [app, address, 'zzdirectorymarker'];
  const labels = {
    'composer.directory': directory,
    'composer.app': app,
    'composer.address': address,
  };

  /** A deployment shaped like Composer's: its artifact unpacked under the project's dev directory, env keys named after the address. */
  function composerShapedDeployment(port: number) {
    const artifactDir = path.join(directory, '.prisma-composer', 'dev', 'artifacts', 'abc123');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'bootstrap.js'), SERVING_BOOTSTRAP);
    const env = baseEnv({
      PORT: String(port),
      [`COMPOSER_${address.toUpperCase()}_PORT`]: String(port),
      [`COMPOSER_${address.toUpperCase()}_INPUT`]: '{}',
      COMPOSER_GATEWAY_QUOTES_URL: 'http://localhost:3001',
      ...servingBootstrapEnv('marker test'),
    });
    return { artifactDir, artifactHash: 'abc123', env };
  }

  function without(value: unknown, keys: readonly string[]): unknown {
    if (Array.isArray(value)) return value.map((item) => without(item, keys));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !keys.includes(key))
        .map(([key, field]) => [key, without(field, keys)]),
    );
  }

  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, field]) => [key, ...keysOf(field)]);
  }

  function filesUnder(dir: string): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true, recursive: true })
      .map((entry) => path.join(entry.parentPath, entry.name));
  }

  function mentions(text: string, marker: string): boolean {
    return text.toLowerCase().includes(marker);
  }

  test('labels and the deployment payload are stored verbatim, and nothing else carries their values', async () => {
    const created = await client.createInstance({ labels });
    const deployment = composerShapedDeployment(created.port);
    await client.putDeployment(created.id, deployment);
    await client.stopInstances([created.id]);

    const stateDir = daemonStateDir(registryRoot, 'compute');
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'instances.json'), 'utf8'),
    );
    const record: unknown = Reflect.get(Reflect.get(state as object, 'instances'), created.id);
    expect(record).toMatchObject({
      labels,
      artifactDir: deployment.artifactDir,
      artifactHash: deployment.artifactHash,
      env: deployment.env,
    });

    const opaque = ['labels', 'artifactDir', 'env'];
    const stateKeys = keysOf(without(state, ['labels', 'env'])).join('\n');
    const listed: unknown = await (await fetch(`${client.baseUrl}/instances`)).json();
    const own: unknown = await (await fetch(`${client.baseUrl}/instances/${created.id}`)).json();
    for (const marker of markers) {
      expect(mentions(JSON.stringify(without(state, opaque)), marker)).toBe(false);
      expect(mentions(stateKeys, marker)).toBe(false);
      expect(mentions(JSON.stringify(without(listed, ['labels'])), marker)).toBe(false);
      expect(mentions(JSON.stringify(without(own, ['labels'])), marker)).toBe(false);
      for (const file of filesUnder(stateDir)) expect(mentions(file, marker)).toBe(false);
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

describe('emulators in different emulators directories', () => {
  test("a stopped instance's port is not given to another emulator's instance until it is deleted", async () => {
    // Far above the ports other suites' emulators hand out, so none takes it after the delete.
    const requested = await getPort({ port: portNumbers(58_000, 59_000) });
    const held = await client.createInstance({ labels: {}, port: requested });
    const otherRoot = tempDir('compute-instances-other-registry');
    await ensureFreshDaemon('compute', otherRoot);
    const other = computeClient({ registryRoot: otherRoot });
    try {
      const whileHeld = await other.createInstance({ labels: {}, port: held.port });
      await client.deleteInstance(held.id);
      const afterDelete = await other.createInstance({ labels: {}, port: held.port });

      expect(whileHeld.port).not.toBe(held.port);
      expect(afterDelete.port).toBe(held.port);
    } finally {
      await stopDaemon('compute', { registryRoot: otherRoot }).catch(() => undefined);
    }
  });
});
