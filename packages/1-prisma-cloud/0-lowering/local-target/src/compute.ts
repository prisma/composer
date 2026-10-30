/**
 * Local compute-cluster providers: upstream alchemy's `Prisma.App` and
 * `Prisma.Deployment` become clients of the machine-scoped Compute emulator;
 * `Prisma.EnvironmentVariable` becomes a row in the dev env store;
 * `Prisma.Project` is an identity stand-in. Attributes match upstream's
 * shapes; fields the emulator cannot answer are left absent, and both
 * `appEndpointDomain`s carry the emulator's local URL. Nothing here reads
 * `process.cwd()`; the environment is read only for the variables a service's
 * rows point at.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigPools, LocalTargetProvidersInput } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
import { App, Deployment, EnvironmentVariable, Project } from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import { appScopeOf } from './app-name.ts';
import { extractComputeArtifact } from './artifact-extract.ts';
import { envStore } from './dev-store.ts';
import {
  deleteNodeInstance,
  ensureServiceInstance,
  liveServiceInstance,
  withServiceAddresses,
} from './emulator-instances.ts';
import { DEV_TIMESTAMP, projectIdOfInput } from './upstream-attributes.ts';

/** Reads an app id from upstream's `app` input: a plain string or a resolved `Prisma.App` attributes record. */
function appIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['appId'] === 'string') return value['appId'];
  throw new Error(`local Deployment received an app reference it cannot read: ${String(value)}`);
}

/**
 * The artifact's own sha256, streamed from its bytes — the digest that names
 * the unpacked artifact directory and identifies the deployment. Memoized on
 * (path, size, mtime): every converge re-runs providers and artifacts run to
 * hundreds of megabytes.
 */
const artifactHashes = new Map<string, string>();

async function artifactSha256(artifactPath: string): Promise<string> {
  const stat = await fs.promises.stat(artifactPath);
  const identity = `${artifactPath}:${String(stat.size)}:${String(stat.mtimeMs)}`;
  const memoized = artifactHashes.get(identity);
  if (memoized !== undefined) return memoized;
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(artifactPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
    }
  } finally {
    await handle.close();
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
  return ['COMPOSER', ...addressKeySegments(address), 'PORT'].join('_').toUpperCase();
}

/** The `COMPOSER_<ADDRESS SEGMENTS>_` prefix every env row this address OWNS carries — `configKey`'s convention (see `servicePortEnvKey`'s doc comment). */
function ownEnvKeyPrefix(address: string): string {
  return `${['COMPOSER', ...addressKeySegments(address)].join('_').toUpperCase()}_`;
}

/** The serializer's `addressKeySegments`, duplicated for the same reason as `servicePortEnvKey`: `-` in the app name becomes `_`. */
function addressKeySegments(address: string): string[] {
  return address
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => s.replaceAll('-', '_'));
}

const COMPOSER_NAMESPACE_PREFIX = 'COMPOSER_';

/**
 * Scopes `env.json` to what THIS service may see: rows it owns
 * (`COMPOSER_<its address>_*`) plus every unprefixed (platform-owned,
 * app-wide) row. Materializing the app-wide set locally causes spurious
 * restarts — an early service's snapshot "completes" on the second converge
 * and diffs as changed — and the dropped sibling rows have no sanctioned
 * reader.
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

// The pointer formats of `@prisma/composer-prisma-cloud`'s serializer.ts,
// duplicated for the same layer-order reason as `servicePortEnvKey`.
const PARAM_POINTER_PREFIX = '@composer-param-pointer:';
const SECRET_MARKER = '$secret';
const INPUT_KEY_NAME = 'INPUT';

function collectSecretPointers(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const member of value) collectSecretPointers(member, out);
    return;
  }
  if (!Predicate.isObject(value)) return;
  const pointer = value[SECRET_MARKER];
  if (Object.keys(value).length === 1 && typeof pointer === 'string') {
    out.add(pointer);
    return;
  }
  for (const member of Object.values(value)) collectSecretPointers(member, out);
}

/** The variables this service's own rows point at: its param pointer rows, and its input document's `$secret` pointers. */
export function pointedVariables(
  rows: Readonly<Record<string, string>>,
  address: string,
): { readonly params: ReadonlySet<string>; readonly secrets: ReadonlySet<string> } {
  const ownPrefix = ownEnvKeyPrefix(address);
  const params = new Set<string>();
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(rows)) {
    if (!key.startsWith(ownPrefix)) continue;
    if (value.startsWith(PARAM_POINTER_PREFIX)) {
      params.add(value.slice(PARAM_POINTER_PREFIX.length));
    } else if (key === `${ownPrefix}${INPUT_KEY_NAME}`) {
      collectSecretPointers(JSON.parse(value), secrets);
    }
  }
  return { params, secrets };
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
  readonly listens?: boolean;
}

function isComputeManifest(value: unknown): value is ComputeManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifestVersion' in value &&
    typeof value.manifestVersion === 'string' &&
    'entrypoint' in value &&
    typeof value.entrypoint === 'string' &&
    (!('address' in value) || typeof value.address === 'string') &&
    (!('listens' in value) || typeof value.listens === 'boolean')
  );
}

/**
 * Reads the address the artifact was packaged for, and whether the service
 * listens on its port, out of its own `compute.manifest.json` — intrinsic
 * artifact metadata (the SAME manifest `bootstrap.js` was baked from), never
 * dev config threaded through the platform's `Deployment` primitive
 * (local-dev spec § 4, REVERTED — operator review of #162).
 */
export function readComputeManifest(artifactDir: string): {
  readonly address: string;
  readonly listens: boolean;
} {
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
  return { address: parsed.address, listens: parsed.listens !== false };
}

/**
 * The environment a service's deployment runs with: its own rows from
 * `env.json` (`scopedEnvRows`), `COMPOSER_<ADDRESS>_PORT`, the current values
 * of the variables its rows point at, and `PATH` and `HOME` from the shell.
 * The `Deployment` provider puts it with an artifact; a dev server is given it
 * too (ADR-0056).
 */
export async function materializeEnv(
  devDir: string,
  address: string,
  port: number,
  pools: ConfigPools,
): Promise<Record<string, string>> {
  const rows = await envStore(devDir).read();
  const env: Record<string, string> = scopedEnvRows(rows, address);
  env[servicePortEnvKey(address)] = JSON.stringify(port);
  const pointed = pointedVariables(rows, address);
  const setIfText = (name: string, value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  };
  for (const name of pointed.secrets) setIfText(name, pools.secrets[name]);
  for (const name of pointed.params) {
    if (!pointed.secrets.has(name)) setIfText(name, pools.config[name]);
  }
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  return env;
}

function artifactDirOf(devDir: string, artifactHash: string): string {
  return path.join(devDir, 'artifacts', artifactHash);
}

function localUrl(port: number): string {
  return `http://localhost:${String(port)}`;
}

/**
 * `Prisma.App` → the Compute emulator: finds or creates the instance that
 * runs the service, which holds the service's port. The app id here IS the
 * service's own address. An App whose instance was re-created on another
 * port is updated, so its dependents get the new URL. Deleting an App (its
 * service was removed) deletes its instance.
 */
export function LocalAppProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<App>> {
  const service: Provider.ProviderService<App> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          // The resource ID is the node's address, the record's key (ADR-0057).
          const name = id;
          const { instance } = await ensureServiceInstance(appScopeOf(input), name);
          const url = localUrl(instance.port);
          return {
            appId: name,
            name,
            projectId: projectIdOfInput(news.project),
            regionId: news.regionId ?? 'us-east-1',
            branchId: news.branchId ?? null,
            latestDeploymentId: null,
            appEndpointDomain: url,
            createdAt: DEV_TIMESTAMP,
            logicalId: null,
          } satisfies App['Attributes'];
        },
        catch: (cause) => cause,
      }),
    diff: ({ output }) =>
      Effect.tryPromise({
        try: async () => {
          if (output === undefined) return undefined;
          const live = await liveServiceInstance(appScopeOf(input), output.name);
          if (live?.url === output.appEndpointDomain) return undefined;
          return { action: 'update' as const };
        },
        catch: (cause) => cause,
      }),
    delete: ({ output }) =>
      Effect.tryPromise({
        try: () => deleteNodeInstance(appScopeOf(input), output.name),
        catch: (cause) => cause,
      }),
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
 * `Prisma.Deployment` → unpacks the artifact once per hash, finds the
 * service's emulator instance and its port, materializes the child's full env (env store +
 * the current values of the variables its rows point at + the port override +
 * `PATH`/`HOME`), and puts the deployment — the
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
          const appId = appIdOfInput(news.app);
          if (news.artifactPath === undefined) {
            throw new Error('local Deployment requires an artifactPath — nothing to run.');
          }
          const artifactHash = await artifactSha256(news.artifactPath);

          const artifactDir = artifactDirOf(input.devDir, artifactHash);
          if (!fs.existsSync(artifactDir)) {
            extractComputeArtifact(news.artifactPath, artifactDir);
          }
          const { address, listens } = readComputeManifest(artifactDir);

          const { instance } = await ensureServiceInstance(appScopeOf(input), appId);
          const env = await materializeEnv(input.devDir, address, instance.port, input.pools);
          try {
            await computeClient().putDeployment(instance.id, {
              artifactDir,
              artifactHash,
              env,
              listens,
            });
          } catch (error) {
            throw withServiceAddresses(error, [{ address, instance }]);
          }

          const url = localUrl(instance.port);
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
    // An instance that no longer runs this deployment — re-created after the
    // emulator lost it, or never deployed — needs the deployment again, even
    // when nothing in the app changed, and so does an artifact no longer
    // unpacked in the environment's folder.
    diff: ({ output }) =>
      Effect.tryPromise({
        try: async () => {
          if (output === undefined) return undefined;
          const live = await liveServiceInstance(appScopeOf(input), output.appId);
          const { artifactHash } = output;
          if (live?.artifactHash !== artifactHash) return { action: 'update' as const };
          const unpacked =
            artifactHash === undefined || fs.existsSync(artifactDirOf(input.devDir, artifactHash));
          return unpacked ? undefined : { action: 'update' as const };
        },
        catch: (cause) => cause,
      }),
    // Content-addressed, cheap to leave unpacked; `--fresh` removes the whole
    // dev dir, and deleting the App deletes the emulator's instance.
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
