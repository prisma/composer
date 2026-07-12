import { Stack, type StackServices } from 'alchemy';
import { State } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import postgres from 'postgres';
import * as client from '../client.ts';
import * as credentials from '../credentials.ts';
import { bootstrapStateConnection } from './bootstrap.ts';
import { hostedStateBootstrapError } from './errors.ts';
import { acquireStateLock } from './lock.ts';
import { migratePrismaState } from './schema.ts';
import { guardStateService, makePrismaStateService } from './service.ts';

/**
 * The hosted Alchemy state store. On layer init (scoped, once per stack
 * run): find-or-create the workspace's `prisma-compose-state` project, mint a
 * fresh connection to its default database, migrate the schema, and
 * acquire the (stack, stage) advisory lock — see `bootstrap.ts` and
 * `lock.ts`. The Management API plumbing (`ManagementClient`,
 * `PrismaCredentials`) is provided internally, so the returned layer's
 * only requirements are the ones alchemy itself already provides to every
 * state store (`StackServices`).
 *
 * Any bootstrap/lock/migration failure is wrapped into an operator-facing
 * `HostedStateBootstrapError` (naming the workspace and the step that
 * failed, never the raw driver/API error — see `errors.ts`) before dying the
 * layer (loud, immediate, unrecoverable) rather than surfacing as a typed
 * error — matching core's `LowerOptions.state: Layer.Layer<State, never,
 * StackServices>` contract and alchemy's own convention (e.g. a missing
 * state store is `Effect.die` in `Stack.make`).
 */
export const prismaState = (
  opts: {
    /** Defaults to the PRISMA_WORKSPACE_ID environment variable. */
    workspaceId?: string;
  } = {},
): Layer.Layer<State, never, StackServices> => {
  const workspaceId = opts.workspaceId ?? process.env['PRISMA_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new Error('prismaState(): environment variable PRISMA_WORKSPACE_ID is required.');
  }
  return Layer.effect(
    State,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const bootstrapError = (step: string) => (cause: unknown) =>
        hostedStateBootstrapError(workspaceId, step, cause);

      const { connectionString } = yield* bootstrapStateConnection(workspaceId).pipe(
        Effect.provide(client.layer().pipe(Layer.provide(credentials.fromEnv()))),
        Effect.mapError(bootstrapError('finding/creating the prisma-compose-state project')),
      );

      // The pool reconnects on demand for ordinary (non-reserved) queries —
      // postgres.js's default behaviour — which is what absorbs PPg closing
      // idle direct connections (FT-5219 class) for the store's CRUD calls.
      // The lock's reserved connection is deliberately exempt from this: see
      // `lock.ts`'s `checkLive`.
      const sql = postgres(Redacted.value(connectionString), {
        max: 5,
        onnotice: () => {},
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => sql.end({ timeout: 5 })));

      // The migration is the pool's first query, i.e. the first actual
      // connect. A freshly provisioned database (first-ever bootstrap in a
      // workspace) can refuse connections for a while after the Management
      // API returns it, so retry the window out before failing.
      yield* migratePrismaState(sql).pipe(
        Effect.retry(Schedule.both(Schedule.spaced('5 seconds'), Schedule.during('2 minutes'))),
        Effect.mapError(bootstrapError('schema migration')),
      );

      const lock = yield* acquireStateLock(sql, stack.name, stack.stage).pipe(
        Effect.mapError(bootstrapError('lock acquisition')),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => lock.release()));

      const service = guardStateService(makePrismaStateService(sql), lock.checkLive);

      return Effect.succeed(service);
    }),
  ).pipe(Layer.orDie);
};
