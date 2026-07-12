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
        list: () => Effect.succeed([] as EnvironmentVariableAttributes[]),
        reconcile: Effect.fn(function* ({ news, output }) {
          const cls = news.class ?? 'production';
          // The value is write-only (encrypted), so we never diff it — we PATCH.
          // Find the row to write, adopting in order: our own prior row
          // (output.id), then a pre-existing row at the same (project, class,
          // key). The platform seeds DATABASE_URL/_POOLED at project creation,
          // which Prisma App poisons — a duplicate POST 409s and the API directs
          // callers to PATCH. Adopting also makes create idempotent.
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
                  query: { projectId: news.projectId, class: cls, key: news.key } as never,
                },
              }),
            );
            id = (match as { data?: Array<{ id: string }> }).data?.[0]?.id;
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
