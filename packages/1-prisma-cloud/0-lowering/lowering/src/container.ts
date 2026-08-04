import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { call, callVoid, PrismaApiError } from './http.ts';
import { collectPages, drivePages } from './pagination.ts';

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
  /** Set only when `stage` was omitted — the project's default Branch's id (a read; the Branch is never created here). */
  readonly defaultBranchId?: string;
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
  collectPages('projects', (cursor) =>
    call(() =>
      client.GET('/v1/projects', {
        params: { query: cursor === undefined ? {} : { cursor } },
      }),
    ),
  );

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

    // createDatabase: false — the platform default database is never used
    // (composer poisons DATABASE_URL at provision), so don't create it. The
    // API 403s this for user actors, but deploys authenticate as workspace
    // actors (service tokens), which are allowed.
    const created = yield* call(() =>
      client.POST('/v1/projects', { body: { name: appName, workspaceId, createDatabase: false } }),
    );
    return created.data.id;
  });

/**
 * The project's implicit default Branch — every live Project owns exactly
 * one (a platform invariant). The list endpoint has no `isDefault` filter,
 * so this pages through the Branches (bounded — drivePages) and returns as
 * soon as a page contains it. Never creates one: its absence means the
 * platform's invariant is broken, which is not something a deploy can
 * repair.
 */
export const resolveDefaultBranchId = (
  client: ManagementApiClient,
  projectId: string,
): Effect.Effect<string, PrismaApiError> =>
  Effect.gen(function* () {
    let found: string | undefined;
    yield* drivePages(
      `branches of project ${projectId}`,
      (cursor) =>
        call(() =>
          client.GET('/v1/projects/{projectId}/branches', {
            params: { path: { projectId }, query: cursor === undefined ? {} : { cursor } },
          }),
        ),
      (data) => {
        found = data.find((b) => b.isDefault)?.id;
        return found !== undefined;
      },
    );
    if (found !== undefined) return found;
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message: `project ${projectId} has no default Branch — the platform guarantees every live Project owns one; contact support.`,
      }),
    );
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
 * (no `stage`) creates no Branch; `branchId` is omitted, and the project's
 * default Branch's id is read into `defaultBranchId` instead. With `ensure:
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
    if (opts.stage === undefined) {
      const defaultBranchId = yield* resolveDefaultBranchId(client, projectId);
      return { projectId, defaultBranchId };
    }

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

/**
 * Deletes a Project. Tolerates a 404 (already gone). The API refuses with a
 * 400 if the Project still has live dependencies (e.g. another stage's
 * Branch/resources) — that surfaces as a `PrismaApiError`.
 */
export const deleteProject = (
  projectId: string,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    yield* callVoid(() =>
      client.DELETE('/v1/projects/{id}', { params: { path: { id: projectId } } }),
    );
  });
