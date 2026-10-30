import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load, module, resolve, type ServiceNode } from '@internal/core';
import { preflightEnv } from '@internal/core/config';
import { SecretBox } from '@internal/foundation/secret';
import { rawHttpContract } from '@internal/http';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID, PrismaCloudContainer } from '../container.ts';
import { decodePreflightPayload, transportedPreflight } from '../control/preflight-payload.ts';
import { compute, publicUrl } from '../exports/index.ts';
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

const fakeContainer = (environment = 'dev') =>
  new PrismaCloudContainer({ appName: 'app', environment }, 'local', undefined, undefined, true);

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

const sharedGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(
        compute({ name: 'billing', deps: {}, input: requiresSecrets('stripeKey'), build }),
        {
          id: 'billing',
          input: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
        },
      );
      provision(compute({ name: 'reports', deps: {}, input: requiresSecrets(), build }), {
        id: 'reports',
        input: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

const webService = compute({ name: 'web', deps: {}, build, expose: { http: rawHttpContract } });

const publicUrlGraph = (environment: string) =>
  Load(
    module('shop', ({ provision }) => {
      const web = provision(webService);
      provision(publicUrl({ name: 'site', url: 'shop.com', target: web.http }));
      provision(
        publicUrl({ name: 'api', url: publicUrl.hostname('api.shop.com'), target: web.http }),
      );
      provision(publicUrl({ name: 'preview', url: publicUrl.prismaBuild(), target: web.http }));
    }),
    { environment: { name: environment } },
  );

const badPublicUrlGraph = () =>
  Load(
    module('shop', ({ environment, provision }) => {
      const web = provision(webService);
      const url = resolve([environment.name], () => 42) as unknown as string;
      provision(publicUrl({ name: 'site', url, target: web.http }));
    }),
    { environment: { name: 'dev' } },
  );

const sharedHostnameGraph = () =>
  Load(
    module('shop', ({ provision }) => {
      const web = provision(webService);
      provision(publicUrl({ name: 'site', url: 'shop.com', target: web.http }));
      provision(publicUrl({ name: 'www', url: publicUrl.hostname('Shop.COM.'), target: web.http }));
    }),
    { environment: { name: 'dev' } },
  );

const devPreflightWarnings = async (graph: ReturnType<typeof Load>, environment: string) => {
  const warnings: string[] = [];
  await runDevPreflight({
    graph,
    container: fakeContainer(environment),
    environment,
    pools: { config, secrets },
    warn: (message) => warnings.push(message),
  });
  return warnings;
};

/** What the dev command's adapters returned: the secrets pool and the config pool. */
let secrets: Record<string, string> = {};
let config: Record<string, unknown> = {};

const preflight = (graph: ReturnType<typeof Load>, environment = 'dev') =>
  runDevPreflight({
    graph,
    container: fakeContainer(environment),
    environment,
    pools: { config, secrets },
  });

/** The folder `prisma dev --environment <name>` keeps its local copy in. */
const environmentDir = (cwd: string, folder = 'dev') =>
  path.join(cwd, '.prisma-composer', 'dev', folder);

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
  const node = graph.nodes.find((entry) => entry.id === 'app.billing')?.node as ServiceNode;
  const binding = graph.inputBindings.find((b) => b.serviceAddress === 'app.billing')?.binding;
  const { absentSecrets } = transportedPreflight(new Map(), childEnv);
  const row = serializeInput(node, 'app.billing', binding, { env: {}, absentSecrets });
  return JSON.parse(row?.value ?? 'null');
}

/** The dev payload as the alchemy process decodes it. */
function devPayload(childEnv: Record<string, string>) {
  const decoded = decodePreflightPayload(
    childEnv['PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD'],
  );
  if (decoded.kind !== 'dev') throw new Error(`expected a dev payload, got ${decoded.kind}`);
  return decoded;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('prisma dev preflight', () => {
  let cwd: string;
  let previousCwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preflight-test-'));
    previousCwd = process.cwd();
    process.chdir(cwd);
    secrets = {};
    config = {};
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    secrets = {};
    config = {};
  });

  test('a required secret that is unset stops dev, naming the variable, the service and both fixes', async () => {
    secrets['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "app.billing"');
    expect(message).toContain('stripeKey is required');
    expect(message).toContain('the `secrets` list of the `composer` section for a secret');
    expect(message).toContain('environmentVariables() reads the shell you run `prisma dev` from');
  });

  test('a required secret that is set to an empty string stops dev the same way', async () => {
    secrets['STRIPE_SECRET_KEY'] = '';
    secrets['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY  (required by service "app.billing"');
  });

  test('the error lists every missing required secret and leaves out the optional ones', async () => {
    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain('STRIPE_WEBHOOK_SECRET');

    const both = await preflightError(billingGraph(requiresSecrets('stripeKey', 'webhookSecret')));
    expect(both).toContain('STRIPE_SECRET_KEY  (required by service "app.billing"');
    expect(both).toContain('STRIPE_WEBHOOK_SECRET  (required by service "app.billing"');
  });

  test('when the schema needs some of several unset secrets but none alone, the error says so instead of calling each one required', async () => {
    const message = await preflightError(billingGraph(requiresOneOf('stripeKey', 'webhookSecret')));

    expect(message).toContain('some of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET');
    expect(message).not.toContain('required by service');
  });

  test('an optional secret that is unset is left out of the service input', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('an optional secret that is set to an empty string is left out of the service input', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';
    secrets['STRIPE_WEBHOOK_SECRET'] = '';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('the payload reaches the alchemy process with the absent secrets and a hash of each value, never the value', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const childEnv = transported(await preflight(billingGraph(requiresSecrets('stripeKey'))));

    const payload = devPayload(childEnv);
    expect([...payload.absentSecrets]).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect([...payload.pointerVersions.keys()]).toEqual(['STRIPE_SECRET_KEY']);
    expect(Object.values(childEnv).join('')).not.toContain('sk_test_1');
  });

  test("the deployment's trigger member for a secret changes exactly when its value changes", async () => {
    const graph = billingGraph(requiresSecrets('stripeKey'));
    const memberFor = async (value: string) => {
      secrets['STRIPE_SECRET_KEY'] = value;
      const { pointerVersion } = transportedPreflight(
        new Map(),
        transported(await preflight(graph)),
      );
      return pointerVersion('STRIPE_SECRET_KEY');
    };

    const first = await memberFor('sk_test_1');
    expect(await memberFor('sk_test_1')).toBe(first);
    expect(await memberFor('sk_test_2')).not.toBe(first);
    expect(first).not.toBe(sha256('sk_test_1'));
  });

  test('an unset secret has no trigger member value', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const childEnv = transported(await preflight(billingGraph(requiresSecrets('stripeKey'))));

    expect(
      transportedPreflight(new Map(), childEnv).pointerVersion('STRIPE_WEBHOOK_SECRET'),
    ).toBeUndefined();
  });

  test('a missing env-sourced param is a hard error naming the variable and service', async () => {
    const message = await preflightError(paramGraph());

    expect(message).toContain('APP_PORT');
    expect(message).toContain('service "app.web"');
    expect(message).toContain('the `config` list for an env-sourced param');
  });

  test('missing params and secrets are reported together, with the ways to set them given once', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('APP_PORT  (required by service "app.web")');
    expect(message).toContain('STRIPE_SECRET_KEY  (required by service "app.billing"');
    expect(message.split('Set each missing variable').length - 1).toBe(1);
  });

  test('an input that fails even with every secret set is reported as invalid, next to the other problems', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('somethingElse')));

    expect(message).toContain('invalid input for service "app.billing": somethingElse is required');
    expect(message).not.toContain('Deploy-time');
    expect(message).not.toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('APP_PORT  (required by service "app.web")');
  });

  test('an env-sourced param that is set is fingerprinted for the alchemy process', async () => {
    config['APP_PORT'] = '3000';

    const childEnv = transported(await preflight(paramGraph()));

    expect([...devPayload(childEnv).pointerVersions.keys()]).toEqual(['APP_PORT']);
  });

  test('the fingerprint key is created once, readable only by its owner, and reused', async () => {
    config['APP_PORT'] = '3000';
    const keyPath = path.join(environmentDir(cwd), 'fingerprint.key');

    const first = devPayload(transported(await preflight(paramGraph())));
    const key = fs.readFileSync(keyPath);
    const second = devPayload(transported(await preflight(paramGraph())));

    // Windows has no POSIX file modes, and local dev does not run there.
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyPath)).toEqual(key);
    expect(second.pointerVersions).toEqual(first.pointerVersions);
  });

  test('a lost fingerprint key only changes the fingerprints', async () => {
    config['APP_PORT'] = '3000';
    const keyPath = path.join(environmentDir(cwd), 'fingerprint.key');

    const first = devPayload(transported(await preflight(paramGraph())));
    fs.rmSync(keyPath);
    const second = devPayload(transported(await preflight(paramGraph())));

    expect(second.pointerVersions.get('APP_PORT')).not.toBe(first.pointerVersions.get('APP_PORT'));
  });

  test('a secret shared by two services stops dev naming only the service that requires it', async () => {
    const message = await preflightError(sharedGraph());

    expect(message).toContain('STRIPE_SECRET_KEY  (required by service "app.billing"');
    expect(message).not.toContain('service "app.reports"');
  });

  test('a secret shared by two services that is set gets one fingerprint', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const payload = devPayload(transported(await preflight(sharedGraph())));

    expect([...payload.pointerVersions.keys()]).toEqual(['STRIPE_SECRET_KEY']);
    expect([...payload.absentSecrets]).toEqual([]);
  });

  test('a damaged fingerprint key stops dev with the file and how to fix it', async () => {
    config['APP_PORT'] = '3000';
    const devDir = environmentDir(cwd);
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'fingerprint.key'), 'short');

    const message = await preflightError(paramGraph());

    expect(message).toContain(path.join('.prisma-composer', 'dev', 'dev', 'fingerprint.key'));
    expect(message).toContain('Delete the file or run `prisma dev --fresh`');
  });

  test('prisma dev does not require a secret only a resolve() dependency lists', async () => {
    secrets['A'] = 'sk_test_a';
    delete secrets['B'];
    try {
      const graph = Load(
        module('app', ({ environment, provision }) => {
          const stripeKey = resolve(
            [envSecret('A'), envSecret('B'), environment.name],
            ([a, b, name]) => (name === 'dev' ? a : b),
          );
          provision(
            compute({ name: 'billing', deps: {}, input: requiresSecrets('stripeKey'), build }),
            {
              id: 'billing',
              input: { stripeKey },
            },
          );
        }),
        { environment: { name: 'dev' } },
      );

      await preflight(graph);
    } finally {
      delete secrets['A'];
    }
  });

  test('a secrets file left by an older prisma dev is deleted', async () => {
    const devDir = environmentDir(cwd);
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'secrets.json'), '{"STRIPE_SECRET_KEY":"sk_live_old"}');
    fs.writeFileSync(path.join(devDir, 'env.json'), '{}');

    await preflight(paramGraph()).catch(() => undefined);

    expect(fs.readdirSync(devDir)).toEqual(['env.json']);
  });

  test('a secrets file a release before environments wrote is deleted, not moved into dev', async () => {
    const root = path.join(cwd, '.prisma-composer', 'dev');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'emulator-instances.json'),
      '{"formatVersion":2,"current":"app","apps":{}}',
    );
    fs.writeFileSync(path.join(root, 'secrets.json'), '{"STRIPE_SECRET_KEY":"sk_live_old"}');

    await preflight(paramGraph(), 'test').catch(() => undefined);

    expect(fs.existsSync(path.join(root, 'secrets.json'))).toBe(false);
    expect(fs.existsSync(path.join(environmentDir(cwd), 'secrets.json'))).toBe(false);
  });

  test('each environment has its own fingerprint key, in its own folder', async () => {
    config['APP_PORT'] = '3000';

    const versions = [];
    for (const environment of ['dev', 'test', 'feature/x']) {
      const payload = devPayload(transported(await preflight(paramGraph(), environment)));
      versions.push(payload.pointerVersions.get('APP_PORT'));
    }

    expect(new Set(versions).size).toBe(3);
    for (const folder of ['dev', 'test', 'feature%2Fx']) {
      expect(fs.existsSync(path.join(environmentDir(cwd, folder), 'fingerprint.key'))).toBe(true);
    }
  });

  test('a required secret only the shell has stops prisma dev', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_shell';
    try {
      const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

      expect(message).toContain('STRIPE_SECRET_KEY  (required by service "app.billing"');
    } finally {
      delete process.env['STRIPE_SECRET_KEY'];
    }
  });

  test("a secret in the secrets pool satisfies prisma dev, and its fingerprint is the pool value's", async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_pool';
    process.env['STRIPE_SECRET_KEY'] = 'sk_shell';
    try {
      const payload = devPayload(
        transported(await preflight(billingGraph(requiresSecrets('stripeKey')))),
      );
      const key = fs.readFileSync(path.join(environmentDir(cwd), 'fingerprint.key'));

      expect(payload.pointerVersions.get('STRIPE_SECRET_KEY')).toBe(
        createHmac('sha256', key).update('sk_pool').digest('hex'),
      );
    } finally {
      delete process.env['STRIPE_SECRET_KEY'];
    }
  });

  test('an env-sourced param is read from the config pool', async () => {
    process.env['APP_PORT'] = '3000';
    try {
      expect(await preflightError(paramGraph())).toContain(
        'APP_PORT  (required by service "app.web")',
      );

      config['APP_PORT'] = '3000';
      const payload = devPayload(transported(await preflight(paramGraph())));

      expect([...payload.pointerVersions.keys()]).toEqual(['APP_PORT']);
    } finally {
      delete process.env['APP_PORT'];
    }
  });

  test('the missing-values message says where the adapters read', async () => {
    const message = await preflightError(paramGraph());

    expect(message).toContain(
      'Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for an env-sourced param. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.dev and .env.dev.local beside prisma.config.ts.',
    );
  });

  test('warns once per public URL that names a hostname, in any environment, and never for a prisma-build one', async () => {
    for (const environment of ['dev', 'staging']) {
      expect(await devPreflightWarnings(publicUrlGraph(environment), environment)).toEqual([
        'shop.site names the hostname shop.com. prisma dev ignores it and serves the service on its local URL.',
        'shop.api names the hostname api.shop.com. prisma dev ignores it and serves the service on its local URL.',
      ]);
    }
  });

  test('a url that resolves to neither a hostname nor a strategy stops dev, naming the public URL', async () => {
    await expect(devPreflightWarnings(badPublicUrlGraph(), 'dev')).rejects.toThrow(
      'shop.site: url resolved to 42, which is not a hostname or a public URL strategy.',
    );
    expect(fs.existsSync(path.join(cwd, '.prisma-composer'))).toBe(false);
  });

  test('two public URLs that name the same hostname stop dev, naming both and the hostname', async () => {
    await expect(devPreflightWarnings(sharedHostnameGraph(), 'dev')).rejects.toThrow(
      'shop.site and shop.www both name the hostname shop.com. One hostname serves one public URL.',
    );
    expect(fs.existsSync(path.join(cwd, '.prisma-composer'))).toBe(false);
  });
});
