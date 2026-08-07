import { blindCast } from '@internal/foundation/casts';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid } from '../http.ts';

export type EnvironmentClass = 'production' | 'preview';

export interface EnvironmentVariableProps {
  /** The project this variable belongs to. */
  projectId: string;
  /** Variable name, e.g. `AUTH_URL`. */
  key: string;
  /** Variable value. Stored encrypted; not readable back. */
  value: string;
  /** Which environment the value applies to. Defaults to `production`. */
  class?: EnvironmentClass;
  /** Set only for a preview-branch override. */
  branchId?: string;
}

export interface EnvironmentVariableAttributes {
  id: string;
  key: string;
}

export type EnvironmentVariable = Resource<
  'Prisma.EnvironmentVariable',
  EnvironmentVariableProps,
  EnvironmentVariableAttributes
>;

/**
 * A project-scoped **environment variable** that Compute injects into the
 * project's services from their attached branch (e.g. wiring one module's URL into
 * another).
 */
export const EnvironmentVariable = Resource<EnvironmentVariable>('Prisma.EnvironmentVariable');

export const EnvironmentVariableProvider = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id'],
        list: () => Effect.succeed<EnvironmentVariableAttributes[]>([]),
        reconcile: Effect.fn(function* ({ news, output }) {
          const cls = news.class ?? 'production';
          // Value is write-only, so we PATCH, never diff. Adopt our own prior
          // row (output.id), or a pre-existing poison-key row (DATABASE_URL(_POOLED),
          // platform-seeded). Any other untracked match is a COMPOSER_ collision we
          // refuse to overwrite (see the throw below).
          let id = output?.id;
          if (id !== undefined) {
            const priorId = id;
            const mine = yield* callOptional(() =>
              client.GET('/v1/environment-variables/{envVarId}', {
                params: { path: { envVarId: priorId } },
              }),
            );
            if (!mine) id = undefined;
          }
          if (id === undefined) {
            const match = yield* call(() =>
              client.GET('/v1/environment-variables', {
                params: {
                  query: blindCast<
                    never,
                    'openapi-fetch types this list query as never (an SDK path/operation mismatch); the endpoint accepts projectId/class/key/branchId'
                  >({
                    projectId: news.projectId,
                    class: cls,
                    key: news.key,
                    ...(news.branchId !== undefined ? { branchId: news.branchId } : {}),
                  }),
                },
              }),
            );
            // The platform keys rows on (project, branch, class, key), so only a
            // row in the exact scope this deploy writes — same branch, or the
            // project scope when branchId is unset — is a collision. A sibling
            // preview branch's row or a project-level preview template legally
            // coexists with the row this deploy is about to create. The query
            // above narrows server-side by branchId; the comparison here also
            // excludes template rows ("branchId is null" is not expressible as a
            // query filter).
            const rows = blindCast<
              { data?: readonly { id: string; branchId?: string | null }[] },
              'the query-never workaround defeats response inference; project the list response to the fields reconcile reads'
            >(match).data;
            const matchId = rows?.find(
              (row) => (row.branchId ?? null) === (news.branchId ?? null),
            )?.id;
            if (matchId !== undefined) {
              const isPoison = news.key === 'DATABASE_URL' || news.key === 'DATABASE_URL_POOLED';
              if (!isPoison) {
                const scope =
                  news.branchId !== undefined
                    ? `class "${cls}", branch "${news.branchId}"`
                    : `class "${cls}"`;
                throw new Error(
                  `EnvironmentVariable "${news.key}" (project "${news.projectId}", ${scope}) ` +
                    'exists but is untracked in this deploy state — refusing to overwrite a reserved ' +
                    "COMPOSER_ key. Restore this deploy's hosted state, or remove the variable to let " +
                    'this deploy recreate it.',
                );
              }
              id = matchId;
            }
          }
          if (id !== undefined) {
            const targetId = id;
            yield* call(() =>
              client.PATCH('/v1/environment-variables/{envVarId}', {
                params: { path: { envVarId: targetId } },
                body: { value: news.value },
              }),
            );
            return { id, key: news.key };
          }

          const created = yield* call(() =>
            client.POST('/v1/environment-variables', {
              body: {
                projectId: news.projectId,
                class: cls,
                key: news.key,
                value: news.value,
                ...(news.branchId ? { branchId: news.branchId } : {}),
              },
            }),
          );
          return { id: created.data.id, key: created.data.key };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* callVoid(() =>
            client.DELETE('/v1/environment-variables/{envVarId}', {
              params: { path: { envVarId: output.id } },
            }),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const v = yield* callOptional(() =>
            client.GET('/v1/environment-variables/{envVarId}', {
              params: { path: { envVarId: output.id } },
            }),
          );
          return v ? { id: v.data.id, key: v.data.key } : undefined;
        }),
      };
    }),
  );
