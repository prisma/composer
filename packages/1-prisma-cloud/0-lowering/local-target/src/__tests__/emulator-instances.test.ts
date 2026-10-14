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
import { CliStructuredError } from '@internal/foundation/errors';
import { packageComputeArtifact } from '@internal/lowering/compute';
import { App, Deployment } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { ensureServiceInstances, LocalAppProvider, LocalDeploymentProvider } from '../compute.ts';
import {
  deleteRecordedInstances,
  EMULATOR_INSTANCES_FILE,
  type EmulatorInstances,
  readEmulatorInstances,
  retirePreviousApp,
  withServiceAddresses,
} from '../emulator-instances.ts';

const APP = 'shared-app';
const ADDRESSES = ['quotes', 'gateway'];
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
let root: string;
let registryRoot: string;

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

/** A packaged artifact whose service exits before it listens. */
function crashingArtifactFor(address: string): string {
  const bundleDir = fs.mkdtempSync(path.join(root, `bundle-${address}-`));
  fs.writeFileSync(
    path.join(bundleDir, 'main.js'),
    'export default { run: async () => { process.exit(1); } };\n',
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
  artifactPath: string = artifactFor(address, version),
): Promise<Deployment['Attributes']> {
  const provider = await Effect.runPromise(
    Deployment.Provider.pipe(Effect.provide(LocalDeploymentProvider({ container, devDir }))),
  );
  return Effect.runPromise(
    provider.reconcile(
      reconcileInput(`${address}-deployment`, {
        app: address,
        artifactPath,
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

describe('errors name services by address', () => {
  const nodes = [{ address: 'shop.quotes', instance: { id: 'svc_0123456789abcdef' } }];

  test('an instance id in a plain error becomes the service address, keeping the original as cause', () => {
    const original = new Error(
      'request failed (500): instance "svc_0123456789abcdef" exited (code 1) before it accepted connections',
    );

    const rewritten = withServiceAddresses(original, nodes);

    expect(rewritten).toBeInstanceOf(Error);
    expect((rewritten as Error).message).toBe(
      'request failed (500): service "shop.quotes" exited (code 1) before it accepted connections',
    );
    expect((rewritten as Error).cause).toBe(original);
  });

  test("the emulator's listens hint becomes the compute() option, alongside the address", () => {
    const original = new Error(
      'request failed (500): instance "svc_0123456789abcdef" did not accept connections on its port 3001 within 30s. If it never listens on its port, deploy it with listens: false.',
    );

    const rewritten = withServiceAddresses(original, nodes);

    expect((rewritten as Error).message).toBe(
      'request failed (500): service "shop.quotes" did not accept connections on its port 3001 within 30s. If it never listens on its port, declare it with compute({ listens: false }).',
    );
  });

  test('a structured error is left untouched', () => {
    const structured = new CliStructuredError(
      'DEV.EMULATOR_UNREACHABLE',
      'instance "svc_0123456789abcdef" unreachable',
    );

    expect(withServiceAddresses(structured, nodes)).toBe(structured);
  });
});

// Local dev does not support Windows, so neither do the tests that start a real Compute emulator.
describe.skipIf(process.platform === 'win32')('against a real Compute emulator', () => {
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

  describe('two directories running the same app', () => {
    test('each gets its own instances, and a deploy in one restarts nothing in the other', async () => {
      const a = projectDir('a');
      const b = projectDir('b');
      await Promise.all([
        ensureServiceInstances(container, a.devDir, ADDRESSES),
        ensureServiceInstances(container, b.devDir, ADDRESSES),
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
      expect(await (await fetch(`http://localhost:${String(quotesB.port)}`)).text()).toEndWith(
        ' v2',
      );
    }, 60_000);
  });

  describe('reusing the recorded instances', () => {
    test('a recorded instance the emulator no longer has is re-created on its remembered port', async () => {
      const { directory, devDir } = projectDir('lost');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const before = await nodeOf(directory, 'quotes');
      await computeClient().deleteInstance(before.id);

      const changes = await ensureServiceInstances(container, devDir, ['quotes']);

      const after = await nodeOf(directory, 'quotes');
      expect(after.id).not.toBe(before.id);
      expect(after.port).toBe(before.port);
      expect(changes).toEqual([]);
    });

    test('a remembered port another instance now holds gives a new port, reported as a change', async () => {
      const { directory, devDir } = projectDir('moved');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const before = await nodeOf(directory, 'quotes');
      await computeClient().deleteInstance(before.id);
      await computeClient().createInstance({ labels: {}, port: before.port });

      const changes = await ensureServiceInstances(container, devDir, ['quotes']);

      const after = await nodeOf(directory, 'quotes');
      expect(after.port).not.toBe(before.port);
      expect(changes).toEqual([{ address: 'quotes', previous: before.port, given: after.port }]);
    });

    test('a warm restart after a stop reuses the same instances and ports', async () => {
      const { directory, devDir } = projectDir('warm');
      await ensureServiceInstances(container, devDir, ADDRESSES);
      for (const address of ADDRESSES) await deploy(devDir, address, 'v1');
      const before = (await mappingOf(directory))?.nodes;
      const ids = Object.values(before ?? {}).map((n) => n.id);
      await computeClient().stopInstances(ids);

      const changes = await ensureServiceInstances(container, devDir, ADDRESSES);
      await computeClient().startInstances(ids);

      expect(changes).toEqual([]);
      expect((await mappingOf(directory))?.nodes).toEqual(before ?? {});
      for (const node of Object.values(before ?? {})) {
        expect((await computeClient().getInstance(node.id))?.status).toBe('running');
      }
    }, 30_000);

    test('a deployment whose instance was re-created is deployed again even when nothing changed', async () => {
      const { directory, devDir } = projectDir('redeploy');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const deployed = await deploy(devDir, 'quotes', 'v1');
      expect(await deploymentDiff(devDir, deployed)).toBeUndefined();

      await computeClient().deleteInstance((await nodeOf(directory, 'quotes')).id);
      await ensureServiceInstances(container, devDir, ['quotes']);

      expect(await deploymentDiff(devDir, deployed)).toEqual({ action: 'update' });
    }, 30_000);

    test("deleting a removed service's App deletes its instance and forgets it", async () => {
      const { directory, devDir } = projectDir('removed');
      await ensureServiceInstances(container, devDir, ADDRESSES);
      const quotes = await nodeOf(directory, 'quotes');
      const provider = await appProvider(devDir);

      await Effect.runPromise(provider.delete({ output: { name: 'quotes' } } as never));

      expect(await computeClient().getInstance(quotes.id)).toBeUndefined();
      expect(Object.keys((await mappingOf(directory))?.nodes ?? {})).toEqual(['gateway']);
    });
  });

  test('the record is one JSON file in the dev directory, readable from the directory alone', async () => {
    const { directory, devDir } = projectDir('file');
    await ensureServiceInstances(container, devDir, ['quotes']);

    const onDisk: unknown = JSON.parse(
      fs.readFileSync(path.join(devDir, EMULATOR_INSTANCES_FILE), 'utf8'),
    );
    const node = await nodeOf(directory, 'quotes');
    expect(onDisk).toEqual({ app: APP, nodes: { quotes: node } });
    expect((await computeClient().getInstance(node.id))?.labels).toEqual({
      'composer.directory': directory,
      'composer.app': APP,
      'composer.address': 'quotes',
    });
    expect(await readEmulatorInstances(path.join(root, 'never-ran'))).toBeUndefined();
  });

  describe('switching apps in a directory', () => {
    test("running another app deletes the previous app's compute instances and starts a new record", async () => {
      const { directory, devDir } = projectDir('switch');
      await ensureServiceInstances(container, devDir, ADDRESSES);
      const previous = Object.values((await mappingOf(directory))?.nodes ?? {});

      const retired = await retirePreviousApp({ devDir, app: 'another-app' });

      expect(retired).toBe(APP);
      for (const node of previous)
        expect(await computeClient().getInstance(node.id)).toBeUndefined();
      expect(await mappingOf(directory)).toEqual({ app: 'another-app', nodes: {} });
    });

    test('running the same app again retires nothing', async () => {
      const { directory, devDir } = projectDir('same');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const quotes = await nodeOf(directory, 'quotes');

      expect(await retirePreviousApp({ devDir, app: APP })).toBeUndefined();
      expect(await computeClient().getInstance(quotes.id)).toBeDefined();
    });
  });

  describe('--fresh', () => {
    const otherApp: ContainerInstance = {
      input: { appName: 'other-app', stage: undefined },
      serialize: () => 'x',
    };

    async function liveIds(ids: readonly string[]): Promise<string[]> {
      const live = await Promise.all(ids.map((id) => computeClient().getInstance(id)));
      return live.flatMap((instance) => (instance ? [instance.id] : []));
    }

    test('deletes the recorded instances even when the record names the app run here before', async () => {
      const { directory, devDir } = projectDir('fresh-previous');
      await ensureServiceInstances(container, devDir, ADDRESSES);
      const ids = Object.values((await mappingOf(directory))?.nodes ?? {}).map((n) => n.id);

      await deleteRecordedInstances(devDir);

      expect(await liveIds(ids)).toEqual([]);
      expect((await mappingOf(directory))?.nodes).toEqual({});
    });

    test('after switching apps, leaves no instance of either app', async () => {
      const { directory, devDir } = projectDir('fresh-switch');
      await ensureServiceInstances(container, devDir, ADDRESSES);
      const first = Object.values((await mappingOf(directory))?.nodes ?? {}).map((n) => n.id);
      await retirePreviousApp({ devDir, app: 'other-app' });
      await ensureServiceInstances(otherApp, devDir, ['web']);
      const second = Object.values((await mappingOf(directory))?.nodes ?? {}).map((n) => n.id);

      await deleteRecordedInstances(devDir);

      expect(await liveIds([...first, ...second])).toEqual([]);
    });
  });

  describe("the App provider's diff", () => {
    async function reconcileApp(devDir: string, address: string): Promise<App['Attributes']> {
      const provider = await appProvider(devDir);
      return Effect.runPromise(
        provider.reconcile(
          reconcileInput(`${address}-svc`, { project: 'local', displayName: address }),
        ),
      );
    }

    async function appDiff(devDir: string, output: App['Attributes']): Promise<unknown> {
      const diff = (await appProvider(devDir)).diff;
      if (!diff) throw new Error('the local App provider has no diff');
      return Effect.runPromise(diff({ output } as never));
    }

    test('asks for an update when the re-created instance got another port', async () => {
      const { directory, devDir } = projectDir('app-moved');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const before = await reconcileApp(devDir, 'quotes');
      const recorded = await nodeOf(directory, 'quotes');
      await computeClient().deleteInstance(recorded.id);
      await computeClient().createInstance({ labels: {}, port: recorded.port });
      await ensureServiceInstances(container, devDir, ['quotes']);

      expect(await appDiff(devDir, before)).toEqual({ action: 'update' });
      const after = await reconcileApp(devDir, 'quotes');
      expect(after.appEndpointDomain).toBe(
        `http://localhost:${String((await nodeOf(directory, 'quotes')).port)}`,
      );
      expect(after.appEndpointDomain).not.toBe(before.appEndpointDomain);
    });

    test('asks for nothing when the re-created instance kept its port', async () => {
      const { directory, devDir } = projectDir('app-kept');
      await ensureServiceInstances(container, devDir, ['quotes']);
      const before = await reconcileApp(devDir, 'quotes');
      await computeClient().deleteInstance((await nodeOf(directory, 'quotes')).id);
      await ensureServiceInstances(container, devDir, ['quotes']);

      expect(await appDiff(devDir, before)).toBeUndefined();
    });
  });

  describe('errors name services by address', () => {
    test('a deployed service that exits before it listens fails naming its address', async () => {
      const { devDir } = projectDir('crash');
      await ensureServiceInstances(container, devDir, ['quotes']);

      const failure = await deploy(devDir, 'quotes', 'v1', crashingArtifactFor('quotes')).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect(failure).toContain('service "quotes" exited (code 1) before it accepted connections');
      expect(failure).not.toContain('instance "svc_');
    }, 30_000);
  });
});
