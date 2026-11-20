import type { Graph, ServiceNode } from '@internal/core';
import { inputManifest } from '@internal/core';
import type {
  PlatformVariableReader,
  PreflightInput,
  UnsetPlatformVariable,
} from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import {
  composerClientOf,
  drivePagesAsync,
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
} from '@internal/lowering';
import { type } from 'arktype';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { type PrismaCloudContainer, prismaCloudContainerOf } from './container.ts';
import type { DeployPreflightPayload } from './control/preflight-payload.ts';
import { type EnvKeyClash, findEnvKeyClashes } from './env-key-clash.ts';
import { addReader, missingVariableNames, missingVariablesText } from './missing-variables-text.ts';
import { resolveOrmConfig } from './orm-config.ts';
import { isPostgresResourceNode, requiredPackHeadOf } from './orm-postgres.ts';
import { inputVariableNames, unreadVariables } from './preflight-names.ts';
import { checkPublicUrls } from './public-url.ts';
import { checkRequirements, type MissingVariables } from './required-variables.ts';

type EnvClass = 'production' | 'preview';

/** production for the environment `production`; preview for any other — matching how the pack writes config rows. */
const classFor = (branchId: string | undefined): EnvClass =>
  branchId === undefined ? 'production' : 'preview';

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

const RESOLVED_VARIABLES_PATH = '/v1/projects/{projectId}/resolved-variables';

const resolvedVariablesBody = type({
  group: { name: 'string', class: 'string' },
  data: type({ key: 'string', updatedAt: 'string', isManagedBySystem: 'boolean' }).array(),
});
type ResolvedVariables = typeof resolvedVariablesBody.infer;
type VariableGroup = ResolvedVariables['group'];

interface ResolvedVariablesClient {
  GET(
    path: typeof RESOLVED_VARIABLES_PATH,
    init: {
      params: { path: { projectId: string }; query: { branchId: string } };
      parseAs: 'text';
    },
  ): Promise<{ readonly data?: unknown; readonly error?: unknown; readonly response: Response }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCursor = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

const saysThereIsMore = (fields: Record<string, unknown>): boolean =>
  fields['hasMore'] === true || isCursor(fields['nextCursor']) || isCursor(fields['cursor']);

const isPartial = (body: unknown): boolean =>
  isRecord(body) &&
  (saysThereIsMore(body) || (isRecord(body['pagination']) && saysThereIsMore(body['pagination'])));

const NOT_JSON = Symbol('not JSON');

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return NOT_JSON;
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

const EXCERPT_LENGTH = 120;

const excerpt = (body: unknown): string => {
  const text = typeof body === 'string' ? body : (JSON.stringify(body) ?? '');
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= EXCERPT_LENGTH ? line : `${line.slice(0, EXCERPT_LENGTH)}…`;
};

const withoutClosingStops = (message: string): string => message.trim().replace(/\.+$/, '');

const statusOf = (error: unknown): number | undefined =>
  isRecord(error) && typeof error['status'] === 'number' ? error['status'] : undefined;

interface ResolvedRead {
  readonly call: string;
  readonly projectId: string;
  readonly branchId: string;
}

async function readResolvedVariables(
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Promise<ResolvedVariables> {
  const read: ResolvedRead = {
    call: `GET /v1/projects/${projectId}/resolved-variables?branchId=${branchId}`,
    projectId,
    branchId,
  };
  const res = await blindCast<
    ResolvedVariablesClient,
    'the published Management API SDK does not describe the resolved-variables read yet; its body is checked below'
  >(client)
    .GET(RESOLVED_VARIABLES_PATH, {
      params: { path: { projectId }, query: { branchId } },
      parseAs: 'text',
    })
    .catch((cause: unknown) => {
      throw readThrewError(read, cause);
    });
  if (res.error !== undefined || !res.response.ok) {
    throw readStatusError(read, res.response.status, res.error);
  }
  const body = parseJson(res.data);
  if (body === NOT_JSON) throw notJsonError(read, res.response.status, res.data);
  if (isPartial(body)) throw pagedReadError(read);
  const parsed = resolvedVariablesBody(body);
  if (parsed instanceof type.errors) throw unexpectedReadError(read, parsed.summary);
  return parsed;
}

function deployBranchIdOf(container: PrismaCloudContainer): string {
  if (container.deployBranchId === undefined) {
    throw new Error(
      `deploy preflight: the container for the environment "${container.input.environment}" has no branch id. This is a bug in Composer.`,
    );
  }
  return container.deployBranchId;
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

/** The preflight input typed against this extension's own client — the concrete form of the framework's erased `PreflightInput<unknown>`. */
export type PrismaCloudPreflightInput = PreflightInput<ManagementApiClient>;

// ——— Preflight errors (centralized; ADR-0029). Values are never logged. ———

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required for deploy preflight.');

const listFailedError = (key: string, error: unknown): Error =>
  new Error(
    `deploy preflight: Prisma Management API error listing "${key}": ${JSON.stringify(error)}.`,
  );

const couldNotRead = (read: ResolvedRead): string =>
  `Deploy failed. Composer could not read which variables branch "${read.branchId}" of project "${read.projectId}" receives: ${read.call}`;

const readStatusError = (read: ResolvedRead, status: number, error: unknown): Error =>
  new Error(
    `${couldNotRead(read)} answered HTTP ${String(status)}` +
      `${error === undefined || error === '' ? '' : `: ${excerpt(error)}`}.` +
      (status === 404
        ? ' The platform may not offer this read yet, and this Composer version needs it to check platform variables.'
        : ''),
  );

const readThrewError = (read: ResolvedRead, cause: unknown): Error => {
  const status = statusOf(cause);
  const reason = withoutClosingStops(cause instanceof Error ? cause.message : String(cause));
  return new Error(
    `${couldNotRead(read)} failed${status === undefined ? '' : ` with HTTP ${String(status)}`}: ${reason}.`,
    { cause },
  );
};

const notJsonError = (read: ResolvedRead, status: number, body: unknown): Error => {
  const shown = excerpt(body);
  return new Error(
    `${couldNotRead(read)} answered HTTP ${String(status)} with ${shown === '' ? 'an empty body' : `a body that is not JSON: ${shown}`}.`,
  );
};

const unexpectedReadError = (read: ResolvedRead, problem: string): Error =>
  new Error(
    `${couldNotRead(read)} answered with a body this Composer version cannot read: ${problem}. The platform's answer may have changed, and a newer Composer version may read it.`,
  );

const pagedReadError = (read: ResolvedRead): Error =>
  new Error(
    `${couldNotRead(read)} answered with one page of a longer list. This Composer version reads only one page, so it would report set variables as missing. It is too old for the platform: upgrade Composer and deploy again.`,
  );

/** `value` as one POSIX shell word: single-quoted, each embedded `'` written as `'\''`. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function setCommands(name: string, projectId: string, group: VariableGroup): readonly string[] {
  const add = `prisma project env add ${shellQuote(`${name}=<value>`)} --project ${shellQuote(projectId)}`;
  switch (group.class) {
    case 'production':
      return [`${add} --role production`];
    case 'preview':
      return [`${add} --role preview`];
    default:
      return [`Set ${name} in the variable group "${group.name}" in the Prisma Console.`];
  }
}

function requiredError(
  required: readonly MissingVariables[],
  readers: ReadonlyMap<string, readonly PlatformVariableReader[]>,
  commandsFor: (name: string) => readonly string[],
): Error {
  const names = missingVariableNames(required);
  const commands = names.flatMap(commandsFor).map((command) => `  - ${command}`);
  return new Error(
    `Deploy failed. ${missingVariablesText(required, readers)}\n\n` +
      `Set ${names.length === 1 ? 'it' : 'them'} on the platform, then deploy again:\n` +
      commands.join('\n'),
  );
}

const managedBySystemError = (names: readonly string[]): Error =>
  new Error(
    `Deploy failed. ${names.map((name) => `"${name}"`).join(', ')} ${names.length === 1 ? 'is a platform variable' : 'are platform variables'} that Prisma Cloud manages itself, so the app cannot read ${names.length === 1 ? 'it' : 'them'} as its own. Rename ${names.length === 1 ? 'it' : 'them'} in the app.`,
  );

const invalidInputError = (serviceAddress: string, message: string): Error =>
  new Error(`invalid input for service "${serviceAddress}": ${message}`);

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

function serviceNodeAt(graph: Graph, address: string): ServiceNode {
  const found = graph.nodes.find((entry) => entry.id === address)?.node;
  if (found?.kind !== 'service') {
    throw new Error(`deploy preflight: no service node at address "${address}".`);
  }
  return found;
}

export async function runPreflight(
  input: PrismaCloudPreflightInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<DeployPreflightPayload> {
  checkPublicUrls(input.graph);
  const container = prismaCloudContainerOf(input.container);
  const { projectId, branchId } = container;

  const services = inputManifest(input.graph).map(({ serviceAddress, binding }) => ({
    serviceAddress,
    binding,
    names: inputVariableNames(binding, serviceAddress).map((variable) => variable.name),
  }));
  const unread = unreadVariables(input.graph).map(({ name, node }) => ({
    name,
    reader: { kind: 'unread', node } as const,
  }));
  const names = [
    ...new Set([...services.flatMap((service) => service.names), ...unread.map((use) => use.name)]),
  ];
  const clashes = findEnvKeyClashes(input.graph);
  if (names.length === 0 && clashes.length === 0) {
    input.report?.({ checked: 0, unset: [] });
    return { updatedAt: new Map() };
  }

  const client = composerClientOf(input.credentials) ?? deps?.client ?? (await managementClient());
  const pending = await pendingEnvKeyClashes(client, projectId, branchId, clashes);
  if (pending.length > 0) throw envKeyClashError(pending, projectId, branchId, input.environment);

  if (names.length === 0) {
    input.report?.({ checked: 0, unset: [] });
    return { updatedAt: new Map() };
  }

  const resolved = await readResolvedVariables(client, projectId, deployBranchIdOf(container));
  const entries = new Map(resolved.data.map((entry) => [entry.key, entry]));
  const updatedAt = new Map<string, string>();
  const unset = new Set<string>();
  const managedBySystem: string[] = [];
  for (const name of names) {
    const entry = entries.get(name);
    if (entry === undefined) {
      unset.add(name);
      continue;
    }
    updatedAt.set(name, entry.updatedAt);
    if (entry.isManagedBySystem) managedBySystem.push(name);
  }
  if (managedBySystem.length > 0) throw managedBySystemError(managedBySystem);
  if (unset.size === 0) {
    input.report?.({ checked: names.length, unset: [] });
    return { updatedAt };
  }

  const readers = new Map<string, PlatformVariableReader[]>();
  const required: MissingVariables[] = [];
  for (const { serviceAddress, binding, names: serviceNames } of services) {
    const unsetHere = serviceNames.filter((name) => unset.has(name));
    if (unsetHere.length === 0) continue;
    const node = serviceNodeAt(input.graph, serviceAddress);
    const decided = checkRequirements(node, serviceAddress, binding, unsetHere);
    if (decided.kind === 'invalid') throw invalidInputError(serviceAddress, decided.message);
    for (const marker of decided.markers) {
      if (!unset.has(marker.name)) continue;
      addReader(readers, marker.name, {
        kind: 'field',
        service: serviceAddress,
        path: marker.path,
      });
    }
    required.push(...decided.missing);
  }
  for (const use of unread) {
    if (unset.has(use.name)) addReader(readers, use.name, use.reader);
  }

  const commandsFor = (name: string) => setCommands(name, projectId, resolved.group);
  if (required.length > 0) throw requiredError(required, readers, commandsFor);
  const findings: UnsetPlatformVariable[] = [...unset].sort().map((name) => ({
    name,
    readers: readers.get(name) ?? [],
    commands: commandsFor(name),
  }));
  input.report?.({ checked: names.length, unset: findings });
  return { updatedAt };
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
