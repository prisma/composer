/**
 * Deploy preflight (ADR-0029). Before Alchemy runs, it reads, for every
 * platform variable the graph names, whether a row exists in the scopes the
 * environment sees, and when the row the platform resolves was last written.
 * It writes no variable and reads no value: env-var values are write-only.
 *
 * A variable with no row fails the deploy only when a service cannot boot
 * without it, decided from the service's schema (ADR-0058). The others are
 * handed back as findings, beside the `updatedAt` of each resolved row, which
 * the compute deploy hook folds into each deployment's triggers.
 *
 * Control-plane only; runs in the CLI parent, on the caller's Management API
 * client when it passed one, and otherwise on a client built from env.
 */
import type { Graph, ServiceNode } from '@internal/core';
import { inputManifest, secretSourceManifest } from '@internal/core';
import type {
  PlatformVariableReader,
  PreflightFindings,
  PreflightInput,
  UnsetPlatformVariable,
} from '@internal/core/config';
import { platformVariableReaderText } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { collectPlatformMarkers } from '@internal/input-document';
import {
  drivePagesAsync,
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
} from '@internal/lowering';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { mapWithConcurrency } from './bounded-concurrency.ts';
import { prismaCloudContainerOf } from './container.ts';
import { type EnvKeyClash, findEnvKeyClashes } from './env-key-clash.ts';
import { resolveOrmConfig } from './orm-config.ts';
import { isPostgresResourceNode, requiredPackHeadOf } from './orm-postgres.ts';
import { envParamBindings, inputSecretNames } from './preflight-names.ts';
import { checkPublicUrls } from './public-url.ts';
import { requiredVariables } from './required-variables.ts';
import { secretName } from './secret.ts';
import { serializeInput } from './serializer.ts';

type EnvClass = 'production' | 'preview';

/** production for the environment `production`; preview for any other — matching how the pack writes config rows. */
const classFor = (branchId: string | undefined): EnvClass =>
  branchId === undefined ? 'production' : 'preview';

/** The fields of one env-var list page that preflight consumes (metadata only; values are write-only). */
interface EnvVarListPage {
  readonly data: readonly {
    readonly branchId: string | null;
    readonly updatedAt: string;
    readonly isManagedBySystem?: boolean;
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

/** The row the platform resolves for one name in this environment, and whether any row the environment sees is the platform's own. */
interface PlatformVariable {
  readonly updatedAt?: string;
  readonly managedBySystem: boolean;
}

/** At most this many list calls run at once. */
const LIST_CONCURRENCY = 8;

/**
 * What the platform holds for `key` in this environment. One list call,
 * filtered by class and key, walked to its last page. The environment sees
 * the class row (no branch) and, for a preview environment, its own
 * branch's row; the branch row wins when there is one, as the platform
 * resolves it.
 */
async function readPlatformVariable(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
  key: string,
): Promise<PlatformVariable | undefined> {
  const cls = classFor(branchId);
  let classRow: string | undefined;
  let branchRow: string | undefined;
  let managedBySystem = false;
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
        if (row.branchId === null) classRow = row.updatedAt;
        else if (branchId !== undefined && row.branchId === branchId) branchRow = row.updatedAt;
        else continue;
        managedBySystem ||= row.isManagedBySystem === true;
      }
      return false;
    },
  );
  const updatedAt = branchRow ?? classRow;
  if (updatedAt === undefined) return undefined;
  return { updatedAt, managedBySystem };
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

/** What the deploy preflight hands back: the `updatedAt` of each resolved row, and the variables with no value that nothing requires. */
export interface PreflightResult {
  readonly updatedAt: ReadonlyMap<string, string>;
  readonly findings: PreflightFindings;
}

// ——— Preflight errors (centralized; ADR-0029). Values are never logged. ———

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required for deploy preflight.');

const listFailedError = (key: string, error: unknown): Error =>
  new Error(
    `deploy preflight: Prisma Management API error listing "${key}": ${JSON.stringify(error)}.`,
  );

/** `value` as one POSIX shell word: single-quoted, each embedded `'` written as `'\''`. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The commands that set `name`: the production row, or the preview-wide row first and this branch's row second. */
function setCommands(
  name: string,
  projectId: string,
  branchId: string | undefined,
  environment: string,
): readonly string[] {
  const add = `prisma project env add ${shellQuote(`${name}=<value>`)} --project ${shellQuote(projectId)}`;
  return branchId === undefined
    ? [`${add} --role production`]
    : [`${add} --role preview`, `${add} --role preview --branch ${shellQuote(environment)}`];
}

const readersText = (readers: readonly PlatformVariableReader[]): string =>
  readers.length === 0 ? '' : `  (${readers.map(platformVariableReaderText).join('; ')})`;

/** Required variables: one name a service needs, or several of which it needs some. */
interface Required {
  readonly names: readonly string[];
  readonly serviceAddress: string;
}

function requiredError(
  required: readonly Required[],
  readers: ReadonlyMap<string, readonly PlatformVariableReader[]>,
  commandsFor: (name: string) => readonly string[],
): Error {
  const names = [...new Set(required.flatMap((entry) => entry.names))];
  const listed = new Set<string>();
  const entries = required.filter((entry) => {
    const [only] = entry.names;
    if (entry.names.length !== 1 || only === undefined) return true;
    if (listed.has(only)) return false;
    listed.add(only);
    return true;
  });
  const lines = entries.map((entry) =>
    entry.names.length === 1
      ? `  - ${entry.names[0]}${readersText(readers.get(entry.names[0] ?? '') ?? [])}`
      : `  - some of ${entry.names.join(', ')}  (service "${entry.serviceAddress}" needs some of them)`,
  );
  const countLine =
    names.length === 1
      ? '1 platform variable a service needs has no value:'
      : `${names.length} platform variables a service needs have no value:`;
  const commands = names.flatMap(commandsFor).map((command) => `  - ${command}`);
  return new Error(
    `Deploy failed. ${countLine}\n${lines.join('\n')}\n\n` +
      `Set ${names.length === 1 ? 'it' : 'them'} on the platform, then deploy again:\n` +
      commands.join('\n'),
  );
}

const managedBySystemError = (names: readonly string[]): Error =>
  new Error(
    `Deploy failed. ${names.map((name) => `"${name}"`).join(', ')} ${names.length === 1 ? 'is a platform variable' : 'are platform variables'} that Prisma Cloud manages itself (isManagedBySystem), so the app cannot read ${names.length === 1 ? 'it' : 'them'} as its own. Rename ${names.length === 1 ? 'it' : 'them'} in the app.`,
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

/** Appends `reader` to `name`'s readers. */
function addReader(
  readers: Map<string, PlatformVariableReader[]>,
  name: string,
  reader: PlatformVariableReader,
): void {
  const list = readers.get(name);
  if (list === undefined) readers.set(name, [reader]);
  else list.push(reader);
}

/**
 * The Prisma Cloud extension's `preflight`. Checks every platform variable
 * the graph names: the `envSecret()` leaves of every service's input
 * binding, every secret source in `graph.secretSources` (including one in a
 * module's input that no service receives), and every per-key param bound to
 * `envParam()`. Writes nothing. Fails when a variable a service needs has no
 * row, or when a row the environment sees is the platform's own.
 */
export async function runPreflight(
  input: PrismaCloudPreflightInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<PreflightResult> {
  checkPublicUrls(input.graph);
  const { projectId, branchId } = prismaCloudContainerOf(input.container);

  const services = inputManifest(input.graph).map(({ serviceAddress, binding }) => ({
    serviceAddress,
    binding,
    names: inputSecretNames(binding, serviceAddress),
  }));
  const params = envParamBindings(input.graph);
  const unread = secretSourceManifest(input.graph).flatMap((use) =>
    use.nodeKind === 'service'
      ? []
      : [
          {
            name: secretName(use.source, `a secret source of ${use.nodeKind} "${use.address}"`),
            reader: { kind: 'unread', node: use.address, nodeKind: use.nodeKind } as const,
          },
        ],
  );
  const names = [
    ...new Set([
      ...services.flatMap((service) => service.names),
      ...unread.map((use) => use.name),
      ...params.map((param) => param.name),
    ]),
  ];
  const clashes = findEnvKeyClashes(input.graph);
  if (names.length === 0 && clashes.length === 0) {
    input.report?.({ checked: 0, unset: 0 });
    return { updatedAt: new Map(), findings: { unset: [] } };
  }

  const client = input.credentials?.client ?? deps?.client ?? (await managementClient());
  const pending = await pendingEnvKeyClashes(client, projectId, branchId, clashes);
  if (pending.length > 0) throw envKeyClashError(pending, projectId, branchId, input.environment);

  const rows = await mapWithConcurrency(names, LIST_CONCURRENCY, (name) =>
    readPlatformVariable(client, projectId, branchId, name),
  );
  const updatedAt = new Map<string, string>();
  const unset = new Set<string>();
  const managedBySystem: string[] = [];
  names.forEach((name, index) => {
    const row = rows[index];
    if (row?.updatedAt === undefined) {
      unset.add(name);
      return;
    }
    updatedAt.set(name, row.updatedAt);
    if (row.managedBySystem) managedBySystem.push(name);
  });
  input.report?.({ checked: names.length, unset: unset.size });
  if (managedBySystem.length > 0) throw managedBySystemError(managedBySystem);
  if (unset.size === 0) return { updatedAt, findings: { unset: [] } };

  const readers = new Map<string, PlatformVariableReader[]>();
  const required: Required[] = [];
  for (const { serviceAddress, binding, names: serviceNames } of services) {
    const unsetHere = serviceNames.filter((name) => unset.has(name));
    if (unsetHere.length === 0) continue;
    const node = serviceNodeAt(input.graph, serviceAddress);
    const document = serializeInput(node, serviceAddress, binding, {
      env: input.configuration,
    });
    const markers =
      document === undefined ? [] : collectPlatformMarkers(JSON.parse(document.value));
    const inArray = new Set<string>();
    for (const marker of markers) {
      if (!unset.has(marker.name)) continue;
      addReader(readers, marker.name, {
        kind: 'field',
        service: serviceAddress,
        path: marker.path,
      });
      if (marker.inArray) inArray.add(marker.name);
    }
    for (const name of inArray) required.push({ names: [name], serviceAddress });
    const decided = requiredVariables(
      node,
      serviceAddress,
      binding,
      unsetHere.filter((name) => !inArray.has(name)),
      input.configuration,
    );
    if (decided.kind === 'invalid') throw invalidInputError(serviceAddress, decided.message);
    required.push(...decided.missing);
  }
  for (const use of unread) {
    if (unset.has(use.name)) addReader(readers, use.name, use.reader);
  }
  for (const param of params) {
    if (!unset.has(param.name)) continue;
    addReader(readers, param.name, {
      kind: 'param',
      service: param.serviceAddress,
      param: param.param,
    });
    const declared = serviceNodeAt(input.graph, param.serviceAddress).params[param.param];
    if (declared !== undefined && declared.default === undefined && declared.optional !== true) {
      required.push({ names: [param.name], serviceAddress: param.serviceAddress });
    }
  }

  const commandsFor = (name: string) => setCommands(name, projectId, branchId, input.environment);
  if (required.length > 0) throw requiredError(required, readers, commandsFor);
  const findings: UnsetPlatformVariable[] = [...unset].sort().map((name) => ({
    name,
    readers: readers.get(name) ?? [],
    commands: commandsFor(name),
  }));
  return { updatedAt, findings: { unset: findings } };
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
