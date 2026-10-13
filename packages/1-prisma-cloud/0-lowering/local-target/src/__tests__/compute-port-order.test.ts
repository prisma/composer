import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerInstance } from '@internal/core/config';
import { EMULATORS_DIR_ENV, ensureDaemon, stopDaemon } from '@internal/dev-emulators';
import { App } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { ensureAppInstances } from '../app-instances.ts';
import { LocalAppProvider } from '../compute.ts';
import { ensureComputeInstance, nodeInstancesOf } from '../emulator-instances.ts';

function ensureServiceInstances(
  forContainer: ContainerInstance,
  devDir: string,
  addresses: readonly string[],
) {
  return ensureAppInstances(
    { devDir, app: forContainer.input.appName },
    addresses.map((address) => ({ address, kind: 'compute' as const })),
  );
}

const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
let registryRoot: string;
let devDir: string;

beforeEach(async () => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-port-order-'));
  devDir = path.join(registryRoot, 'project', '.prisma-composer', 'dev');
  process.env[EMULATORS_DIR_ENV] = registryRoot;
  const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/compute-main'));
  await ensureDaemon('compute', entry, { registryRoot });
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
  fs.rmSync(registryRoot, { recursive: true, force: true });
  if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
  else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
});

function fakeContainer(appName: string): ContainerInstance {
  return { input: { appName, stage: undefined }, serialize: () => 'x' };
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

async function reconcileApp(container: ContainerInstance, address: string): Promise<number> {
  const provider = await Effect.runPromise(
    App.Provider.pipe(Effect.provide(LocalAppProvider({ container, devDir }))),
  );
  const attributes: App['Attributes'] = await Effect.runPromise(
    provider.reconcile(
      reconcileInput(`${address}-svc`, { project: 'local', displayName: address }),
    ),
  );
  return Number(new URL(attributes.appEndpointDomain ?? '').port);
}

async function reservedPorts(app: string): Promise<Record<string, number>> {
  const nodes = await nodeInstancesOf({ devDir, app }, 'compute');
  return Object.fromEntries(nodes.map(({ address, instance }) => [address, instance.port]));
}

test('each App provider returns the port reserved for its service, even when the providers race', async () => {
  for (let run = 0; run < 10; run++) {
    const appName = `port-order-${String(run)}`;
    const container = fakeContainer(appName);
    await ensureServiceInstances(container, devDir, ['quotes', 'gateway']);
    const reserved = await reservedPorts(appName);

    const [gateway, quotes] = await Promise.all([
      reconcileApp(container, 'gateway'),
      reconcileApp(container, 'quotes'),
    ]);

    expect({ quotes, gateway }).toEqual({
      quotes: reserved['quotes'] ?? -1,
      gateway: reserved['gateway'] ?? -1,
    });
  }
});

test('a failed reservation names the service', async () => {
  await stopDaemon('compute', { registryRoot });

  await expect(
    ensureServiceInstances(fakeContainer('port-order-down'), devDir, ['quotes']),
  ).rejects.toThrow('service "quotes"');
});

test('reserving the services of an app that already has ports keeps those ports', async () => {
  const container = fakeContainer('port-order-warm');
  const scope = { devDir, app: 'port-order-warm' };
  const { instance: gateway } = await ensureComputeInstance(scope, 'gateway');
  const { instance: quotes } = await ensureComputeInstance(scope, 'quotes');

  await ensureServiceInstances(container, devDir, ['quotes', 'gateway']);

  expect(await reconcileApp(container, 'quotes')).toBe(quotes.port);
  expect(await reconcileApp(container, 'gateway')).toBe(gateway.port);
});

test('a dotted service address reserves the same emulator instance the App provider uses', async () => {
  const container = fakeContainer('port-order-nested');
  await ensureServiceInstances(container, devDir, ['shop.quotes']);

  const listed = (await nodeInstancesOf({ devDir, app: 'port-order-nested' }, 'compute')).map(
    (node) => node.instance,
  );
  expect(await reconcileApp(container, 'shop.quotes')).toBe(listed[0]?.port ?? -1);
  expect(listed).toHaveLength(1);
});
