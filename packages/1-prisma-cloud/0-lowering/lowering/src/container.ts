import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { call, callVoid, type PrismaApiError } from './http.ts';

export interface ResolveContainerOptions {
  /** The workspace to resolve the Project in. */
  readonly workspaceId: string;
  /** The app's name — the root `module("<name>", …)` name, or `--name`. */
  readonly appName: string;
  /** A named stage (e.g. `staging`); omit for the default (production) stage. */
  readonly stage?: string;
  /** Create the Project/Branch if absent (default `true`). `false` finds only — used by `destroy`. */
  readonly ensure?: boolean;
}

/** Raised with `ensure: false` when the app's Project (or a named stage's Branch) doesn't exist. */
export class ContainerNotFoundError extends Data.TaggedError('ContainerNotFoundError')<{
  readonly appName: string;
  readonly stage?: string;
}> {}

export interface ResolvedContainer {
  readonly projectId: string;
  /** Set only when `stage` was given — the default stage has no Branch. */
  readonly branchId?: string;
}

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly workspace: { readonly id: string };
}

const listAllProjects = (
  client: ManagementApiClient,
): Effect.Effect<readonly ProjectSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const projects: ProjectSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? {} : { cursor };
      const page = yield* call(() => client.GET('/v1/projects', { params: { query } }));
      projects.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return projects;
  });

/**
 * Workspace ids circulate in two shapes: `wksp_`-prefixed and bare. Compare
 * bare-to-bare so a `wksp_`-prefixed API id still matches a bare configured
 * one (the same normalization `state/bootstrap.ts` applies to the same
 * `/v1/projects` listing).
 */
const bareWorkspaceId = (id: string): string =>
  id.startsWith('wksp_') ? id.slice('wksp_'.length) : id;

/**
 * Finds the app's Project by name in the workspace — PDP allows duplicate
 * project names, so more than one can match; the oldest wins. Creates one
 * if none match, unless `ensure` is `false` (find-only — `destroy`), in
 * which case an absent Project fails with `ContainerNotFoundError`. No
 * ownership marker and no `--project` override (both deferred — see
 * ADR-0019).
 */
const resolveProject = (
  client: ManagementApiClient,
  workspaceId: string,
  appName: string,
  ensure: boolean,
): Effect.Effect<string, PrismaApiError | ContainerNotFoundError> =>
  Effect.gen(function* () {
    const projects = yield* listAllProjects(client);
    const oldest = projects
      .filter(
        (p) =>
          bareWorkspaceId(p.workspace.id) === bareWorkspaceId(workspaceId) && p.name === appName,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest !== undefined) return oldest.id;

    if (!ensure) return yield* Effect.fail(new ContainerNotFoundError({ appName }));

    const created = yield* call(() =>
      client.POST('/v1/projects', { body: { name: appName, workspaceId } }),
    );
    return created.data.id;
  });

const findBranchId = (
  client: ManagementApiClient,
  projectId: string,
  gitName: string,
): Effect.Effect<string | undefined, PrismaApiError> =>
  call(() =>
    client.GET('/v1/projects/{projectId}/branches', {
      params: { path: { projectId }, query: { gitName } },
    }),
  ).pipe(Effect.map((page) => page.data[0]?.id));

/**
 * Finds the stage's Branch by its exact `gitName`, creating it if absent
 * unless `ensure` is `false` (find-only — `destroy`), in which case an
 * absent Branch fails with `ContainerNotFoundError`. The Management API has
 * no server-side "create-or-return" idempotency (`POST
 * /v1/projects/:id/branches` 409s on a duplicate `gitName`, with no request
 * field to make that a no-op), so idempotency is client-side: observe
 * first, and on a racing 409 from create, re-observe rather than fail.
 */
const resolveBranch = (
  client: ManagementApiClient,
  projectId: string,
  gitName: string,
  appName: string,
  ensure: boolean,
): Effect.Effect<string, PrismaApiError | ContainerNotFoundError> =>
  Effect.gen(function* () {
    const existing = yield* findBranchId(client, projectId, gitName);
    if (existing !== undefined) return existing;

    if (!ensure) {
      return yield* Effect.fail(new ContainerNotFoundError({ appName, stage: gitName }));
    }

    return yield* call(() =>
      client.POST('/v1/projects/{projectId}/branches', {
        params: { path: { projectId } },
        body: { gitName },
      }),
    ).pipe(
      Effect.map((r) => r.data.id),
      Effect.catch((err) =>
        err.status === 409
          ? findBranchId(client, projectId, gitName).pipe(
              Effect.flatMap((id) => (id === undefined ? Effect.fail(err) : Effect.succeed(id))),
            )
          : Effect.fail(err),
      ),
    );
  });

/**
 * Resolves the two containers a stage's deploy runs into (ADR-0019): the
 * app's **Project**, found-or-created by name, and — for a named stage
 * only — its **Branch**, found-or-created by `gitName`. The default stage
 * (no `stage`) creates no Branch; `branchId` is omitted. With `ensure:
 * false` (`destroy`), nothing is created — an absent Project or Branch
 * fails with `ContainerNotFoundError` instead.
 */
export const resolveContainer = (
  opts: ResolveContainerOptions,
): Effect.Effect<ResolvedContainer, PrismaApiError | ContainerNotFoundError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const ensure = opts.ensure ?? true;
    const projectId = yield* resolveProject(client, opts.workspaceId, opts.appName, ensure);
    if (opts.stage === undefined) return { projectId };

    const branchId = yield* resolveBranch(client, projectId, opts.stage, opts.appName, ensure);
    return { projectId, branchId };
  });

/**
 * Soft-deletes a Branch. Tolerates a 404 (already gone). The API refuses if
 * the Branch still has live members or is the production/default Branch —
 * that surfaces as a `PrismaApiError`.
 */
export const deleteBranch = (
  branchId: string,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    yield* callVoid(() =>
      client.DELETE('/v1/branches/{branchId}', { params: { path: { branchId } } }),
    );
  });
