/**
 * Local compute-cluster providers (local-dev spec § 4): upstream alchemy's
 * `Prisma.App` and `Prisma.Deployment` become clients of the machine-scoped
 * Compute emulator; `Prisma.EnvironmentVariable` becomes a row in the dev env
 * store; `Prisma.Project` is a total-but-unused identity stand-in (no lowering
 * yields one today). Every factory takes `LocalTargetProvidersInput` — the app
 * name is `input.container`'s `input.appName` (see `app-name.ts`), `devDir` is
 * `input.devDir`; nothing here reads `process.cwd()` or the environment.
 *
 * The emitted attributes match upstream's shapes. Fields the emulator has no
 * answer for are left `null`/`undefined` where upstream's types allow it and
 * nothing local reads them; the two that ARE read — the App's
 * `appEndpointDomain` and the Deployment's — carry the emulator's local URL,
 * which is what the deployed shapes carry too.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
import { App, Deployment, EnvironmentVariable, Project } from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';
import { extractComputeArtifact } from './artifact-extract.ts';
import { envStore, secretsStore } from './dev-store.ts';
import { DEV_TIMESTAMP, isRecord, projectIdOfInput } from './upstream-attributes.ts';

/** Reads an app id from upstream's `app` input: a plain string or a resolved `Prisma.App` attributes record. */
function appIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['appId'] === 'string') return value['appId'];
  throw new Error(`local Deployment received an app reference it cannot read: ${String(value)}`);
}

/**
 * The artifact's own sha256, streamed from its bytes. Upstream's
 * `Prisma.Deployment` carries no artifact-hash prop (it fingerprints the file
 * inside the provider), so the emulator hashes the file it is handed — the
 * same digest `packageComputeArtifact` derived the path from, which is what
 * names the unpacked artifact directory and identifies the deployment.
 *
 * Memoized on the file's identity (path, size, mtime): a converge re-runs
 * every provider, artifacts run to hundreds of megabytes, and the watch loop
 * converges on every save.
 */
const artifactHashes = new Map<string, string>();

function artifactSha256(artifactPath: string): string {
  const stat = fs.statSync(artifactPath);
  const identity = `${artifactPath}:${String(stat.size)}:${String(stat.mtimeMs)}`;
  const memoized = artifactHashes.get(identity);
  if (memoized !== undefined) return memoized;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(artifactPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  artifactHashes.set(identity, digest);
  return digest;
}

/**
 * The env-var key the app's own boot-side `deserialize()` reads for its
 * `port` service param — `COMPOSER_<ADDRESS SEGMENTS>_PORT`. Mirrors
 * `@prisma/composer-prisma-cloud`'s serializer.ts `configKey(address, {
 * owner: 'service', name: 'port' })` byte-for-byte; duplicated rather than
 * imported because `@internal/local-target` sits below the extensions layer
 * and cannot import a target's serializer (ADR-0028's layer order) — the two
 * encode one shared wire protocol (ADR-0029) and must never diverge.
 */
function servicePortEnvKey(address: string): string {
  const segments = address.split('.').filter((s) => s.length > 0);
  return ['COMPOSER', ...segments, 'PORT'].join('_').toUpperCase();
}

/** The `COMPOSER_<ADDRESS SEGMENTS>_` prefix every env row this address OWNS carries — `configKey`'s convention (see `servicePortEnvKey`'s doc comment). */
function ownEnvKeyPrefix(address: string): string {
  const segments = address.split('.').filter((s) => s.length > 0);
  return `${['COMPOSER', ...segments].join('_').toUpperCase()}_`;
}

const COMPOSER_NAMESPACE_PREFIX = 'COMPOSER_';

/**
 * Scopes `env.json` to what THIS service is allowed to see: rows it owns
 * (`COMPOSER_<its address>_*`) plus every row OUTSIDE the `COMPOSER_`
 * namespace entirely — an unprefixed row is a platform-owned name, app-wide
 * by nature (local-dev spec § 4's pinned parity note). The hosted platform
 * materializes the app-wide row set into every
 * deployment but DIFFS a deployment only on its own referenced rows; an
 * app-wide LOCAL materialization restart-amplifies instead — an
 * early-deployed service's snapshot is incomplete on the first converge,
 * "completes" on the second, and diffs as changed. Scoping the content here
 * aligns local restart behavior with the platform's diff scope. The dropped
 * sibling rows have no sanctioned reader: `run()`/`load()` consume only
 * own-address rows, and an ambient sibling read is exactly the mistake the
 * COMPOSER_ namespace exists to make impossible.
 */
export function scopedEnvRows(
  allRows: Readonly<Record<string, string>>,
  address: string,
): Record<string, string> {
  const ownPrefix = ownEnvKeyPrefix(address);
  const scoped: Record<string, string> = {};
  for (const [key, value] of Object.entries(allRows)) {
    if (key.startsWith(ownPrefix) || !key.startsWith(COMPOSER_NAMESPACE_PREFIX)) {
      scoped[key] = value;
    }
  }
  return scoped;
}

function manifestMissingAddressError(): Error {
  return new Error(
    'artifact manifest carries no address — repackage with a current @prisma/composer.',
  );
}

interface ComputeManifest {
  readonly manifestVersion: string;
  readonly entrypoint: string;
  readonly address?: string;
}

function isComputeManifest(value: unknown): value is ComputeManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifestVersion' in value &&
    typeof value.manifestVersion === 'string' &&
    'entrypoint' in value &&
    typeof value.entrypoint === 'string'
  );
}

/**
 * Reads the address the artifact was packaged for out of its own
 * `compute.manifest.json` — intrinsic artifact metadata (the SAME manifest
 * `bootstrap.js` was baked from), never dev config threaded through the
 * platform's `Deployment` primitive (local-dev spec § 4, REVERTED —
 * operator review of #162).
 */
function readManifestAddress(artifactDir: string): string {
  const manifestPath = path.join(artifactDir, 'compute.manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw manifestMissingAddressError();
  }
  if (!isComputeManifest(parsed) || parsed.address === undefined) {
    throw manifestMissingAddressError();
  }
  return parsed.address;
}

/**
 * The Compute emulator's `<id>` path segment must match
 * `/^[a-z0-9][a-z0-9-]*$/` (its API hygiene rule, local-dev spec § 2) — but a
 * service's own address (`news.name`/`news.computeServiceId`) is
 * hierarchical and dot-separated (e.g. `"orders.service"`, a nested
 * module's service). This is the seam: every dot (or other disallowed char)
 * becomes a dash, runs collapse, and the result is what both `ensureService`
 * and `putDeployment` address the emulator with — the REAL address still
 * rides the deployment body's `address` field untouched, so the front door
 * and every listing still show it verbatim (compute-main.ts's `svc.address`
 * is set from that field, not from the id).
 */
function slugServiceId(address: string): string {
  const slug = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'svc';
}

async function materializeEnv(
  devDir: string,
  address: string,
  port: number,
): Promise<Record<string, string>> {
  const env: Record<string, string> = scopedEnvRows(await envStore(devDir).read(), address);
  env[servicePortEnvKey(address)] = JSON.stringify(port);
  const secrets = await secretsStore(devDir).read();
  for (const [key, value] of Object.entries(secrets)) env[key] = value;
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  return env;
}

/**
 * `Prisma.App` → the Compute emulator: reserves (or returns) the service's
 * stable port. The app id here IS the service's own address, which
 * `Deployment` slugs back into the emulator's id. `delete` is a no-op —
 * instance removal belongs to `teardown` (`DELETE /apps/<app>`), not
 * per-resource Alchemy deletes.
 */
export function LocalAppProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<App>> {
  const service: Provider.ProviderService<App> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          const appName = appNameOf(input.container);
          const name = news.displayName ?? id;
          const { url } = await computeClient().ensureService(appName, slugServiceId(name));
          return {
            appId: name,
            name,
            projectId: projectIdOfInput(news.project),
            regionId: news.regionId ?? 'us-east-1',
            branchId: news.branchId ?? null,
            latestDeploymentId: null,
            appEndpointDomain: url,
            createdAt: DEV_TIMESTAMP,
          } satisfies App['Attributes'];
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(App, Effect.succeed(service));
}

/** `Prisma.EnvironmentVariable` → a key/value row in `<devDir>/env.json`. Upstream's value is `Redacted`; env.json holds the plain string the child process is given. */
export function LocalEnvironmentVariableProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<EnvironmentVariable>> {
  const service: Provider.ProviderService<EnvironmentVariable> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          await envStore(input.devDir).update((current) => ({
            ...current,
            [news.key]: Redacted.value(news.value),
          }));
          return {
            environmentVariableId: news.key,
            projectId: projectIdOfInput(news.project),
            branchId: news.branchId ?? null,
            class: news.class,
            key: news.key,
            value: news.value,
            valueKid: '',
            isManagedBySystem: false,
            createdAt: DEV_TIMESTAMP,
            updatedAt: DEV_TIMESTAMP,
          } satisfies EnvironmentVariable['Attributes'];
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
 * `Prisma.Deployment` → unpacks the artifact once per hash, fetches the
 * emulator's assigned port, materializes the child's full env (env store +
 * secrets + the port override + `PATH`/`HOME`), and puts the deployment — the
 * emulator (re)starts the child only when the hash or env actually changed.
 * `portMapping` is ignored on purpose: the emulator owns port allocation, and
 * the child learns its port from `COMPOSER_<ADDRESS>_PORT` in the env this
 * provider materializes.
 */
export function LocalDeploymentProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Deployment>> {
  const service: Provider.ProviderService<Deployment> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async (): Promise<Deployment['Attributes']> => {
          const app = appNameOf(input.container);
          const appId = appIdOfInput(news.app);
          const emulatorId = slugServiceId(appId);
          if (news.artifactPath === undefined) {
            throw new Error('local Deployment requires an artifactPath — nothing to run.');
          }
          const artifactHash = artifactSha256(news.artifactPath);

          const artifactDir = path.join(input.devDir, 'artifacts', artifactHash);
          if (!fs.existsSync(artifactDir)) {
            extractComputeArtifact(news.artifactPath, artifactDir);
          }
          const address = readManifestAddress(artifactDir);

          const { port } = await computeClient().ensureService(app, emulatorId);
          const env = await materializeEnv(input.devDir, address, port);
          await computeClient().putDeployment(app, emulatorId, {
            address,
            artifactDir,
            artifactHash,
            env,
            port,
          });

          const url = `http://localhost:${port}`;
          return {
            deploymentId: artifactHash,
            appId,
            // The emulator has no Foundry: the artifact digest is the only
            // identity a local deployment has, and it is what upstream's
            // recovery-by-version lookup would be given.
            foundryVersionId: artifactHash,
            status: 'running',
            previewDomain: null,
            artifactHash,
            appEndpointDomain: url,
            createdAt: DEV_TIMESTAMP,
          } satisfies Deployment['Attributes'];
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
 * `Prisma.Project` — identity only; present so the provider collection stays
 * total. No lowering yields a `Project` resource today (mirrors the hosted
 * wiring, where the container resolves the project pre-alchemy).
 */
export function LocalProjectProvider(
  _input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Project>> {
  const service: Provider.ProviderService<Project> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.succeed({
        projectId: 'local',
        projectName: news.name ?? id,
        workspaceId: 'local',
        createdAt: DEV_TIMESTAMP,
        defaultRegion: null,
        databaseId: undefined,
        defaultConnectionId: undefined,
        directConnectionString: undefined,
        pooledConnectionString: undefined,
        accelerateConnectionString: undefined,
        host: undefined,
        user: undefined,
        password: undefined,
      } satisfies Project['Attributes']),
    delete: () => Effect.void,
  };
  return Provider.effect(Project, Effect.succeed(service));
}
