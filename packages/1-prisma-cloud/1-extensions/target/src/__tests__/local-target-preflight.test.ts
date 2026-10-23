import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load, module, type ServiceNode } from '@internal/core';
import { preflightEnv } from '@internal/core/config';
import { SecretBox } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID, PrismaCloudContainer } from '../container.ts';
import {
  pointerUpdatedAtLookup,
  serializePointerUpdatedAt,
} from '../control/pointer-timestamps.ts';
import { readDevPreflightPayload, transportedAbsentSecrets } from '../dev-preflight-payload.ts';
import { compute } from '../exports/index.ts';
import { runDevPreflight } from '../local-target/preflight.ts';
import { envParam } from '../param.ts';
import { envSecret } from '../secret.ts';
import { serializeInput } from '../serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const fakeContainer = () =>
  new PrismaCloudContainer(
    { appName: 'app', stage: undefined },
    'local',
    undefined,
    undefined,
    true,
  );

/** Passes when every field named in `required` holds a secret. */
const requiresSecrets = (...required: string[]): StandardSchemaV1<unknown, unknown> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const record = typeof value === 'object' && value !== null ? value : {};
      const missing = required.filter(
        (key) => !(Object.getOwnPropertyDescriptor(record, key)?.value instanceof SecretBox),
      );
      return missing.length === 0
        ? { value }
        : { issues: missing.map((key) => ({ message: `${key} is required` })) };
    },
  },
});

/** Passes when at least one of `keys` holds a secret. */
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

const billingGraph = (schema: StandardSchemaV1<unknown, unknown>) =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'billing', deps: {}, input: schema, build }), {
        id: 'billing',
        input: {
          stripeKey: envSecret('STRIPE_SECRET_KEY'),
          webhookSecret: envSecret('STRIPE_WEBHOOK_SECRET'),
        },
      });
    }),
  );

const paramGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }), {
        id: 'web',
        params: { port: envParam('APP_PORT') },
      });
    }),
  );

const mixedGraph = (schema: StandardSchemaV1<unknown, unknown>) =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'billing', deps: {}, input: schema, build }), {
        id: 'billing',
        input: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
      provision(compute({ name: 'web', deps: {}, build }), {
        id: 'web',
        params: { port: envParam('APP_PORT') },
      });
    }),
  );

const NAMES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_PORT'];

const preflight = (graph: ReturnType<typeof Load>) =>
  runDevPreflight({ graph, container: fakeContainer(), stage: undefined });

async function preflightError(graph: ReturnType<typeof Load>): Promise<string> {
  const error: unknown = await preflight(graph).catch((e: unknown) => e);
  if (!(error instanceof Error)) throw new Error('expected the preflight to fail');
  return error.message;
}

/** What the alchemy process sees after the CLI transports the payload. */
function transported(payload: string | undefined): Record<string, string> {
  return preflightEnv(
    payload === undefined ? new Map() : new Map([[PRISMA_CLOUD_EXTENSION_ID, payload]]),
  );
}

function billingDocument(
  graph: ReturnType<typeof Load>,
  childEnv: Record<string, string>,
): unknown {
  const node = graph.nodes.find((entry) => entry.id === 'billing')?.node as ServiceNode;
  const binding = graph.inputBindings.find((b) => b.serviceAddress === 'billing')?.binding;
  const row = serializeInput(node, 'billing', binding, {}, transportedAbsentSecrets(childEnv)());
  return JSON.parse(row?.value ?? 'null');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('prisma dev preflight', () => {
  let cwd: string;
  let previousCwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preflight-test-'));
    previousCwd = process.cwd();
    process.chdir(cwd);
    for (const name of NAMES) delete process.env[name];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    for (const name of NAMES) delete process.env[name];
  });

  test('a required secret that is unset stops dev, naming the variable, the service and both fixes', async () => {
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "billing"');
    expect(message).toContain('stripeKey is required');
    expect(message).toContain('export it in the shell you run `prisma dev` from');
    expect(message).toContain(
      "install the dotenv package and add import 'dotenv/config' at the top of prisma.config.ts",
    );
    expect(message).toContain('only when the CLI runs under Node: Bun does not implement it');
  });

  test('a required secret that is set to an empty string stops dev the same way', async () => {
    process.env['STRIPE_SECRET_KEY'] = '';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY  (required by service "billing"');
  });

  test('the error lists every missing required secret and leaves out the optional ones', async () => {
    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain('STRIPE_WEBHOOK_SECRET');

    const both = await preflightError(billingGraph(requiresSecrets('stripeKey', 'webhookSecret')));
    expect(both).toContain('STRIPE_SECRET_KEY  (required by service "billing"');
    expect(both).toContain('STRIPE_WEBHOOK_SECRET  (required by service "billing"');
  });

  test('when the schema needs some of several unset secrets but none alone, the error says so instead of calling each one required', async () => {
    const message = await preflightError(billingGraph(requiresOneOf('stripeKey', 'webhookSecret')));

    expect(message).toContain('some of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET');
    expect(message).not.toContain('required by service');
  });

  test('an optional secret that is unset is left out of the service input', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_1';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('an optional secret that is set to an empty string is left out of the service input', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_1';
    process.env['STRIPE_WEBHOOK_SECRET'] = '';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('the payload reaches the alchemy process with the absent secrets and a hash of each value, never the value', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const childEnv = transported(await preflight(billingGraph(requiresSecrets('stripeKey'))));

    const payload = readDevPreflightPayload(childEnv);
    expect(payload?.absentSecrets).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(Object.keys(payload?.fingerprints ?? {})).toEqual(['STRIPE_SECRET_KEY']);
    expect(Object.values(childEnv).join('')).not.toContain('sk_test_1');
  });

  test("the deployment's trigger member for a secret changes exactly when its value changes", async () => {
    const graph = billingGraph(requiresSecrets('stripeKey'));
    const memberFor = async (value: string) => {
      process.env['STRIPE_SECRET_KEY'] = value;
      const lookup = pointerUpdatedAtLookup(new Map(), transported(await preflight(graph)));
      return lookup('STRIPE_SECRET_KEY');
    };

    const first = await memberFor('sk_test_1');
    expect(await memberFor('sk_test_1')).toBe(first);
    expect(await memberFor('sk_test_2')).not.toBe(first);
    expect(first).not.toBe(sha256('sk_test_1'));
  });

  test('an unset secret has no trigger member value', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const childEnv = transported(await preflight(billingGraph(requiresSecrets('stripeKey'))));

    expect(pointerUpdatedAtLookup(new Map(), childEnv)('STRIPE_WEBHOOK_SECRET')).toBeUndefined();
  });

  test('a missing env-sourced param is a hard error naming the variable and service', async () => {
    const message = await preflightError(paramGraph());

    expect(message).toContain('APP_PORT');
    expect(message).toContain('service "web"');
    expect(message).toContain('export it in the shell you run `prisma dev` from');
    expect(message).toContain("import 'dotenv/config'");
  });

  test('missing params and secrets are reported together, with the ways to set them given once', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('APP_PORT  (required by service "web")');
    expect(message).toContain('STRIPE_SECRET_KEY  (required by service "billing"');
    expect(message.split('Set each missing variable').length - 1).toBe(1);
  });

  test('an input that fails even with every secret set is reported as invalid, next to the other problems', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('somethingElse')));

    expect(message).toContain('invalid input for service "billing": somethingElse is required');
    expect(message).not.toContain('Deploy-time');
    expect(message).not.toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('APP_PORT  (required by service "web")');
  });

  test('an env-sourced param that is set is fingerprinted for the alchemy process', async () => {
    process.env['APP_PORT'] = '3000';

    const childEnv = transported(await preflight(paramGraph()));

    expect(Object.keys(readDevPreflightPayload(childEnv)?.fingerprints ?? {})).toEqual([
      'APP_PORT',
    ]);
  });

  test('the fingerprint key is created once, readable only by its owner, and reused', async () => {
    process.env['APP_PORT'] = '3000';
    const keyPath = path.join(cwd, '.prisma-composer', 'dev', 'fingerprint.key');

    const first = readDevPreflightPayload(transported(await preflight(paramGraph())));
    const key = fs.readFileSync(keyPath);
    const second = readDevPreflightPayload(transported(await preflight(paramGraph())));

    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyPath)).toEqual(key);
    expect(second?.fingerprints).toEqual(first?.fingerprints ?? {});
  });

  test('a lost fingerprint key only changes the fingerprints', async () => {
    process.env['APP_PORT'] = '3000';
    const keyPath = path.join(cwd, '.prisma-composer', 'dev', 'fingerprint.key');

    const first = readDevPreflightPayload(transported(await preflight(paramGraph())));
    fs.rmSync(keyPath);
    const second = readDevPreflightPayload(transported(await preflight(paramGraph())));

    expect(second?.fingerprints['APP_PORT']).not.toBe(first?.fingerprints['APP_PORT']);
  });

  test('a secrets file left by an older prisma dev is deleted', async () => {
    const devDir = path.join(cwd, '.prisma-composer', 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'secrets.json'), '{"STRIPE_SECRET_KEY":"sk_live_old"}');
    fs.writeFileSync(path.join(devDir, 'env.json'), '{}');

    await preflight(paramGraph()).catch(() => undefined);

    expect(fs.readdirSync(devDir)).toEqual(['env.json']);
  });
});

describe('deploy input serialization without a dev payload', () => {
  test('an unset secret still becomes a pointer in the document', () => {
    const graph = billingGraph(requiresSecrets('stripeKey', 'webhookSecret'));

    expect(billingDocument(graph, transported(undefined))).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      webhookSecret: { $secret: 'STRIPE_WEBHOOK_SECRET' },
    });
  });

  test('a deploy payload on the transport names no absent secret and still reads as timestamps', () => {
    const graph = billingGraph(requiresSecrets('stripeKey', 'webhookSecret'));
    const childEnv = transported(
      serializePointerUpdatedAt(new Map([['STRIPE_SECRET_KEY', '2026-10-01T00:00:00Z']])),
    );

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      webhookSecret: { $secret: 'STRIPE_WEBHOOK_SECRET' },
    });
    expect(pointerUpdatedAtLookup(new Map(), childEnv)('STRIPE_SECRET_KEY')).toBe(
      '2026-10-01T00:00:00Z',
    );
  });
});
