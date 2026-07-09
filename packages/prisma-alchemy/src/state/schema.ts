// TODO: replace with Prisma Next (deferred — see .drive/projects/authoring-layer/slices/r8-hosted-state-store/pn-adoption-design-note.md)

import type { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { toStateStoreError } from './errors.ts';

/**
 * The well-known marker row written into every database this store owns.
 * Its presence proves the database is genuinely MakerKit's state store, not
 * a same-named project squatting on the discovery query (see `bootstrap.ts`
 * `verifyOwnership` — PDP allows duplicate project names).
 */
export const STATE_META_MARKER = 'makerkit-state-v1';

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
      await sql`
        create table if not exists makerkit_state_meta (
          marker text primary key,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        insert into makerkit_state_meta (marker) values (${STATE_META_MARKER})
        on conflict (marker) do nothing
      `;
    },
    catch: toStateStoreError,
  });
