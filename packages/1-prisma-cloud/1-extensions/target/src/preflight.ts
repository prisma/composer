/**
 * Deploy preflight (ADR-0029, extended for env-sourced params): before Alchemy
 * runs, verify every secret binding AND every env-sourced param binding in the
 * app's manifests (each a platform env-var NAME) exists on Prisma Cloud for
 * the target stage. A literal-bound param never touches the platform — only
 * `envParam(...)` sources are checked here.
 * A name absent on the platform but present in the deploy shell is provisioned
 * via a direct Management API POST — NEVER an Alchemy resource, so the value
 * never lands in hosted deploy state. A name absent from both fails the deploy,
 * listing exactly what is missing and where to set it.
 *
 * Control-plane only (imported by control.ts → prisma-composer.config.ts); runs
 * in the CLI parent, so it builds its own Management API client from env — the
 * same credential path `container.ts`'s `ensure`/`locate` use.
 *
 * It also returns WHEN each of those names was last written. This is the only
 * place in a deploy that reads those rows off the platform, so it is where the
 * reading belongs; the compute deploy hook folds the timestamps into its
 * environment fingerprint so that rotating a secret or an env-sourced param
 * out of band ships a new deployment. A timestamp, never a value: env-var
 * values are write-only and the API never returns one.
 */
import type { Graph } from '@internal/core';
import type { PreflightInput } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import {
  drivePagesAsync,
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
} from '@internal/lowering';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { prismaCloudContainerOf } from './container.ts';
import { resolvePrismaNextConfig } from './pn-config.ts';
import { collectPreflightNames } from './preflight-names.ts';
import { isPnPostgresResourceNode, requiredPackHeadOf } from './prisma-next.ts';

type EnvClass = 'production' | 'preview';

/** production for the default stage; preview for a named stage — matching how the pack writes config rows. */
const classFor = (branchId: string | undefined): EnvClass =>
  branchId === undefined ? 'production' : 'preview';

/** The fields of one env-var list page that preflight consumes (metadata only; values are write-only). */
interface EnvVarListPage {
  readonly data: readonly {
    readonly branchId: string | null;
    readonly updatedAt: string;
  }[];
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

/** What the platform holds for one name: whether it is there at all, and when it last changed. */
interface PlatformVariable {
  readonly exists: boolean;
  /** The latest `updatedAt` across every row visible to this stage — undefined when the name is absent. */
  readonly updatedAt?: string;
}

/**
 * What the platform holds for `key` in the target stage's scope. Default stage
 * → any production-class template. Named stage → a preview template (branchId
 * null) OR this branch's own override — the platform's preview materialization
 * (pdp-data-model.md). Metadata read only; env-var values are write-only.
 *
 * The whole list is walked rather than short-circuiting on the first visible
 * row, because the newest `updatedAt` across every visible row is the rotation
 * signal the compute deploy hook fingerprints on: stopping early would make
 * that timestamp depend on where the page boundary happened to fall, and a
 * fingerprint that moves for that reason would redeploy for no reason. A key
 * with more rows than one page (a template plus many per-branch overrides) is
 * rare, so this costs one request in practice.
 */
async function readPlatformVariable(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  key: string,
): Promise<PlatformVariable> {
  const cls = classFor(branchId);
  const visible = (row: { branchId: string | null }): boolean =>
    branchId === undefined || row.branchId === null || row.branchId === branchId;

  // The list is paginated: a key with more preview rows (template + many
  // per-branch overrides) than one page must be followed to the end, or a
  // present name is falsely reported missing. Walked to the end (no
  // short-circuit) because the LATEST updatedAt across visible rows feeds
  // the deploy fingerprint; bounded (drivePagesAsync) so broken pagination
  // fails loudly instead of looping.
  let exists = false;
  let latest: string | undefined;
  await drivePagesAsync(
    `environment variables named "${key}"`,
    async (cursor) => {
      const res = await listEnvVars(
        client,
        cursor === undefined
          ? { projectId, class: cls, key }
          : { projectId, class: cls, key, cursor },
      );
      if (res.error !== undefined) throw listFailedError(key, res.error);
      return res.data ?? { data: [], pagination: { nextCursor: null, hasMore: false } };
    },
    (data) => {
      for (const row of data) {
        if (!visible(row)) continue;
        exists = true;
        if (latest === undefined || row.updatedAt > latest) latest = row.updatedAt;
      }
      return false;
    },
  );
  return latest === undefined ? { exists } : { exists, updatedAt: latest };
}

/**
 * Provision `key`=`value` directly via the Management API for the target
 * stage's scope (a production template for the default stage; a preview branch
 * override for a named stage — the same scope the pack's config rows are
 * written to, through alchemy's `Prisma.EnvironmentVariable`). A 409 means a
 * concurrent deploy already provisioned
 * it — tolerated. The value is never logged.
 */
async function fillMissing(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  key: string,
  value: string,
): Promise<string | undefined> {
  const res = await client.POST('/v1/environment-variables', {
    body: {
      projectId,
      class: classFor(branchId),
      key,
      value,
      ...(branchId !== undefined ? { branchId } : {}),
    },
  });
  if (res.error !== undefined && res.response.status !== 409) {
    throw fillFailedError(key, res.error);
  }
  // The created row's timestamp, so this deploy fingerprints on the same value
  // the next one will read back. A 409 (a concurrent deploy won the race)
  // returns no row: the name reads as unknown for this run and the next deploy
  // picks its timestamp up, which redeploys once — the safe direction.
  return res.data?.data.updatedAt;
}

interface MissingBinding {
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

function missingError(
  missing: readonly MissingBinding[],
  branchId: string | undefined,
  stage: string | undefined,
): Error {
  const scope =
    branchId === undefined
      ? 'the production class (project-level template)'
      : `the preview class of stage "${stage ?? branchId}" (branch override or template)`;
  const lines = missing.map((m) => `  - ${m.name}  (required by service "${m.serviceAddress}")`);
  return new Error(
    `Deploy preflight failed — ${missing.length} env var(s) (secret or env-sourced param) are not ` +
      `provisioned on Prisma Cloud for ${scope}, and are absent from the deploy shell:\n` +
      `${lines.join('\n')}\n\n` +
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
 * The Prisma Cloud extension's `preflight`. Uses the shared name collector
 * (`collectPreflightNames`, ADR-0042) — every service's input-binding
 * `envSecret` leaf, plus `paramManifest` filtered to env-sourced reserved
 * params — checks each platform name against the platform, fills from the
 * shell where possible, and fails loudly on anything absent from both.
 * `envParam` leaves of an input binding are NOT checked here — they resolve
 * from the deploy shell at serialize, and an unset one is an omitted key the
 * schema arbitrates. Accepts an injected client for tests; otherwise builds
 * one from env.
 */
export async function runPreflight(
  input: PreflightInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<ReadonlyMap<string, string>> {
  const { projectId, branchId } = prismaCloudContainerOf(input.container);

  // One check per platform NAME (many leaves/services, secret or param, may
  // bind the same one). Every bound secret leaf is required — absence is
  // expressed by omitting the key from the binding, never by an unprovisioned
  // var; a param binding is only checked when it is env-sourced. Deploy treats
  // the two lists identically (unlike dev preflight), so they're merged here,
  // secrets first.
  const collected = collectPreflightNames(input.graph);
  const names = new Map<string, MissingBinding>();
  for (const meta of [...collected.secrets, ...collected.envParams]) {
    if (!names.has(meta.name)) names.set(meta.name, meta);
  }
  if (names.size === 0) return new Map();

  const client = deps?.client ?? (await managementClient());
  const missing: MissingBinding[] = [];
  const updatedAt = new Map<string, string>();
  for (const meta of names.values()) {
    const platform = await readPlatformVariable(client, projectId, branchId, meta.name);
    if (platform.exists) {
      if (platform.updatedAt !== undefined) updatedAt.set(meta.name, platform.updatedAt);
      continue;
    }
    const shellValue = process.env[meta.name];
    if (shellValue !== undefined && shellValue.length > 0) {
      const filled = await fillMissing(client, projectId, branchId, meta.name, shellValue);
      if (filled !== undefined) updatedAt.set(meta.name, filled);
      continue;
    }
    missing.push(meta);
  }
  if (missing.length > 0) throw missingError(missing, branchId, input.stage);
  return updatedAt;
}

/**
 * The extension-pack half of the deploy preflight: every dependency edge
 * whose required contract carries a `requiredPackHead` must be wired to a
 * `pnPostgres` resource whose `prisma-next.config.ts` lists that pack at the
 * required head hash. Enforced HERE — at deploy time, before the migration
 * step constructs — because wireability (`pnContract().satisfies`)
 * deliberately says yes to every required pack head (the authoring-side
 * contract value cannot see the resource's config), and boot time would be
 * too late: the service would be down after a green deploy. Invoked from the
 * `prisma-next` descriptor's lowering, beside the migration-step
 * construction.
 */
export async function runPackPreflight(graph: Graph): Promise<void> {
  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue;
    const consumer = graph.nodes.find((n) => n.id === edge.to)?.node;
    if (consumer === undefined || consumer.kind !== 'service') continue;
    const slot = consumer.inputs[edge.input];
    if (slot === undefined) continue;
    const requirement = requiredPackHeadOf(slot.required);
    if (requirement === undefined) continue;

    const node = graph.nodes.find((n) => n.id === edge.from)?.node;
    const provider =
      node !== undefined &&
      (node.kind === 'resource' || node.kind === 'service') &&
      isPnPostgresResourceNode(node)
        ? node
        : undefined;
    if (provider === undefined) {
      throw new Error(
        `service "${edge.to}" requires extension pack "${requirement.packId}", which only a ` +
          'pnPostgres resource can carry.',
      );
    }

    const { extensionPacks } = await resolvePrismaNextConfig(provider.config);
    const pack = extensionPacks.find((p) => p.id === requirement.packId);
    if (pack === undefined) {
      throw new Error(
        `prisma-next database "${provider.name}" does not list extension pack ` +
          `"${requirement.packId}" in its prisma-next.config.ts extensionPacks — service ` +
          `"${edge.to}" requires it. Add the pack and run migration plan.`,
      );
    }
  }
}
