/**
 * The environment→deployment ordering edge, against the REAL Output machinery
 * and upstream's REAL `Prisma.Deployment` provider (an eager-collapse stub
 * cannot represent the unresolved half of planning). Two properties on the
 * deploy that adds a variable and changes code in one run: every variable
 * write and the app are upstream of the deployment, and the artifact
 * comparison still runs while the new variable is unresolved (see
 * deployment-edge.ts for why only the `app` prop keeps that true).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import type * as Provider from 'alchemy/Provider';
import { Stack } from 'alchemy/Stack';
import { PlatformServices } from 'alchemy/Util/PlatformServices';
import { sha256, sha256Object } from 'alchemy/Util/sha256';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import {
  deployEnvFingerprint,
  type EnvFingerprintEntry,
  fingerprintedArtifactPath,
} from '../deploy-fingerprint.ts';
import { appAfterEnvironment } from '../deployment-edge.ts';

/** A stack the resource constructors register into; nothing ever applies it. */
const stack = { name: 'shop', stage: 'prod', resources: {}, bindings: {}, actions: {} };

const registered = <A>(effect: Effect.Effect<A, never, unknown>): A =>
  Effect.runSync(
    effect.pipe(Effect.provideService(Stack, stack as never)) as Effect.Effect<A, never, never>,
  );

const app = registered(
  Prisma.App('auth-svc', { project: 'proj-1', displayName: 'auth', regionId: 'us-east-1' }),
);

/** Two variables: one this deploy already had, one it is adding. */
const persistedVariable = registered(
  Prisma.EnvironmentVariable('COMPOSER_AUTH_PORT-var', {
    project: 'proj-1',
    class: 'production',
    key: 'COMPOSER_AUTH_PORT',
    value: Redacted.make('3000'),
  }),
);

const newVariable = registered(
  Prisma.EnvironmentVariable('COMPOSER_AUTH_DB_URL-var', {
    project: 'proj-1',
    class: 'production',
    key: 'COMPOSER_AUTH_DB_URL',
    value: Redacted.make('postgres://db'),
  }),
);

const environment = [persistedVariable, newVariable];

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-edge-'));
const artifactPath = path.join(artifactDir, 'auth.tar.gz');
fs.writeFileSync(artifactPath, 'artifact-generation-2');

afterAll(() => {
  fs.rmSync(artifactDir, { recursive: true, force: true });
});

/** The deploy hook's props, built by the same helper the descriptor uses. */
const deploymentProps = (propArtifactPath: string = artifactPath) => ({
  app: appAfterEnvironment(app.appId, environment),
  artifactPath: propArtifactPath,
  artifactContentType: 'application/gzip',
  portMapping: { http: 8080 },
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

const persistedOutput = (artifactHash: string) => ({
  deploymentId: 'dep-1',
  appId: 'app-1',
  foundryVersionId: 'fv-1',
  status: 'running',
  previewDomain: null,
  artifactHash,
  appEndpointDomain: 'auth.prisma.app',
  createdAt: '2025-01-01T00:00:00.000Z',
});

/**
 * `news` as the planner hands it over on the deploy that adds a variable: the
 * combined `app` expression cannot resolve (the new variable has no state to
 * resolve to), every other prop is a value. `olds` are the previous deploy's
 * persisted props, where `app` had resolved to the app id.
 */
const diffAgainst = async (
  output: Record<string, unknown>,
  paths: { oldPath?: string; newPath?: string } = {},
) => {
  const service = await deploymentService();
  if (service.diff === undefined) throw new Error('provider must expose diff');
  return Effect.runPromise(
    service
      .diff({
        id: 'auth-deploy',
        fqn: 'auth-deploy',
        instanceId: 'inst-deploy',
        olds: { ...deploymentProps(paths.oldPath), app: 'app-1' },
        news: deploymentProps(paths.newPath),
        output,
        session: undefined,
        bindings: [],
      } as never)
      .pipe(Effect.provide(PlatformServices)) as Effect.Effect<unknown, never, never>,
  );
};

describe('appAfterEnvironment — the edge Alchemy actually plans on', () => {
  test('every variable AND the app are upstream of the deployment', () => {
    const upstream = Output.upstreamAny(deploymentProps());
    expect(Object.keys(upstream).sort()).toEqual(
      ['COMPOSER_AUTH_DB_URL-var', 'COMPOSER_AUTH_PORT-var', 'auth-svc'].sort(),
    );
  });

  test('a service with no variables passes the app id straight through', () => {
    expect(Object.keys(Output.upstreamAny({ app: appAfterEnvironment(app.appId, []) }))).toEqual([
      'auth-svc',
    ]);
  });

  test('the artifact props are plain values, never expressions', () => {
    const props = deploymentProps();
    expect(Output.isOutput(props.artifactPath)).toBe(false);
    expect(Output.isOutput(props.artifactContentType)).toBe(false);
    expect(Output.isOutput(props.portMapping)).toBe(false);
    // The unresolved half is confined to `app`, which is the point.
    expect(Output.isOutput(props.app)).toBe(true);
  });
});

describe('upstream Deployment.diff while the new variable is still unresolved', () => {
  test('a changed artifact plans a REPLACE — the code change is not dropped', async () => {
    const diff = await diffAgainst(persistedOutput('the-previous-generations-fingerprint'));
    expect(diff).toEqual({ action: 'replace' });
  });

  test('an identical artifactPath plans no replacement', async () => {
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()));
    // An update, not a replace: with the SAME path and bytes, upstream reuses
    // the deployment and only re-asserts start/promote. The platform never
    // re-reads environment rows into a reused deployment, so a real deploy may
    // only reach this plan when its environment is unchanged too — which is
    // what folding the environment into the path enforces.
    expect(diff).toEqual({ action: 'update' });
  });
});

/**
 * What each environment produces as a path, and what upstream plans for it.
 * The environment-value-only change is the case that has no other signal at
 * all: no Deployment prop moves, and the platform never returns a value — so
 * the fingerprint is the ONLY thing that can tell upstream to ship a fresh
 * deployment, which the platform requires because it materializes env rows
 * only at deployment create (PRO-211).
 */
const envRows = (port: string): readonly EnvFingerprintEntry[] => [
  { key: 'COMPOSER_AUTH_PORT', value: port },
  {
    key: 'COMPOSER_AUTH_INPUT',
    value: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
    pointers: ['STRIPE_KEY'],
  },
];

const rotatedAt = (updatedAt: string) => () => updatedAt;

const pathForEnvironment = (
  entries: readonly EnvFingerprintEntry[],
  updatedAt = '2026-01-02T00:00:00.000Z',
): string =>
  fingerprintedArtifactPath(artifactPath, deployEnvFingerprint(entries, rotatedAt(updatedAt)));

describe('the environment fingerprint, against upstream diff', () => {
  test('nothing changed — upstream reuses the deployment rather than replacing it', async () => {
    const unchanged = pathForEnvironment(envRows('3000'));
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()), {
      oldPath: unchanged,
      newPath: unchanged,
    });
    // An update, not a replace: same path, same bytes, so upstream keeps the
    // running deployment and only re-asserts start/promote. This is the reuse
    // the per-deploy-generation path gave up and the fingerprint restores.
    expect(diff).toEqual({ action: 'update' });
  });

  test('a changed environment VALUE plans a replace, though the bytes are identical', async () => {
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()), {
      oldPath: pathForEnvironment(envRows('3000')),
      newPath: pathForEnvironment(envRows('8080')),
    });
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a rotated POINTED platform variable plans a replace, though every row is identical', async () => {
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()), {
      oldPath: pathForEnvironment(envRows('3000'), '2026-01-02T00:00:00.000Z'),
      newPath: pathForEnvironment(envRows('3000'), '2026-06-30T09:15:00.000Z'),
    });
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a changed artifact plans a replace under an unchanged environment', async () => {
    const unchanged = pathForEnvironment(envRows('3000'));
    const diff = await diffAgainst(persistedOutput('the-previous-artifacts-fingerprint'), {
      oldPath: unchanged,
      newPath: unchanged,
    });
    expect(diff).toEqual({ action: 'replace' });
  });

  test('the fingerprinted path stays a plain value — the diff never degrades to update', () => {
    // The replacement block {portMapping, skipCodeUpload, artifactPath,
    // artifactContentType} must be RESOLVED at plan time or upstream returns
    // no opinion and the engine falls back to a plain update — the silent
    // artifact skip all over again. The fingerprinted path is a string
    // computed before lowering, never an Output.
    expect(Output.isOutput(pathForEnvironment(envRows('3000')))).toBe(false);
  });
});
