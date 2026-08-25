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
const deploymentProps = (triggers?: Record<string, unknown>) => ({
  app: appAfterEnvironment(app.appId, environment),
  artifactPath,
  artifactContentType: 'application/gzip',
  portMapping: { http: 8080 },
  ...(triggers !== undefined ? { triggers } : {}),
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
) => ({
  deploymentId: 'dep-1',
  appId: 'app-1',
  foundryVersionId: 'fv-1',
  status: 'running',
  previewDomain: null,
  artifactHash,
  ...(triggersHash !== undefined ? { triggersHash } : {}),
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
  triggers: { old?: Record<string, unknown>; new?: Record<string, unknown> } = {},
) => {
  const service = await deploymentService();
  if (service.diff === undefined) throw new Error('provider must expose diff');
  return Effect.runPromise(
    service
      .diff({
        id: 'auth-deploy',
        fqn: 'auth-deploy',
        instanceId: 'inst-deploy',
        olds: { ...deploymentProps(triggers.old), app: 'app-1' },
        news: deploymentProps(triggers.new),
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

  test('the combined expression still resolves to the app id — not a variable id or tuple', () => {
    const resolved = Effect.runSync(
      Output.evaluate(appAfterEnvironment(app.appId, environment), {
        'auth-svc': { appId: 'app-123' },
        'COMPOSER_AUTH_PORT-var': { environmentVariableId: 'var-1' },
        'COMPOSER_AUTH_DB_URL-var': { environmentVariableId: 'var-2' },
      }) as Effect.Effect<string>,
    );
    expect(resolved).toBe('app-123');
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
    // The unresolved half is confined to `app` and (possibly) `triggers`
    // members, which is the point: upstream's replacement block stays resolved.
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
 * What each environment declares as `triggers`, and what upstream plans for
 * it. The environment-value-only change is the case that has no other signal
 * at all: no other Deployment prop moves, and the platform never returns a
 * value — so the triggers fingerprint is the ONLY thing that can tell
 * upstream to ship a fresh deployment, which the platform requires because it
 * materializes env rows only at deployment create (PRO-211). These members
 * mirror the compute descriptor's: one Redacted member per env row, plus a
 * `<name>:updatedAt` member per pointed platform variable.
 */
const envTriggers = (port: string, updatedAt = '2026-01-02T00:00:00.000Z') => ({
  COMPOSER_AUTH_PORT: Redacted.make(port),
  COMPOSER_AUTH_INPUT: Redacted.make('{"apiKey":{"$secret":"STRIPE_KEY"}}'),
  'STRIPE_KEY:updatedAt': updatedAt,
});

/** Upstream's recorded fingerprint for these triggers — its salt, its formula (`triggersHashOf`), so the diff compares against exactly what a prior apply persisted. */
const recordedTriggersHash = (triggers: Record<string, unknown>) =>
  Effect.runPromise(
    sha256Object({
      salt: 'alchemy/Prisma.Deployment/triggers/v1',
      triggers: Object.fromEntries(
        Object.entries(triggers).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      ),
    }),
  );

describe('the environment triggers, against upstream diff', () => {
  test('nothing changed — upstream reuses the deployment rather than replacing it', async () => {
    const unchanged = envTriggers('3000');
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedTriggersHash(unchanged)),
      { old: unchanged, new: unchanged },
    );
    // An update, not a replace: same triggers, same bytes, so upstream keeps
    // the running deployment and only re-asserts start/promote.
    expect(diff).toEqual({ action: 'update' });
  });

  test('a changed environment VALUE plans a replace, though the bytes are identical', async () => {
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedTriggersHash(envTriggers('3000'))),
      { old: envTriggers('3000'), new: envTriggers('8080') },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a rotated POINTED platform variable plans a replace, though every row is identical', async () => {
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedTriggersHash(envTriggers('3000'))),
      {
        old: envTriggers('3000'),
        new: envTriggers('3000', '2026-06-30T09:15:00.000Z'),
      },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('a changed artifact plans a replace under unchanged triggers', async () => {
    const unchanged = envTriggers('3000');
    const diff = await diffAgainst(
      persistedOutput('the-previous-artifacts-fingerprint', await recordedTriggersHash(unchanged)),
      { old: unchanged, new: unchanged },
    );
    expect(diff).toEqual({ action: 'replace' });
  });

  test('the FIRST deploy that declares triggers records the fingerprint without replacing', async () => {
    // The persisted output predates triggers (no triggersHash recorded), so
    // there is nothing to compare against: upstream lets the engine's plain
    // update record the fingerprint instead of forcing a replacement. This is
    // what makes adopting the seam free for already-deployed services.
    const diff = await diffAgainst(persistedOutput(await artifactFingerprint()), {
      new: envTriggers('3000'),
    });
    expect(diff).toEqual({ action: 'update' });
  });

  test('a trigger member still unresolved at plan time replaces conservatively', async () => {
    // The member reads an attribute of a resource the same deploy is changing,
    // so the diff cannot prove the fingerprint unchanged — upstream replaces
    // rather than silently reusing a deployment with a possibly-stale value.
    const unresolved = {
      ...envTriggers('3000'),
      COMPOSER_AUTH_DB_URL: Output.map(newVariable.environmentVariableId, (value) => value),
    };
    const diff = await diffAgainst(
      persistedOutput(await artifactFingerprint(), await recordedTriggersHash(envTriggers('3000'))),
      { old: envTriggers('3000'), new: unresolved },
    );
    expect(diff).toEqual({ action: 'replace' });
  });
});
