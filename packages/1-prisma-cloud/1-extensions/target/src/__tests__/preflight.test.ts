import { beforeEach, describe, expect, test } from 'bun:test';
import { Load, module, secret } from '@internal/core';
import type { ManagementApiClient } from '@internal/lowering';
import { compute } from '../index.ts';
import { runPreflight } from '../preflight.ts';
import { envSecret } from '../secret.ts';

const build = {
  extension: '@prisma/compose/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

interface Row {
  projectId: string;
  class: 'production' | 'preview';
  key: string;
  branchId: string | null;
}

interface FakeState {
  gets: Record<string, string>[];
  posts: Record<string, unknown>[];
  rows: Row[];
  postStatus: number;
}

/** A stubbed Management API client — test file, exempt from the no-bare-cast rule. */
const fakeClient = (state: FakeState): ManagementApiClient =>
  ({
    GET: async (_path: string, init: { params: { query: Record<string, string> } }) => {
      const q = init.params.query;
      state.gets.push(q);
      const rows = state.rows.filter(
        (r) => r.projectId === q['projectId'] && r.class === q['class'] && r.key === q['key'],
      );
      return {
        data: { data: rows, pagination: { nextCursor: null, hasMore: false } },
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    },
    POST: async (_path: string, init: { body: Record<string, unknown> }) => {
      state.posts.push(init.body);
      if (state.postStatus === 409) {
        return {
          data: undefined,
          error: { code: 'conflict', message: 'already exists' },
          response: new Response(null, { status: 409 }),
        };
      }
      return {
        data: { data: { id: 'ev-new', key: init.body['key'] } },
        error: undefined,
        response: new Response(null, { status: 201 }),
      };
    },
  }) as unknown as ManagementApiClient;

const secretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, secrets: { stripeKey: secret() }, build }), {
        id: 'ingest',
        secrets: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

const noSecretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, build }), { id: 'ingest' });
    }),
  );

/** Two services binding the SAME platform name — the manifest dedups it. */
const sharedSecretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, secrets: { key: secret() }, build }), {
        id: 'web',
        secrets: { key: envSecret('STRIPE_SECRET_KEY') },
      });
      provision(compute({ name: 'ingest', deps: {}, secrets: { key: secret() }, build }), {
        id: 'ingest',
        secrets: { key: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

/** Sets env vars for the duration of `fn`, restoring whatever was there before. */
async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('runPreflight — secret manifest verification (ADR-0029)', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [], postStatus: 201 };
    // The manifest secret must not leak from the ambient shell into "absent" tests.
    delete process.env['STRIPE_SECRET_KEY'];
  });

  test('default stage: checks the production class; all-present passes with no writes', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY' },
    ]);
    expect(state.posts).toEqual([]);
  });

  test('named stage: a preview TEMPLATE (branchId null) counts as present', async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: 'br-1', stage: 'pr-1' },
      { client: fakeClient(state) },
    );

    expect(state.gets[0]?.['class']).toBe('preview');
    expect(state.posts).toEqual([]);
  });

  test("named stage: this branch's own OVERRIDE counts as present", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-1' },
    ];

    await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: 'br-1', stage: 'pr-1' },
      { client: fakeClient(state) },
    );

    expect(state.posts).toEqual([]);
  });

  test("named stage: another branch's override does NOT count — absent from both fails", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-2' },
    ];

    const error: unknown = await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: 'br-1', stage: 'pr-1' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STRIPE_SECRET_KEY');
    expect(state.posts).toEqual([]);
  });

  test('fill-missing (named stage): absent-but-in-shell is POSTed as a preview branch override', async () => {
    state.rows = [];

    await withEnv({ STRIPE_SECRET_KEY: 'sk_live_fill' }, () =>
      runPreflight(
        { graph: secretGraph(), projectId: 'proj', branchId: 'br-1', stage: 'pr-1' },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([
      {
        projectId: 'proj',
        class: 'preview',
        key: 'STRIPE_SECRET_KEY',
        value: 'sk_live_fill',
        branchId: 'br-1',
      },
    ]);
  });

  test('fill-missing (default stage): POSTed as a production template, no branchId', async () => {
    state.rows = [];

    await withEnv({ STRIPE_SECRET_KEY: 'sk_live_fill' }, () =>
      runPreflight(
        { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', value: 'sk_live_fill' },
    ]);
  });

  test('present on the platform is never overwritten, even when also in the shell', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await withEnv({ STRIPE_SECRET_KEY: 'sk_live_ignored' }, () =>
      runPreflight(
        { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([]);
  });

  test('absent from both platform and shell fails, naming the missing name, service, and scope', async () => {
    state.rows = [];

    const error: unknown = await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "ingest"');
    expect(message).toContain('production');
    expect(state.posts).toEqual([]);
  });

  test('a graph with no pointer secrets is a pass-through — no platform calls at all', async () => {
    await runPreflight(
      { graph: noSecretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  test('a race 409 on fill-missing is tolerated as already-provisioned', async () => {
    state.rows = [];
    state.postStatus = 409;

    await withEnv({ STRIPE_SECRET_KEY: 'sk_live_race' }, () =>
      runPreflight(
        { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toHaveLength(1);
  });

  test('follows pagination — a present name on a later page is not reported missing', async () => {
    const pages = [
      { data: [], pagination: { nextCursor: 'c1', hasMore: true } },
      {
        data: [
          { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
        ],
        pagination: { nextCursor: null, hasMore: false },
      },
    ];
    const queries: Record<string, string>[] = [];
    const posts: unknown[] = [];
    let call = 0;
    const client = {
      GET: async (_path: string, init: { params: { query: Record<string, string> } }) => {
        queries.push(init.params.query);
        return {
          data: pages[call++],
          error: undefined,
          response: new Response(null, { status: 200 }),
        };
      },
      POST: async (_path: string, init: { body: Record<string, unknown> }) => {
        posts.push(init.body);
        return {
          data: { data: { id: 'ev-new', key: init.body['key'] } },
          error: undefined,
          response: new Response(null, { status: 201 }),
        };
      },
    } as unknown as ManagementApiClient;

    await runPreflight(
      { graph: secretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
      { client },
    );

    expect(call).toBe(2); // followed to the second page
    expect(queries[1]?.['cursor']).toBe('c1'); // carried the cursor forward
    expect(posts).toEqual([]); // found present → no fill
  });

  test('the same platform name bound by two services is checked once and named in the failure', async () => {
    state.rows = [];

    const error: unknown = await runPreflight(
      { graph: sharedSecretGraph(), projectId: 'proj', branchId: undefined, stage: undefined },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STRIPE_SECRET_KEY');
    expect((error as Error).message).toMatch(/service "(web|ingest)"/);
    // The shared name is deduped to a single platform existence check.
    expect(state.gets).toHaveLength(1);
  });
});
