import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import {
  ComputeService,
  ComputeServiceProvider,
  deleteSafeRetrySchedule,
  isDeleteNotSafeYet,
} from '../compute/ComputeService.ts';
import { PrismaApiError } from '../http.ts';

const deleteNotSafeError = new PrismaApiError({
  status: 409,
  message: JSON.stringify({
    error: {
      code: 'client-error',
      message: 'The deployment did not reach a delete-safe state after stop',
      hint: 'The resource already exists or is in a conflicting state.',
    },
  }),
});

describe('isDeleteNotSafeYet', () => {
  test('classifies the delete-safe-after-stop error as retryable', () => {
    expect(isDeleteNotSafeYet(deleteNotSafeError)).toBe(true);
  });

  test('does not classify an unrelated API error as retryable', () => {
    const unauthorized = new PrismaApiError({ status: 401, message: '{"error":"unauthorized"}' });
    const notFound = new PrismaApiError({ status: 404, message: '{"error":"not found"}' });
    const serverError = new PrismaApiError({ status: 500, message: '{"error":"internal error"}' });

    expect(isDeleteNotSafeYet(unauthorized)).toBe(false);
    expect(isDeleteNotSafeYet(notFound)).toBe(false);
    expect(isDeleteNotSafeYet(serverError)).toBe(false);
  });
});

describe('delete retry wiring (Effect.retry({ schedule, while }))', () => {
  // Exercises the same `{ schedule, while: isDeleteNotSafeYet }` composition
  // ComputeService's delete uses, swapping in a millisecond-scale schedule so
  // the test doesn't wait on the real 2s-to-5min production backoff.
  const fastSchedule = Schedule.spaced('1 millis');

  test('retries a delete-not-safe-yet failure until it succeeds', async () => {
    let attempts = 0;
    const flaky = Effect.gen(function* () {
      attempts++;
      if (attempts < 3) return yield* Effect.fail(deleteNotSafeError);
      return 'deleted';
    });

    const result = await Effect.runPromise(
      flaky.pipe(Effect.retry({ schedule: fastSchedule, while: isDeleteNotSafeYet })),
    );

    expect(result).toBe('deleted');
    expect(attempts).toBe(3);
  });

  test('does not retry a different error — it fails on the first attempt', async () => {
    let attempts = 0;
    const alwaysUnauthorized = Effect.gen(function* () {
      attempts++;
      return yield* Effect.fail(
        new PrismaApiError({ status: 401, message: '{"error":"unauthorized"}' }),
      );
    });

    const outcome = await Effect.runPromiseExit(
      alwaysUnauthorized.pipe(Effect.retry({ schedule: fastSchedule, while: isDeleteNotSafeYet })),
    );

    expect(outcome._tag).toBe('Failure');
    expect(attempts).toBe(1);
  });

  test('gives up once the delete-safe error persists past the overall timeout', async () => {
    // A near-zero overall cap makes the "generous timeout" boundary itself
    // fast to test: it should retry a couple of times and then still fail.
    let attempts = 0;
    const alwaysNotSafe = Effect.gen(function* () {
      attempts++;
      return yield* Effect.fail(deleteNotSafeError);
    });

    const shortCappedSchedule = Schedule.both(
      Schedule.spaced('1 millis'),
      Schedule.during('20 millis'),
    );

    const outcome = await Effect.runPromiseExit(
      alwaysNotSafe.pipe(
        Effect.retry({ schedule: shortCappedSchedule, while: isDeleteNotSafeYet }),
      ),
    );

    expect(outcome._tag).toBe('Failure');
    expect(attempts).toBeGreaterThan(1);
  });
});

describe('deleteSafeRetrySchedule', () => {
  test('is a Schedule value wired into the delete provider', () => {
    expect(Schedule.isSchedule(deleteSafeRetrySchedule)).toBe(true);
  });
});

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
  /** When set, GET /v1/compute-services/{computeServiceId} resolves to this — the observed path. */
  observed?: { id: string; name: string; serviceEndpointDomain?: string };
}

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

const notFoundResponse = () => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status: 404 }),
});

/**
 * A stubbed `ManagementApiClient` covering the ComputeService provider's
 * endpoints (GET/POST for observe-or-create; PATCH is stubbed but should
 * never be hit — reconcile no longer PATCHes), recording every call it
 * receives — the container.test.ts fake-client idiom. `as unknown as
 * ManagementApiClient` is acceptable here (test file — exempt from the
 * no-bare-cast rule).
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string) => {
    state.calls.push({ method: 'GET', path });
    if (path === '/v1/compute-services/{computeServiceId}') {
      return Promise.resolve(
        state.observed ? okResponse({ data: state.observed }) : notFoundResponse(),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'POST', path, body: init.body });
    if (path === '/v1/projects/{projectId}/compute-services') {
      return Promise.resolve(
        okResponse({ data: { id: 'cs-created', name: String(init.body?.['displayName']) } }, 201),
      );
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const PATCH = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'PATCH', path, body: init.body });
    if (path === '/v1/compute-services/{computeServiceId}') {
      return Promise.resolve(okResponse({ data: { id: 'cs-created', name: 'compute' } }));
    }
    throw new Error(`fakeClient: unexpected PATCH ${path}`);
  };

  return { GET, POST, PATCH } as unknown as ManagementApiClient;
};

const getService = (state: FakeState) =>
  Effect.runPromise(
    ComputeService.Provider.pipe(
      Effect.provide(ComputeServiceProvider()),
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

const reconcile = async (
  state: FakeState,
  input: { news: Record<string, unknown>; output?: { id: string; name: string } | undefined },
) => {
  const svc = await getService(state);
  return Effect.runPromise(svc.reconcile(input as unknown as Parameters<typeof svc.reconcile>[0]));
};

describe('ComputeService reconcile — Branch via the create body', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { calls: [] };
  });

  test('branchId set, no prior output: creates on the Branch, no PATCH', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'compute', branchId: 'br-1' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'cs-created', name: 'compute' });
    expect(state.calls.map((c) => c.method)).toEqual(['POST']);
    expect(state.calls[0]?.body).toEqual({ displayName: 'compute', branchId: 'br-1' });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('branchId set, prior output exists: observes only, no POST, no PATCH', async () => {
    state.observed = { id: 'cs-existing', name: 'compute' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'compute', branchId: 'br-1' },
      output: { id: 'cs-existing', name: 'compute' },
    });

    expect(result).toEqual({ id: 'cs-existing', name: 'compute' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET']);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('branchId unset, no prior output: creates without a branchId key, no PATCH', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'compute' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'cs-created', name: 'compute' });
    expect(state.calls.map((c) => c.method)).toEqual(['POST']);
    expect(state.calls[0]?.body).toEqual({ displayName: 'compute' });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('branchId unset, prior output exists: observes only, no POST, no PATCH', async () => {
    state.observed = { id: 'cs-existing', name: 'compute' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'compute' },
      output: { id: 'cs-existing', name: 'compute' },
    });

    expect(result).toEqual({ id: 'cs-existing', name: 'compute' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET']);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});
