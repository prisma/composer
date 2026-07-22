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

export class PrismaCloudContainer implements ContainerInstance {
  constructor(
    readonly input: LocateContainerInput,
    readonly projectId: string,
    readonly branchId: string | undefined,
  ) {}

  serialize(): string {
    return JSON.stringify({
      input: this.input,
      projectId: this.projectId,
      ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
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

  return new PrismaCloudContainer({ appName, stage }, projectId, branchId);
}

const workspaceRequiredError = (): Error =>
  new Error('environment variable PRISMA_WORKSPACE_ID is required.');

const tokenRequiredError = (): Error =>
  new Error('environment variable PRISMA_SERVICE_TOKEN is required.');

function requireWorkspaceId(): string {
  const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId.length === 0) throw workspaceRequiredError();
  return workspaceId;
}

function requireTokenUnlessInjected(
  deps: { readonly client?: ManagementApiClient } | undefined,
): void {
  if (deps?.client === undefined && (process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    throw tokenRequiredError();
  }
}

async function ensureContainer(
  input: LocateContainerInput,
  deps: { readonly client?: ManagementApiClient } | undefined,
): Promise<PrismaCloudContainer> {
  const workspaceId = requireWorkspaceId();
  requireTokenUnlessInjected(deps);

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

  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));
  const outcome = await Effect.runPromise(provided);
  if (!outcome.ok) throw new Error(outcome.message);
  return new PrismaCloudContainer(input, outcome.container.projectId, outcome.container.branchId);
}

async function locateContainer(
  input: LocateContainerInput,
  deps: { readonly client?: ManagementApiClient } | undefined,
): Promise<PrismaCloudContainer | undefined> {
  const workspaceId = requireWorkspaceId();
  requireTokenUnlessInjected(deps);

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

  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));
  const outcome = await Effect.runPromise(provided);
  if (!outcome.ok) return undefined;
  return new PrismaCloudContainer(input, outcome.container.projectId, outcome.container.branchId);
}

/**
 * Soft-deletes a named stage's Branch after a successful `alchemy destroy`
 * has removed its members — the Management API refuses to delete a Branch
 * that still has live members.
 */
async function removeStageBranch(
  branchId: string,
  deps: { readonly client?: ManagementApiClient } | undefined,
): Promise<void> {
  requireTokenUnlessInjected(deps);
  const program = deleteBranch(branchId).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) =>
      Effect.succeed({
        ok: false as const,
        message: `Failed to delete the stage Branch: ${e.message}.`,
      }),
    ),
  );
  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));
  const outcome = await Effect.runPromise(provided);
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
  deps: { readonly client?: ManagementApiClient } | undefined,
): Promise<void> {
  if (deps?.client === undefined && (process.env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    console.warn(`Skipped removing the Project (${projectId}): PRISMA_SERVICE_TOKEN is not set.`);
    return;
  }
  const program = deleteProject(projectId).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) => Effect.succeed({ ok: false as const, error: e })),
  );
  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));
  const outcome = await Effect.runPromise(provided);
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

export function containerDescriptor(deps?: {
  readonly client?: ManagementApiClient;
}): ContainerDescriptor<PrismaCloudContainer> {
  return {
    ensure: (input) => ensureContainer(input, deps),
    locate: (input) => locateContainer(input, deps),
    remove: (instance) =>
      instance.input.stage !== undefined
        ? removeStageBranch(instance.branchId ?? missingBranchId(instance), deps)
        : removeAppProject(instance.projectId, deps),
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
