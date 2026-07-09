import type { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { toStateStoreError } from './errors.ts';

/**
 * Idempotent schema migration for the Prisma-hosted state store — safe to run
 * on every deploy, since `create table if not exists` no-ops once the tables
 * exist. Run this against `sql` before serving a {@link StateService} built
 * by `makePrismaStateService` over the same client.
 */
export const migratePrismaState = (
  sql: postgres.Sql,
): Effect.Effect<void, StateStoreError, never> =>
  Effect.tryPromise({
    try: async () => {
      await sql`
        create table if not exists alchemy_resource_state (
          stack text not null,
          stage text not null,
          fqn text not null,
          value jsonb not null,
          updated_at timestamptz not null default now(),
          primary key (stack, stage, fqn)
        )
      `;
      await sql`
        create table if not exists alchemy_stack_output (
          stack text not null,
          stage text not null,
          value jsonb not null,
          updated_at timestamptz not null default now(),
          primary key (stack, stage)
        )
      `;
    },
    catch: toStateStoreError,
  });
