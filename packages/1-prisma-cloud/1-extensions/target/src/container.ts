/**
 * This extension's container lifecycle (the `container` descriptor,
 * ADR-0037): resolves the app's Project + (named stage) Branch via
 * `@internal/lowering`'s `resolveContainer`, before the generated stack file
 * runs — `deploy` ensures (creates if absent), `destroy` locates only.
 * Control-plane only (imported by control.ts and the hook modules); errors
 * here are plain `Error`s — `CliError` is a CLI concept this extension must
 * not import.
 */
import type {
  ContainerCredentials,
  ContainerDescriptor,
  ContainerInstance,
  LocateContainerInput,
} from '@internal/core/config';
import {
  deleteBranch,
  deleteProject,
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
  resolveContainer,
} from '@internal/lowering';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

export const PRISMA_CLOUD_EXTENSION_ID = '@prisma/composer-prisma-cloud';

/** Accepts exactly what Alchemy's own `--stage` validation accepts (pinned 2.0.0-beta.59, `Cli/commands/_shared.ts`), rewritten without overlapping quantifiers so it cannot backtrack catastrophically. Asserted before a Branch id is exposed as a stage. */
const ALCHEMY_STAGE_PATTERN = /^[a-z0-9][-_a-z0-9]*$/i;

function invalidAlchemyStageError(branchId: string): Error {
  return new Error(
    `${PRISMA_CLOUD_EXTENSION_ID}: the resolved Branch id "${branchId}" does not match Alchemy's ` +
      'stage pattern ^[a-z0-9][-_a-z0-9]*$ (case-insensitive) — it cannot scope the deploy ' +
      'state. The platform should never return such an id; contact support.',
  );
}

export class PrismaCloudContainer implements ContainerInstance {
  /** The deterministic Alchemy stage (ContainerInstance SPI): the stage Branch's id, or the default Branch's id for the default stage. Absent only for the dev container, which resolves no Branch. */
  readonly alchemyStage: string | undefined;

  constructor(
    readonly input: LocateContainerInput,
    readonly projectId: string,
    readonly branchId: string | undefined,
    readonly defaultBranchId?: string,
  ) {
    const stageBranchId = branchId ?? defaultBranchId;
    if (stageBranchId !== undefined && !ALCHEMY_STAGE_PATTERN.test(stageBranchId)) {
      throw invalidAlchemyStageError(stageBranchId);
    }
    this.alchemyStage = stageBranchId;
  }

  serialize(): string {
    return JSON.stringify({
      input: this.input,
      projectId: this.projectId,
      ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
      ...(this.defaultBranchId !== undefined ? { defaultBranchId: this.defaultBranchId } : {}),
    });
  }
}

/** `instanceof` — parent-side instances and child-side deserialized instances are both constructed by this module. */
export function isPrismaCloudContainer(value: unknown): value is PrismaCloudContainer {
  return value instanceof PrismaCloudContainer;
}

/** Narrow-or-throw for hook inputs. */
export function prismaCloudContainerOf(value: ContainerInstance | undefined): PrismaCloudContainer {
  if (!isPrismaCloudContainer(value)) {
    throw new Error(
      "the Prisma Cloud container was not resolved — the extension's container descriptor did not run.",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidPayloadError(reason: string): Error {
  return new Error(
    `${PRISMA_CLOUD_EXTENSION_ID}: invalid container transport payload — ${reason}.`,
  );
}

/**
 * Reconstructs a `PrismaCloudContainer` from `serialize()`'s JSON output —
 * real narrowing, no casts. Exported so `dev/container.ts`'s
 * `devContainerDescriptor` can reuse it verbatim (local-dev spec § 5) — the
 * dev and deploy container descriptors deserialize the identical wire shape.
 */
export function deserialize(serialized: string): PrismaCloudContainer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw invalidPayloadError(
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isRecord(parsed)) throw invalidPayloadError('not an object');

  const input = parsed['input'];
  if (!isRecord(input)) throw invalidPayloadError('"input" is not an object');
  const appName = input['appName'];
  if (typeof appName !== 'string') throw invalidPayloadError('"input.appName" is not a string');
  const stage = input['stage'];
  if (stage !== undefined && typeof stage !== 'string') {
    throw invalidPayloadError('"input.stage" is not a string or absent');
  }

  const projectId = parsed['projectId'];
  if (typeof projectId !== 'string') throw invalidPayloadError('"projectId" is not a string');
  const branchId = parsed['branchId'];
  if (branchId !== undefined && typeof branchId !== 'string') {
    throw invalidPayloadError('"branchId" is not a string or absent');
  }
  const defaultBranchId = parsed['defaultBranchId'];
  if (defaultBranchId !== undefined && typeof defaultBranchId !== 'string') {
    throw invalidPayloadError('"defaultBranchId" is not a string or absent');
  }

  return new PrismaCloudContainer({ appName, stage }, projectId, branchId, defaultBranchId);
}

/** The credentials this extension's container lifecycle accepts per call. */
type PrismaCloudCredentials = ContainerCredentials<ManagementApiClient>;

/** Construction-time injection. Per-call credentials outrank it wherever both are present. */
interface ContainerDeps {
  readonly client?: ManagementApiClient;
}

const workspaceRequiredError = (): Error =>
  new Error('environment variable PRISMA_WORKSPACE_ID is required.');

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required.');

/**
 * The caller's workspace id, or — only when the caller passed no credentials
 * at all — the env protocol, which is what the alchemy child process and
 * existing programmatic hosts have set.
 */
function requireWorkspaceId(credentials: PrismaCloudCredentials | undefined): string {
  const workspaceId =
    credentials === undefined ? process.env['PRISMA_WORKSPACE_ID'] : credentials.workspaceId;
  if (workspaceId === undefined || workspaceId.length === 0) throw workspaceRequiredError();
  return workspaceId;
}

function requireTokenUnlessInjected(client: ManagementApiClient | undefined): void {
  if (client === undefined && (process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    throw tokenRequiredError();
  }
}

function clientFor(
  credentials: PrismaCloudCredentials | undefined,
  deps: ContainerDeps | undefined,
): ManagementApiClient | undefined {
  return credentials?.client ?? deps?.client;
}

/** Runs against the injected client when there is one, and against an env-built one otherwise. */
function runWithClient<A, E>(
  program: Effect.Effect<A, E, ManagementClient>,
  client: ManagementApiClient | undefined,
): Promise<A> {
  return Effect.runPromise(
    client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv())))),
  );
}

async function ensureContainer(
  input: LocateContainerInput,
  credentials: PrismaCloudCredentials | undefined,
  deps: ContainerDeps | undefined,
): Promise<PrismaCloudContainer> {
  const workspaceId = requireWorkspaceId(credentials);
  const client = clientFor(credentials, deps);
  requireTokenUnlessInjected(client);

  // All typed failures are caught and carried as a failure *value*, so
  // runPromise only rejects on a genuine defect.
  const program = resolveContainer({
    workspaceId,
    appName: input.appName,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ensure: true,
  }).pipe(
    Effect.map((c) => ({ ok: true as const, container: c })),
    Effect.catchTag('PrismaApiError', (e) =>
      Effect.succeed({
        ok: false as const,
        message: `Prisma Management API error resolving containers: ${e.message}.`,
      }),
    ),
  );

  const outcome = await runWithClient(program, client);
  if (!outcome.ok) throw new Error(outcome.message);
  return new PrismaCloudContainer(
    input,
    outcome.container.projectId,
    outcome.container.branchId,
    outcome.container.defaultBranchId,
  );
}

async function locateContainer(
  input: LocateContainerInput,
  credentials: PrismaCloudCredentials | undefined,
  deps: ContainerDeps | undefined,
): Promise<PrismaCloudContainer | undefined> {
  const workspaceId = requireWorkspaceId(credentials);
  const client = clientFor(credentials, deps);
  requireTokenUnlessInjected(client);

  const program = resolveContainer({
    workspaceId,
    appName: input.appName,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ensure: false,
  }).pipe(
    Effect.map((c) => ({ ok: true as const, container: c })),
    Effect.catchTag('ContainerNotFoundError', () => Effect.succeed({ ok: false as const })),
    Effect.catchTag('PrismaApiError', (e) =>
      Effect.fail(new Error(`Prisma Management API error resolving containers: ${e.message}.`)),
    ),
  );

  const outcome = await runWithClient(program, client);
  if (!outcome.ok) return undefined;
  return new PrismaCloudContainer(
    input,
    outcome.container.projectId,
    outcome.container.branchId,
    outcome.container.defaultBranchId,
  );
}

/**
 * Soft-deletes a named stage's Branch after a successful `alchemy destroy`
 * has removed its members — the Management API refuses to delete a Branch
 * that still has live members.
 */
async function removeStageBranch(
  branchId: string,
  credentials: PrismaCloudCredentials | undefined,
  deps: ContainerDeps | undefined,
): Promise<void> {
  const client = clientFor(credentials, deps);
  requireTokenUnlessInjected(client);
  const program = deleteBranch(branchId).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) =>
      Effect.succeed({
        ok: false as const,
        message: `Failed to delete the stage Branch: ${e.message}.`,
      }),
    ),
  );
  const outcome = await runWithClient(program, client);
  if (!outcome.ok) throw new Error(outcome.message);
}

/**
 * Best-effort cleanup after a successful `--production` destroy: removes
 * the app's Project so hand-run stacks don't accumulate as empty Projects
 * (they eventually hit the workspace's plan limit). Unlike `removeStageBranch`,
 * this never throws: the destroy itself already succeeded, and the API's own
 * 400 ("still has dependencies") is the only check that matters — failing
 * the command over a cleanup step would be worse than leaving a Project shell.
 */
async function removeAppProject(
  projectId: string,
  credentials: PrismaCloudCredentials | undefined,
  deps: ContainerDeps | undefined,
): Promise<void> {
  const client = clientFor(credentials, deps);
  if (client === undefined && (process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    console.warn(`Skipped removing the Project (${projectId}): PRISMA_SERVICE_TOKEN is not set.`);
    return;
  }
  const program = deleteProject(projectId).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) => Effect.succeed({ ok: false as const, error: e })),
  );
  const outcome = await runWithClient(program, client);
  if (outcome.ok) {
    console.log(`Removed the Project (${projectId}) — nothing was left in it.`);
    return;
  }
  if (outcome.error.status === 400) {
    console.log(`Kept the Project (${projectId}) — it still has another stage's resources.`);
    return;
  }
  console.warn(
    `Could not remove the Project (${projectId}) after destroy: ${outcome.error.message}.`,
  );
}

export function containerDescriptor(
  deps?: ContainerDeps,
): ContainerDescriptor<PrismaCloudContainer, ManagementApiClient> {
  return {
    ensure: (input, credentials) => ensureContainer(input, credentials, deps),
    locate: (input, credentials) => locateContainer(input, credentials, deps),
    remove: (instance, credentials) =>
      instance.input.stage !== undefined
        ? removeStageBranch(instance.branchId ?? missingBranchId(instance), credentials, deps)
        : removeAppProject(instance.projectId, credentials, deps),
    deserialize,
  };
}

/** Defensive: a named-stage container always resolves a Branch together with its stage — `ensure`/`locate`/`deserialize` never produce one without the other. */
function missingBranchId(instance: PrismaCloudContainer): never {
  throw new Error(
    `${PRISMA_CLOUD_EXTENSION_ID}: a named-stage ("${instance.input.stage}") container instance is ` +
      'missing its branchId — this is a bug in ensure/locate/deserialize.',
  );
}
