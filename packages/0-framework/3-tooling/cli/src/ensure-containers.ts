/**
 * Pipeline pre-stack step: resolves the app's Project + (named stage) Branch
 * via `@internal/lowering`'s `resolveContainer`, before the generated stack file
 * runs — `deploy` creates-if-absent, `destroy` finds only.
 */
import { spawnSync } from 'node:child_process';
import {
  deleteBranch,
  deleteProject,
  fromEnv,
  type ManagementApiClient,
  ManagementClient,
  managementClientLayer,
  type ResolvedContainer,
  resolveContainer,
} from '@internal/lowering';
import { deleteStateDatabase } from '@internal/lowering/state';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { CliError } from './cli-error.ts';

/** Validates `stage` as a git ref name via `git check-ref-format` — no silent normalization. */
export function validateStageName(stage: string): void {
  const result = spawnSync('git', ['check-ref-format', `refs/heads/${stage}`], {
    stdio: 'ignore',
  });
  if (result.error) {
    throw new CliError(
      `git is required to validate --stage "${stage}" (git check-ref-format): ${result.error.message}.`,
    );
  }
  if (result.status !== 0) {
    throw new CliError(
      `Invalid --stage "${stage}": must be a valid git ref name (git check-ref-format rejected "refs/heads/${stage}").`,
    );
  }
}

export interface EnsureContainersInput {
  readonly command: 'deploy' | 'destroy';
  readonly appName: string;
  readonly stage: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export async function ensureContainers(
  input: EnsureContainersInput,
  deps?: { readonly client?: ManagementApiClient },
): Promise<ResolvedContainer> {
  const env = input.env ?? process.env;
  const workspaceId = env['PRISMA_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new CliError('environment variable PRISMA_WORKSPACE_ID is required.');
  }
  if (deps?.client === undefined && (env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    throw new CliError('environment variable PRISMA_SERVICE_TOKEN is required.');
  }
  if (input.stage !== undefined) validateStageName(input.stage);

  // All typed failures are caught and carried as a failure *value*, so
  // runPromise only rejects on a genuine defect.
  const program = resolveContainer({
    workspaceId,
    appName: input.appName,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ensure: input.command === 'deploy',
  }).pipe(
    Effect.map((c) => ({ ok: true as const, container: c })),
    Effect.catchTag('ContainerNotFoundError', (e) =>
      Effect.succeed({
        ok: false as const,
        message: `Nothing deployed for ${e.appName}${e.stage ? `/${e.stage}` : ''} — deploy it first.`,
      }),
    ),
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
  if (!outcome.ok) throw new CliError(outcome.message);
  return outcome.container;
}

/**
 * Removes the stage's deploy-state database after a successful `alchemy
 * destroy` (ADR-0033). Runs before the Branch/Project delete: alchemy reads
 * state to know what to remove, so the store must outlive every resource it
 * describes, and the Branch delete is refused while the database is still a
 * live member.
 */
export async function deleteStageStateDatabase(
  input: {
    readonly projectId: string;
    readonly branchId?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
  deps?: { readonly client?: ManagementApiClient },
): Promise<void> {
  const env = input.env ?? process.env;
  if (deps?.client === undefined && (env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    throw new CliError('environment variable PRISMA_SERVICE_TOKEN is required.');
  }
  const program = deleteStateDatabase({
    projectId: input.projectId,
    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
  }).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) =>
      Effect.succeed({
        ok: false as const,
        message: `Failed to delete the deploy-state database: ${e.message}.`,
      }),
    ),
  );
  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));
  const outcome = await Effect.runPromise(provided);
  if (!outcome.ok) throw new CliError(outcome.message);
}

/**
 * Soft-deletes a named stage's Branch after a successful `alchemy destroy`
 * has removed its members (spec §10) — the Management API refuses to delete
 * a Branch that still has live members.
 */
export async function deleteStageBranch(
  input: { readonly branchId: string; readonly env?: NodeJS.ProcessEnv },
  deps?: { readonly client?: ManagementApiClient },
): Promise<void> {
  const env = input.env ?? process.env;
  if (deps?.client === undefined && (env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    throw new CliError('environment variable PRISMA_SERVICE_TOKEN is required.');
  }
  const program = deleteBranch(input.branchId).pipe(
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
  if (!outcome.ok) throw new CliError(outcome.message);
}

/**
 * Best-effort cleanup after a successful `--production` destroy: removes
 * the app's Project so hand-run stacks don't accumulate as empty Projects
 * (they eventually hit the workspace's plan limit). Unlike `deleteStageBranch`,
 * this never throws: the destroy itself already succeeded, and the API's own
 * 400 ("still has dependencies") is the only check that matters — failing
 * the command over a cleanup step would be worse than leaving a Project shell.
 */
export async function deleteAppProject(
  input: { readonly projectId: string; readonly env?: NodeJS.ProcessEnv },
  deps?: { readonly client?: ManagementApiClient },
): Promise<void> {
  const env = input.env ?? process.env;
  if (deps?.client === undefined && (env['PRISMA_SERVICE_TOKEN'] ?? '').length === 0) {
    console.warn(
      `Skipped removing the Project (${input.projectId}): PRISMA_SERVICE_TOKEN is not set.`,
    );
    return;
  }
  const program = deleteProject(input.projectId).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag('PrismaApiError', (e) => Effect.succeed({ ok: false as const, error: e })),
  );
  const provided =
    deps?.client !== undefined
      ? program.pipe(Effect.provideService(ManagementClient, deps.client))
      : program.pipe(Effect.provide(managementClientLayer().pipe(Layer.provide(fromEnv()))));

  const outcome = await Effect.runPromise(provided);
  if (outcome.ok) {
    console.log(`Removed the Project (${input.projectId}) — nothing was left in it.`);
    return;
  }
  if (outcome.error.status === 400) {
    console.log(`Kept the Project (${input.projectId}) — it still has another stage's resources.`);
    return;
  }
  console.warn(
    `Could not remove the Project (${input.projectId}) after destroy: ${outcome.error.message}.`,
  );
}
