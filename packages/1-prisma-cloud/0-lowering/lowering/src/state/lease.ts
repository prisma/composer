import * as os from 'node:os';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Headers from 'effect/unstable/http/Headers';
import type { ManagementApiClient } from '../client.ts';
import { PrismaApiError } from '../http.ts';

/** The header every state operation and lease call carries. Its value is a capability token — never log it. */
export const LEASE_HEADER = 'Alchemy-State-Lease-Id';

/**
 * Adds the lease header to effect's redacted header names (alongside the
 * defaults such as `authorization`), so a logged failed request renders the
 * lease id as `<redacted>`. Merged into the state layer's outputs.
 */
export const redactLeaseHeader: Layer.Layer<never> = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.gen(function* () {
    const names = yield* Headers.CurrentRedactedNames;
    return [...names, LEASE_HEADER];
  }),
);

const LEASE_PATH = '/v1/projects/{projectId}/branches/{branchId}/alchemy-state/lease';

export interface LeaseScope {
  readonly projectId: string;
  readonly branchId: string;
  readonly stack: string;
  readonly stage: string;
}

export interface DeployLease {
  readonly leaseId: Redacted.Redacted<string>;
  readonly expiresAt: string;
}

/** The server names the current holder in its 409 message; pass it through verbatim, hint appended. */
const serverErrorText = (error: { error: { message: string; hint?: string } }): string =>
  error.error.hint === undefined
    ? error.error.message
    : `${error.error.message} ${error.error.hint}`;

const transportError = (cause: unknown): PrismaApiError =>
  new PrismaApiError({ status: 0, message: String(cause) });

/** Best-effort `user@host`, echoed in the contention error a blocked deploy sees. */
const holderDescription = (): string => {
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    return 'unknown';
  }
};

/**
 * Acquires the (stack, stage) deploy lease. Contention (409) fails fast with
 * the server's message naming the current holder — no queueing, no retry.
 * The server's default TTL (60s) applies; no `ttlSeconds` is sent.
 */
export const acquireDeployLease = (
  client: ManagementApiClient,
  scope: LeaseScope,
): Effect.Effect<DeployLease, PrismaApiError> =>
  Effect.tryPromise({
    try: () =>
      client.POST(LEASE_PATH, {
        params: { path: { projectId: scope.projectId, branchId: scope.branchId } },
        body: {
          stack: scope.stack,
          stage: scope.stage,
          holderDescription: holderDescription(),
        },
      }),
    catch: transportError,
  }).pipe(
    Effect.flatMap((r) => {
      const status = r.response.status;
      if (r.error !== undefined) {
        return Effect.fail(new PrismaApiError({ status, message: serverErrorText(r.error) }));
      }
      if (r.data !== undefined) {
        return Effect.succeed({
          leaseId: Redacted.make(r.data.data.leaseId),
          expiresAt: r.data.data.expiresAt,
        });
      }
      return Effect.fail(
        new PrismaApiError({
          status,
          message: `lease acquisition returned HTTP ${String(status)} with no error body`,
        }),
      );
    }),
  );

/**
 * Extends the lease on a fixed cadence (TTL/3) until interrupted. A 404 means
 * the lease was lost — log one loud warning and stop; enforcement is
 * server-side, so the run's next state operation fails with 409. Any other
 * heartbeat failure is ignored and the next tick retries; the heartbeat never
 * fails the run.
 */
export const heartbeatDeployLease = (
  client: ManagementApiClient,
  scope: LeaseScope,
  lease: DeployLease,
  every: Duration.Input = '20 seconds',
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(every);
      const status = yield* Effect.tryPromise(() =>
        client.PATCH(LEASE_PATH, {
          params: {
            path: { projectId: scope.projectId, branchId: scope.branchId },
            header: { 'alchemy-state-lease-id': Redacted.value(lease.leaseId) },
          },
        }),
      ).pipe(
        Effect.map((r) => r.response.status),
        Effect.catch(() => Effect.succeed(0)),
      );
      if (status === 404) {
        yield* Effect.logWarning(
          `the deploy lease for stage "${scope.stage}" was lost (heartbeat returned 404) — ` +
            'another deploy may have taken over; the next state operation of this run will fail.',
        );
        return;
      }
    }
  });

/**
 * Releases the lease on clean exit. Never fails: a 404 (lease already
 * expired or replaced) or any other failure is logged, not thrown — the run
 * already completed.
 */
export const releaseDeployLease = (
  client: ManagementApiClient,
  scope: LeaseScope,
  lease: DeployLease,
): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    client.DELETE(LEASE_PATH, {
      params: {
        path: { projectId: scope.projectId, branchId: scope.branchId },
        header: { 'alchemy-state-lease-id': Redacted.value(lease.leaseId) },
      },
    }),
  ).pipe(
    Effect.flatMap((r) =>
      r.response.status === 404
        ? Effect.logWarning(
            `releasing the deploy lease for stage "${scope.stage}" returned 404 — ` +
              'it had already expired or been replaced.',
          )
        : Effect.void,
    ),
    Effect.catch((cause) =>
      Effect.logWarning(
        `releasing the deploy lease for stage "${scope.stage}" failed: ${String(cause)}`,
      ),
    ),
  );
