import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { Bucket, BucketProvider } from '../buckets/Bucket.ts';
import { type ManagementApiClient, ManagementClient } from '../client.ts';

interface RecordedCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
  /** When set, GET /v1/buckets/{bucketId} resolves to this — the observed path. */
  observed?: { id: string; name: string };
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
 * A stubbed `ManagementApiClient` covering only the Bucket provider's
 * endpoints, recording every call it receives — the Database.test.ts pattern.
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string) => {
    state.calls.push({ method: 'GET', path });
    if (path === '/v1/buckets/{bucketId}') {
      return Promise.resolve(
        state.observed ? okResponse({ data: state.observed }) : notFoundResponse(),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'POST', path, body: init.body });
    if (path === '/v1/buckets') {
      return Promise.resolve(
        okResponse({ data: { id: 'bucket-created', name: String(init.body?.['name']) } }, 201),
      );
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const DELETE = (path: string) => {
    state.calls.push({ method: 'DELETE', path });
    if (path === '/v1/buckets/{bucketId}') {
      return Promise.resolve({
        data: undefined,
        error: undefined,
        response: new Response(null, { status: 204 }),
      });
    }
    throw new Error(`fakeClient: unexpected DELETE ${path}`);
  };

  return { GET, POST, DELETE } as unknown as ManagementApiClient;
};

const getService = (state: FakeState) =>
  Effect.runPromise(
    Bucket.Provider.pipe(
      Effect.provide(BucketProvider()),
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

describe('Bucket reconcile', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { calls: [] };
  });

  test('no prior output: creates the bucket with projectId, name, and optional branchId', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'files', branchId: 'br-1' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'bucket-created', name: 'files' });
    expect(state.calls.map((c) => c.method)).toEqual(['POST']);
    expect(state.calls[0]?.body).toEqual({ projectId: 'proj-1', name: 'files', branchId: 'br-1' });
  });

  test('no branchId: creates the bucket without branchId in the body', async () => {
    await reconcile(state, {
      news: { projectId: 'proj-1', name: 'files' },
      output: undefined,
    });

    expect(state.calls[0]?.body).toEqual({ projectId: 'proj-1', name: 'files' });
    expect(Object.keys(state.calls[0]?.body as Record<string, unknown>)).not.toContain('branchId');
  });

  test('prior output exists and observed via GET: skips creation', async () => {
    state.observed = { id: 'bucket-existing', name: 'files' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'files' },
      output: { id: 'bucket-existing', name: 'files' },
    });

    expect(result).toEqual({ id: 'bucket-existing', name: 'files' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET']);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('prior output exists but GET returns 404: creates a new bucket', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'files' },
      output: { id: 'bucket-gone', name: 'files' },
    });

    expect(result).toEqual({ id: 'bucket-created', name: 'files' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });
});
