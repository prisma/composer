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

/** A resolved container: a named environment carries its branch id, production its project's default branch id. */
const fakeContainer = (projectId: string, branchId: string | undefined) =>
  new PrismaCloudContainer(
    { appName: 'app', environment: branchId === undefined ? 'production' : 'pr-1' },
    projectId,
    branchId,
    branchId === undefined ? DEFAULT_BRANCH_ID : undefined,
  );

const DEFAULT_BRANCH_ID = 'br-default';

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
}

type Source =
  | { type: 'group'; groupId: string; groupName: string; groupClass: string }
  | { type: 'branchOverride' }
  | { type: 'service'; serviceId: string };

/** One key the resolved-variables read lists for the branch. */
interface Entry {
  key: string;
  updatedAt?: string;
  isManagedBySystem?: boolean;
  source?: Source;
}

interface Group {
  id: string;
  name: string;
  class: 'production' | 'preview' | 'custom';
}

/** What a key the test did not date reads as. */
const DEFAULT_UPDATED_AT = '2026-01-01T00:00:00.000Z';

const RESOLVED_VARIABLES_PATH = '/v1/projects/{projectId}/resolved-variables';

interface FakeState {
  /** Queries of the environment-variable list. */
  gets: Record<string, string>[];
  /** Each resolved-variables read, by the project and branch it asked about. */
  reads: { projectId: string; branchId: string }[];
  posts: Record<string, unknown>[];
  rows: Row[];
  entries: Entry[];
  /** The group the branch receives; unset gives `production` for the default branch and `preview` otherwise. */
  group?: Group;
  /** Replaces the read's answer: an error status, or a body of the test's own. */
  answer?: { status: number; body?: unknown; error?: unknown };
  /** Makes the read throw, as the client does on a network failure or a body that is not JSON. */
  throws?: Error;
}

const emptyState = (): FakeState => ({ gets: [], reads: [], posts: [], rows: [], entries: [] });

const builtInGroup = (branchId: string): Group =>
  branchId === DEFAULT_BRANCH_ID
    ? { id: 'grp-production', name: 'production', class: 'production' }
    : { id: 'grp-preview', name: 'preview', class: 'preview' };

/** A stubbed Management API client — test file, exempt from the no-bare-cast rule. */
const fakeClient = (state: FakeState): ManagementApiClient =>
  ({
    GET: async (
      path: string,
      init: {
        params: { path?: Record<string, string>; query: Record<string, string> };
      },
    ) => {
      if (path === RESOLVED_VARIABLES_PATH) {
        const projectId = init.params.path?.['projectId'] ?? '';
        const branchId = init.params.query['branchId'] ?? '';
        state.reads.push({ projectId, branchId });
        if (state.throws !== undefined) throw state.throws;
        if (state.answer !== undefined) {
          const ok = state.answer.status < 400;
          return {
            data: ok ? state.answer.body : undefined,
            error: ok ? undefined : state.answer.error,
            response: new Response(null, { status: state.answer.status }),
          };
        }
        const group = state.group ?? builtInGroup(branchId);
        return {
          data: {
            group,
            data: state.entries.map((entry) => ({
              key: entry.key,
              updatedAt: entry.updatedAt ?? DEFAULT_UPDATED_AT,
              isManagedBySystem: entry.isManagedBySystem ?? false,
              source: entry.source ?? {
                type: 'group',
                groupId: group.id,
                groupName: group.name,
                groupClass: group.class,
              },
            })),
          },
          error: undefined,
          response: new Response(null, { status: 200 }),
        };
      }
      const q = init.params.query;
      state.gets.push(q);
      const rows = state.rows.filter(
        (r) => r.projectId === q['projectId'] && r.class === q['class'] && r.key === q['key'],
      );
      return {
        data: {
          data: rows.map((r) => ({ ...r, updatedAt: DEFAULT_UPDATED_AT })),
          pagination: { nextCursor: null, hasMore: false },
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

describe('the deploy check reads which variables the branch receives and sets none', () => {
  let state: FakeState;

  beforeEach(() => {
    state = emptyState();
  });

  const manyNamesGraph = (names: readonly string[]) =>
    Load(
      appRoot('app', ({ provision }) => {
        provision(compute({ name: 'ingest', deps: {}, input: anySchema, build }), {
          id: 'ingest',
          input: Object.fromEntries(
            names.map((name) => [name.toLowerCase(), provision(variable.secret({ name }))]),
          ),
        });
      }),
    );

  test("a key from the branch's group is present, and its time is handed back", async () => {
    state.entries = [{ key: 'STRIPE_SECRET_KEY', updatedAt: '2026-05-05T12:00:00.000Z' }];

    const result = await preflightWith(
      { graph: requiredSecretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect([...result.updatedAt]).toEqual([['STRIPE_SECRET_KEY', '2026-05-05T12:00:00.000Z']]);
    expect(result.findings).toEqual({ unset: [] });
  });

  test("a key from the branch's override is present, and its time is handed back", async () => {
    state.entries = [
      {
        key: 'STRIPE_SECRET_KEY',
        updatedAt: '2026-07-07T12:00:00.000Z',
        source: { type: 'branchOverride' },
      },
    ];

    const result = await preflightWith(
      { graph: requiredSecretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect([...result.updatedAt]).toEqual([['STRIPE_SECRET_KEY', '2026-07-07T12:00:00.000Z']]);
  });

  test('a key the read does not list is unset and has no time', async () => {
    state.entries = [{ key: 'SOMETHING_ELSE' }];

    const result = await preflightWith(
      { graph: secretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect(result.findings.unset.map((variable) => variable.name)).toEqual(['STRIPE_SECRET_KEY']);
    expect(result.updatedAt.has('STRIPE_SECRET_KEY')).toBe(false);
  });

  test('a listed key the platform manages itself fails, naming the variable', async () => {
    state.entries = [{ key: 'STRIPE_SECRET_KEY', isManagedBySystem: true }];

    const message = await failureOf(
      preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) }),
    );

    expect(message).toContain(
      '"STRIPE_SECRET_KEY" is a platform variable that Prisma Cloud manages itself',
    );
  });

  test('reads once per deploy, however many names the app has', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `KEY_${index}`);

    await preflightWith(
      { graph: manyNamesGraph(names), ...production },
      { client: fakeClient(state) },
    );

    expect(state.reads).toHaveLength(1);
    expect(state.gets).toEqual([]);
  });

  test('production reads the project default branch', async () => {
    await preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) });

    expect(state.reads).toEqual([{ projectId: 'proj', branchId: DEFAULT_BRANCH_ID }]);
  });

  test('another environment reads its own branch', async () => {
    await preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) });

    expect(state.reads).toEqual([{ projectId: 'proj', branchId: 'br-1' }]);
  });

  test('a graph with no platform variable makes no platform call and returns nothing', async () => {
    const result = await preflightWith(
      { graph: noSecretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.reads).toEqual([]);
    expect(state.gets).toEqual([]);
    expect(result).toEqual({ updatedAt: new Map(), findings: { unset: [] } });
  });

  test('a value Composer generates needs no platform check', async () => {
    await preflightWith({ graph: generatedGraph(), ...production }, { client: fakeClient(state) });

    expect(state.reads).toEqual([]);
  });

  test('a literal-bound param never reaches the platform', async () => {
    await preflightWith(
      { graph: literalParamGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.reads).toEqual([]);
    expect(state.gets).toEqual([]);
  });

  const COULD_NOT_READ =
    'Deploy failed. Composer could not read which variables branch "br-1" of project "proj" receives: GET /v1/projects/proj/resolved-variables?branchId=br-1';

  const failedReadMessage = async () => {
    const message = await failureOf(
      preflightWith({ graph: secretGraph(), ...preview }, { client: fakeClient(state) }),
    );
    expect(state.reads).toHaveLength(1);
    expect(state.gets).toEqual([]);
    expect(state.posts).toEqual([]);
    return message;
  };

  describe('a failed read fails the deploy, naming the call, the project and the branch', () => {
    test.each([
      ['an unknown project', { code: 'not-found', message: 'Project not found' }],
      ['an unknown branch', { code: 'not-found', message: 'Branch not found' }],
    ])('%s answers 404, which says the platform may not offer the read', async (_case, error) => {
      state.answer = { status: 404, error: { error } };

      expect(await failedReadMessage()).toBe(
        `${COULD_NOT_READ} answered HTTP 404: ${JSON.stringify({ error })}. ` +
          'The platform may not offer this read yet, and this Composer version needs it to check platform variables.',
      );
    });

    test('a server error names its status and body, and does not blame a missing read', async () => {
      state.answer = { status: 500, error: { error: { code: 'internal', message: 'boom' } } };

      expect(await failedReadMessage()).toBe(
        `${COULD_NOT_READ} answered HTTP 500: {"error":{"code":"internal","message":"boom"}}.`,
      );
    });

    test('an error status with an empty body names the status', async () => {
      state.answer = { status: 502 };

      expect(await failedReadMessage()).toBe(`${COULD_NOT_READ} answered HTTP 502.`);
    });

    test('a network failure names the call and keeps the cause', async () => {
      const cause = new TypeError('fetch failed');
      state.throws = cause;

      const error = await preflightWith(
        { graph: secretGraph(), ...preview },
        { client: fakeClient(state) },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`${COULD_NOT_READ} failed: fetch failed.`);
      expect((error as Error).cause).toBe(cause);
    });

    test('a body that is not JSON names the call', async () => {
      state.throws = new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');

      expect(await failedReadMessage()).toBe(
        `${COULD_NOT_READ} failed: Unexpected token '<', "<html>" is not valid JSON.`,
      );
    });

    test('a body without the group names the call and says the answer may have changed', async () => {
      state.answer = { status: 200, body: { data: [] } };

      const message = await failedReadMessage();

      expect(message).toStartWith(
        `${COULD_NOT_READ} answered with a body this Composer version cannot read: `,
      );
      expect(message).toEndWith(
        "The platform's answer may have changed, and a newer Composer version may read it.",
      );
    });
  });

  test.each([
    ['a pagination object with more to fetch', { pagination: { nextCursor: 'c1', hasMore: true } }],
    ['a pagination object with a cursor', { pagination: { nextCursor: 'c1', hasMore: false } }],
    ['a next cursor', { nextCursor: 'c1' }],
    ['a cursor', { cursor: 'c1' }],
    ['a more-pages flag', { hasMore: true }],
  ])(
    'an answer that says it has more, with %s, fails the deploy as too old for the platform',
    async (_case, extra) => {
      state.answer = { status: 200, body: { group: builtInGroup('br-1'), data: [], ...extra } };

      const message = await failedReadMessage();

      expect(message).toStartWith(`${COULD_NOT_READ} answered with one page of a longer list.`);
      expect(message).toContain('too old for the platform');
    },
  );

  test.each([
    ['a complete pagination object', { pagination: { nextCursor: null, hasMore: false } }],
    ['top-level fields that say nothing is left', { nextCursor: null, hasMore: false, cursor: '' }],
  ])('a complete answer in a list envelope, with %s, is accepted', async (_case, extra) => {
    state.answer = {
      status: 200,
      body: {
        group: builtInGroup('br-1'),
        data: [
          { key: 'STRIPE_SECRET_KEY', updatedAt: DEFAULT_UPDATED_AT, isManagedBySystem: false },
        ],
        ...extra,
      },
    };

    const result = await preflightWith(
      { graph: requiredSecretGraph(), ...preview },
      { client: fakeClient(state) },
    );

    expect([...result.updatedAt]).toEqual([['STRIPE_SECRET_KEY', DEFAULT_UPDATED_AT]]);
  });

  describe('the commands that set a missing variable follow the group the branch receives', () => {
    const commandsFor = async (group: Group | undefined, environment = preview) => {
      if (group !== undefined) state.group = group;
      const result = await preflightWith(
        { graph: secretGraph(), ...environment },
        { client: fakeClient(state) },
      );
      return result.findings.unset[0]?.commands;
    };

    test('production', async () => {
      expect(await commandsFor(undefined, production)).toEqual([
        "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role production",
      ]);
    });

    test('preview', async () => {
      expect(await commandsFor(undefined)).toEqual([
        "prisma project env add 'STRIPE_SECRET_KEY=<value>' --project 'proj' --role preview",
      ]);
    });

    test('a custom group is named in a sentence, since no command writes to it', async () => {
      expect(await commandsFor({ id: 'grp-1', name: "team's staging", class: 'custom' })).toEqual([
        `Set STRIPE_SECRET_KEY in the variable group "team's staging" in the Prisma Console.`,
      ]);
    });

    test('a group of a class Composer does not know gets the custom-group sentence', async () => {
      expect(
        await commandsFor({ id: 'grp-2', name: 'qa', class: 'experimental' as Group['class'] }),
      ).toEqual([`Set STRIPE_SECRET_KEY in the variable group "qa" in the Prisma Console.`]);
    });

    test('no command sets a branch override', async () => {
      const all = [
        ...((await commandsFor(undefined, production)) ?? []),
        ...((await commandsFor(undefined)) ?? []),
        ...((await commandsFor({ id: 'grp-1', name: 'staging', class: 'custom' })) ?? []),
      ];

      expect(all).toHaveLength(3);
      expect(all.join('\n')).not.toContain('--branch');
    });
  });

  test('sets no platform variable, even when the app secrets hold a value for a missing name', async () => {
    await withValues({ secrets: { STRIPE_SECRET_KEY: 'sk_live_fill' } }, async () => {
      await preflightWith({ graph: secretGraph(), ...production }, { client: fakeClient(state) });
      await preflightWith(
        { graph: requiredSecretGraph(), ...preview },
        { client: fakeClient(state) },
      ).catch(() => undefined);
    });

    expect(state.reads.length).toBeGreaterThan(0);
    expect(state.posts).toEqual([]);
  });

  test('a required variable with no value fails in production, naming the reader and the one command', async () => {
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

  test('a required variable with no value on a custom group fails, naming the group', async () => {
    state.group = { id: 'grp-1', name: 'staging', class: 'custom' };

    const message = await failureOf(
      preflightWith({ graph: requiredSecretGraph(), ...preview }, { client: fakeClient(state) }),
    );

    expect(message).toEndWith(
      'Set it on the platform, then deploy again:\n' +
        '  - Set STRIPE_SECRET_KEY in the variable group "staging" in the Prisma Console.',
    );
  });

  test('a variable with no value that nothing requires passes and is reported with its reader and commands', async () => {
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
          ],
        },
      ],
    });
    expect(result.updatedAt.size).toBe(0);
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
    state.entries = [{ key: 'STRIPE_SECRET_KEY' }];
    await run(secretGraph());

    expect(first.findings.unset.map((variable) => variable.name)).toEqual(['STRIPE_SECRET_KEY']);
    expect(reports).toEqual([
      { checked: 1, ...first.findings },
      { checked: 1, unset: [] },
    ]);
  });

  test('the same platform name bound by two services is checked once, and the finding names both readers', async () => {
    const result = await preflightWith(
      { graph: sharedNestedSecretGraph(), ...production },
      { client: fakeClient(state) },
    );

    expect(state.reads).toHaveLength(1);
    expect(result.findings.unset).toHaveLength(1);
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

  test('a variable in an array position with no value is required, whatever the schema says', async () => {
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
    state = emptyState();
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

  test('passes once that variable is deleted, and an app with no platform variable reads none', async () => {
    await preflight();

    expect(state.gets.length).toBeGreaterThan(0);
    expect(state.reads).toEqual([]);
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
      ...emptyState(),
      rows: [row('COMPOSER_SHOP_X_ORIGIN'), row('COMPOSER_SHOP_SHOP_X_ORIGIN')],
    };

    const message = String(await preflight(state).catch((e: unknown) => e));

    expect(message).toContain('COMPOSER_SHOP_X_ORIGIN belongs to "shop.shop.x"');
    expect(message).toContain('COMPOSER_SHOP_SHOP_X_ORIGIN belongs to "shop.shop.shop.x"');
  });

  test('passes once every node has moved', async () => {
    const state: FakeState = {
      ...emptyState(),
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
        preflightWith({ graph, ...production }, { client: fakeClient(emptyState()) }),
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
    state = emptyState();
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
    state.entries = [{ key: 'EMAIL_KEY' }];

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
    state.entries = [{ key: 'EMAIL_FROM' }];

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

  test('a node the branch receives passes and its time is handed back', async () => {
    state.entries = [{ key: 'EMAIL_FROM' }, { key: 'EMAIL_KEY' }];

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
  test("the read of the branch's variables through the caller's client carries Composer's headers", async () => {
    const state: FakeState = { ...emptyState(), entries: [{ key: 'STRIPE_SECRET_KEY' }] };
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

    expect(state.reads).toHaveLength(1);
    expect(headersSeen).toHaveLength(1);
    for (const headers of headersSeen) {
      expect(headers).toMatchObject({
        'x-prisma-client-name': 'composer',
        'x-prisma-client-version': expect.stringMatching(/^\d+\.\d+\.\d+/),
      });
    }
  });
});
