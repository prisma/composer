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
 * project's services from their attached branch (e.g. wiring one hex's URL into
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
          // The value is write-only (stored encrypted), so it can't be diffed.
          // If we already created this variable, PATCH the value to match `news`;
          // otherwise create it.
          if (output?.id) {
            const existing = yield* callOptional(() =>
              client.GET('/v1/environment-variables/{envVarId}', {
                params: { path: { envVarId: output.id } },
              }),
            );
            if (existing) {
              yield* call(() =>
                client.PATCH('/v1/environment-variables/{envVarId}', {
                  params: { path: { envVarId: output.id } },
                  body: { value: news.value },
                }),
              );
              return { id: existing.data.id, key: existing.data.key };
            }
          }

          const created = yield* call(() =>
            client.POST('/v1/environment-variables', {
              body: {
                projectId: news.projectId,
                class: news.class ?? 'production',
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
