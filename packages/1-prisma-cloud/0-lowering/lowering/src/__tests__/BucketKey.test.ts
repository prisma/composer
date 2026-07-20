import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { BucketKey, type BucketKeyAttributes, BucketKeyProvider } from '../buckets/BucketKey.ts';
import { type ManagementApiClient, ManagementClient } from '../client.ts';

interface RecordedCall {
  method: 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
}

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

/** The full reveal-once response the API returns at creation. */
const createdKeyResponse = {
  id: 'key-created',
  type: 'bucketKey' as const,
  name: 'files',
  valueHint: 'AKIA****',
  role: 'read_write' as const,
  createdAt: '2025-01-01T00:00:00Z',
  secretAccessKey: 'super-secret-value',
  accessKeyId: 'AKIA123',
  endpoint: 'https://t3.storage.dev',
  bucketName: 'user-abc123',
};

const fakeClient = (state: FakeState): ManagementApiClient => {
  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'POST', path, body: init.body });
    if (path === '/v1/buckets/{bucketId}/keys') {
      return Promise.resolve(okResponse({ data: createdKeyResponse }, 201));
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const DELETE = (path: string) => {
    state.calls.push({ method: 'DELETE', path });
    if (path === '/v1/buckets/{bucketId}/keys/{keyId}') {
      return Promise.resolve({
        data: undefined,
        error: undefined,
        response: new Response(null, { status: 204 }),
      });
    }
    throw new Error(`fakeClient: unexpected DELETE ${path}`);
  };

  return { POST, DELETE } as unknown as ManagementApiClient;
};

const getService = (state: FakeState) =>
  Effect.runPromise(
    BucketKey.Provider.pipe(
      Effect.provide(BucketKeyProvider()),
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

const reconcile = async (
  state: FakeState,
  input: { news: Record<string, unknown>; output?: BucketKeyAttributes | undefined },
) => {
  const svc = await getService(state);
  return Effect.runPromise(svc.reconcile(input as unknown as Parameters<typeof svc.reconcile>[0]));
};

describe('BucketKey reconcile — reveal-once secret capture', () => {
  test('first create captures the full key response; secretAccessKey is Redacted', async () => {
    const state: FakeState = { calls: [] };
    const result = await reconcile(state, {
      news: { bucketId: 'bucket-1', name: 'files', role: 'read_write' },
      output: undefined,
    });

    expect(result.id).toBe('key-created');
    expect(result.bucketId).toBe('bucket-1');
    expect(result.accessKeyId).toBe('AKIA123');
    expect(result.endpoint).toBe('https://t3.storage.dev');
    expect(result.bucketName).toBe('user-abc123');
    // secretAccessKey is Redacted — the value is captured but not exposed as a plain string.
    expect(Redacted.isRedacted(result.secretAccessKey)).toBe(true);
    expect(Redacted.value(result.secretAccessKey)).toBe('super-secret-value');
    expect(state.calls.map((c) => c.method)).toEqual(['POST']);
    expect(state.calls[0]?.body).toEqual({ name: 'files', role: 'read_write' });
  });

  test('a redeploy with prior output returns the persisted attributes unchanged — no POST', async () => {
    const state: FakeState = { calls: [] };
    const prior: BucketKeyAttributes = {
      id: 'key-created',
      bucketId: 'bucket-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: Redacted.make('super-secret-value'),
      endpoint: 'https://t3.storage.dev',
      bucketName: 'user-abc123',
    };

    const result = await reconcile(state, {
      news: { bucketId: 'bucket-1', name: 'files', role: 'read_write' },
      output: prior,
    });

    // The secret is only returned at creation; the provider must never re-create.
    expect(state.calls).toHaveLength(0);
    expect(result).toEqual(prior);
  });
});
