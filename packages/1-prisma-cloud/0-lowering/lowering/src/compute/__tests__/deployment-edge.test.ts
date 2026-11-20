/**
 * The deployment's ordering edge and its replacement rules, against the REAL
 * Output machinery and upstream's REAL `Prisma.Deployment` diff (an
 * eager-collapse stub cannot represent the unresolved half of planning).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Prisma from '@alchemy.run/prisma';
import * as Output from 'alchemy/Output';
import type * as Provider from 'alchemy/Provider';
import { Stack } from 'alchemy/Stack';
import { PlatformServices } from 'alchemy/Util/PlatformServices';
import { sha256, sha256Object } from 'alchemy/Util/sha256';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { appAfter } from '../deployment-edge.ts';

/** A stack the resource constructors register into; nothing ever applies it. */
const stack = { name: 'shop', stage: 'prod', resources: {}, bindings: {}, actions: {} };

const registered = <A>(effect: Effect.Effect<A, never, unknown>): A =>
  Effect.runSync(
    effect.pipe(Effect.provideService(Stack, stack as never)) as Effect.Effect<A, never, never>,
  );

const app = registered(
  Prisma.App('auth-svc', { project: 'proj-1', displayName: 'auth', regionId: 'us-east-1' }),
);

/** A resource the same deploy may be changing, so its attributes are unresolved while planning. */
const generated = registered(
  Prisma.App('generated-svc', { project: 'proj-1', displayName: 'gen', regionId: 'us-east-1' }),
);

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-edge-'));
const artifactPath = path.join(artifactDir, 'auth.tar.gz');
fs.writeFileSync(artifactPath, 'artifact-generation-2');

afterAll(() => {
  fs.rmSync(artifactDir, { recursive: true, force: true });
});

/** The deploy hook's props, built by the same helper the descriptor uses. */
const deploymentProps = (
  triggers?: Record<string, unknown>,
  variables?: Record<string, unknown>,
) => ({
  app: appAfter(app.appId, []),
  artifactPath,
  artifactContentType: 'application/gzip',
  portMapping: { http: 8080 },
  ...(triggers !== undefined ? { triggers } : {}),
  ...(variables !== undefined ? { variables } : {}),
  start: true,
  promote: true,
});

/** Upstream's own fingerprint for the bytes on disk — its formula, its hashes. */
const artifactFingerprint = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const digest = yield* sha256(fs.readFileSync(artifactPath));
      return yield* sha256Object({ artifact: digest, contentType: 'application/gzip' });
    }),
  );

const apiDeployment = {
  id: 'dep-1',
  type: 'deployment',
  url: 'https://api.prisma.io/v1/deployments/dep-1',
  foundryVersionId: 'fv-1',
  status: 'running',
  previewDomain: 'dep-1.preview.prisma.app',
  createdAt: '2025-01-01T00:00:00.000Z',
};

/** Only the endpoints a diff may touch; a create would be a test failure. */
const stubClient = {
  getDeployment: (id: string) =>
    id === 'dep-1' ? Effect.succeed(apiDeployment) : Effect.die(`unexpected getDeployment ${id}`),
  listAppDeployments: () => Effect.succeed([apiDeployment]),
  createAppDeployment: () => Effect.die('a diff must not create a deployment'),
} as unknown as Prisma.PrismaManagementClient;

// Same `any` leak through Provider.effect's typing the state tests document:
// the stubbed PrismaClient is the only real requirement and it IS provided.
const deploymentService = () =>
  Effect.runPromise(
    Prisma.Deployment.Provider.pipe(
      Effect.provide(
        Prisma.DeploymentProvider().pipe(
          Layer.provide(Layer.succeed(Prisma.PrismaClient, stubClient)),
        ),
      ),
    ) as Effect.Effect<Provider.ProviderService<Prisma.Deployment>, never, never>,
  );

const persistedOutput = (
  artifactHash: string,
  triggersHash?: Redacted.Redacted<string> | string,
  variablesHash?: Redacted.Redacted<string> | string,
) => ({
  deploymentId: 'dep-1',
  appId: 'app-1',
  foundryVersionId: 'fv-1',
  status: 'running',
  previewDomain: null,
  artifactHash,
  ...(triggersHash !== undefined ? { triggersHash } : {}),
  ...(variablesHash !== undefined ? { variablesHash } : {}),
  appEndpointDomain: 'auth.prisma.app',
  createdAt: '2025-01-01T00:00:00.000Z',
});

/** `olds` are the previous deploy's persisted props, where `app` had resolved to the app id. */
const diffAgainst = async (
  output: Record<string, unknown>,
  triggers: { old?: Record<string, unknown>; new?: Record<string, unknown> } = {},
  variables: { old?: Record<string, unknown>; new?: Record<string, unknown> } = {},
) => {
  const service = await deploymentService();
  if (service.diff === undefined) throw new Error('provider must expose diff');
  return Effect.runPromise(
    service
      .diff({
        id: 'auth-deploy',
        fqn: 'auth-deploy',
        instanceId: 'inst-deploy',
        olds: { ...deploymentProps(triggers.old, variables.old), app: 'app-1' },
        news: deploymentProps(triggers.new, variables.new),
        output,
        session: undefined,
        bindings: [],
      } as never)
      .pipe(Effect.provide(PlatformServices)) as Effect.Effect<unknown, never, never>,
  );
};

describe('appAfter — the edge Alchemy actually plans on', () => {
  test('a service with no producers passes the app id straight through', () => {
    expect(Object.keys(Output.upstreamAny({ app: appAfter(app.appId, []) }))).toEqual(['auth-svc']);
  });

  test("a producer's outputs are upstream of the deployment, and it still resolves to the app id", () => {
    const producer = registered(
      Prisma.App('producer-svc', {
        project: 'proj-1',
        displayName: 'producer',
        regionId: 'us-east-1',
      }),
    );
    const edge = appAfter(app.appId, [producer.appId]);

    expect(Object.keys(Output.upstreamAny({ app: edge })).sort()).toEqual(
      ['auth-svc', 'producer-svc'].sort(),
    );
    const resolved = Effect.runSync(
      Output.evaluate(edge, {
        'auth-svc': { appId: 'app-123' },
        'producer-svc': { appId: 'app-456' },
      }) as Effect.Effect<string>,
    );
    expect(resolved).toBe('app-123');
  });

  test('the artifact props are plain values, never expressions', () => {
    const props = deploymentProps();
    expect(Output.isOutput(props.artifactPath)).toBe(false);
    expect(Output.isOutput(props.artifactContentType)).toBe(false);
    expect(Output.isOutput(props.portMapping)).toBe(false);
  });
});

describe('upstream Deployment.diff compares the artifact', () => {
  test('a changed artifact plans a REPLACE — the code change is not dropped', async () => {
    const diff = await diffAgainst(persistedOutput('the-previous-generations-fingerprint'));
    expect(diff).toEqual({ action: 'replace' });
  });

  test('an identical artifactPath plans no replacement', async () => {
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()));
    expect(diff).toEqual({ action: 'update' });
  });
});

/** The compute descriptor's triggers: one `<name>:updatedAt` member per platform variable the input document names. */
const platformTriggers = (updatedAt = '2026-01-02T00:00:00.000Z') => ({
  'STRIPE_KEY:updatedAt': updatedAt,
});

/** Upstream's recorded fingerprint, by its own salt and formula, so the diff compares against exactly what a prior apply persisted. */
const recordedHash = (field: 'triggers' | 'variables', value: Record<string, unknown>) =>
  Effect.runPromise(
    sha256Object({
      salt: `alchemy/Prisma.Deployment/${field}/v1`,
      [field]: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          Redacted.isRedacted(item) ? Redacted.value(item) : item,
        ]),
      ),
    }),
  );

describe('the platform variable triggers, against upstream diff', () => {
  test('nothing changed — upstream reuses the deployment', async () => {
    const unchanged = platformTriggers();
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedHash('triggers', unchanged)),
      { old: unchanged, new: unchanged },
    );
    expect(diff).toEqual({ action: 'update' });
  });

  test('a changed platform variable plans a replace, though the bytes are identical', async () => {
    const diff = await diffAgainst(
      persistedOutput(
        await artifactFingerprint(),
        await recordedHash('triggers', platformTriggers()),
      ),
      { old: platformTriggers(), new: platformTriggers('2026-06-30T09:15:00.000Z') },
    );
    expect(diff).toEqual({ action: 'replace' });
  });
});

const serviceVariables = (port: string) => ({
  COMPOSER_SHOP_AUTH_PORT: Redacted.make(port),
  COMPOSER_SHOP_AUTH_STREAMS_API_KEY: null,
});

describe('the service variables, against upstream diff', () => {
  test('unchanged variables reuse the deployment', async () => {
    const diff = await diffAgainst(
      persistedOutput(
        await artifactFingerprint(),
        undefined,
        await recordedHash('variables', serviceVariables('3000')),
      ),
      {},
      { old: serviceVariables('3000'), new: serviceVariables('3000') },
    );
    expect(diff).toEqual({ action: 'update' });
  });

  test('a changed value plans a replace, though the bytes are identical', async () => {
    const diff = await diffAgainst(
      persistedOutput(
        await artifactFingerprint(),
        undefined,
        await recordedHash('variables', serviceVariables('3000')),
      ),
      {},
      { old: serviceVariables('3000'), new: serviceVariables('8080') },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a key deleted with null plans a replace', async () => {
    const diff = await diffAgainst(
      persistedOutput(
        await artifactFingerprint(),
        undefined,
        await recordedHash('variables', serviceVariables('3000')),
      ),
      {},
      {
        old: serviceVariables('3000'),
        new: { ...serviceVariables('3000'), COMPOSER_SHOP_AUTH_OLD: null },
      },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('declaring variables on a deployment created without them plans a replace', async () => {
    const unchanged = platformTriggers();
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedHash('triggers', unchanged)),
      { old: unchanged, new: unchanged },
      { new: serviceVariables('3000') },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a value still unresolved at plan time plans a replace', async () => {
    const diff = await diffAgainst(
      persistedOutput(
        await artifactFingerprint(),
        undefined,
        await recordedHash('variables', serviceVariables('3000')),
      ),
      {},
      {
        old: serviceVariables('3000'),
        new: {
          ...serviceVariables('3000'),
          COMPOSER_SHOP_AUTH_ORIGIN: Output.map(generated.appEndpointDomain, (domain) =>
            Redacted.make(String(domain)),
          ),
        },
      },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a changed artifact still plans a replace while a variable is unresolved', async () => {
    const diff = await diffAgainst(
      persistedOutput('the-previous-artifacts-fingerprint'),
      {},
      { new: { COMPOSER_SHOP_AUTH_ORIGIN: Output.map(generated.appId, Redacted.make) } },
    );
    expect(diff).toEqual({ action: 'replace' });
  });
});
