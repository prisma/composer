/**
 * Legacy state rows — written by Composer's own deleted `Prisma.Database` /
 * `Prisma.Connection` / `Prisma.ComputeService` / `Prisma.Deployment` /
 * `Prisma.EnvironmentVariable` resources — must round-trip through the hosted
 * state store into shapes upstream alchemy's providers ACCEPT. On the
 * unchanged path that means: the provider's `diff` plans no action (so no
 * create and no replace), its `read` finds the physical resource instead of
 * returning `undefined` (which would plan a create), and `reconcile` keeps the
 * persisted secret without rotating anything. Where migration cannot avoid a
 * mutating plan (a production App's unrecorded branch, a deployment's
 * unrecoverable artifact fingerprint), the test pins WHICH action is planned,
 * so the one-time cost stays visible.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstanceId } from 'alchemy/InstanceId';
import * as Prisma from 'alchemy/Prisma';
import type * as Provider from 'alchemy/Provider';
import { Stack } from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import {
  type CreatedResourceState,
  type ReplacedResourceState,
  State,
  type StateService,
} from 'alchemy/State';
import { PlatformServices } from 'alchemy/Util/PlatformServices';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { stateLayerAgainst } from '../layer.ts';
import { migrateLegacyResourceState } from '../legacy-resources.ts';
import { FakeStateApi } from './fake-state-api.ts';

process.env['PRISMA_SERVICE_TOKEN'] ??= 'test-service-token';

const DIRECT_URL = 'postgres://user:pass@db.prisma.io:5432/postgres';

const legacyDatabaseRow = (): CreatedResourceState => ({
  resourceType: 'Prisma.Database',
  namespace: undefined,
  fqn: 'data-db',
  logicalId: 'data-db',
  instanceId: 'inst-db',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { projectId: 'proj-1', name: 'data', region: 'us-east-1' },
  attr: { id: 'db-1', name: 'data' },
});

const legacyConnectionRow = (): CreatedResourceState => ({
  resourceType: 'Prisma.Connection',
  namespace: undefined,
  fqn: 'data-conn',
  logicalId: 'data-conn',
  instanceId: 'inst-conn',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { databaseId: 'db-1', name: 'data' },
  attr: { id: 'conn-1', connectionString: Redacted.make(DIRECT_URL) },
});

const apiDatabase = {
  id: 'db-1',
  name: 'data',
  project: { id: 'proj-1' },
  status: 'ready',
  region: { id: 'us-east-1' },
  isDefault: false,
  branchId: null,
  defaultConnectionId: 'conn-default',
  createdAt: '2025-01-01T00:00:00.000Z',
  source: { type: 'empty' },
  connections: [],
};

const apiConnection = {
  id: 'conn-1',
  name: 'data',
  database: { id: 'db-1' },
  kind: 'postgres',
  createdAt: '2025-01-01T00:00:00.000Z',
};

/** Only the endpoints the adoption paths under test actually hit; anything else throws loudly. */
const stubClient = {
  getDatabase: (id: string) =>
    id === 'db-1' ? Effect.succeed(apiDatabase) : Effect.die(`unexpected getDatabase ${id}`),
  getConnection: (id: string) =>
    id === 'conn-1' ? Effect.succeed(apiConnection) : Effect.die(`unexpected getConnection ${id}`),
  rotateConnection: (id: string) =>
    Effect.die(`rotateConnection(${id}) must not be called for an adopted legacy row`),
} as unknown as Prisma.PrismaManagementClient;

// The provider layers' inferred environment leaks an `any` through
// Provider.effect's typing; the stubbed PrismaClient is the only real
// requirement and it IS provided, so the runtime environment is complete.
const databaseService = () =>
  Effect.runPromise(
    Prisma.Database.Provider.pipe(
      Effect.provide(
        Prisma.DatabaseProvider().pipe(
          Layer.provide(Layer.succeed(Prisma.PrismaClient, stubClient)),
        ),
      ),
    ) as Effect.Effect<Provider.ProviderService<Prisma.Database>, never, never>,
  );

const connectionService = () =>
  Effect.runPromise(
    Prisma.Connection.Provider.pipe(
      Effect.provide(
        Prisma.ConnectionProvider().pipe(
          Layer.provide(Layer.succeed(Prisma.PrismaClient, stubClient)),
        ),
      ),
    ) as Effect.Effect<Provider.ProviderService<Prisma.Connection>, never, never>,
  );

type MigratedRow = CreatedResourceState & {
  props: Record<string, unknown>;
  attr: Record<string, unknown>;
};

describe('migrateLegacyResourceState (pure mapping)', () => {
  test('maps a legacy Database row to upstream field names, idempotently', () => {
    const migrated = migrateLegacyResourceState(legacyDatabaseRow()) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.Database');
    expect(migrated.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
    expect(migrated.attr).toMatchObject({
      databaseId: 'db-1',
      databaseName: 'data',
      projectId: 'proj-1',
      region: 'us-east-1',
      isDefault: false,
      branchId: null,
    });
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
  });

  test('maps a legacy Connection row, carrying the Redacted secret into directConnectionString', () => {
    const migrated = migrateLegacyResourceState(legacyConnectionRow()) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.Connection');
    expect(migrated.props).toEqual({ database: 'db-1', name: 'data' });
    expect(migrated.attr).toMatchObject({
      connectionId: 'conn-1',
      connectionName: 'data',
      databaseId: 'db-1',
      kind: 'postgres',
    });
    const direct = migrated.attr['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
  });

  test('migrates the nested old-generation chain of a replaced row', () => {
    const replaced: ReplacedResourceState = {
      ...legacyDatabaseRow(),
      status: 'replaced',
      old: legacyDatabaseRow(),
      deleteFirst: false,
    } as ReplacedResourceState;
    const migrated = migrateLegacyResourceState(replaced) as ReplacedResourceState & {
      old: MigratedRow;
    };
    expect(migrated.old.resourceType).toBe('Prisma.Database');
    expect(migrated.old.attr).toMatchObject({ databaseId: 'db-1', databaseName: 'data' });
    expect(migrated.old.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
  });

  test('maps the unreleased PrismaComposer.* type-ids too, and passes foreign rows through', () => {
    const composerEra = { ...legacyDatabaseRow(), resourceType: 'PrismaComposer.Database' };
    expect((migrateLegacyResourceState(composerEra) as MigratedRow).resourceType).toBe(
      'Prisma.Database',
    );
    const foreign = { ...legacyDatabaseRow(), resourceType: 'Cloudflare.Worker' };
    expect(migrateLegacyResourceState(foreign)).toEqual(foreign);
  });
});

describe('upstream provider acceptance of migrated rows (stubbed management client)', () => {
  const migratedDb = migrateLegacyResourceState(legacyDatabaseRow()) as MigratedRow;
  const migratedConn = migrateLegacyResourceState(legacyConnectionRow()) as MigratedRow;

  test('Database: diff plans NO action, and read finds the database (no create)', async () => {
    const service = await databaseService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const diff = await Effect.runPromise(
      service.diff({
        id: 'data-db',
        fqn: 'data-db',
        instanceId: 'inst-db',
        olds: migratedDb.props,
        news: { project: 'proj-1', name: 'data', region: 'us-east-1' },
        output: migratedDb.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toBeUndefined();

    const read = await Effect.runPromise(
      service.read({
        id: 'data-db',
        fqn: 'data-db',
        instanceId: 'inst-db',
        olds: migratedDb.props,
        output: migratedDb.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ databaseId: 'db-1', databaseName: 'data', projectId: 'proj-1' });
  });

  test('Connection: diff plans NO action, read finds it, reconcile keeps the secret WITHOUT rotating', async () => {
    const service = await connectionService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const diff = await Effect.runPromise(
      service.diff({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        news: { database: 'db-1', name: 'data' },
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toBeUndefined();

    const read = await Effect.runPromise(
      service.read({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ connectionId: 'conn-1', databaseId: 'db-1' });

    // The stub's rotateConnection dies, so this passing proves reconcile
    // never touched the live credentials.
    const reconciled = (await Effect.runPromise(
      service.reconcile({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        news: { database: 'db-1', name: 'data' },
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    )) as Record<string, unknown>;
    const direct = reconciled['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
  });
});

describe('branch-stage migrated rows against upstream Database provider', () => {
  // A branch-stage row: the legacy descriptor passed an explicit name AND a
  // branchId; the replacement descriptor omits the name when branchId is set.
  const legacyBranchRow = (): CreatedResourceState => ({
    ...legacyDatabaseRow(),
    props: { projectId: 'proj-1', name: 'data', region: 'us-east-1', branchId: 'branch_1' },
  });

  test('diff plans an UPDATE (the one-time rename + credential-recovery path), never a replace or create', async () => {
    const migrated = migrateLegacyResourceState(legacyBranchRow()) as MigratedRow;
    expect(migrated.props).toEqual({
      project: 'proj-1',
      name: 'data',
      region: 'us-east-1',
      branchId: 'branch_1',
    });
    expect(migrated.attr).toMatchObject({ branchId: 'branch_1' });

    const service = await databaseService();
    if (service.diff === undefined) throw new Error('upstream provider must expose diff');
    const diff = await Effect.runPromise(
      service
        .diff({
          id: 'data-db',
          fqn: 'data-db',
          instanceId: 'inst-db',
          olds: migrated.props,
          // Branch-stage news shape from descriptors/postgres.ts: NO name.
          news: { project: 'proj-1', region: 'us-east-1', branchId: 'branch_1' },
          output: migrated.attr,
          session: undefined,
          bindings: [],
        } as never)
        .pipe(
          // The omitted name makes upstream derive a generated physical name,
          // which reads the engine's Stack/Stage/InstanceId context.
          Effect.provideService(Stack, { name: 'app' } as never),
          Effect.provideService(Stage, 'stage1'),
          Effect.provideService(InstanceId, 'abcd1234abcd1234abcd1234abcd1234'),
        ),
    );
    expect(diff).toEqual({ action: 'update' });
  });
});

describe('legacy compute-family rows against upstream providers', () => {
  const legacyAppRow = (branchId?: string): CreatedResourceState => ({
    resourceType: 'Prisma.ComputeService',
    namespace: undefined,
    fqn: 'auth-svc',
    logicalId: 'auth-svc',
    instanceId: 'inst-app',
    providerVersion: 1,
    status: 'created',
    downstream: [],
    bindings: [],
    props: {
      projectId: 'proj-1',
      name: 'auth',
      region: 'us-east-1',
      ...(branchId !== undefined ? { branchId } : {}),
    },
    attr: { id: 'app-1', name: 'auth', endpointDomain: 'auth.prisma.app' },
  });

  const legacyDeploymentRow = (artifactPath: string): CreatedResourceState => ({
    resourceType: 'Prisma.Deployment',
    namespace: undefined,
    fqn: 'auth-deploy',
    logicalId: 'auth-deploy',
    instanceId: 'inst-deploy',
    providerVersion: 1,
    status: 'created',
    downstream: [],
    bindings: [],
    props: {
      computeServiceId: 'app-1',
      artifactPath,
      artifactHash: 'sha-auth',
      port: 8080,
      environment: [{ id: 'var-1', key: 'COMPOSER_AUTH_PORT' }],
    },
    attr: { deploymentId: 'dep-1', deployedUrl: 'auth.prisma.app' },
  });

  const legacyEnvRow = (key: string): CreatedResourceState => ({
    resourceType: 'Prisma.EnvironmentVariable',
    namespace: undefined,
    fqn: `${key}-var`,
    logicalId: `${key}-var`,
    instanceId: 'inst-var',
    providerVersion: 1,
    status: 'created',
    downstream: [],
    bindings: [],
    props: { projectId: 'proj-1', key, value: 'plain-secret', class: 'production' },
    attr: { id: 'var-1', key },
  });

  const apiApp = {
    id: 'app-1',
    name: 'auth',
    projectId: 'proj-1',
    region: { id: 'us-east-1' },
    branchId: 'branch_1',
    latestDeploymentId: 'dep-1',
    appEndpointDomain: 'auth.prisma.app',
    createdAt: '2025-01-01T00:00:00.000Z',
  };

  const apiDeployment = {
    id: 'dep-1',
    type: 'deployment',
    url: 'https://api.prisma.io/v1/deployments/dep-1',
    foundryVersionId: 'fv-1',
    status: 'running',
    previewDomain: 'dep-1.preview.prisma.app',
    createdAt: '2025-01-01T00:00:00.000Z',
  };

  const apiVariable = {
    id: 'var-1',
    projectId: 'proj-1',
    branchId: null,
    class: 'production',
    key: 'COMPOSER_AUTH_PORT',
    valueKid: 'kid-1',
    isManagedBySystem: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };

  /** Only the endpoints these adoption paths hit; anything else throws loudly. */
  const computeClient = {
    getApp: (id: string) =>
      id === 'app-1' ? Effect.succeed(apiApp) : Effect.die(`unexpected getApp ${id}`),
    listBranches: () => Effect.succeed([{ id: 'branch_1', isDefault: true }]),
    getDeployment: (id: string) =>
      id === 'dep-1' ? Effect.succeed(apiDeployment) : Effect.die(`unexpected getDeployment ${id}`),
    listAppDeployments: () => Effect.succeed([apiDeployment]),
    getEnvironmentVariable: (id: string) =>
      id === 'var-1'
        ? Effect.succeed(apiVariable)
        : Effect.die(`unexpected getEnvironmentVariable ${id}`),
    deleteEnvironmentVariable: (id: string) =>
      Effect.die(`deleteEnvironmentVariable(${id}) must not be called for a platform-owned key`),
    createAppDeployment: () => Effect.die('createAppDeployment must not be called by a diff'),
  } as unknown as Prisma.PrismaManagementClient;

  // Same `any` leak through Provider.effect's typing as the postgres services
  // above: the stubbed PrismaClient is the only real requirement and it IS
  // provided, so the runtime environment is complete.
  const appService = () =>
    Effect.runPromise(
      Prisma.App.Provider.pipe(
        Effect.provide(
          Prisma.AppProvider().pipe(
            Layer.provide(Layer.succeed(Prisma.PrismaClient, computeClient)),
          ),
        ),
      ) as Effect.Effect<Provider.ProviderService<Prisma.App>, never, never>,
    );

  const deploymentService = () =>
    Effect.runPromise(
      Prisma.Deployment.Provider.pipe(
        Effect.provide(
          Prisma.DeploymentProvider().pipe(
            Layer.provide(Layer.succeed(Prisma.PrismaClient, computeClient)),
          ),
        ),
      ) as Effect.Effect<Provider.ProviderService<Prisma.Deployment>, never, never>,
    );

  const environmentVariableService = () =>
    Effect.runPromise(
      Prisma.EnvironmentVariable.Provider.pipe(
        Effect.provide(
          Prisma.EnvironmentVariableProvider().pipe(
            Layer.provide(Layer.succeed(Prisma.PrismaClient, computeClient)),
          ),
        ),
      ) as Effect.Effect<Provider.ProviderService<Prisma.EnvironmentVariable>, never, never>,
    );

  test('maps a legacy ComputeService row onto Prisma.App, idempotently', () => {
    const migrated = migrateLegacyResourceState(legacyAppRow('branch_1')) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.App');
    expect(migrated.props).toEqual({
      project: 'proj-1',
      displayName: 'auth',
      regionId: 'us-east-1',
      branchId: 'branch_1',
    });
    expect(migrated.attr).toMatchObject({
      appId: 'app-1',
      name: 'auth',
      projectId: 'proj-1',
      regionId: 'us-east-1',
      branchId: 'branch_1',
      appEndpointDomain: 'auth.prisma.app',
    });
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
  });

  test('App on a branch stage: diff plans NO action, read finds the app (no create)', async () => {
    const migrated = migrateLegacyResourceState(legacyAppRow('branch_1')) as MigratedRow;
    const service = await appService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const diff = await Effect.runPromise(
      service.diff({
        id: 'auth-svc',
        fqn: 'auth-svc',
        instanceId: 'inst-app',
        olds: migrated.props,
        news: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toBeUndefined();

    const read = await Effect.runPromise(
      service.read({
        id: 'auth-svc',
        fqn: 'auth-svc',
        instanceId: 'inst-app',
        olds: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ appId: 'app-1', projectId: 'proj-1' });
  });

  test('App on production: diff plans an UPDATE — the one-time branch-id repair, never a replace', async () => {
    // A production row recorded no branch, and the project's default branch id
    // is not derivable from the row, so upstream re-reads the App once.
    const migrated = migrateLegacyResourceState(legacyAppRow()) as MigratedRow;
    expect(migrated.attr).toMatchObject({ branchId: null });
    const service = await appService();
    if (service.diff === undefined) throw new Error('upstream provider must expose diff');
    const diff = await Effect.runPromise(
      service.diff({
        id: 'auth-svc',
        fqn: 'auth-svc',
        instanceId: 'inst-app',
        olds: migrated.props,
        news: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toEqual({ action: 'update' });
  });

  test('maps a legacy Deployment row onto upstream props/attrs, idempotently', () => {
    const migrated = migrateLegacyResourceState(
      legacyDeploymentRow('/tmp/auth.tar.gz'),
    ) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.Deployment');
    expect(migrated.props).toEqual({
      app: 'app-1',
      artifactPath: '/tmp/auth.tar.gz',
      artifactContentType: 'application/gzip',
      portMapping: { http: 8080 },
      start: true,
      promote: true,
    });
    expect(migrated.attr).toMatchObject({
      deploymentId: 'dep-1',
      appId: 'app-1',
      appEndpointDomain: 'auth.prisma.app',
    });
    // Absent, not invented: upstream recovers a lost deployment by Foundry
    // version id, and a made-up one could claim a stranger's deployment.
    expect(migrated.attr['foundryVersionId']).toBeUndefined();
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
  });

  test('Deployment: read finds the deployment; diff plans the one-time REPLACE (unrecoverable artifact fingerprint)', async () => {
    const artifactPath = path.join(os.tmpdir(), `legacy-artifact-${process.pid}.tar.gz`);
    fs.writeFileSync(artifactPath, 'artifact-bytes');
    try {
      const migrated = migrateLegacyResourceState(legacyDeploymentRow(artifactPath)) as MigratedRow;
      const service = await deploymentService();
      if (service.diff === undefined || service.read === undefined) {
        throw new Error('upstream provider must expose diff and read');
      }

      const read = await Effect.runPromise(
        service
          .read({
            id: 'auth-deploy',
            fqn: 'auth-deploy',
            instanceId: 'inst-deploy',
            olds: migrated.props,
            output: migrated.attr,
            session: undefined,
            bindings: [],
          } as never)
          .pipe(Effect.provide(PlatformServices)) as Effect.Effect<unknown, never, never>,
      );
      // Read adopts the live deployment — no create planned for it.
      expect(read).toMatchObject({ deploymentId: 'dep-1', appId: 'app-1', status: 'running' });

      const diff = await Effect.runPromise(
        service
          .diff({
            id: 'auth-deploy',
            fqn: 'auth-deploy',
            instanceId: 'inst-deploy',
            olds: migrated.props,
            news: migrated.props,
            output: migrated.attr,
            session: undefined,
            bindings: [],
          } as never)
          .pipe(Effect.provide(PlatformServices)) as Effect.Effect<unknown, never, never>,
      );
      // Pinned, not tolerated silently: upstream's fingerprint hashes the
      // artifact digest with the content type, which a legacy row cannot
      // reproduce, so the first deploy after migration ships one fresh
      // deployment per service (create-before-delete, artifact unchanged).
      expect(diff).toEqual({ action: 'replace' });
    } finally {
      fs.rmSync(artifactPath, { force: true });
    }
  });

  test('maps a legacy EnvironmentVariable row onto upstream field names, redacting the stored value', () => {
    const migrated = migrateLegacyResourceState(legacyEnvRow('COMPOSER_AUTH_PORT')) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.EnvironmentVariable');
    expect(migrated.attr).toMatchObject({
      environmentVariableId: 'var-1',
      projectId: 'proj-1',
      branchId: null,
      class: 'production',
      key: 'COMPOSER_AUTH_PORT',
      isManagedBySystem: false,
    });
    // The legacy row kept the value in PLAIN TEXT in state; the migrated prop
    // carries it wrapped, which is what keeps it out of the next state write.
    const value = (migrated.props as { value: unknown })['value'];
    expect(Redacted.isRedacted(value)).toBe(true);
    expect(Redacted.value(value as Redacted.Redacted<string>)).toBe('plain-secret');
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
  });

  test('EnvironmentVariable: read finds the variable (no create); diff plans the value re-apply', async () => {
    const migrated = migrateLegacyResourceState(legacyEnvRow('COMPOSER_AUTH_PORT')) as MigratedRow;
    const service = await environmentVariableService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const read = await Effect.runPromise(
      service.read({
        id: 'COMPOSER_AUTH_PORT-var',
        fqn: 'COMPOSER_AUTH_PORT-var',
        instanceId: 'inst-var',
        olds: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ environmentVariableId: 'var-1', key: 'COMPOSER_AUTH_PORT' });

    const diff = await Effect.runPromise(
      service.diff({
        id: 'COMPOSER_AUTH_PORT-var',
        fqn: 'COMPOSER_AUTH_PORT-var',
        instanceId: 'inst-var',
        olds: migrated.props,
        news: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    // Values are write-only, so upstream re-applies the desired one on every
    // deploy — an update, never a replace or a create.
    expect(diff).toEqual({ action: 'update' });
  });

  test('a poison DATABASE_URL row is RETAINED, not deleted: state row retired, platform variable untouched', async () => {
    const migrated = migrateLegacyResourceState(legacyEnvRow('DATABASE_URL')) as MigratedRow;
    // `retain` is what makes the engine drop the state row, skip the provider
    // entirely, and report the resource as `retained` — the truthful verb for
    // "we let go of it and called no API". Reporting `deleted` would tell an
    // operator the platform variable is gone when it is still there.
    expect(migrated['removalPolicy']).toBe('retain');
    expect(migrated.attr).toEqual({
      environmentVariableId: 'dev:legacy-poison-DATABASE_URL',
      key: 'DATABASE_URL',
    });
    expect(migrateLegacyResourceState(migrated)).toEqual(migrated);
    const service = await environmentVariableService();
    // The stub's deleteEnvironmentVariable/getEnvironmentVariable die on this
    // id, so completing proves the platform's own variable is never touched.
    await Effect.runPromise(
      service.delete({
        id: 'DATABASE_URL-var',
        fqn: 'DATABASE_URL-var',
        instanceId: 'inst-var',
        olds: migrated.props,
        output: migrated.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
  });

  test('an UPSTREAM-shaped DATABASE_URL row is left alone: the props shape, not the key, decides', () => {
    // Upstream's own EnvironmentVariable rows carry the same type-id as the
    // legacy ones, so only the props shape tells them apart. A live variable
    // upstream manages must survive every state read untouched — retiring it
    // would drop a real resource from state on each deploy.
    const upstreamRow: CreatedResourceState = {
      ...legacyEnvRow('DATABASE_URL'),
      props: {
        project: 'proj-1',
        key: 'DATABASE_URL',
        class: 'production',
        value: Redacted.make('postgres://live'),
      },
      attr: {
        environmentVariableId: 'var-9',
        projectId: 'proj-1',
        branchId: null,
        class: 'production',
        key: 'DATABASE_URL',
        isManagedBySystem: false,
      },
    } as CreatedResourceState;
    const migrated = migrateLegacyResourceState(upstreamRow) as MigratedRow;
    expect(migrated['removalPolicy']).toBeUndefined();
    expect(migrated.attr).toEqual({
      environmentVariableId: 'var-9',
      projectId: 'proj-1',
      branchId: null,
      class: 'production',
      key: 'DATABASE_URL',
      isManagedBySystem: false,
    });
    expect(migrated).toEqual(upstreamRow as unknown as MigratedRow);
  });

  test('a REPLACED poison row migrates its displaced old generation before retiring itself', () => {
    // The row on top is retired, but the generation it displaced still rides
    // along under `old` and the engine reads it. It must arrive in the
    // upstream shape, so the old chain is rewritten before the retirement.
    const legacy = legacyEnvRow('DATABASE_URL');
    const replaced = {
      ...legacy,
      status: 'replaced',
      old: { props: legacy.props, attr: legacy.attr, bindings: [] },
      deleteFirst: false,
    } as unknown as ReplacedResourceState;
    const migrated = migrateLegacyResourceState(replaced) as ReplacedResourceState & {
      removalPolicy?: string;
      attr: Record<string, unknown>;
      old: { props: Record<string, unknown>; attr: Record<string, unknown> };
    };
    expect(migrated.removalPolicy).toBe('retain');
    expect(migrated.attr).toEqual({
      environmentVariableId: 'dev:legacy-poison-DATABASE_URL',
      key: 'DATABASE_URL',
    });
    expect(migrated.old.attr).toMatchObject({
      environmentVariableId: 'var-1',
      projectId: 'proj-1',
      key: 'DATABASE_URL',
      isManagedBySystem: false,
    });
    expect(migrated.old.props).toMatchObject({ project: 'proj-1', key: 'DATABASE_URL' });
    expect(Redacted.isRedacted(migrated.old.props['value'])).toBe(true);
  });

  test('maps the unreleased PrismaComposer.* compute type-ids too', () => {
    const composerEra = {
      ...legacyAppRow('branch_1'),
      resourceType: 'PrismaComposer.ComputeService',
    };
    expect((migrateLegacyResourceState(composerEra) as MigratedRow).resourceType).toBe(
      'Prisma.App',
    );
    const composerEnv = {
      ...legacyEnvRow('COMPOSER_AUTH_PORT'),
      resourceType: 'PrismaComposer.EnvironmentVariable',
    };
    expect((migrateLegacyResourceState(composerEnv) as MigratedRow).resourceType).toBe(
      'Prisma.EnvironmentVariable',
    );
    const composerPoison = {
      ...legacyEnvRow('DATABASE_URL_POOLED'),
      resourceType: 'PrismaComposer.EnvironmentVariable',
    };
    const migratedPoison = migrateLegacyResourceState(composerPoison) as MigratedRow;
    expect(migratedPoison.resourceType).toBe('Prisma.EnvironmentVariable');
    expect(migratedPoison['removalPolicy']).toBe('retain');
  });
});

describe('state round-trip of legacy rows through the hosted state layer', () => {
  // The REAL layer (stateLayerAgainst → stock HTTP client → on-read
  // migration) against an in-process fake of the platform state API — the
  // same wiring a deploy uses, so this proves the layer applies the
  // migration, not just that the pure function works.
  const fake = new FakeStateApi();
  const stack = 'legacy-state-stack';
  const stage = 'br_legacy';

  beforeAll(async () => {
    await fake.start();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const stackContext = Layer.succeed(Stack, {
    name: stack,
    stage,
    resources: {},
    bindings: {},
    actions: {},
  });

  const runLayer = <A>(use: (service: StateService) => Effect.Effect<A, unknown>): Promise<A> => {
    const layer = stateLayerAgainst(fake.origin, {
      projectId: 'proj-legacy',
      branchId: 'br-legacy',
    }).pipe(Layer.provide(stackContext)) as unknown as Layer.Layer<State>;
    return Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* yield* State;
        return yield* use(service).pipe(Effect.orDie);
      }).pipe(Effect.provide(layer)) as Effect.Effect<A>,
    );
  };

  test('an old-shape Database row persisted as-is is read back in the upstream shape', async () => {
    const row = (await runLayer((service) =>
      Effect.gen(function* () {
        yield* service.set({ stack, stage, fqn: 'data-db', value: legacyDatabaseRow() });
        return yield* service.get({ stack, stage, fqn: 'data-db' });
      }),
    )) as MigratedRow;
    expect(row.resourceType).toBe('Prisma.Database');
    expect(row.attr).toMatchObject({ databaseId: 'db-1', databaseName: 'data' });
    expect(row.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
  });

  test('an old-shape Connection row round-trips with the Redacted secret intact', async () => {
    const row = (await runLayer((service) =>
      Effect.gen(function* () {
        yield* service.set({ stack, stage, fqn: 'data-conn', value: legacyConnectionRow() });
        return yield* service.get({ stack, stage, fqn: 'data-conn' });
      }),
    )) as MigratedRow;
    expect(row.resourceType).toBe('Prisma.Connection');
    expect(row.attr).toMatchObject({ connectionId: 'conn-1', databaseId: 'db-1' });
    const direct = row.attr['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
    // The databaseUrl mirror keeps the value usable where the conventional
    // application URL is read.
    expect(Redacted.value(row.attr['databaseUrl'] as Redacted.Redacted<string>)).toBe(DIRECT_URL);
  });
});
