/**
 * Deploy preflight (ADR-0029): before Alchemy runs, verify every secret binding
 * in the app's provision manifest (each a platform env-var NAME) exists on Prisma
 * Cloud for the target stage.
 * A name absent on the platform but present in the deploy shell is provisioned
 * via a direct Management API POST — NEVER an Alchemy resource, so the value
 * never lands in hosted deploy state. A name absent from both fails the deploy,
 * listing exactly what is missing and where to set it.
 *
 * Control-plane only (imported by control.ts → prisma-compose.config.ts); runs
 * in the CLI parent, so it builds its own Management API client from env — the
 * same credential path `ensureContainers` uses.
 */
import { provisionManifest } from '@internal/core';
import type { PreflightInput } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import {
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
} from '@internal/lowering';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { secretName } from './secret.ts';

type EnvClass = 'production' | 'preview';

/** production for the default stage; preview for a named stage — matching how the pack writes config rows. */
const classFor = (branchId: string | undefined): EnvClass =>
  branchId === undefined ? 'production' : 'preview';

/**
 * Does `key` exist for the target stage's scope? Default stage → any
 * production-class template. Named stage → a preview template (branchId null)
 * OR this branch's own override — the platform's preview materialization
 * (pdp-data-model.md). Metadata read only; env-var values are write-only.
 */
/** The fields of one env-var list page that preflight consumes (metadata only; values are write-only). */
interface EnvVarListPage {
  readonly data: readonly { readonly branchId: string | null }[];
  readonly pagination: { readonly nextCursor: string | null; readonly hasMore: boolean };
}
interface EnvVarListResult {
  readonly data?: EnvVarListPage;
  readonly error?: unknown;
}

/**
 * One page of the env-var list. The query is `blindCast` to `never` because
 * openapi-fetch types this path's query as `never` (an SDK path/operation
 * mismatch); that same workaround defeats the client's response-type inference,
 * so the result is projected to the small shape we actually read.
 */
async function listEnvVars(
  client: ManagementApiClient,
  query: { projectId: string; class: EnvClass; key: string; cursor?: string },
): Promise<EnvVarListResult> {
  const res = await client.GET('/v1/environment-variables', {
    params: {
      query: blindCast<
        never,
        'openapi-fetch types this list query as never; the endpoint accepts projectId/class/key/cursor'
      >(query),
    },
  });
  return blindCast<
    EnvVarListResult,
    'project the SDK list response to the fields preflight reads; the query-never workaround defeats response inference'
  >(res);
}

async function existsOnPlatform(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  key: string,
): Promise<boolean> {
  const cls = classFor(branchId);
  // Default stage → any production template counts; named stage → a preview
  // template (branchId null) OR this branch's own override.
  const visible = (row: { branchId: string | null }): boolean =>
    branchId === undefined || row.branchId === null || row.branchId === branchId;

  // The list is paginated: a key with more preview rows (template + many
  // per-branch overrides) than one page must be followed to the end, or a
  // present name is falsely reported missing. Short-circuit as soon as a
  // visible row is seen.
  let cursor: string | null = null;
  do {
    const res = await listEnvVars(
      client,
      cursor === null ? { projectId, class: cls, key } : { projectId, class: cls, key, cursor },
    );
    if (res.error !== undefined) throw listFailedError(key, res.error);
    const page = res.data;
    if (page === undefined) return false;
    if (page.data.some(visible)) return true;
    cursor = page.pagination.hasMore ? page.pagination.nextCursor : null;
  } while (cursor !== null);
  return false;
}

/**
 * Provision `key`=`value` directly via the Management API for the target
 * stage's scope (a production template for the default stage; a preview branch
 * override for a named stage — the same scope the pack writes config rows to,
 * EnvironmentVariable.ts). A 409 means a concurrent deploy already provisioned
 * it — tolerated. The value is never logged.
 */
async function fillMissing(
  client: ManagementApiClient,
  input: PreflightInput,
  key: string,
  value: string,
): Promise<void> {
  const res = await client.POST('/v1/environment-variables', {
    body: {
      projectId: input.projectId,
      class: classFor(input.branchId),
      key,
      value,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    },
  });
  if (res.error !== undefined && res.response.status !== 409) {
    throw fillFailedError(key, res.error);
  }
}

interface MissingSecret {
  readonly name: string;
  readonly serviceAddress: string;
}

// ——— Preflight errors (centralized; ADR-0029). Values are never logged. ———

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required for deploy preflight.');

const listFailedError = (key: string, error: unknown): Error =>
  new Error(
    `deploy preflight: Prisma Management API error listing "${key}": ${JSON.stringify(error)}.`,
  );

const fillFailedError = (key: string, error: unknown): Error =>
  new Error(
    `deploy preflight: failed to provision "${key}" from the deploy shell: ${JSON.stringify(error)}.`,
  );

function missingError(missing: readonly MissingSecret[], input: PreflightInput): Error {
  const scope =
    input.branchId === undefined
      ? 'the production class (project-level template)'
      : `the preview class of stage "${input.stage ?? input.branchId}" (branch override or template)`;
  const lines = missing.map((m) => `  - ${m.name}  (required by service "${m.serviceAddress}")`);
  return new Error(
    `Deploy preflight failed — ${missing.length} secret env var(s) are not provisioned on Prisma ` +
      `Cloud for ${scope}, and are absent from the deploy shell:\n${lines.join('\n')}\n\n` +
      'Set each in the deploy shell environment (the CLI will provision it on deploy), or create ' +
      `it on the platform (Prisma Console or the Management API) in ${scope}.`,
  );
}

async function managementClient(): Promise<ManagementApiClient> {
  if ((process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) throw tokenRequiredError();
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ManagementClient;
    }).pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv())))),
  );
}

/**
 * The Prisma Cloud extension's `preflight`. Aggregates the target-agnostic
 * manifest (core's `provisionManifest`), checks each pointer secret against the
 * platform, fills from the shell where possible, and fails loudly on anything
 * absent from both. Accepts an injected client for tests; otherwise builds one
 * from env.
 */
export async function runPreflight(
  input: PreflightInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<void> {
  const manifest = provisionManifest(input.graph);
  if (manifest.length === 0) return;

  // One check per platform NAME (many slots/services may bind the same one).
  // Every wired secret is required — the forwarding model has no optional slot.
  const names = new Map<string, MissingSecret>();
  for (const binding of manifest) {
    if (!names.has(secretName(binding))) {
      names.set(secretName(binding), {
        name: secretName(binding),
        serviceAddress: binding.serviceAddress,
      });
    }
  }

  const client = deps?.client ?? (await managementClient());
  const missing: MissingSecret[] = [];
  for (const meta of names.values()) {
    if (await existsOnPlatform(client, input.projectId, input.branchId, meta.name)) continue;
    const shellValue = process.env[meta.name];
    if (shellValue !== undefined && shellValue.length > 0) {
      await fillMissing(client, input, meta.name, shellValue);
      continue;
    }
    missing.push(meta);
  }
  if (missing.length > 0) throw missingError(missing, input);
}
