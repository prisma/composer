import { blindCast } from '@internal/foundation/casts';
import {
  encodeState,
  type PersistedState,
  type ReplacedResourceState,
  reviveStateRecursive,
  STATE_STORE_VERSION,
  type StateService,
  type StateStoreError,
} from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { toStateStoreError } from './errors.ts';
import { retryColdStart } from './transient.ts';

const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, StateStoreError, never> =>
  retryColdStart(Effect.tryPromise({ try: f, catch: toStateStoreError }));

/**
 * Wraps an already-`encodeState`d value as a jsonb-typed bind parameter.
 * Must go through `sql.json(...)` (not `JSON.stringify(...)::jsonb`) —
 * postgres.js re-serializes the parameter once it learns the server-inferred
 * type is jsonb, so a pre-stringified value passed through a `::jsonb` cast
 * gets JSON-encoded *twice* and lands as a jsonb string instead of an
 * object. `sql.json` gives postgres.js the raw value up front and declares
 * the jsonb oid itself, so it is serialized exactly once.
 */
const jsonParam = (sql: postgres.Sql, value: unknown): postgres.Parameter =>
  sql.json(
    blindCast<
      postgres.JSONValue,
      'encodeState is typed to return unknown (it recursively walks an arbitrary PersistedState/output value); the result is always a JSON-safe shape by construction, which is what JSONValue describes'
    >(encodeState(value)),
  );

/**
 * `reviveStateRecursive` is typed to return `unknown` — the caller is
 * expected to know the shape it revived. Here the shape is known by
 * construction: every row was written by `set()`, which persists a value
 * through `encodeState` first, so reviving it recovers a `PersistedState`.
 */
const revivePersistedState = (value: unknown): PersistedState =>
  blindCast<
    PersistedState,
    'reviveStateRecursive returns unknown; the row was written by set() through encodeState, so the revived shape is a PersistedState by construction'
  >(reviveStateRecursive(value));

/** Same reasoning as {@link revivePersistedState}, narrowed by the SQL status filter. */
const reviveReplacedResourceState = (value: unknown): ReplacedResourceState =>
  blindCast<
    ReplacedResourceState,
    "filtered to status = 'replaced' in SQL; the row was written by set() through encodeState, so the revived shape is a ReplacedResourceState by construction"
  >(reviveStateRecursive(value));

/**
 * Builds alchemy's `StateService` over a caller-supplied postgres.js client,
 * against the two-table schema `migratePrismaState` creates. The caller owns
 * the client's lifecycle (connection pooling, reconnects, `.end()`); this
 * factory only issues queries.
 */
export const makePrismaStateService = (sql: postgres.Sql): StateService => ({
  id: 'prisma-postgres',

  getVersion: () => Effect.succeed(STATE_STORE_VERSION),

  listStacks: () =>
    attempt(
      () => sql<{ stack: string }[]>`
        select stack from alchemy_resource_state
        union
        select stack from alchemy_stack_output
        order by stack
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => row.stack))),

  listStages: (stack) =>
    attempt(
      () => sql<{ stage: string }[]>`
        select stage from alchemy_resource_state where stack = ${stack}
        union
        select stage from alchemy_stack_output where stack = ${stack}
        order by stage
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => row.stage))),

  get: (request) =>
    attempt(
      () => sql<{ value: unknown }[]>`
        select value from alchemy_resource_state
        where stack = ${request.stack} and stage = ${request.stage} and fqn = ${request.fqn}
      `,
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? undefined : revivePersistedState(row.value);
      }),
    ),

  // Filters by status = 'replaced' directly in SQL rather than listing FQNs
  // and fetching each one (LocalState's approach, which reads a directory
  // then re-reads every file) — same semantics, avoids the N+1.
  getReplacedResources: (request) =>
    attempt(
      () => sql<{ value: unknown }[]>`
        select value from alchemy_resource_state
        where stack = ${request.stack} and stage = ${request.stage}
          and value ->> 'status' = 'replaced'
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => reviveReplacedResourceState(row.value)))),

  set: (request) =>
    attempt(
      () => sql`
        insert into alchemy_resource_state (stack, stage, fqn, value, updated_at)
        values (
          ${request.stack}, ${request.stage}, ${request.fqn},
          ${jsonParam(sql, request.value)}, now()
        )
        on conflict (stack, stage, fqn) do update
          set value = excluded.value, updated_at = excluded.updated_at
      `,
    ).pipe(Effect.map(() => request.value)),

  delete: (request) =>
    attempt(
      () => sql`
        delete from alchemy_resource_state
        where stack = ${request.stack} and stage = ${request.stage} and fqn = ${request.fqn}
      `,
    ).pipe(Effect.asVoid),

  deleteStack: (request) =>
    attempt(async () => {
      if (request.stage === undefined) {
        await sql`delete from alchemy_resource_state where stack = ${request.stack}`;
        await sql`delete from alchemy_stack_output where stack = ${request.stack}`;
      } else {
        await sql`
          delete from alchemy_resource_state
          where stack = ${request.stack} and stage = ${request.stage}
        `;
        await sql`
          delete from alchemy_stack_output
          where stack = ${request.stack} and stage = ${request.stage}
        `;
      }
    }),

  list: (request) =>
    attempt(
      () => sql<{ fqn: string }[]>`
        select fqn from alchemy_resource_state
        where stack = ${request.stack} and stage = ${request.stage}
        order by fqn
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => row.fqn))),

  getOutput: (request) =>
    attempt(
      () => sql<{ value: unknown }[]>`
        select value from alchemy_stack_output
        where stack = ${request.stack} and stage = ${request.stage}
      `,
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? undefined : reviveStateRecursive(row.value);
      }),
    ),

  setOutput: (request) =>
    attempt(
      () => sql`
        insert into alchemy_stack_output (stack, stage, value, updated_at)
        values (${request.stack}, ${request.stage}, ${jsonParam(sql, request.value)}, now())
        on conflict (stack, stage) do update
          set value = excluded.value, updated_at = excluded.updated_at
      `,
    ).pipe(Effect.map(() => request.value)),
});

/**
 * How long a passing lease check is trusted before the next storage
 * operation re-verifies it. A deploy issues many state ops in quick
 * succession, and each raw `checkLive` is a `pg_locks` round-trip; without
 * amortization the guard roughly doubles the store's traffic. The cost of the
 * window is bounded: a lease lost mid-window is detected within this many ms,
 * not instantly — an accepted tradeoff on top of the already-accepted
 * non-atomic (TOCTOU) gap between the check and the operation.
 */
const LEASE_CHECK_TTL_MS = 5_000;

/**
 * Amortizes a lease check over a short TTL: a *passing* check is trusted for
 * `ttlMs`, so a burst of operations inside the window does one round-trip, not
 * one per op. A *failing* check is never cached — it propagates immediately
 * and leaves the last-good timestamp untouched, so the very next op re-checks.
 * The `lastOkAt` state is captured per call, so each store (each layer) gets
 * its own window — two stores in one process never share a cached success.
 */
const amortizeCheck = (
  checkLive: Effect.Effect<void, StateStoreError, never>,
  ttlMs: number,
  now: () => number,
): Effect.Effect<void, StateStoreError, never> => {
  let lastOkAt: number | undefined;
  return Effect.suspend(() => {
    if (lastOkAt !== undefined && now() - lastOkAt < ttlMs) return Effect.void;
    return checkLive.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastOkAt = now();
        }),
      ),
    );
  });
};

/**
 * Wraps a {@link StateService} so every method that touches storage first
 * re-verifies the state lock's lease via `checkLive`. Used to enforce "a
 * dropped lock connection fails loudly" — see {@link ../lock.ts}. The check is
 * amortized over a short TTL (see {@link amortizeCheck}), so a run of
 * back-to-back operations does not fire one `pg_locks` round-trip per call.
 *
 * Reads are gated too, not just writes: a lost lease means a concurrent
 * deploy may already be mutating this stack's rows, so a read could return
 * stale or conflicting data — untrustworthy either way, not just the writes.
 * The check is best-effort and not atomic with the operation it guards (the
 * lease could be lost in the gap between `checkLive` passing and the wrapped
 * call executing, or within the TTL window); that residual race is accepted.
 *
 * `getVersion` is excluded: it returns a compile-time constant
 * (`STATE_STORE_VERSION`), so guarding it would only add a pointless
 * reserved-connection round-trip.
 *
 * `now` is injectable so tests can advance the clock deterministically; it
 * defaults to `Date.now` (fine in library runtime code — only Workflow
 * scripts forbid it).
 */
export const guardStateService = (
  service: StateService,
  checkLive: Effect.Effect<void, StateStoreError, never>,
  now: () => number = Date.now,
): StateService => {
  const guard = amortizeCheck(checkLive, LEASE_CHECK_TTL_MS, now);
  return {
    id: service.id,
    getVersion: () => service.getVersion(),
    listStacks: () => guard.pipe(Effect.andThen(service.listStacks())),
    listStages: (stack) => guard.pipe(Effect.andThen(service.listStages(stack))),
    get: (request) => guard.pipe(Effect.andThen(service.get(request))),
    getReplacedResources: (request) =>
      guard.pipe(Effect.andThen(service.getReplacedResources(request))),
    set: (request) => guard.pipe(Effect.andThen(service.set(request))),
    delete: (request) => guard.pipe(Effect.andThen(service.delete(request))),
    deleteStack: (request) => guard.pipe(Effect.andThen(service.deleteStack(request))),
    list: (request) => guard.pipe(Effect.andThen(service.list(request))),
    getOutput: (request) => guard.pipe(Effect.andThen(service.getOutput(request))),
    setOutput: (request) => guard.pipe(Effect.andThen(service.setOutput(request))),
  };
};
