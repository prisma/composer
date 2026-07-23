/**
 * Local compute-cluster providers (local-dev spec § 4): `ComputeService` and
 * `Deployment` become clients of the machine-scoped Compute emulator;
 * `EnvironmentVariable` becomes a row in the dev env store; `Project` is a
 * total-but-unused identity stand-in (no lowering yields one today). Every
 * factory takes `DevProvidersInput` — the app name is
 * `input.container`'s `input.appName` (see `app-name.ts`), `devDir` is
 * `input.devDir`; nothing here reads `process.cwd()` or the environment.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DevProvidersInput } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import { extractComputeArtifact } from '../compute/artifact-extract.ts';
import { ComputeService } from '../compute/ComputeService.ts';
import { Deployment, type DeploymentAttributes } from '../compute/Deployment.ts';
import { EnvironmentVariable } from '../compute/EnvironmentVariable.ts';
import { Project } from '../postgres/Project.ts';
import { appNameOf } from './app-name.ts';
import { envStore, secretsStore } from './dev-store.ts';

/**
 * The env-var key the app's own boot-side `deserialize()` reads for its
 * `port` service param — `COMPOSER_<ADDRESS SEGMENTS>_PORT`. Mirrors
 * `@prisma/composer-prisma-cloud`'s serializer.ts `configKey(address, {
 * owner: 'service', name: 'port' })` byte-for-byte; duplicated rather than
 * imported because `@internal/lowering` sits below the extensions layer and
 * cannot import a target's serializer (ADR-0028's layer order) — the two
 * encode one shared wire protocol (ADR-0029) and must never diverge.
 */
function servicePortEnvKey(address: string): string {
  const segments = address.split('.').filter((s) => s.length > 0);
  return ['COMPOSER', ...segments, 'PORT'].join('_').toUpperCase();
}

function missingServiceAddressError(computeServiceId: string): Error {
  return new Error(
    `Deployment for "${computeServiceId}" carries no serviceAddress — the lowering predates ` +
      'local dev support.',
  );
}

async function materializeEnv(
  devDir: string,
  address: string,
  port: number,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(await envStore(devDir).read()) };
  env[servicePortEnvKey(address)] = JSON.stringify(port);
  const secrets = await secretsStore(devDir).read();
  for (const [key, value] of Object.entries(secrets)) env[key] = value;
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  return env;
}

/**
 * `ComputeService` → the Compute emulator: reserves (or returns) the
 * service's stable port. `delete` is a no-op — instance removal belongs to
 * `teardown` (`DELETE /apps/<app>`), not per-resource Alchemy deletes.
 */
export function LocalComputeServiceProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<ComputeService>> {
  const service: Provider.ProviderService<ComputeService> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const { url } = await computeClient().ensureService(app, news.name);
          return { id: news.name, name: news.name, endpointDomain: url };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(ComputeService, Effect.succeed(service));
}

/** `EnvironmentVariable` → a key/value row in `<devDir>/env.json`. Parity with deploy: the poison `DATABASE_URL` rows land here like any other. */
export function LocalEnvironmentVariableProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<EnvironmentVariable>> {
  const service: Provider.ProviderService<EnvironmentVariable> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          await envStore(input.devDir).update((current) => ({
            ...current,
            [news.key]: news.value,
          }));
          return { id: news.key, key: news.key };
        },
        catch: (cause) => cause,
      }),
    delete: ({ output }) =>
      Effect.tryPromise({
        try: async () => {
          await envStore(input.devDir).update((current) => {
            const next = { ...current };
            delete next[output.key];
            return next;
          });
        },
        catch: (cause) => cause,
      }),
  };
  return Provider.effect(EnvironmentVariable, Effect.succeed(service));
}

/**
 * `Deployment` → unpacks the artifact once per hash, fetches the emulator's
 * assigned port, materializes the child's full env (env store + secrets +
 * the port override + `PATH`/`HOME`), and puts the deployment — the emulator
 * (re)starts the child only when the hash or env actually changed.
 */
export function LocalDeploymentProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Deployment>> {
  const service: Provider.ProviderService<Deployment> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async (): Promise<DeploymentAttributes> => {
          const app = appNameOf(input.container);
          const id = news.computeServiceId;
          if (news.serviceAddress === undefined) throw missingServiceAddressError(id);
          const address = news.serviceAddress;

          const artifactDir = path.join(input.devDir, 'artifacts', news.artifactHash);
          if (!fs.existsSync(artifactDir)) {
            extractComputeArtifact(news.artifactPath, artifactDir);
          }

          const { port } = await computeClient().ensureService(app, id);
          const env = await materializeEnv(input.devDir, address, port);
          await computeClient().putDeployment(app, id, {
            address,
            artifactDir,
            artifactHash: news.artifactHash,
            env,
            port,
          });

          return { deploymentId: news.artifactHash, deployedUrl: `http://localhost:${port}` };
        },
        catch: (cause) => cause,
      }),
    // Content-addressed, cheap to leave unpacked; `--fresh` removes the whole
    // dev dir and `teardown` removes the emulator's instance.
    delete: () => Effect.void,
  };
  return Provider.effect(Deployment, Effect.succeed(service));
}

/**
 * `Project` — identity only; present so the provider collection stays total.
 * No lowering yields a `Project` resource today (mirrors the hosted
 * `Project` provider, which is also never exercised — see postgres.ts).
 */
export function LocalProjectProvider(
  _input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Project>> {
  const service: Provider.ProviderService<Project> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) => Effect.succeed({ id: 'local', name: news.name }),
    delete: () => Effect.void,
  };
  return Provider.effect(Project, Effect.succeed(service));
}
