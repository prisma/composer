import { beforeEach, describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PrismaCloudContainer } from '../container.ts';
import { compute } from '../exports/index.ts';
import { envParam, generatedParam } from '../param.ts';
import { runPreflight } from '../preflight.ts';
import { envSecret } from '../secret.ts';

/** A resolved container matching `input.container` after the boundary move — preflight narrows it with `prismaCloudContainerOf`. */
const fakeContainer = (projectId: string, branchId: string | undefined) =>
  new PrismaCloudContainer({ appName: 'app', stage: undefined }, projectId, branchId);

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

interface Row {
  projectId: string;
  class: 'production' | 'preview';
  key: string;
  branchId: string | null;
  /** Defaulted by the fake client — only the rotation tests below care what it is. */
  updatedAt?: string;
}

/** What a row the test did not date reads as. */
const DEFAULT_UPDATED_AT = '2026-01-01T00:00:00.000Z';

/** What the fake platform stamps on a row preflight creates from the deploy shell. */
const CREATED_UPDATED_AT = '2026-03-03T00:00:00.000Z';

interface FakeState {
  gets: Record<string, string>[];
  posts: Record<string, unknown>[];
  rows: Row[];
  postStatus: number;
  /** Page size for the env-var listing — unset serves everything in one page. */
  pageSize?: number;
  /** When set, the listing reports hasMore with a nextCursor equal to the request's cursor — a broken, non-advancing pagination. */
  cursorStuck?: boolean;
  /** When set, the listing always reports hasMore with an ever-advancing nextCursor — pagination that never ends. */
  cursorRunaway?: boolean;
  /** When set, the listing reports hasMore but returns no nextCursor — more pages that cannot be fetched. */
  cursorMissing?: boolean;
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
      const offset = q['cursor'] === undefined ? 0 : Number(q['cursor']);
      const pageSize = state.pageSize ?? rows.length;
      const data = rows.slice(offset, offset + pageSize);
      const pagination =
        state.cursorStuck === true
          ? { nextCursor: String(offset), hasMore: true }
          : state.cursorRunaway === true
            ? { nextCursor: String(offset + 1), hasMore: true }
            : state.cursorMissing === true
              ? { nextCursor: null, hasMore: true }
              : {
                  nextCursor:
                    offset + data.length < rows.length ? String(offset + data.length) : null,
                  hasMore: offset + data.length < rows.length,
                };
      return {
        data: {
          data: data.map((r) => ({ ...r, updatedAt: r.updatedAt ?? DEFAULT_UPDATED_AT })),
          pagination,
        },
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
        data: {
          data: { id: 'ev-new', key: init.body['key'], updatedAt: CREATED_UPDATED_AT },
        },
        error: undefined,
        response: new Response(null, { status: 201 }),
      };
    },
  }) as unknown as ManagementApiClient;

/** Load never validates a binding, so a pass-anything schema is enough here. */
const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const secretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

const noSecretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, build }), { id: 'ingest' });
    }),
  );

/** Only a generated leaf — the deploy provisions its var; nothing for an operator to seed. */
const generatedGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { secret: generatedParam() },
      });
    }),
  );

/** Two services binding the SAME platform name — the manifest dedups it. */
const sharedSecretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, input: anySchema, build }), {
        id: 'web',
        // Nested on purpose — preflight's walk must find a leaf at any depth.
        input: { stripe: { key: envSecret('STRIPE_SECRET_KEY') } },
      });
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { key: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

// The reserved `port` param keeps the env-sourced param channel (ADR-0042):
// binding it to envParam(...) still writes a pointer row the platform must back.
const paramGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }), {
        id: 'web',
        params: { port: envParam('APP_ORIGIN') },
      });
    }),
  );

/** A literal-bound param never touches the platform — preflight must not check it. */
const literalParamGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }), {
        id: 'web',
        params: { port: 3100 },
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
      { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
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
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'pr-1' },
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
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'pr-1' },
      { client: fakeClient(state) },
    );

    expect(state.posts).toEqual([]);
  });

  test("named stage: another branch's override does NOT count — absent from both fails", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-2' },
    ];

    const error: unknown = await runPreflight(
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'pr-1' },
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
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'pr-1' },
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
        { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
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
        { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([]);
  });

  test('absent from both platform and shell fails, naming the missing name, service, and scope', async () => {
    state.rows = [];

    const error: unknown = await runPreflight(
      { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "ingest"');
    expect(message).toContain('production');
    expect(message).toContain(
      'prisma project env add STRIPE_SECRET_KEY="<value>" --project proj --role production',
    );
    expect(state.posts).toEqual([]);
  });

  test('a graph with no pointer secrets is a pass-through — no platform calls at all', async () => {
    await runPreflight(
      { graph: noSecretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  test('a generated leaf is skipped — nothing to seed, no platform calls at all', async () => {
    await runPreflight(
      { graph: generatedGraph(), container: fakeContainer('proj', undefined), stage: undefined },
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
        { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
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
      { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client },
    );

    expect(call).toBe(2); // followed to the second page
    expect(queries[1]?.['cursor']).toBe('c1'); // carried the cursor forward
    expect(posts).toEqual([]); // found present → no fill
  });

  test('the same platform name bound by two services is checked once and named in the failure', async () => {
    state.rows = [];

    const error: unknown = await runPreflight(
      { graph: sharedSecretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STRIPE_SECRET_KEY');
    expect((error as Error).message).toMatch(/service "(web|ingest)"/);
    // The shared name is deduped to a single platform existence check.
    expect(state.gets).toHaveLength(1);
  });

  test('env-sourced param: missing on the platform and absent from the shell fails, naming the platform var', async () => {
    delete process.env['APP_ORIGIN'];
    state.rows = [];

    const error: unknown = await runPreflight(
      { graph: paramGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('APP_ORIGIN');
    expect(message).toContain('service "web"');
    expect(state.posts).toEqual([]);
  });

  test('env-sourced param: absent on the platform but present in the shell is shell-filled', async () => {
    state.rows = [];

    await withEnv({ APP_ORIGIN: 'https://preview.example.com' }, () =>
      runPreflight(
        { graph: paramGraph(), container: fakeContainer('proj', undefined), stage: undefined },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([
      {
        projectId: 'proj',
        class: 'production',
        key: 'APP_ORIGIN',
        value: 'https://preview.example.com',
      },
    ]);
  });

  test('env-sourced param: present on the platform passes with no writes', async () => {
    state.rows = [{ projectId: 'proj', class: 'production', key: 'APP_ORIGIN', branchId: null }];

    await runPreflight(
      { graph: paramGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    );

    expect(state.posts).toEqual([]);
  });

  test('a literal-bound param never reaches the platform — no calls at all', async () => {
    await runPreflight(
      { graph: literalParamGraph(), container: fakeContainer('proj', undefined), stage: undefined },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  describe('env-var listing pagination (bounded — drivePagesAsync)', () => {
    test('a visible row beyond the first page still counts as present', async () => {
      state.pageSize = 1;
      state.rows = [
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-other' },
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
      ];

      await runPreflight(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'pr-1' },
        { client: fakeClient(state) },
      );

      expect(state.gets).toHaveLength(2);
      expect(state.posts).toEqual([]);
    });

    test('a non-advancing cursor fails as broken pagination instead of looping', async () => {
      // No matching rows: every page is empty, so the search never
      // short-circuits and the stuck cursor is what ends it.
      state.pageSize = 1;
      state.cursorStuck = true;

      await expect(
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      ).rejects.toThrow(/pagination appears broken.*possibly incomplete listing/);
    });

    test('pagination that never ends fails at the page cap instead of hanging', async () => {
      state.pageSize = 1;
      state.cursorRunaway = true;

      await expect(
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      ).rejects.toThrow(/did not finish within 1000 pages/);
    });

    test('more pages reported without a cursor fails instead of accepting a partial listing', async () => {
      state.pageSize = 1;
      state.cursorMissing = true;

      await expect(
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      ).rejects.toThrow(/reported more pages but returned no cursor/);
    });
  });

  describe('the rotation timestamps it hands back', () => {
    test('a name present on the platform reports when it was last written', async () => {
      state.rows = [
        {
          projectId: 'proj',
          class: 'production',
          key: 'STRIPE_SECRET_KEY',
          branchId: null,
          updatedAt: '2026-05-05T12:00:00.000Z',
        },
      ];

      const timestamps = await runPreflight(
        { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
        { client: fakeClient(state) },
      );

      expect([...timestamps]).toEqual([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']]);
    });

    test('with a template and a branch override in scope, the NEWER row wins', async () => {
      state.rows = [
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: null,
          updatedAt: '2026-05-05T12:00:00.000Z',
        },
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: 'br-1',
          updatedAt: '2026-07-07T12:00:00.000Z',
        },
      ];

      const timestamps = await runPreflight(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'feature' },
        { client: fakeClient(state) },
      );

      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe('2026-07-07T12:00:00.000Z');
    });

    test('the NEWER row wins even when it is the template, not the branch override', async () => {
      state.rows = [
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: null,
          updatedAt: '2026-08-08T12:00:00.000Z',
        },
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: 'br-1',
          updatedAt: '2026-07-07T12:00:00.000Z',
        },
      ];

      const timestamps = await runPreflight(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'feature' },
        { client: fakeClient(state) },
      );

      // Recency, not scope precedence: the rotation signal is the newest write
      // among every row visible to this stage.
      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe('2026-08-08T12:00:00.000Z');
    });

    test('a row belonging to ANOTHER branch is not in scope and does not date this one', async () => {
      state.rows = [
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: null,
          updatedAt: '2026-05-05T12:00:00.000Z',
        },
        {
          projectId: 'proj',
          class: 'preview',
          key: 'STRIPE_SECRET_KEY',
          branchId: 'br-other',
          updatedAt: '2026-09-09T12:00:00.000Z',
        },
      ];

      const timestamps = await runPreflight(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), stage: 'feature' },
        { client: fakeClient(state) },
      );

      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe('2026-05-05T12:00:00.000Z');
    });

    test('a name preflight fills from the shell reports the created row\u2019s time', async () => {
      state.rows = [];

      const timestamps = await withEnv({ STRIPE_SECRET_KEY: 'sk_live_fill' }, () =>
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      );

      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe(CREATED_UPDATED_AT);
    });

    test('a fill that lost the race (409) reports no time, so the next deploy redeploys once', async () => {
      state.rows = [];
      state.postStatus = 409;

      const timestamps = await withEnv({ STRIPE_SECRET_KEY: 'sk_live_fill' }, () =>
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      );

      expect(timestamps.has('STRIPE_SECRET_KEY')).toBe(false);
    });

    test('a graph with nothing to check hands back an empty map', async () => {
      const timestamps = await runPreflight(
        { graph: noSecretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
        { client: fakeClient(state) },
      );

      expect(timestamps.size).toBe(0);
    });

    test('no VALUE is ever handed back — the API returns none and preflight asks for none', async () => {
      state.rows = [];

      const timestamps = await withEnv({ STRIPE_SECRET_KEY: 'sk_live_sentinel' }, () =>
        runPreflight(
          { graph: secretGraph(), container: fakeContainer('proj', undefined), stage: undefined },
          { client: fakeClient(state) },
        ),
      );

      expect(JSON.stringify([...timestamps])).not.toContain('sk_live_sentinel');
    });
  });
});
