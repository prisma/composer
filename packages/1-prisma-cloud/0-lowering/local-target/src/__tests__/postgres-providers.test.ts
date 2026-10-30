/**
 * The local Database and Connection providers against a real Postgres
 * emulator in a temporary emulators directory: a Database is a database
 * instance, and its Connection resolves the same instance by its id.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerInstance, LocalTargetProvidersInput } from '@internal/core/config';
import {
  EMULATORS_DIR_ENV,
  ensureDaemon,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import { Connection, Database } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { deleteAppInstances, readEmulatorInstances } from '../emulator-instances.ts';
import { LocalConnectionProvider, LocalDatabaseProvider } from '../postgres.ts';

const APP = 'pg-providers-app';
const CATALOG = `${APP}.catalog.database`;
const ORDERS = `${APP}.orders`;
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
let root: string;
let registryRoot: string;
let input: LocalTargetProvidersInput;

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

/** The resource ID is the node's address and keys the record; `name` is only the label. */
async function reconcileDatabase(address: string): Promise<Database['Attributes']> {
  const service = await Effect.runPromise(
    Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
  );
  return Effect.runPromise(
    service.reconcile(
      reconcileInput(address, {
        project: 'p',
        name: address.slice(address.indexOf('.') + 1),
        region: 'us-east-1',
      }),
    ),
  );
}

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')('the local Database and Connection providers', () => {
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-pg-providers-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/postgres-main'));
    await ensureDaemon('postgres', entry, { registryRoot });
    const container: ContainerInstance = {
      input: { appName: APP, environment: 'dev' },
      serialize: () => 'x',
    };
    input = {
      container,
      devDir: path.join(root, 'project', '.prisma-composer', 'dev', 'dev'),
      pools: { config: {}, secrets: {} },
    };
  });

  afterEach(async () => {
    await deleteAppInstances({ devDir: input.devDir, app: APP, environment: 'dev' }).catch(
      () => undefined,
    );
    await stopDaemon('postgres', { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  test('a Database creates a database instance, and its Connection resolves the same one', async () => {
    const database = await reconcileDatabase(CATALOG);

    const service = await Effect.runPromise(
      Connection.Provider.pipe(Effect.provide(LocalConnectionProvider(input))),
    );
    const connection: Connection['Attributes'] = await Effect.runPromise(
      service.reconcile(reconcileInput('conn', { database, name: 'conn' })),
    );

    const instance = await postgresClient().getInstance(database.databaseId);
    expect(instance?.labels['composer.address']).toBe(CATALOG);
    expect(connection.databaseId).toBe(database.databaseId);
    const direct = connection.directConnectionString;
    if (direct === undefined) throw new Error('expected a direct connection string');
    expect(Redacted.value(direct)).toBe(instance?.url ?? '');
  }, 60_000);

  test('reconciling a Database again reuses its instance, starting it when stopped', async () => {
    const first = await reconcileDatabase(ORDERS);
    await postgresClient().stopInstances([first.databaseId]);

    const second = await reconcileDatabase(ORDERS);

    expect(second.databaseId).toBe(first.databaseId);
    expect((await postgresClient().getInstance(first.databaseId))?.status).toBe('running');
  }, 60_000);

  async function databaseDiff(output: Database['Attributes']): Promise<unknown> {
    const service = await Effect.runPromise(
      Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
    );
    const diff = service.diff;
    if (!diff) throw new Error('the local Database provider has no diff');
    return Effect.runPromise(diff({ output } as never));
  }

  test('a Database whose recorded instance was re-created asks for an update', async () => {
    const database = await reconcileDatabase(ORDERS);
    expect(await databaseDiff(database)).toBeUndefined();

    await postgresClient().deleteInstance(database.databaseId);
    const again = await reconcileDatabase(ORDERS);

    expect(again.databaseId).not.toBe(database.databaseId);
    expect(await databaseDiff(database)).toEqual({ action: 'update' });
    const recorded = (await readEmulatorInstances(input.devDir))?.apps[APP];
    expect(recorded?.nodes[ORDERS]).toMatchObject({
      kind: 'database',
      id: again.databaseId,
    });
  }, 90_000);
});
