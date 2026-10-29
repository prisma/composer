/**
 * Deploy preflight (ADR-0029, extended for env-sourced params): before Alchemy
 * runs, verify every secret binding AND every env-sourced param binding in the
 * app's manifests (each a platform env-var NAME) exists on Prisma Cloud for
 * the target environment. A literal-bound param never touches the platform — only
 * `envParam(...)` sources are checked here.
 * A name absent on the platform but present in the deploy shell is provisioned
 * via a direct Management API POST — NEVER an Alchemy resource, so the value
 * never lands in hosted deploy state. A name absent from both fails the deploy,
 * listing exactly what is missing and where to set it.
 *
 * Control-plane only (imported by control.ts → prisma.config.ts); runs
 * in the CLI parent, on the caller's Management API client when it passed one,
 * and otherwise on a client built from env — the same credential path
 * `container.ts`'s `ensure`/`locate` use.
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
import { type EnvKeyClash, findEnvKeyClashes } from './env-key-clash.ts';
import { resolveOrmConfig } from './orm-config.ts';
import { isPostgresResourceNode, requiredPackHeadOf } from './orm-postgres.ts';
import { collectPreflightNames } from './preflight-names.ts';
import { checkPublicUrls } from './public-url.ts';

type EnvClass = 'production' | 'preview';

/** production for the environment `production`; preview for any other — matching how the pack writes config rows. */
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
  /** The latest `updatedAt` across every row visible to this environment — undefined when the name is absent. */
  readonly updatedAt?: string;
}

/**
 * What the platform holds for `key` in the target environment's scope. `production`
 * → any production-class template. Any other environment → a preview template (branchId
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
        // Parsed, not string-compared: lexicographic order breaks the moment
        // two rows serialize with different precision or UTC designators.
        if (latest === undefined || Date.parse(row.updatedAt) > Date.parse(latest)) {
          latest = row.updatedAt;
        }
      }
      return false;
    },
  );
  return latest === undefined ? { exists } : { exists, updatedAt: latest };
}

/** Whether `key` has a row in the scope Composer writes its own rows to: production, or the environment's branch. */
async function composerRowExists(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  key: string,
): Promise<boolean> {
  const cls = classFor(branchId);
  let exists = false;
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
      exists ||= data.some((row) => row.branchId === (branchId ?? null));
      return exists;
    },
  );
  return exists;
}

/**
 * A clash blocks the deploy while the old owner's row still holds the key and has not moved to
 * its new key yet. Before the move, the deploy would fail on that key partway through; after it,
 * the key belongs to the new owner, and a new environment has neither row. The old owner's new key can
 * itself be a third node's old key (`shop.x`, `shop.shop.x`, `shop.shop.shop.x`); a row there
 * counts as moved only when that clash is not pending, so a whole chain is reported at once.
 * Along a chain every key is longer than the one before, so the walk ends.
 */
async function pendingEnvKeyClashes(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  clashes: readonly EnvKeyClash[],
): Promise<readonly EnvKeyClash[]> {
  const byKey = new Map(clashes.map((clash) => [clash.key, clash]));
  const exists = new Map<string, Promise<boolean>>();
  const rowExists = (key: string) => {
    const known = exists.get(key);
    if (known !== undefined) return known;
    const found = composerRowExists(client, projectId, branchId, key);
    exists.set(key, found);
    return found;
  };
  const isPending = async (clash: EnvKeyClash): Promise<boolean> =>
    (await rowExists(clash.key)) && !(await hasMoved(clash.oldOwnerNewKey));
  const hasMoved = async (key: string): Promise<boolean> => {
    if (!(await rowExists(key))) return false;
    const next = byKey.get(key);
    return next === undefined || !(await isPending(next));
  };
  const pending: EnvKeyClash[] = [];
  for (const clash of clashes) {
    if (await isPending(clash)) pending.push(clash);
  }
  return pending;
}

/**
 * Provision `key`=`value` directly via the Management API for the target
 * environment's scope (a production template for `production`; a preview branch
 * override for any other environment — the same scope the pack's config rows are
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
  readonly address: string;
  readonly nodeKind: 'service' | 'module';
}

/** The preflight input typed against this extension's own client — the concrete form of the framework's erased `PreflightInput<unknown>`. */
export type PrismaCloudPreflightInput = PreflightInput<ManagementApiClient>;

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

/** `value` as one POSIX shell word: single-quoted, each embedded `'` written as `'\''`. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function missingError(
  missing: readonly MissingBinding[],
  projectId: string,
  branchId: string | undefined,
  environment: string,
): Error {
  const lines = missing.map((m) => `  - ${m.name}  (used by ${m.nodeKind} "${m.address}")`);
  const countPhrase =
    missing.length === 1 ? '1 required setting has' : `${missing.length} required settings have`;
  const scopeFlag =
    branchId === undefined ? '--role production' : `--branch ${shellQuote(environment)}`;
  // `project env add` takes a single KEY=VALUE per call. Quoting the pair keeps the
  // `<value>` placeholder from being read as a shell redirection.
  const commands = missing.map(
    (m) =>
      `prisma project env add ${shellQuote(`${m.name}=<value>`)} --project ${shellQuote(projectId)} ${scopeFlag}`,
  );
  const runStep =
    commands.length === 1
      ? `Run: ${commands[0]}`
      : `Run, once per setting:\n${commands.map((cmd) => `      ${cmd}`).join('\n')}`;
  const consoleStep =
    branchId === undefined
      ? 'add each one under Production. Those values apply when the default branch deploys to production.'
      : `add each one under Preview. Preview values apply to every branch deploy, including "${environment}".`;
  return new Error(
    `Deploy failed. ${countPhrase} no value:\n` +
      `${lines.join('\n')}\n\n` +
      'Set the value in one of these two places, then deploy again:\n' +
      `  - ${runStep}\n` +
      `  - Or in the Prisma Console: open the project, go to Environment variables, and ${consoleStep}`,
  );
}

function envKeyClashError(
  clashes: readonly EnvKeyClash[],
  projectId: string,
  branchId: string | undefined,
  environment: string,
): Error {
  const scopeFlag =
    branchId === undefined ? '--role production' : `--branch ${shellQuote(environment)}`;
  const lines = clashes.map(
    (c) =>
      `  - ${c.key} belongs to "${c.oldOwner}" from the previous Composer release. ` +
      `This release writes it for "${c.newOwner}", and moves "${c.oldOwner}"'s value to ${c.oldOwnerNewKey}.`,
  );
  const commands = clashes.map(
    (c) =>
      `      prisma project env delete ${shellQuote(c.key)} --project ${shellQuote(projectId)} ${scopeFlag}`,
  );
  return new Error(
    "Deploy failed before any resource was created, changed or deleted; the branch's application " +
      'topology has already been replaced and the build recorded. Moving to addresses that start with the app name ' +
      "gives these environment variables a new owner, but each still holds its old owner's value:\n" +
      `${lines.join('\n')}\n\n` +
      'Delete each one, then deploy again. The deploy writes every value under its new key, so ' +
      'nothing is lost; the running deployments keep their own copy until then.\n' +
      `${commands.join('\n')}\n` +
      'Or delete it in the Prisma Console: open the project, go to Environment variables, and ' +
      `delete it under ${branchId === undefined ? 'Production' : `the branch "${environment}"`}.`,
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
 * The Prisma Cloud extension's `preflight`. Every secret source the graph
 * names is checked, including one only a resolve() dependency lists. Uses the
 * shared name collector
 * (`collectPreflightNames`, ADR-0042) — every service's input-binding
 * `envSecret` leaf, plus `paramManifest` filtered to env-sourced reserved
 * params — checks each platform name against the platform, fills from the
 * shell where possible, and fails loudly on anything absent from both.
 * `envParam` leaves of an input binding are NOT checked here — they resolve
 * from the deploy shell at serialize, and an unset one is an omitted key the
 * schema arbitrates. Uses the caller's client (`input.credentials`), then an
 * injected one for tests, then a client built from env.
 */
export async function runPreflight(
  input: PrismaCloudPreflightInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<ReadonlyMap<string, string>> {
  checkPublicUrls(input.graph);
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
  const clashes = findEnvKeyClashes(input.graph);
  if (names.size === 0 && clashes.length === 0) {
    input.report?.({ checked: 0, filled: 0, missing: 0 });
    return new Map();
  }

  const client = input.credentials?.client ?? deps?.client ?? (await managementClient());
  const pending = await pendingEnvKeyClashes(client, projectId, branchId, clashes);
  if (pending.length > 0) throw envKeyClashError(pending, projectId, branchId, input.environment);
  const missing: MissingBinding[] = [];
  const updatedAt = new Map<string, string>();
  let filled = 0;
  for (const meta of names.values()) {
    const platform = await readPlatformVariable(client, projectId, branchId, meta.name);
    if (platform.exists) {
      if (platform.updatedAt !== undefined) updatedAt.set(meta.name, platform.updatedAt);
      continue;
    }
    const shellValue = process.env[meta.name];
    if (shellValue !== undefined && shellValue.length > 0) {
      const filledAt = await fillMissing(client, projectId, branchId, meta.name, shellValue);
      if (filledAt !== undefined) {
        updatedAt.set(meta.name, filledAt);
        filled += 1;
      }
      continue;
    }
    missing.push(meta);
  }
  input.report?.({ checked: names.size, filled, missing: missing.length });
  if (missing.length > 0) throw missingError(missing, projectId, branchId, input.environment);
  return updatedAt;
}

/**
 * The extension-pack half of the deploy preflight: every dependency edge
 * whose required contract carries a `requiredPackHead` must be wired to a
 * `postgres` resource whose `prisma.config.ts` lists that pack at the
 * required head hash. Enforced HERE — at deploy time, before the migration
 * step constructs — because wireability (`dataContract().satisfies`)
 * deliberately says yes to every required pack head (the authoring-side
 * contract value cannot see the resource's config), and boot time would be
 * too late: the service would be down after a green deploy. Invoked from the
 * `postgres` descriptor's lowering, beside the migration-step
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
      isPostgresResourceNode(node)
        ? node
        : undefined;
    if (provider === undefined) {
      throw new Error(
        `service "${edge.to}" requires extension pack "${requirement.packId}", which only a ` +
          'postgres resource can carry.',
      );
    }

    const { extensionPacks } = await resolveOrmConfig(provider.config);
    const pack = extensionPacks.find((p) => p.id === requirement.packId);
    if (pack === undefined) {
      throw new Error(
        `postgres database "${provider.name}" does not list extension pack ` +
          `"${requirement.packId}" in its prisma.config.ts extensions — service ` +
          `"${edge.to}" requires it. Add the pack and run migration plan.`,
      );
    }
    // A pack listed at the wrong head is the failure this check exists for:
    // the migration step would take the database to the configured head while
    // the service is typed against a different one.
    const head = pack.contractSpace?.headRef.hash;
    if (head !== requirement.headHash) {
      throw new Error(
        `postgres database "${provider.name}" lists extension pack ` +
          `"${requirement.packId}" at head ${head ?? '(no contract space)'}, but service ` +
          `"${edge.to}" requires ${requirement.headHash}. Upgrade the pack and run ` +
          'migration plan.',
      );
    }
  }
}
