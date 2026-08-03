import type { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, PrismaApiError } from '../http.ts';
import { toStateStoreError } from './errors.ts';

/**
 * Adopts a stack's legacy deploy state into the branch-id stage scope.
 *
 * Deploys used to run without `--stage`, so Alchemy scoped their rows by its
 * own default (`dev_$USER`/`dev_$USERNAME`/`unknown`), or by the user-facing
 * stage name for flagged stages. Now the stage is always the PDP branch id
 * (TML-3157), so on the first run under the new scope this moves the old
 * rows across instead of silently starting a fresh scope. Each state
 * database is branch-local (ADR-0034), so any other scope holding this
 * stack's rows here IS a prior deploy of this same branch. Local dev never
 * writes here — the dev stack pins `state: localState()`
 * (generate-dev-stack.ts), so no `dev` exclusion is needed.
 *
 * Must run under the (stack, stage) deploy lock and before Alchemy's first
 * state read — `layer.ts` calls it right after lock acquisition.
 *
 * - New scope already has rows → nothing to do (no scan).
 * - No other scope has rows → fresh deploy, nothing to adopt.
 * - Exactly one other scope → transactionally re-stage both tables' rows and
 *   print a one-line notice.
 * - More than one other scope → fail naming every scope; an operator must
 *   decide which one is the live deployment.
 *
 * Returns whether the scope holds rows once adoption is done, so the caller
 * can act on a still-empty scope (see {@link failOnEmptyScopeWithLiveApps})
 * without re-running the occupancy probe.
 */
export const adoptLegacyState = (
  sql: postgres.Sql,
  stack: string,
  stage: string,
): Effect.Effect<{ readonly occupied: boolean }, StateStoreError, never> =>
  Effect.tryPromise({
    try: async () => {
      const occupied = await sql<{ occupied: boolean }[]>`
        select
          exists (select 1 from alchemy_resource_state where stack = ${stack} and stage = ${stage})
          or exists (select 1 from alchemy_stack_output where stack = ${stack} and stage = ${stage})
          as occupied
      `;
      if (occupied[0]?.occupied === true) return { occupied: true };

      const legacy = await sql<{ stage: string }[]>`
        select distinct stage from (
          select stage from alchemy_resource_state where stack = ${stack}
          union
          select stage from alchemy_stack_output where stack = ${stack}
        ) scopes
        where stage <> ${stage}
        order by stage
      `;
      if (legacy.length === 0) return { occupied: false };
      if (legacy.length > 1) {
        throw multipleLegacyScopesError(
          stack,
          stage,
          legacy.map((row) => row.stage),
        );
      }

      const legacyStage = legacy[0]?.stage;
      if (legacyStage === undefined) return { occupied: false };
      await sql.begin(async (tx) => {
        await tx`
          update alchemy_resource_state set stage = ${stage}
          where stack = ${stack} and stage = ${legacyStage}
        `;
        await tx`
          update alchemy_stack_output set stage = ${stage}
          where stack = ${stack} and stage = ${legacyStage}
        `;
      });
      console.error(
        `hosted state: adopted the legacy deploy state scope "${legacyStage}" as "${stage}" for stack "${stack}"`,
      );
      return { occupied: true };
    },
    catch: toStateStoreError,
  });

interface AppSummary {
  readonly id: string;
  readonly name: string;
}

const listAppsOnBranch = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly AppSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const apps: AppSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query =
        cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
      const page = yield* call(() => client.GET('/v1/apps', { params: { query } }));
      apps.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return apps;
  });

/**
 * The residual empty-scope case adoption cannot repair: the scope holds no
 * rows (nothing to adopt, or the state database was lost) while the platform
 * already runs this app's Compute apps on the target Branch. Deploying would
 * recreate every resource and die in a pile of per-resource `already_exists`
 * failures — so fail once, up front, naming the empty scope and what exists.
 * Any app on the Branch is this deploy's: the Project is app-scoped and the
 * Branch is the deploy's own target. A genuinely fresh deploy sees an empty
 * Branch and passes.
 */
export const failOnEmptyScopeWithLiveApps = (
  projectId: string,
  branchId: string,
  stage: string,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const apps = yield* listAppsOnBranch(client, projectId, branchId);
    if (apps.length === 0) return;
    const names = apps.map((app) => `"${app.name}"`).join(', ');
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `the deploy state scope "${stage}" is empty, but the platform already runs ` +
          `${String(apps.length)} app(s) on the target branch ${branchId}: ${names}. With no ` +
          'state, a deploy would recreate every resource and fail with already_exists, and a ' +
          'destroy would remove nothing. Restore the missing deploy state rows, or delete the ' +
          'existing app(s), then retry.',
      }),
    );
  });

function multipleLegacyScopesError(stack: string, stage: string, scopes: readonly string[]): Error {
  const quoted = scopes.map((scope) => `"${scope}"`).join(', ');
  return new Error(
    `the deploy state for stack "${stack}" holds rows under ${String(scopes.length)} scopes ` +
      `(${quoted}) while the current scope "${stage}" is empty — cannot decide which one to ` +
      'adopt. Keep the scope that represents the live deployment and delete the other ' +
      "scopes' rows from alchemy_resource_state and alchemy_stack_output, then redeploy.",
  );
}
