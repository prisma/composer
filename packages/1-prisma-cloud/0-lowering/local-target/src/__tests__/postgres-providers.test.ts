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
import {
  deleteDatabaseInstances,
  LocalConnectionProvider,
  LocalDatabaseProvider,
} from '../postgres.ts';

const APP = 'pg-providers-app';
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

async function reconcileDatabase(name: string): Promise<Database['Attributes']> {
  const service = await Effect.runPromise(
    Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
  );
  return Effect.runPromise(
    service.reconcile(reconcileInput('db', { project: 'p', name, region: 'us-east-1' })),
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
      input: { appName: APP, stage: undefined },
      serialize: () => 'x',
    };
    input = { container, devDir: path.join(root, 'project', '.prisma-composer', 'dev') };
  });

  afterEach(async () => {
    await deleteDatabaseInstances({ devDir: input.devDir, app: APP }).catch(() => undefined);
    await stopDaemon('postgres', { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  test('a Database creates a database instance, and its Connection resolves the same one', async () => {
    const database = await reconcileDatabase('catalog.database');

    const service = await Effect.runPromise(
      Connection.Provider.pipe(Effect.provide(LocalConnectionProvider(input))),
    );
    const connection: Connection['Attributes'] = await Effect.runPromise(
      service.reconcile(reconcileInput('conn', { database, name: 'conn' })),
    );

    const instance = await postgresClient().getInstance(database.databaseId);
    expect(instance?.labels['composer.address']).toBe('catalog.database');
    expect(connection.databaseId).toBe(database.databaseId);
    const direct = connection.directConnectionString;
    if (direct === undefined) throw new Error('expected a direct connection string');
    expect(Redacted.value(direct)).toBe(instance?.url ?? '');
  }, 60_000);

  test('reconciling a Database again reuses its instance, starting it when stopped', async () => {
    const first = await reconcileDatabase('orders');
    await postgresClient().stopInstances([first.databaseId]);

    const second = await reconcileDatabase('orders');

    expect(second.databaseId).toBe(first.databaseId);
    expect((await postgresClient().getInstance(first.databaseId))?.status).toBe('running');
  }, 60_000);
});
