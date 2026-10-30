import { beforeEach, describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import type { ConfigPool, ConfigPools, SecretsPool } from '@internal/core/config';
import { secretString } from '@internal/foundation/arktype';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { PrismaCloudContainer } from '../container.ts';
import { compute } from '../exports/index.ts';
import { envParam, generatedParam } from '../param.ts';
import { type PrismaCloudPreflightInput, runPreflight } from '../preflight.ts';
import { inputSecretNames } from '../preflight-names.ts';
import { envSecret } from '../secret.ts';

/** An ArkType copy of `value`: a transform elsewhere in the schema makes ArkType copy its whole input. */
const copyOf = <T>(value: T): T => {
  const out = type({ value: 'object', n: 'string.integer.parse' })({ value, n: '1' });
  if (out instanceof type.errors) throw new Error(out.summary);
  return out.value as T;
};

/** A resolved container matching `input.container` after the boundary move — preflight narrows it with `prismaCloudContainerOf`. */
const fakeContainer = (projectId: string, branchId: string | undefined) =>
  new PrismaCloudContainer({ appName: 'app', environment: 'production' }, projectId, branchId);

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

/** What the fake platform stamps on a row preflight creates from a pool. */
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
      if (state.postStatus === 500) {
        return {
          data: undefined,
          error: { code: 'internal', message: 'boom' },
          response: new Response(null, { status: 500 }),
        };
      }
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

const NO_POOLS: ConfigPools = { config: {}, secrets: {} };
let pools: ConfigPools = NO_POOLS;

/** Runs preflight with the pools `withPools` set, or empty ones. */
const preflightWith = (
  input: Omit<PrismaCloudPreflightInput, 'pools'>,
  deps?: Parameters<typeof runPreflight>[1],
) => runPreflight({ ...input, pools }, deps);

/** Sets the pools preflight reads for the duration of `fn`. */
async function withPools<T>(
  values: { readonly config?: ConfigPool; readonly secrets?: SecretsPool },
  fn: () => Promise<T> | T,
): Promise<T> {
  pools = { config: values.config ?? {}, secrets: values.secrets ?? {} };
  try {
    return await fn();
  } finally {
    pools = NO_POOLS;
  }
}

describe('runPreflight — secret manifest verification (ADR-0029)', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [], postStatus: 201 };
  });

  test('production: checks the production class; all-present passes with no writes', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await preflightWith(
      {
        graph: secretGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY' },
    ]);
    expect(state.posts).toEqual([]);
  });

  test('named environment: a preview TEMPLATE (branchId null) counts as present', async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await preflightWith(
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'pr-1' },
      { client: fakeClient(state) },
    );

    expect(state.gets[0]?.['class']).toBe('preview');
    expect(state.posts).toEqual([]);
  });

  test("named environment: this branch's own OVERRIDE counts as present", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-1' },
    ];

    await preflightWith(
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'pr-1' },
      { client: fakeClient(state) },
    );

    expect(state.posts).toEqual([]);
  });

  test("named environment: another branch's override does NOT count — absent from both fails", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-2' },
    ];

    const error: unknown = await preflightWith(
      { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'pr-1' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STRIPE_SECRET_KEY');
    expect(state.posts).toEqual([]);
  });

  test('fill-missing (named environment): absent-but-in-the-secrets-pool is POSTed as a preview branch override', async () => {
    state.rows = [];

    await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, () =>
      preflightWith(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'pr-1' },
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

  test('fill-missing (production): POSTed as a production template, no branchId', async () => {
    state.rows = [];

    await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, () =>
      preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
        },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', value: 'sk_live_fill' },
    ]);
  });

  test('present on the platform is never overwritten, even when also in the secrets pool', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_ignored' } }, () =>
      preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
        },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toEqual([]);
  });

  test('absent from both platform and secrets pool fails, naming the missing name, service, and scope', async () => {
    state.rows = [];

    const error: unknown = await preflightWith(
      {
        graph: secretGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "app.ingest"');
    expect(message).toContain('production');
    expect(message).toContain(
      "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role production",
    );
    expect(state.posts).toEqual([]);
  });

  test('quotes the environment in the printed add command so it is safe to paste', async () => {
    state.rows = [];

    const error = await preflightWith(
      {
        graph: secretGraph(),
        container: fakeContainer('proj', 'br_1'),
        environment: `it's "$HOME" x`,
      },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(String(error)).toContain(
      `prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --branch 'it'\\''s "$HOME" x'`,
    );
  });

  test('reports how many names it checked, filled from the pools, and found missing', async () => {
    const reports: Readonly<Record<string, number>>[] = [];
    const run = () =>
      preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
          report: (counts) => reports.push(counts),
        },
        { client: fakeClient(state) },
      );

    await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, run);
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];
    await run();
    state.rows = [];
    await run().catch(() => undefined);

    expect(reports).toEqual([
      { checked: 1, filled: 1, missing: 0 },
      { checked: 1, filled: 0, missing: 0 },
      { checked: 1, filled: 0, missing: 1 },
    ]);
  });

  test('a graph with no pointer secrets is a pass-through — no platform calls at all', async () => {
    await preflightWith(
      {
        graph: noSecretGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  test('a generated leaf is skipped — nothing to seed, no platform calls at all', async () => {
    await preflightWith(
      {
        graph: generatedGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  test('a race 409 on fill-missing is tolerated as already-provisioned', async () => {
    state.rows = [];
    state.postStatus = 409;

    const reports: Readonly<Record<string, number>>[] = [];

    await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_race' } }, () =>
      preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
          report: (counts) => reports.push(counts),
        },
        { client: fakeClient(state) },
      ),
    );

    expect(state.posts).toHaveLength(1);
    // The other deploy's row won, so this run filled nothing.
    expect(reports).toEqual([{ checked: 1, filled: 0, missing: 0 }]);
  });

  test('a failed fill names the key and its pool, never the value', async () => {
    state.postStatus = 500;

    const run = withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_SENTINEL' } }, () =>
      preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
          report: () => {},
        },
        { client: fakeClient(state) },
      ),
    );

    await expect(run).rejects.toThrow(
      'deploy preflight: failed to set "STRIPE_SECRET_KEY" on the platform from its pool: ' +
        '{"code":"internal","message":"boom"}.',
    );
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

    await preflightWith(
      {
        graph: secretGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client },
    );

    expect(call).toBe(2); // followed to the second page
    expect(queries[1]?.['cursor']).toBe('c1'); // carried the cursor forward
    expect(posts).toEqual([]); // found present → no fill
  });

  test('the same platform name bound by two services is checked once and named in the failure', async () => {
    state.rows = [];

    const error: unknown = await preflightWith(
      {
        graph: sharedSecretGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STRIPE_SECRET_KEY');
    expect((error as Error).message).toMatch(/service "app\.(web|ingest)"/);
    // The shared name is deduped to a single platform existence check.
    expect(state.gets).toHaveLength(1);
  });

  test('env-sourced param: missing on the platform and absent from the config pool fails, naming the platform var', async () => {
    state.rows = [];

    const error: unknown = await preflightWith(
      {
        graph: paramGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('APP_ORIGIN');
    expect(message).toContain('service "app.web"');
    expect(state.posts).toEqual([]);
  });

  test('env-sourced param: absent on the platform but present in the config pool is filled from it', async () => {
    state.rows = [];

    await withPools({ config: { APP_ORIGIN: 'https://preview.example.com' } }, () =>
      preflightWith(
        {
          graph: paramGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
        },
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

    await preflightWith(
      {
        graph: paramGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

    expect(state.posts).toEqual([]);
  });

  test('a literal-bound param never reaches the platform — no calls at all', async () => {
    await preflightWith(
      {
        graph: literalParamGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
  });

  test("a secret in a module's input that no service receives is checked, named as used by the module", async () => {
    const mail = module('mail', { input: type({ 'key?': secretString() }) }, () => {});
    const graph = Load(
      module('app', ({ provision }) => {
        provision(mail, { input: { key: envSecret('MAIL_KEY') } });
      }),
    );

    const error: unknown = await preflightWith(
      { graph, container: fakeContainer('proj', undefined), environment: 'production' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('  - MAIL_KEY  (used by module "app.mail")');
  });

  test("a secret a service receives through a module's input is named as used by the service", async () => {
    const mail = module(
      'mail',
      { input: type({ key: secretString() }) },
      ({ input, provision }) => {
        provision(compute({ name: 'sender', deps: {}, input: anySchema, build }), {
          id: 'sender',
          input: { key: input.key },
        });
      },
    );
    const graph = Load(
      module('app', ({ provision }) => {
        provision(mail, { input: { key: envSecret('MAIL_KEY') } });
      }),
    );

    const error: unknown = await preflightWith(
      { graph, container: fakeContainer('proj', undefined), environment: 'production' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('  - MAIL_KEY  (used by service "app.mail.sender")');
  });

  describe('env-var listing pagination (bounded — drivePagesAsync)', () => {
    test('a visible row beyond the first page still counts as present', async () => {
      state.pageSize = 1;
      state.rows = [
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-other' },
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
      ];

      await preflightWith(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'pr-1' },
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
        preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', undefined),
            environment: 'production',
          },
          { client: fakeClient(state) },
        ),
      ).rejects.toThrow(/pagination appears broken.*possibly incomplete listing/);
    });

    test('pagination that never ends fails at the page cap instead of hanging', async () => {
      state.pageSize = 1;
      state.cursorRunaway = true;

      await expect(
        preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', undefined),
            environment: 'production',
          },
          { client: fakeClient(state) },
        ),
      ).rejects.toThrow(/did not finish within 1000 pages/);
    });

    test('more pages reported without a cursor fails instead of accepting a partial listing', async () => {
      state.pageSize = 1;
      state.cursorMissing = true;

      await expect(
        preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', undefined),
            environment: 'production',
          },
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

      const timestamps = await preflightWith(
        {
          graph: secretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
        },
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

      const timestamps = await preflightWith(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'feature' },
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

      const timestamps = await preflightWith(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'feature' },
        { client: fakeClient(state) },
      );

      // Recency, not scope precedence: the rotation signal is the newest write
      // among every row visible to this environment.
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

      const timestamps = await preflightWith(
        { graph: secretGraph(), container: fakeContainer('proj', 'br-1'), environment: 'feature' },
        { client: fakeClient(state) },
      );

      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe('2026-05-05T12:00:00.000Z');
    });

    test('a name preflight fills from the secrets pool reports the created row\u2019s time', async () => {
      state.rows = [];

      const timestamps = await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, () =>
        preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', undefined),
            environment: 'production',
          },
          { client: fakeClient(state) },
        ),
      );

      expect(timestamps.get('STRIPE_SECRET_KEY')).toBe(CREATED_UPDATED_AT);
    });

    test('a fill that lost the race (409) reports no time, so the next deploy redeploys once', async () => {
      state.rows = [];
      state.postStatus = 409;

      const timestamps = await withPools({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, () =>
        preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', undefined),
            environment: 'production',
          },
          { client: fakeClient(state) },
        ),
      );

      expect(timestamps.has('STRIPE_SECRET_KEY')).toBe(false);
    });

    test('a graph with nothing to check hands back an empty map', async () => {
      const timestamps = await preflightWith(
        {
          graph: noSecretGraph(),
          container: fakeContainer('proj', undefined),
          environment: 'production',
        },
        { client: fakeClient(state) },
      );

      expect(timestamps.size).toBe(0);
    });

    test('no VALUE is ever handed back — the API returns none and preflight asks for none', async () => {
      state.rows = [];

      const timestamps = await withPools(
        { secrets: { STRIPE_SECRET_KEY: 'sk_live_sentinel' } },
        () =>
          preflightWith(
            {
              graph: secretGraph(),
              container: fakeContainer('proj', undefined),
              environment: 'production',
            },
            { client: fakeClient(state) },
          ),
      );

      expect(JSON.stringify([...timestamps])).not.toContain('sk_live_sentinel');
    });
  });
});

describe('runPreflight — a COMPOSER_ key that changes owner in the move to full addresses (ADR-0057)', () => {
  const clashGraph = () =>
    Load(
      module('shop', ({ provision }) => {
        provision(compute({ name: 'x', deps: {}, build }), { id: 'x' });
        provision(
          module('shop', ({ provision: p }) => {
            p(compute({ name: 'x', deps: {}, build }), { id: 'x' });
          }),
          { id: 'shop' },
        );
      }),
    );
  const row = (key: string): Row => ({
    projectId: 'proj',
    class: 'preview',
    key,
    branchId: 'br_1',
  });
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [], postStatus: 201 };
  });

  const preflight = () =>
    preflightWith(
      { graph: clashGraph(), container: fakeContainer('proj', 'br_1'), environment: 'pr-1' },
      { client: fakeClient(state) },
    );

  test('fails before any resource changes while the old owner still holds the key', async () => {
    state.rows = [row('COMPOSER_SHOP_X_ORIGIN')];

    const error = await preflight().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      'COMPOSER_SHOP_X_ORIGIN belongs to "shop.shop.x" from the previous Composer release. ' +
        'This release writes it for "shop.x"',
    );
    expect(String(error)).toContain(
      "prisma project env delete 'COMPOSER_SHOP_X_ORIGIN' --project 'proj' --branch 'pr-1'",
    );
    expect(state.posts).toEqual([]);
  });

  test('quotes the environment so the printed command is safe to paste', async () => {
    state.rows = [row('COMPOSER_SHOP_X_ORIGIN')];

    const error = await preflightWith(
      {
        graph: clashGraph(),
        container: fakeContainer('proj', 'br_1'),
        environment: `it's "$HOME" x`,
      },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(String(error)).toContain(`--branch 'it'\\''s "$HOME" x'`);
  });

  test('passes once that variable is deleted', async () => {
    await preflight();
  });

  test("passes after the move, when the old owner's row has its new key", async () => {
    state.rows = [row('COMPOSER_SHOP_X_ORIGIN'), row('COMPOSER_SHOP_SHOP_X_ORIGIN')];

    await preflight();
  });

  test('ignores a row with that key in another scope', async () => {
    state.rows = [{ ...row('COMPOSER_SHOP_X_ORIGIN'), branchId: null }];

    await preflight();
  });
});

describe('runPreflight — a chain of COMPOSER_ keys that change owner', () => {
  /** `shop.x`, `shop.shop.x` and `shop.shop.shop.x`: each node's new key is the next one's old key. */
  const chainGraph = () =>
    Load(
      module('shop', ({ provision }) => {
        provision(compute({ name: 'x', deps: {}, build }), { id: 'x' });
        provision(
          module('shop', ({ provision: p }) => {
            p(compute({ name: 'x', deps: {}, build }), { id: 'x' });
            p(
              module('shop', ({ provision: q }) => {
                q(compute({ name: 'x', deps: {}, build }), { id: 'x' });
              }),
              { id: 'shop' },
            );
          }),
          { id: 'shop' },
        );
      }),
    );
  const row = (key: string): Row => ({
    projectId: 'proj',
    class: 'production',
    key,
    branchId: null,
  });
  const preflight = (state: FakeState) =>
    preflightWith(
      {
        graph: chainGraph(),
        container: fakeContainer('proj', undefined),
        environment: 'production',
      },
      { client: fakeClient(state) },
    );

  test('reports every link in one run', async () => {
    const state: FakeState = {
      gets: [],
      posts: [],
      rows: [row('COMPOSER_SHOP_X_ORIGIN'), row('COMPOSER_SHOP_SHOP_X_ORIGIN')],
      postStatus: 201,
    };

    const message = String(await preflight(state).catch((e: unknown) => e));

    expect(message).toContain('COMPOSER_SHOP_X_ORIGIN belongs to "shop.shop.x"');
    expect(message).toContain('COMPOSER_SHOP_SHOP_X_ORIGIN belongs to "shop.shop.shop.x"');
  });

  test('passes once every node has moved', async () => {
    const state: FakeState = {
      gets: [],
      posts: [],
      rows: [
        row('COMPOSER_SHOP_X_ORIGIN'),
        row('COMPOSER_SHOP_SHOP_X_ORIGIN'),
        row('COMPOSER_SHOP_SHOP_SHOP_X_ORIGIN'),
      ],
      postStatus: 201,
    };

    await preflight(state);
  });
});

describe('runPreflight — values come from the pools, never the shell', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [], postStatus: 201 };
  });

  const production = { container: fakeContainer('proj', undefined), environment: 'production' };

  /** A name bound both as a secret in the service's input and as an env-sourced param. */
  const sharedNameGraph = () =>
    Load(
      module('app', ({ provision }) => {
        provision(compute({ name: 'web', deps: {}, input: anySchema, build }), {
          id: 'web',
          input: { key: envSecret('SHARED') },
          params: { port: envParam('SHARED') },
        });
      }),
    );

  async function withShell<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    try {
      return await fn();
    } finally {
      for (const name of Object.keys(values)) delete process.env[name];
    }
  }

  test('a missing secret is filled from the secrets pool, not the shell', async () => {
    await withShell({ STRIPE_SECRET_KEY: 'shell' }, () =>
      withPools({ secrets: { STRIPE_SECRET_KEY: 'pool' } }, () =>
        preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) }),
      ),
    );

    expect(state.posts).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', value: 'pool' },
    ]);
  });

  test('a missing secret the secrets pool lacks fails, even when the shell has it', async () => {
    const error = await withShell({ STRIPE_SECRET_KEY: 'shell' }, () =>
      preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) }).catch(
        (e: unknown) => e,
      ),
    );

    expect(String(error)).toContain(
      'Deploy failed. 1 required setting has no value:\n  - STRIPE_SECRET_KEY  (used by service "app.ingest")',
    );
    expect(state.posts).toEqual([]);
  });

  test('a missing env-sourced param is filled from the config pool', async () => {
    await withShell({ APP_ORIGIN: 'shell' }, () =>
      withPools({ config: { APP_ORIGIN: 'https://pool.example' } }, () =>
        preflightWith({ graph: paramGraph(), ...production }, { client: fakeClient(state) }),
      ),
    );

    expect(state.posts).toEqual([
      { projectId: 'proj', class: 'production', key: 'APP_ORIGIN', value: 'https://pool.example' },
    ]);
  });

  test('a name bound as a secret and as an env-sourced param is filled from the secrets pool', async () => {
    await withPools(
      { secrets: { SHARED: 'from-secrets' }, config: { SHARED: 'from-config' } },
      () =>
        preflightWith({ graph: sharedNameGraph(), ...production }, { client: fakeClient(state) }),
    );

    expect(state.posts).toEqual([
      { projectId: 'proj', class: 'production', key: 'SHARED', value: 'from-secrets' },
    ]);
  });

  test('an env-sourced param whose config pool value is not text fails naming its kind', async () => {
    const error = await withPools({ config: { APP_ORIGIN: 4 } }, () =>
      preflightWith({ graph: paramGraph(), ...production }, { client: fakeClient(state) }).catch(
        (e: unknown) => e,
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The config pool holds a number at "APP_ORIGIN", not text, so preflight cannot set the platform variable envParam(\'APP_ORIGIN\') of service "app.web" reads. Make the adapter return a string.',
    );
    expect(state.posts).toEqual([]);
  });
});

describe('preflight names', () => {
  test('an envSecret() and its ArkType copy are one name to check', () => {
    const key = envSecret('STRIPE_SECRET_KEY');

    expect(inputSecretNames({ a: key, b: copyOf(key) }, 'app.web')).toEqual(['STRIPE_SECRET_KEY']);
  });
});
