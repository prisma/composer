import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { App } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { LocalAppProvider, reserveServicePorts } from '../compute.ts';

const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
let registryRoot: string;

beforeEach(async () => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-port-order-'));
  process.env[EMULATORS_DIR_ENV] = registryRoot;
  const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/compute-main'));
  await ensureDaemon('compute', entry, { registryRoot });
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
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
    App.Provider.pipe(Effect.provide(LocalAppProvider({ container, devDir: '/dev/null/unused' }))),
  );
  const attributes: App['Attributes'] = await Effect.runPromise(
    provider.reconcile(
      reconcileInput(`${address}-svc`, { project: 'local', displayName: address }),
    ),
  );
  return Number(new URL(attributes.appEndpointDomain ?? '').port);
}

test('services reserved in graph order keep that order when the App providers then race', async () => {
  for (let run = 0; run < 10; run++) {
    const container = fakeContainer(`port-order-${String(run)}`);
    await reserveServicePorts(container, ['quotes', 'gateway']);

    const [gateway, quotes] = await Promise.all([
      reconcileApp(container, 'gateway'),
      reconcileApp(container, 'quotes'),
    ]);

    expect(quotes).toBeLessThan(gateway);
  }
});

test('reserving the services of an app that already has ports keeps those ports', async () => {
  const container = fakeContainer('port-order-warm');
  const client = computeClient();
  const gateway = await client.ensureService('port-order-warm', 'gateway');
  const quotes = await client.ensureService('port-order-warm', 'quotes');

  await reserveServicePorts(container, ['quotes', 'gateway']);

  expect(await reconcileApp(container, 'quotes')).toBe(quotes.port);
  expect(await reconcileApp(container, 'gateway')).toBe(gateway.port);
});

test('a dotted service address reserves the same emulator service the App provider uses', async () => {
  const container = fakeContainer('port-order-nested');
  await reserveServicePorts(container, ['shop.quotes']);

  const listed = await computeClient().listServices('port-order-nested');
  expect(await reconcileApp(container, 'shop.quotes')).toBe(listed[0]?.port ?? -1);
  expect(listed).toHaveLength(1);
});
