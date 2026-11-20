import { beforeEach, describe, expect, test } from 'bun:test';
import { appRoot, isSecretPointer, Load, module, secretSource } from '@internal/core';
import type {
  AppConfiguration,
  AppSecrets,
  PlatformVariableCheck,
  PreflightFindings,
} from '@internal/core/config';
import { platformVariableReaderText } from '@internal/core/config';
import { secretString } from '@internal/foundation/arktype';
import { isSecretString } from '@internal/foundation/secret';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { PrismaCloudContainer } from '../container.ts';
import { compute } from '../exports/index.ts';
import { generatedParam } from '../param.ts';
import { variable } from '../platform-variable.ts';
import { type PrismaCloudPreflightInput, runPreflight } from '../preflight.ts';
import { inputVariableNames } from '../preflight-names.ts';
import { secretVariable } from './variable-values.ts';

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
  isManagedBySystem?: boolean;
}

/** What a row the test did not date reads as. */
const DEFAULT_UPDATED_AT = '2026-01-01T00:00:00.000Z';

interface FakeState {
  gets: Record<string, string>[];
  posts: Record<string, unknown>[];
  rows: Row[];
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
    POST: async (path: string, init: { body: Record<string, unknown> }) => {
      state.posts.push({ path, ...init.body });
      return {
        data: { data: { id: 'ev-new', key: init.body['key'] } },
        error: undefined,
        response: new Response(null, { status: 201 }),
      };
    },
  }) as unknown as ManagementApiClient;

const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

/** Passes when every field named in `required` holds a secret: a secret box or a secret pointer. */
const requiresSecrets = (...required: string[]): StandardSchemaV1<unknown, unknown> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record = typeof value === 'object' && value !== null ? value : {};
      const missing = required.filter((key) => {
        const field = Object.getOwnPropertyDescriptor(record, key)?.value;
        return !(isSecretString(field) || isSecretPointer(field));
      });
      return missing.length === 0
        ? { value }
        : { issues: missing.map((key) => ({ message: `${key} is required` })) };
    },
  },
});

/** Passes when at least one of `keys` is present. */
const requiresOneOf = (...keys: string[]): StandardSchemaV1<unknown, unknown> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record = typeof value === 'object' && value !== null ? value : {};
      return keys.some((key) => key in record)
        ? { value }
        : { issues: [{ message: `one of ${keys.join(', ')} is required` }] };
    },
  },
});

/** Fails whatever it is given. */
const neverSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: () => ({ issues: [{ message: 'region is required' }] }),
  },
};

const secretGraph = (schema: StandardSchemaV1<unknown, unknown> = anySchema) =>
  Load(
    appRoot('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: schema, build }), {
        id: 'ingest',
        input: { stripeKey: provision(variable.secret({ name: 'STRIPE_SECRET_KEY' })) },
      });
    }),
  );

const requiredSecretGraph = () => secretGraph(requiresSecrets('stripeKey'));

const noSecretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, build }), { id: 'ingest' });
    }),
  );

const generatedGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { secret: generatedParam() },
      });
    }),
  );

/** Two services binding the SAME platform name; `web` requires it when `webRequires` is set. */
const sharedNestedSecretGraph = (webRequires = false) =>
  Load(
    appRoot('app', ({ provision }) => {
      const stripeKey = provision(variable.secret({ name: 'STRIPE_SECRET_KEY' }));
      provision(
        compute({
          name: 'web',
          deps: {},
          input: webRequires ? requiresSecrets('stripe') : anySchema,
          build,
        }),
        { id: 'web', input: { stripe: stripeKey } },
      );
      provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
        id: 'ingest',
        input: { stripe: { key: stripeKey } },
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

interface ReadValues {
  readonly configuration: AppConfiguration;
  readonly secrets: AppSecrets;
}

const NO_VALUES: ReadValues = { configuration: {}, secrets: {} };
let read: ReadValues = NO_VALUES;

/** Runs preflight with the app configuration and the app secrets `withValues` set, or empty ones. */
const preflightWith = async (
  input: Omit<PrismaCloudPreflightInput, 'configuration' | 'secrets'>,
  deps?: Parameters<typeof runPreflight>[1],
) => {
  let findings: PreflightFindings = { unset: [] };
  const payload = await runPreflight(
    {
      ...input,
      ...read,
      report: (check) => {
        findings = { unset: check.unset };
        input.report?.(check);
      },
    },
    deps,
  );
  return { ...payload, findings };
};

/** Sets the app configuration and the app secrets preflight reads for the duration of `fn`. */
async function withValues<T>(
  values: { readonly configuration?: AppConfiguration; readonly secrets?: AppSecrets },
  fn: () => Promise<T> | T,
): Promise<T> {
  read = { configuration: values.configuration ?? {}, secrets: values.secrets ?? {} };
  try {
    return await fn();
  } finally {
    read = NO_VALUES;
  }
}

const production = { container: fakeContainer('proj', undefined), environment: 'production' };
const preview = { container: fakeContainer('proj', 'br-1'), environment: 'pr-1' };

const failureOf = async (run: Promise<unknown>): Promise<string> => {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error('expected preflight to fail');
  return error.message;
};

describe('the deploy check reads which variables exist and sets none', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [] };
  });

  test('in production, a variable with a production row passes', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await preflightWith(
      { graph: requiredSecretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY' },
    ]);
  });

  test('in a named environment, a preview-wide row counts as a value', async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    await preflightWith(
      { graph: requiredSecretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect(state.gets[0]?.['class']).toBe('preview');
  });

  test("in a named environment, this branch's own row counts as a value", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-1' },
    ];

    await preflightWith(
      { graph: requiredSecretGraph(), ...preview },
      { client: fakeClient(state) },
    );
  });

  test("in a named environment, another branch's row does not count", async () => {
    state.rows = [
      { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-2' },
    ];

    const message = await failureOf(
      preflightWith({ graph: requiredSecretGraph(), ...preview }, { client: fakeClient(state) }),
    );

    expect(message).toContain('STRIPE_SECRET_KEY');
  });

  test('in production, a production row with a branch does not count', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: 'br-2' },
    ];

    const message = await failureOf(
      preflightWith({ graph: requiredSecretGraph(), ...production }, { client: fakeClient(state) }),
    );

    expect(message).toContain('STRIPE_SECRET_KEY');
  });

  test('sets no platform variable, even when the app secrets hold a value for a missing name', async () => {
    await withValues({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, async () => {
      await preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) });
      await preflightWith(
        { graph: requiredSecretGraph(), ...preview },
        { client: fakeClient(state) },
      ).catch(() => undefined);
    });

    expect(state.gets.length).toBeGreaterThan(0);
    expect(state.posts).toEqual([]);
  });

  test('a required variable with no row fails in production, naming the reader and the one command', async () => {
    const message = await failureOf(
      preflightWith({ graph: requiredSecretGraph(), ...production }, { client: fakeClient(state) }),
    );

    expect(message).toBe(
      'Deploy failed. 1 platform variable a service needs has no value:\n' +
        '  - STRIPE_SECRET_KEY  (read by service "app.ingest", field "stripeKey")\n\n' +
        'Set it on the platform, then deploy again:\n' +
        "  - prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role production",
    );
  });

  test('in any other environment the preview-wide command comes first and the branch command second, quoted to paste', async () => {
    const message = await failureOf(
      preflightWith(
        {
          graph: requiredSecretGraph(),
          container: fakeContainer('proj', 'br_1'),
          environment: `it's "$HOME" x`,
        },
        { client: fakeClient(state) },
      ),
    );

    expect(message).toEndWith(
      'Set it on the platform, then deploy again:\n' +
        "  - prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role preview\n" +
        `  - prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --branch 'it'\\''s "$HOME" x'`,
    );
  });

  test('a variable with no row that nothing requires passes and is reported with its reader and commands', async () => {
    const result = await preflightWith(
      { graph: secretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect(result.findings).toEqual({
      unset: [
        {
          name: 'STRIPE_SECRET_KEY',
          readers: [{ kind: 'field', service: 'app.ingest', path: 'stripeKey' }],
          commands: [
            "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role preview",
            "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --branch 'pr-1'",
          ],
        },
      ],
    });
    expect(result.updatedAt.size).toBe(0);
  });

  test('a variable with a row is not a finding', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];

    const result = await preflightWith(
      { graph: secretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(result.findings).toEqual({ unset: [] });
  });

  test('reports how many names it checked with its findings, and nothing when it fails', async () => {
    const reports: PlatformVariableCheck[] = [];
    const run = (graph: ReturnType<typeof secretGraph>) =>
      preflightWith(
        { graph, ...production, report: (report) => reports.push(report) },
        { client: fakeClient(state) },
      );

    const first = await run(secretGraph());
    await run(requiredSecretGraph()).catch(() => undefined);
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null },
    ];
    await run(secretGraph());

    expect(first.findings.unset.map((variable) => variable.name)).toEqual(['STRIPE_SECRET_KEY']);
    expect(reports).toEqual([
      { checked: 1, ...first.findings },
      { checked: 1, unset: [] },
    ]);
  });

  test('a graph with no platform variable makes no platform call and returns nothing', async () => {
    const result = await preflightWith(
      { graph: noSecretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
    expect(result).toEqual({ updatedAt: new Map(), findings: { unset: [] } });
  });

  test('a value Composer generates needs no platform check', async () => {
    await preflightWith({ graph: generatedGraph(), ...production }, { client: fakeClient(state) });

    expect(state.gets).toEqual([]);
  });

  test('follows pagination — a present name on a later page is not reported missing', async () => {
    const pages = [
      { data: [], pagination: { nextCursor: 'c1', hasMore: true } },
      {
        data: [{ branchId: null, updatedAt: DEFAULT_UPDATED_AT }],
        pagination: { nextCursor: null, hasMore: false },
      },
    ];
    const queries: Record<string, string>[] = [];
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
    } as unknown as ManagementApiClient;

    await preflightWith({ graph: requiredSecretGraph(), ...production }, { client });

    expect(call).toBe(2);
    expect(queries[1]?.['cursor']).toBe('c1');
  });

  test('a failed list call fails the deploy, naming the variable', async () => {
    const client = {
      GET: async () => ({
        data: undefined,
        error: { code: 'internal', message: 'boom' },
        response: new Response(null, { status: 500 }),
      }),
    } as unknown as ManagementApiClient;

    const message = await failureOf(
      preflightWith({ graph: secretGraph(), ...production }, { client }),
    );

    expect(message).toBe(
      'deploy preflight: Prisma Management API error listing "STRIPE_SECRET_KEY": {"code":"internal","message":"boom"}.',
    );
  });

  test('at most eight list calls run at once', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `KEY_${index}`);
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
          id: 'ingest',
          input: Object.fromEntries(
            names.map((name) => [name.toLowerCase(), provision(variable.secret({ name }))]),
          ),
        });
      }),
    );
    let running = 0;
    let most = 0;
    const listed: string[] = [];
    const client = {
      GET: async (_path: string, init: { params: { query: Record<string, string> } }) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        listed.push(init.params.query['key'] ?? '');
        return {
          data: { data: [], pagination: { nextCursor: null, hasMore: false } },
          error: undefined,
          response: new Response(null, { status: 200 }),
        };
      },
    } as unknown as ManagementApiClient;

    await preflightWith({ graph, ...production }, { client });

    expect(most).toBe(8);
    expect(listed.sort()).toEqual([...names].sort());
  });

  test('the same platform name bound by two services is listed once, and the finding names both readers', async () => {
    const result = await preflightWith(
      { graph: sharedNestedSecretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.gets).toHaveLength(1);
    expect(result.findings.unset[0]?.readers).toEqual([
      { kind: 'field', service: 'app.web', path: 'stripe' },
      { kind: 'field', service: 'app.ingest', path: 'stripe.key' },
    ]);
  });

  test('a name one of two readers requires fails, and the error names both readers', async () => {
    const message = await failureOf(
      preflightWith(
        { graph: sharedNestedSecretGraph(true), ...production },
        { client: fakeClient(state) },
      ),
    );

    expect(message).toContain(
      '  - STRIPE_SECRET_KEY  (read by service "app.web", field "stripe"; read by service "app.ingest", field "stripe.key")',
    );
  });

  test('when the schema needs at least one of several unset variables but none alone, the error says so', async () => {
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(compute({ name: 'billing', deps: {}, input: requiresOneOf('a', 'b'), build }), {
          id: 'billing',
          input: {
            a: provision(variable.secret({ name: 'KEY_A' })),
            b: provision(variable.secret({ name: 'KEY_B' })),
          },
        });
      }),
    );

    const message = await failureOf(
      preflightWith({ graph, ...production }, { client: fakeClient(state) }),
    );

    expect(message).toStartWith(
      'Deploy failed. 2 platform variables a service needs have no value:\n' +
        '  - at least one of KEY_A, KEY_B  (service "app.billing" needs at least one of them: one of a, b is required)\n\n' +
        'Set them on the platform, then deploy again:\n',
    );
  });

  test('only the variables whose absence alone fails the schema are required', async () => {
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(
          compute({ name: 'billing', deps: {}, input: requiresSecrets('stripeKey'), build }),
          {
            id: 'billing',
            input: {
              stripeKey: provision(variable.secret({ name: 'STRIPE_SECRET_KEY' })),
              webhookSecret: provision(variable.secret({ name: 'STRIPE_WEBHOOK_SECRET' })),
            },
          },
        );
      }),
    );

    const message = await failureOf(
      preflightWith({ graph, ...production }, { client: fakeClient(state) }),
    );

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain('STRIPE_WEBHOOK_SECRET');
  });

  test('a variable in an array position with no row is required, whatever the schema says', async () => {
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
          id: 'ingest',
          input: { keys: [provision(variable.secret({ name: 'KEY_A' }))] },
        });
      }),
    );

    const message = await failureOf(
      preflightWith({ graph, ...production }, { client: fakeClient(state) }),
    );

    expect(message).toContain(
      '  - KEY_A  (read by service "app.ingest", field "keys.0")\n' +
        '      required by service "app.ingest": an array position reads it, and an array position cannot be left out\n',
    );
  });

  test('an input that fails with every variable present is an invalid input, never blamed on a variable', async () => {
    const message = await failureOf(
      preflightWith(
        { graph: secretGraph(neverSchema), ...production },
        { client: fakeClient(state) },
      ),
    );

    expect(message).toStartWith('invalid input for service "app.ingest"');
    expect(message).toContain('region is required');
    expect(message).not.toContain('platform variable a service needs');
  });

  test('a row the environment sees that the platform manages itself fails, naming the variable', async () => {
    state.rows = [
      {
        projectId: 'proj',
        class: 'preview',
        key: 'STRIPE_SECRET_KEY',
        branchId: null,
        isManagedBySystem: true,
      },
    ];

    const message = await failureOf(
      preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) }),
    );

    expect(message).toContain(
      '"STRIPE_SECRET_KEY" is a platform variable that Prisma Cloud manages itself',
    );
  });

  test("another branch's row that the platform manages is not seen", async () => {
    state.rows = [
      {
        projectId: 'proj',
        class: 'preview',
        key: 'STRIPE_SECRET_KEY',
        branchId: 'br-2',
        isManagedBySystem: true,
      },
    ];

    await preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) });
  });

  test('a literal-bound param never reaches the platform — no calls at all', async () => {
    await preflightWith(
      { graph: literalParamGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.gets).toEqual([]);
  });

  test("a secret a service receives through a module's input is named as read by the service", async () => {
    const mail = module(
      'mail',
      { input: type({ key: secretString() }) },
      ({ input, provision }) => {
        provision(compute({ name: 'sender', deps: {}, input: requiresSecrets('key'), build }), {
          id: 'sender',
          input: { key: input.key },
        });
      },
    );
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(mail, { input: { key: provision(variable.secret({ name: 'MAIL_KEY' })) } });
      }),
    );

    const message = await failureOf(
      preflightWith({ graph, ...production }, { client: fakeClient(state) }),
    );

    expect(message).toContain('  - MAIL_KEY  (read by service "app.mail.sender", field "key")');
  });

  test('a value in the app secrets or the shell does not satisfy a required variable', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'shell';
    try {
      const message = await withValues({ secrets: { STRIPE_SECRET_KEY: 'pool' } }, () =>
        failureOf(
          preflightWith(
            { graph: requiredSecretGraph(), ...production },
            { client: fakeClient(state) },
          ),
        ),
      );
      expect(message).toStartWith(
        'Deploy failed. 1 platform variable a service needs has no value',
      );
    } finally {
      delete process.env['STRIPE_SECRET_KEY'];
    }
  });

  test('no value appears in what preflight hands back or in its error', async () => {
    const sentinel = 'sk_live_SENTINEL';
    const result = await withValues({ secrets: { STRIPE_SECRET_KEY: sentinel } }, () =>
      preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) }),
    );
    const message = await withValues({ secrets: { STRIPE_SECRET_KEY: sentinel } }, () =>
      failureOf(
        preflightWith({ graph: requiredSecretGraph(), ...preview }, { client: fakeClient(state) }),
      ),
    );

    expect(JSON.stringify({ ...result, updatedAt: [...result.updatedAt] })).not.toContain(sentinel);
    expect(message).not.toContain(sentinel);
  });

  describe('env-var listing pagination (bounded — drivePagesAsync)', () => {
    test('a visible row beyond the first page still counts as present', async () => {
      state.pageSize = 1;
      state.rows = [
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: 'br-other' },
        { projectId: 'proj', class: 'preview', key: 'STRIPE_SECRET_KEY', branchId: null },
      ];

      await preflightWith(
        { graph: requiredSecretGraph(), ...preview },
        { client: fakeClient(state) },
      );

      expect(state.gets).toHaveLength(2);
    });

    test('a non-advancing cursor fails as broken pagination instead of looping', async () => {
      state.pageSize = 1;
      state.cursorStuck = true;

      await expect(
        preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) }),
      ).rejects.toThrow(/pagination appears broken.*possibly incomplete listing/);
    });

    test('pagination that never ends fails at the page cap instead of hanging', async () => {
      state.pageSize = 1;
      state.cursorRunaway = true;

      await expect(
        preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) }),
      ).rejects.toThrow(/did not finish within 1000 pages/);
    });

    test('more pages reported without a cursor fails instead of accepting a partial listing', async () => {
      state.pageSize = 1;
      state.cursorMissing = true;

      await expect(
        preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) }),
      ).rejects.toThrow(/reported more pages but returned no cursor/);
    });
  });

  describe('the rotation timestamps it hands back', () => {
    const row = (branchId: string | null, updatedAt: string): Row => ({
      projectId: 'proj',
      class: 'preview',
      key: 'STRIPE_SECRET_KEY',
      branchId,
      updatedAt,
    });
    const timestampsFor = async () =>
      (
        await preflightWith(
          {
            graph: secretGraph(),
            container: fakeContainer('proj', 'br-1'),
            environment: 'feature',
          },
          { client: fakeClient(state) },
        )
      ).updatedAt;

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

      const { updatedAt } = await preflightWith(
        { graph: secretGraph(), ...production },
        { client: fakeClient(state) },
      );

      expect([...updatedAt]).toEqual([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']]);
    });

    test("with a class row and this branch's row, the branch row's time is handed back", async () => {
      state.rows = [row(null, '2026-05-05T12:00:00.000Z'), row('br-1', '2026-07-07T12:00:00.000Z')];

      expect((await timestampsFor()).get('STRIPE_SECRET_KEY')).toBe('2026-07-07T12:00:00.000Z');
    });

    test('the branch row wins even when the class row is newer', async () => {
      state.rows = [row(null, '2026-08-08T12:00:00.000Z'), row('br-1', '2026-07-07T12:00:00.000Z')];

      expect((await timestampsFor()).get('STRIPE_SECRET_KEY')).toBe('2026-07-07T12:00:00.000Z');
    });

    test('a newer class row under a branch row changes nothing', async () => {
      state.rows = [row(null, '2026-05-05T12:00:00.000Z'), row('br-1', '2026-07-07T12:00:00.000Z')];
      const before = await timestampsFor();
      state.rows = [row(null, '2026-09-09T12:00:00.000Z'), row('br-1', '2026-07-07T12:00:00.000Z')];

      expect(await timestampsFor()).toEqual(before);
    });

    test('with no branch row, the class row is handed back', async () => {
      state.rows = [row(null, '2026-05-05T12:00:00.000Z')];

      expect((await timestampsFor()).get('STRIPE_SECRET_KEY')).toBe('2026-05-05T12:00:00.000Z');
    });

    test('a row belonging to ANOTHER branch is not in scope and does not date this one', async () => {
      state.rows = [
        row(null, '2026-05-05T12:00:00.000Z'),
        row('br-other', '2026-09-09T12:00:00.000Z'),
      ];

      expect((await timestampsFor()).get('STRIPE_SECRET_KEY')).toBe('2026-05-05T12:00:00.000Z');
    });

    test('a name with no row has no time', async () => {
      expect((await timestampsFor()).has('STRIPE_SECRET_KEY')).toBe(false);
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
    state = { gets: [], posts: [], rows: [] };
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
    };

    await preflight(state);
  });
});

describe('preflight names', () => {
  test('a secret source that is not a platform variable fails preflight, naming the place and the service', async () => {
    const graph = Load(
      module('app', ({ provision }) => {
        provision(compute({ name: 'web', deps: {}, input: anySchema, build }), {
          id: 'web',
          input: { stripe: { key: secretSource('STRIPE_SECRET_KEY') } },
        });
      }),
    );

    expect(
      await failureOf(
        preflightWith(
          { graph, ...production },
          { client: fakeClient({ gets: [], posts: [], rows: [] }) },
        ),
      ),
    ).toBe(
      'input key "stripe.key" of service "app.web" is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.',
    );
  });

  test("a secret node's value and its ArkType copy are one name to check", () => {
    const key = secretVariable('STRIPE_SECRET_KEY');

    expect(inputVariableNames({ a: key, b: copyOf(key) }, 'app.web')).toEqual([
      { name: 'STRIPE_SECRET_KEY', secret: true },
    ]);
  });
});

describe('the deploy check of platform variable nodes', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { gets: [], posts: [], rows: [] };
  });

  const commands = (name: string) => [
    `prisma project env add '${name}=<value>' --project 'proj' --role production`,
  ];

  const mailGraph = (schema: StandardSchemaV1<unknown, unknown>) =>
    Load(
      appRoot('shop', ({ provision }) => {
        const from = provision(variable({ name: 'EMAIL_FROM' }));
        const key = provision(variable.secret({ name: 'EMAIL_KEY' }));
        provision(compute({ name: 'mail', deps: {}, input: schema, build }), {
          input: { from, key },
        });
      }),
    );

  test('a required unset plain node fails the deploy, naming it and its reader', async () => {
    state.rows = [{ projectId: 'proj', class: 'production', key: 'EMAIL_KEY', branchId: null }];

    const message = await failureOf(
      preflightWith(
        { graph: mailGraph(requiresOneOf('from')), ...production },
        { client: fakeClient(state) },
      ),
    );

    expect(message).toContain('  - EMAIL_FROM  (read by service "shop.mail", field "from")');
    expect(message).not.toContain('EMAIL_KEY');
  });

  test('a required unset secret node fails the deploy', async () => {
    state.rows = [{ projectId: 'proj', class: 'production', key: 'EMAIL_FROM', branchId: null }];

    const message = await failureOf(
      preflightWith(
        { graph: mailGraph(requiresSecrets('key')), ...production },
        { client: fakeClient(state) },
      ),
    );

    expect(message).toContain('  - EMAIL_KEY  (read by service "shop.mail", field "key")');
  });

  test('an optional unset node is reported, never required', async () => {
    const result = await preflightWith(
      { graph: mailGraph(anySchema), ...production },
      { client: fakeClient(state) },
    );

    expect(result.findings.unset).toEqual([
      {
        name: 'EMAIL_FROM',
        readers: [{ kind: 'field', service: 'shop.mail', path: 'from' }],
        commands: commands('EMAIL_FROM'),
      },
      {
        name: 'EMAIL_KEY',
        readers: [{ kind: 'field', service: 'shop.mail', path: 'key' }],
        commands: commands('EMAIL_KEY'),
      },
    ]);
  });

  test('a node with a row passes and its row time is handed back', async () => {
    state.rows = [
      { projectId: 'proj', class: 'production', key: 'EMAIL_FROM', branchId: null },
      { projectId: 'proj', class: 'production', key: 'EMAIL_KEY', branchId: null },
    ];

    const result = await preflightWith(
      { graph: mailGraph(requiresSecrets('key')), ...production },
      { client: fakeClient(state) },
    );

    expect(result.findings.unset).toEqual([]);
    expect([...result.updatedAt.keys()].sort()).toEqual(['EMAIL_FROM', 'EMAIL_KEY']);
  });

  test('an unread plain node, an unread secret node and a secret node only a module receives are each listed once, named by their node', async () => {
    const mail = module('mail', { input: type({ key: secretString() }) }, () => {});
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'UNREAD_FROM' }));
        provision(variable.secret({ name: 'UNREAD_KEY' }));
        const key = provision(variable.secret({ name: 'MAIL_KEY' }));
        provision(mail, { input: { key } });
      }),
    );

    const result = await preflightWith({ graph, ...production }, { client: fakeClient(state) });

    expect(result.findings.unset).toEqual([
      {
        name: 'MAIL_KEY',
        readers: [{ kind: 'unread', node: 'shop.mailKey' }],
        commands: commands('MAIL_KEY'),
      },
      {
        name: 'UNREAD_FROM',
        readers: [{ kind: 'unread', node: 'shop.unreadFrom' }],
        commands: commands('UNREAD_FROM'),
      },
      {
        name: 'UNREAD_KEY',
        readers: [{ kind: 'unread', node: 'shop.unreadKey' }],
        commands: commands('UNREAD_KEY'),
      },
    ]);
    expect(result.findings.unset[1]?.readers.map(platformVariableReaderText)).toEqual([
      'named by resource "shop.unreadFrom", read by no service',
    ]);
  });

  test('a node bound to a plain field through a cast fails as an invalid input that names the variable', async () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const from = provision(variable({ name: 'EMAIL_FROM' }));
        const key = provision(variable.secret({ name: 'EMAIL_KEY' }));
        provision(
          compute({
            name: 'mail',
            deps: {},
            input: type({ from: 'string', key: secretString() }),
            build,
          }),
          { input: { from: from as unknown as string, key } },
        );
      }),
    );

    const message = await failureOf(
      preflightWith({ graph, ...production }, { client: fakeClient(state) }),
    );

    expect(message).toStartWith('invalid input for service "shop.mail": ');
    expect(message).toEndWith('\nThe field "from" reads the platform variable "EMAIL_FROM".');
  });

  test('a schema that needs one of several unset variables gets one line naming them all, and no line naming a field', async () => {
    const needsOne: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          const record = typeof value === 'object' && value !== null ? value : {};
          return 'from' in record || 'key' in record
            ? { value }
            : { issues: [{ message: 'need from or key', path: ['from'] }] };
        },
      },
    };

    const message = await failureOf(
      preflightWith({ graph: mailGraph(needsOne), ...production }, { client: fakeClient(state) }),
    );

    expect(message).toContain(
      '  - at least one of EMAIL_FROM, EMAIL_KEY  (service "shop.mail" needs at least one of them: need from or key)',
    );
    expect(message).not.toContain('reads the platform variable');
  });

  test('a planted secret under a secret node appears in neither the findings, their rendered readers, nor the error', async () => {
    const planted = 'Zq7Xw9Vb3kLm2Rt';
    const hold = { secrets: { EMAIL_KEY: planted }, configuration: { EMAIL_KEY: planted } };
    const result = await withValues(hold, () =>
      preflightWith({ graph: mailGraph(anySchema), ...production }, { client: fakeClient(state) }),
    );
    const message = await withValues(hold, () =>
      failureOf(
        preflightWith(
          { graph: mailGraph(requiresSecrets('key')), ...production },
          { client: fakeClient(state) },
        ),
      ),
    );

    const rendered = result.findings.unset
      .flatMap((variable) => variable.readers.map(platformVariableReaderText))
      .join('\n');
    for (const text of [JSON.stringify(result.findings), rendered, message]) {
      for (let start = 0; start + 4 <= planted.length; start += 1) {
        expect(text).not.toContain(planted.slice(start, start + 4));
      }
    }
  });
});

describe("preflight identifies Composer on the caller's client", () => {
  test("every environment-variable lookup through the caller's client carries Composer's headers", async () => {
    const state: FakeState = {
      gets: [],
      posts: [],
      rows: [{ projectId: 'proj', class: 'production', key: 'STRIPE_SECRET_KEY', branchId: null }],
    };
    const headersSeen: unknown[] = [];
    const fake = fakeClient(state);
    const caller = {
      ...fake,
      GET: async (
        path: string,
        init: { params: { query: Record<string, string> }; headers?: unknown },
      ) => {
        headersSeen.push(init.headers);
        return fake.GET(path as never, init as never);
      },
    } as unknown as ManagementApiClient;

    await preflightWith({
      graph: requiredSecretGraph(),
      ...production,
      credentials: { workspaceId: undefined, client: caller },
    });

    expect(headersSeen.length).toBeGreaterThan(0);
    for (const headers of headersSeen) {
      expect(headers).toMatchObject({
        'x-prisma-client-name': 'composer',
        'x-prisma-client-version': expect.stringMatching(/^\d+\.\d+\.\d+/),
      });
    }
  });
});
