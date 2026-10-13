/**
 * The per-directory record of which Compute instance backs each service,
 * against a real Compute emulator in a temporary emulators directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerInstance } from '@internal/core/config';
import {
  computeClient,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  stopDaemon,
} from '@internal/dev-emulators';
import { packageComputeArtifact } from '@internal/lowering/compute';
import { App, Deployment } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { LocalAppProvider, LocalDeploymentProvider, reserveServicePorts } from '../compute.ts';
import {
  EMULATOR_INSTANCES_FILE,
  type EmulatorInstances,
  readEmulatorInstances,
  retirePreviousApp,
} from '../emulator-instances.ts';

const APP = 'shared-app';
const ADDRESSES = ['quotes', 'gateway'];
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
let root: string;
let registryRoot: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-emulator-instances-'));
  registryRoot = path.join(root, 'emulators');
  process.env[EMULATORS_DIR_ENV] = registryRoot;
  const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/compute-main'));
  await ensureDaemon('compute', entry, { registryRoot });
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
  if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
  else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
});

const container: ContainerInstance = {
  input: { appName: APP, stage: undefined },
  serialize: () => 'x',
};

function projectDir(name: string): { readonly directory: string; readonly devDir: string } {
  const directory = path.join(root, name);
  return { directory, devDir: path.join(directory, '.prisma-composer', 'dev') };
}

/** A packaged artifact whose service answers with its address, its working directory and `version`. */
function artifactFor(address: string, version: string): string {
  const bundleDir = fs.mkdtempSync(path.join(root, `bundle-${address}-`));
  fs.writeFileSync(
    path.join(bundleDir, 'main.js'),
    `export default { run: async (address) => {
  const port = Number(process.env['COMPOSER_' + address.toUpperCase() + '_PORT']);
  Bun.serve({ port, fetch: () => new Response(address + ' ' + process.cwd() + ' ${version}') });
} };
`,
  );
  fs.writeFileSync(path.join(bundleDir, 'server.js'), '');
  return packageComputeArtifact({ id: address, bundleDir, appEntry: 'server.js', address }).path;
}

const reconcileInput = (id: string, news: Record<string, unknown>) =>
  ({
    id,
    fqn: id,
    instanceId: id,
    news,
    olds: undefined,
    output: undefined,
    session: undefined as never,
    bindings: [],
  }) as never;

async function deploy(
  devDir: string,
  address: string,
  version: string,
): Promise<Deployment['Attributes']> {
  const provider = await Effect.runPromise(
    Deployment.Provider.pipe(Effect.provide(LocalDeploymentProvider({ container, devDir }))),
  );
  return Effect.runPromise(
    provider.reconcile(
      reconcileInput(`${address}-deployment`, {
        app: address,
        artifactPath: artifactFor(address, version),
      }),
    ),
  );
}

async function deploymentDiff(devDir: string, output: Deployment['Attributes']): Promise<unknown> {
  const provider = await Effect.runPromise(
    Deployment.Provider.pipe(Effect.provide(LocalDeploymentProvider({ container, devDir }))),
  );
  const diff = provider.diff;
  if (!diff) throw new Error('the local Deployment provider has no diff');
  return Effect.runPromise(diff({ output } as never));
}

async function appProvider(devDir: string) {
  return Effect.runPromise(
    App.Provider.pipe(Effect.provide(LocalAppProvider({ container, devDir }))),
  );
}

function mappingOf(directory: string): Promise<EmulatorInstances | undefined> {
  return readEmulatorInstances(directory);
}

async function nodeOf(directory: string, address: string) {
  const node = (await mappingOf(directory))?.nodes[address];
  if (!node) throw new Error(`no instance recorded for "${address}" in ${directory}`);
  return node;
}

async function pidOf(id: string): Promise<number | undefined> {
  return (await computeClient().getInstance(id))?.pid;
}

describe('two directories running the same app', () => {
  test('each gets its own instances, and a deploy in one restarts nothing in the other', async () => {
    const a = projectDir('a');
    const b = projectDir('b');
    await Promise.all([
      reserveServicePorts(container, a.devDir, ADDRESSES),
      reserveServicePorts(container, b.devDir, ADDRESSES),
    ]);
    await Promise.all(
      [a, b].flatMap(({ devDir }) => ADDRESSES.map((address) => deploy(devDir, address, 'v1'))),
    );

    const nodesA = (await mappingOf(a.directory))?.nodes ?? {};
    const nodesB = (await mappingOf(b.directory))?.nodes ?? {};
    const ids = [...Object.values(nodesA), ...Object.values(nodesB)].map((n) => n.id);
    const ports = [...Object.values(nodesA), ...Object.values(nodesB)].map((n) => n.port);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(ports).size).toBe(4);
    for (const [{ directory }, nodes] of [
      [a, nodesA],
      [b, nodesB],
    ] as const) {
      for (const [address, node] of Object.entries(nodes)) {
        const answer = await (await fetch(`http://localhost:${String(node.port)}`)).text();
        expect(answer).toStartWith(`${address} ${fs.realpathSync(directory)}`);
      }
    }

    const pidsA = await Promise.all(Object.values(nodesA).map((n) => pidOf(n.id)));
    await Promise.all(ADDRESSES.map((address) => deploy(b.devDir, address, 'v2')));

    expect(await Promise.all(Object.values(nodesA).map((n) => pidOf(n.id)))).toEqual(pidsA);
    const quotesB = await nodeOf(b.directory, 'quotes');
    expect(await (await fetch(`http://localhost:${String(quotesB.port)}`)).text()).toEndWith(' v2');
  }, 60_000);
});

describe('reusing the recorded instances', () => {
  test('a recorded instance the emulator no longer has is re-created on its remembered port', async () => {
    const { directory, devDir } = projectDir('lost');
    await reserveServicePorts(container, devDir, ['quotes']);
    const before = await nodeOf(directory, 'quotes');
    await computeClient().deleteInstance(before.id);

    const changes = await reserveServicePorts(container, devDir, ['quotes']);

    const after = await nodeOf(directory, 'quotes');
    expect(after.id).not.toBe(before.id);
    expect(after.port).toBe(before.port);
    expect(changes).toEqual([]);
  });

  test('a remembered port another instance now holds gives a new port, reported as a change', async () => {
    const { directory, devDir } = projectDir('moved');
    await reserveServicePorts(container, devDir, ['quotes']);
    const before = await nodeOf(directory, 'quotes');
    await computeClient().deleteInstance(before.id);
    await computeClient().createInstance({ labels: {}, port: before.port });

    const changes = await reserveServicePorts(container, devDir, ['quotes']);

    const after = await nodeOf(directory, 'quotes');
    expect(after.port).not.toBe(before.port);
    expect(changes).toEqual([{ address: 'quotes', previous: before.port, given: after.port }]);
  });

  test('a warm restart after a stop reuses the same instances and ports', async () => {
    const { directory, devDir } = projectDir('warm');
    await reserveServicePorts(container, devDir, ADDRESSES);
    for (const address of ADDRESSES) await deploy(devDir, address, 'v1');
    const before = (await mappingOf(directory))?.nodes;
    const ids = Object.values(before ?? {}).map((n) => n.id);
    await computeClient().stopInstances(ids);

    const changes = await reserveServicePorts(container, devDir, ADDRESSES);
    await computeClient().startInstances(ids);

    expect(changes).toEqual([]);
    expect((await mappingOf(directory))?.nodes).toEqual(before ?? {});
    for (const node of Object.values(before ?? {})) {
      expect((await computeClient().getInstance(node.id))?.status).toBe('running');
    }
  }, 30_000);

  test('a deployment whose instance was re-created is deployed again even when nothing changed', async () => {
    const { directory, devDir } = projectDir('redeploy');
    await reserveServicePorts(container, devDir, ['quotes']);
    const deployed = await deploy(devDir, 'quotes', 'v1');
    expect(await deploymentDiff(devDir, deployed)).toBeUndefined();

    await computeClient().deleteInstance((await nodeOf(directory, 'quotes')).id);
    await reserveServicePorts(container, devDir, ['quotes']);

    expect(await deploymentDiff(devDir, deployed)).toEqual({ action: 'update' });
  }, 30_000);

  test("deleting a removed service's App deletes its instance and forgets it", async () => {
    const { directory, devDir } = projectDir('removed');
    await reserveServicePorts(container, devDir, ADDRESSES);
    const quotes = await nodeOf(directory, 'quotes');
    const provider = await appProvider(devDir);

    await Effect.runPromise(provider.delete({ output: { name: 'quotes' } } as never));

    expect(await computeClient().getInstance(quotes.id)).toBeUndefined();
    expect(Object.keys((await mappingOf(directory))?.nodes ?? {})).toEqual(['gateway']);
  });
});

test('the record is one JSON file in the dev directory, readable from the directory alone', async () => {
  const { directory, devDir } = projectDir('file');
  await reserveServicePorts(container, devDir, ['quotes']);

  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(devDir, EMULATOR_INSTANCES_FILE), 'utf8'),
  );
  const node = await nodeOf(directory, 'quotes');
  expect(onDisk).toEqual({ app: APP, nodes: { quotes: node } });
  expect(await readEmulatorInstances(path.join(root, 'never-ran'))).toBeUndefined();
});

describe('switching apps in a directory', () => {
  test("running another app deletes the previous app's compute instances and starts a new record", async () => {
    const { directory, devDir } = projectDir('switch');
    await reserveServicePorts(container, devDir, ADDRESSES);
    const previous = Object.values((await mappingOf(directory))?.nodes ?? {});

    const retired = await retirePreviousApp({ devDir, app: 'another-app' });

    expect(retired).toBe(APP);
    for (const node of previous) expect(await computeClient().getInstance(node.id)).toBeUndefined();
    expect(await mappingOf(directory)).toEqual({ app: 'another-app', nodes: {} });
  });

  test('running the same app again retires nothing', async () => {
    const { directory, devDir } = projectDir('same');
    await reserveServicePorts(container, devDir, ['quotes']);
    const quotes = await nodeOf(directory, 'quotes');

    expect(await retirePreviousApp({ devDir, app: APP })).toBeUndefined();
    expect(await computeClient().getInstance(quotes.id)).toBeDefined();
  });
});
