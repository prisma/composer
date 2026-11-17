import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appRoot, isSecretPointer, Load, module, resolve, type ServiceNode } from '@internal/core';
import { preflightEnv } from '@internal/core/config';
import { isSecretString } from '@internal/foundation/secret';
import { rawHttpContract } from '@internal/http';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PRISMA_CLOUD_EXTENSION_ID, PrismaCloudContainer } from '../container.ts';
import { decodePreflightPayload, transportedPreflight } from '../control/preflight-payload.ts';
import { compute, publicUrl, variable } from '../exports/index.ts';
import { runDevPreflight } from '../local-target/preflight.ts';
import { serializeInput } from '../serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const fakeContainer = (environment = 'dev') =>
  new PrismaCloudContainer({ appName: 'app', environment }, 'local', undefined, undefined, true);

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
    appRoot('app', ({ provision }) => {
      provision(compute({ name: 'billing', deps: {}, input: schema, build }), {
        id: 'billing',
        input: {
          stripeKey: provision(variable.secret({ name: 'STRIPE_SECRET_KEY' })),
          webhookSecret: provision(variable.secret({ name: 'STRIPE_WEBHOOK_SECRET' })),
        },
      });
    }),
  );

const acceptsAnything: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const portGraph = () =>
  Load(
    appRoot('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, input: acceptsAnything, build }), {
        id: 'web',
        input: { port: provision(variable({ name: 'APP_PORT' })) },
      });
    }),
  );

/** A service whose input field `token` reads API_TOKEN and is required. */
const tokenService = () => compute({ name: 'web', deps: {}, input: requiresOneOf('token'), build });

const tokenGraph = () =>
  Load(
    appRoot('app', ({ provision }) => {
      provision(tokenService(), {
        id: 'web',
        input: { token: provision(variable({ name: 'API_TOKEN' })) },
      });
    }),
  );

const mixedGraph = (schema: StandardSchemaV1<unknown, unknown>) =>
  Load(
    appRoot('app', ({ provision }) => {
      provision(compute({ name: 'billing', deps: {}, input: schema, build }), {
        id: 'billing',
        input: { stripeKey: provision(variable.secret({ name: 'STRIPE_SECRET_KEY' })) },
      });
      provision(tokenService(), {
        id: 'web',
        input: { token: provision(variable({ name: 'API_TOKEN' })) },
      });
    }),
  );

const sharedGraph = () =>
  Load(
    appRoot('app', ({ provision }) => {
      const stripeKey = provision(variable.secret({ name: 'STRIPE_SECRET_KEY' }));
      provision(
        compute({ name: 'billing', deps: {}, input: requiresSecrets('stripeKey'), build }),
        {
          id: 'billing',
          input: { stripeKey },
        },
      );
      provision(compute({ name: 'reports', deps: {}, input: requiresSecrets(), build }), {
        id: 'reports',
        input: { stripeKey },
      });
    }),
  );

const webService = compute({ name: 'web', deps: {}, build, expose: { http: rawHttpContract } });

const publicUrlGraph = (environment: string) =>
  Load(
    module('shop', ({ provision }) => {
      const web = provision(webService);
      provision(publicUrl({ id: 'site', url: 'shop.com', target: web.http }));
      provision(
        publicUrl({ id: 'api', url: publicUrl.hostname('api.shop.com'), target: web.http }),
      );
      provision(publicUrl({ id: 'preview', url: publicUrl.prismaBuild(), target: web.http }));
    }),
    { environment: { name: environment } },
  );

const badPublicUrlGraph = () =>
  Load(
    module('shop', ({ environment, provision }) => {
      const web = provision(webService);
      const url = resolve([environment.name], () => 42) as unknown as string;
      provision(publicUrl({ id: 'site', url, target: web.http }));
    }),
    { environment: { name: 'dev' } },
  );

const sharedHostnameGraph = () =>
  Load(
    module('shop', ({ provision }) => {
      const web = provision(webService);
      provision(publicUrl({ id: 'site', url: 'shop.com', target: web.http }));
      provision(publicUrl({ id: 'www', url: publicUrl.hostname('Shop.COM.'), target: web.http }));
    }),
    { environment: { name: 'dev' } },
  );

const devPreflightWarnings = async (graph: ReturnType<typeof Load>, environment: string) => {
  const warnings: string[] = [];
  await runDevPreflight({
    graph,
    container: fakeContainer(environment),
    environment,
    configuration,
    secrets,
    warn: (message) => warnings.push(message),
  });
  return warnings;
};

/** What the dev command's adapters returned: the app secrets and the app configuration. */
let secrets: Record<string, string> = {};
let configuration: Record<string, unknown> = {};

const devPreflight = (graph: ReturnType<typeof Load>, environment = 'dev') =>
  runDevPreflight({
    graph,
    container: fakeContainer(environment),
    environment,
    configuration,
    secrets,
  });

const preflight = async (graph: ReturnType<typeof Load>, environment = 'dev') =>
  (await devPreflight(graph, environment)).payload;

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
  const { absentVariables } = transportedPreflight(() => undefined, childEnv);
  const row = serializeInput(node, 'app.billing', binding, { absentVariables });
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
    configuration = {};
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    secrets = {};
    configuration = {};
  });

  test('a required secret that is unset stops dev, naming the variable, the service and both fixes', async () => {
    secrets['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('service "app.billing"');
    expect(message).toContain('field "stripeKey"');
    expect(message).toContain('the `secrets` list of the `composer` section for a secret');
    expect(message).toContain('environmentVariables() reads the shell you run `prisma dev` from');
  });

  test('a required secret that is set to an empty string stops dev the same way', async () => {
    secrets['STRIPE_SECRET_KEY'] = '';
    secrets['STRIPE_WEBHOOK_SECRET'] = 'whsec_1';

    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain(
      'STRIPE_SECRET_KEY  (read by service "app.billing", field "stripeKey")',
    );
  });

  test('the error lists every missing required secret and leaves out the optional ones', async () => {
    const message = await preflightError(billingGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain('STRIPE_WEBHOOK_SECRET');

    const both = await preflightError(billingGraph(requiresSecrets('stripeKey', 'webhookSecret')));
    expect(both).toContain('STRIPE_SECRET_KEY  (read by service "app.billing", field "stripeKey")');
    expect(both).toContain(
      'STRIPE_WEBHOOK_SECRET  (read by service "app.billing", field "webhookSecret")',
    );
  });

  test('when the schema needs at least one of several unset secrets but none alone, the error says so instead of calling each one required', async () => {
    const message = await preflightError(billingGraph(requiresOneOf('stripeKey', 'webhookSecret')));

    expect(message).toContain('at least one of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET');
    expect(message).not.toContain('required by service');
  });

  test('an optional secret that is unset is left out of the service input', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
    });
  });

  test('an optional secret that is set to an empty string is left out of the service input', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';
    secrets['STRIPE_WEBHOOK_SECRET'] = '';
    const graph = billingGraph(requiresSecrets('stripeKey'));

    const childEnv = transported(await preflight(graph));

    expect(billingDocument(graph, childEnv)).toEqual({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
    });
  });

  test('the payload reaches the alchemy process with the absent secrets and a hash of each value, never the value', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const childEnv = transported(await preflight(billingGraph(requiresSecrets('stripeKey'))));

    const payload = devPayload(childEnv);
    expect([...payload.absentVariables]).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect([...payload.pointerVersions.keys()]).toEqual(['STRIPE_SECRET_KEY']);
    expect(Object.values(childEnv).join('')).not.toContain('sk_test_1');
  });

  test("the deployment's trigger member for a secret changes exactly when its value changes", async () => {
    const graph = billingGraph(requiresSecrets('stripeKey'));
    const memberFor = async (value: string) => {
      secrets['STRIPE_SECRET_KEY'] = value;
      const { pointerVersion } = transportedPreflight(
        () => undefined,
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
      transportedPreflight(() => undefined, childEnv).pointerVersion('STRIPE_WEBHOOK_SECRET'),
    ).toBeUndefined();
  });

  test('a secret an array position reads that is unset stops dev, naming the variable and the service', async () => {
    const graph = Load(
      appRoot('app', ({ provision }) => {
        provision(compute({ name: 'billing', deps: {}, input: requiresSecrets(), build }), {
          id: 'billing',
          input: { keys: [provision(variable.secret({ name: 'STRIPE_SECRET_KEY' }))] },
        });
      }),
    );

    const message = await preflightError(graph);

    expect(message).toContain(
      '1 platform variable a service needs has no value:\n  - STRIPE_SECRET_KEY  (read by service "app.billing", field "keys.0")\n      required by service "app.billing": an array position reads it, and an array position cannot be left out',
    );
  });

  test('missing plain variables and secrets are reported together, with the ways to set them given once', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('stripeKey')));

    expect(message).toContain('API_TOKEN  (read by service "app.web", field "token")');
    expect(message).toContain(
      'STRIPE_SECRET_KEY  (read by service "app.billing", field "stripeKey")',
    );
    expect(message.split('Set each missing variable').length - 1).toBe(1);
  });

  test('an input that fails even with every secret set is reported as invalid, next to the other problems', async () => {
    const message = await preflightError(mixedGraph(requiresSecrets('somethingElse')));

    expect(message).toContain('invalid input for service "app.billing": somethingElse is required');
    expect(message).not.toContain('Deploy-time');
    expect(message).not.toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('API_TOKEN  (read by service "app.web", field "token")');
  });

  test('a plain node in an input field that is set is fingerprinted for the alchemy process', async () => {
    configuration['APP_PORT'] = '3000';

    const childEnv = transported(await preflight(portGraph()));

    expect([...devPayload(childEnv).pointerVersions.keys()]).toEqual(['APP_PORT']);
  });

  test('the fingerprint key is created once, readable only by its owner, and reused', async () => {
    configuration['APP_PORT'] = '3000';
    const keyPath = path.join(environmentDir(cwd), 'fingerprint.key');

    const first = devPayload(transported(await preflight(portGraph())));
    const key = fs.readFileSync(keyPath);
    const second = devPayload(transported(await preflight(portGraph())));

    // Windows has no POSIX file modes, and local dev does not run there.
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyPath)).toEqual(key);
    expect(second.pointerVersions).toEqual(first.pointerVersions);
  });

  test('a lost fingerprint key only changes the fingerprints', async () => {
    configuration['APP_PORT'] = '3000';
    const keyPath = path.join(environmentDir(cwd), 'fingerprint.key');

    const first = devPayload(transported(await preflight(portGraph())));
    fs.rmSync(keyPath);
    const second = devPayload(transported(await preflight(portGraph())));

    expect(second.pointerVersions.get('APP_PORT')).not.toBe(first.pointerVersions.get('APP_PORT'));
  });

  test('a secret shared by two services stops dev, naming both services that read it', async () => {
    const message = await preflightError(sharedGraph());

    expect(message).toContain(
      'STRIPE_SECRET_KEY  (read by service "app.billing", field "stripeKey"; read by service "app.reports", field "stripeKey")',
    );
  });

  test('a secret shared by two services that is set gets one fingerprint', async () => {
    secrets['STRIPE_SECRET_KEY'] = 'sk_test_1';

    const payload = devPayload(transported(await preflight(sharedGraph())));

    expect([...payload.pointerVersions.keys()]).toEqual(['STRIPE_SECRET_KEY']);
    expect([...payload.absentVariables]).toEqual([]);
  });

  test('a damaged fingerprint key stops dev with the file and how to fix it', async () => {
    configuration['APP_PORT'] = '3000';
    const devDir = environmentDir(cwd);
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'fingerprint.key'), 'short');

    const message = await preflightError(portGraph());

    expect(message).toContain(path.join('.prisma-composer', 'dev', 'dev', 'fingerprint.key'));
    expect(message).toContain('Delete the file or run `prisma dev --fresh`');
  });

  test('a secrets file left by an older prisma dev is deleted', async () => {
    const devDir = environmentDir(cwd);
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'secrets.json'), '{"STRIPE_SECRET_KEY":"sk_live_old"}');
    fs.writeFileSync(path.join(devDir, 'env.json'), '{}');

    await preflight(Load(appRoot('app', () => {})));

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

    await preflight(Load(appRoot('app', () => {})), 'test');

    expect(fs.existsSync(path.join(root, 'secrets.json'))).toBe(false);
    expect(fs.existsSync(path.join(environmentDir(cwd), 'secrets.json'))).toBe(false);
  });

  test('each environment has its own fingerprint key, in its own folder', async () => {
    configuration['APP_PORT'] = '3000';

    const versions = [];
    for (const environment of ['dev', 'test', 'feature/x']) {
      const payload = devPayload(transported(await preflight(portGraph(), environment)));
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

      expect(message).toContain(
        'STRIPE_SECRET_KEY  (read by service "app.billing", field "stripeKey")',
      );
    } finally {
      delete process.env['STRIPE_SECRET_KEY'];
    }
  });

  test("a secret in the app secrets satisfies prisma dev, and its fingerprint is the app secrets value's", async () => {
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

  test('a plain node is read from the app configuration, not the shell', async () => {
    process.env['API_TOKEN'] = 'from-the-shell';
    try {
      expect(await preflightError(tokenGraph())).toContain(
        'API_TOKEN  (read by service "app.web", field "token")',
      );

      configuration['API_TOKEN'] = 'from-the-configuration';
      const payload = devPayload(transported(await preflight(tokenGraph())));

      expect([...payload.pointerVersions.keys()]).toEqual(['API_TOKEN']);
    } finally {
      delete process.env['API_TOKEN'];
    }
  });

  test('a plain node whose app configuration value is not text stops dev, naming the variable, the service and the kind', async () => {
    configuration['API_TOKEN'] = 42;

    expect(await preflightError(tokenGraph())).toBe(
      'The `config` adapters return a number for "API_TOKEN", not text. prisma dev cannot start, because the platform variable "app.apiToken", which service "app.web" reads, takes text. Make the adapter return a string.',
    );
  });

  test('the missing-values message says where the adapters read', async () => {
    const message = await preflightError(tokenGraph());

    expect(message).toContain(
      'Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for a plain platform variable. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.dev and .env.dev.local beside prisma.config.ts.',
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

  describe('plain platform variable nodes', () => {
    const plainGraph = (schema: StandardSchemaV1<unknown, unknown>) =>
      Load(
        appRoot('shop', ({ provision }) => {
          const from = provision(variable({ name: 'EMAIL_FROM' }));
          provision(compute({ name: 'mail', deps: {}, input: schema, build }), {
            input: { from },
          });
        }),
      );

    function documentOf(
      graph: ReturnType<typeof Load>,
      address: string,
      childEnv: Record<string, string>,
    ): unknown {
      const node = graph.nodes.find((entry) => entry.id === address)?.node as ServiceNode;
      const binding = graph.inputBindings.find((b) => b.serviceAddress === address)?.binding;
      const { absentVariables } = transportedPreflight(() => undefined, childEnv);
      const row = serializeInput(node, address, binding, { absentVariables });
      return JSON.parse(row?.value ?? 'null');
    }

    test('a plain node is filled from the app configuration', async () => {
      configuration['EMAIL_FROM'] = 'shop@example.com';
      const graph = plainGraph(acceptsAnything);

      const result = await devPreflight(graph);

      expect(result.plainVariableText).toEqual({ EMAIL_FROM: 'shop@example.com' });
      const payload = devPayload(transported(result.payload));
      expect([...payload.pointerVersions.keys()]).toEqual(['EMAIL_FROM']);
      expect([...payload.absentVariables]).toEqual([]);
      expect(documentOf(graph, 'shop.mail', transported(result.payload))).toEqual({
        from: { $platform: { name: 'EMAIL_FROM' } },
      });
      expect(JSON.stringify(result.payload)).not.toContain('shop@example.com');
    });

    test('a plain node no service reads is not read from the app configuration', async () => {
      configuration['UNREAD_FROM'] = { not: 'text' };
      const graph = Load(
        appRoot('shop', ({ provision }) => {
          provision(variable({ name: 'UNREAD_FROM' }));
        }),
      );

      expect((await devPreflight(graph)).plainVariableText).toEqual({});
    });

    test('an unset optional input field is left out of the input document', async () => {
      const graph = plainGraph(acceptsAnything);

      const result = await devPreflight(graph);

      expect(result.plainVariableText).toEqual({});
      expect([...devPayload(transported(result.payload)).absentVariables]).toEqual(['EMAIL_FROM']);
      expect(documentOf(graph, 'shop.mail', transported(result.payload))).toEqual({});
    });

    test('a required unset input field stops dev, naming the variable, the service and the field', async () => {
      configuration['EMAIL_FROM'] = '';

      const message = await preflightError(plainGraph(requiresOneOf('from')));

      expect(message).toContain(
        '1 platform variable a service needs has no value:\n  - EMAIL_FROM  (read by service "shop.mail", field "from")',
      );
    });

    test('a value that is not text stops dev before any service starts, naming the variable, the node and its reader', async () => {
      configuration['EMAIL_FROM'] = 42;

      expect(await preflightError(plainGraph(acceptsAnything))).toBe(
        'The `config` adapters return a number for "EMAIL_FROM", not text. prisma dev cannot start, because the platform variable "shop.emailFrom", which service "shop.mail" reads, takes text. Make the adapter return a string.',
      );
    });

    test('the not-text message names every service that reads the node, each once', async () => {
      configuration['SMTP_PORT'] = 25;
      const graph = Load(
        appRoot('shop', ({ provision }) => {
          const smtpPort = provision(variable({ name: 'SMTP_PORT' }));
          provision(compute({ name: 'mail', deps: {}, input: acceptsAnything, build }), {
            input: { port: smtpPort, again: smtpPort },
          });
          provision(compute({ name: 'digest', deps: {}, input: acceptsAnything, build }), {
            input: { port: smtpPort },
          });
        }),
      );

      expect(await preflightError(graph)).toBe(
        'The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which services "shop.mail" and "shop.digest" read, takes text. Make the adapter return a string.',
      );
    });

    test("a changed value changes only that variable's fingerprint", async () => {
      configuration['API_TOKEN'] = 'tok_1';
      const graph = Load(
        appRoot('shop', ({ provision }) => {
          const from = provision(variable({ name: 'EMAIL_FROM' }));
          const token = provision(variable({ name: 'API_TOKEN' }));
          provision(compute({ name: 'mail', deps: {}, input: acceptsAnything, build }), {
            input: { from },
          });
          provision(compute({ name: 'web', deps: {}, input: acceptsAnything, build }), {
            input: { token },
          });
        }),
      );
      const versionsFor = async (from: string) => {
        configuration['EMAIL_FROM'] = from;
        return devPayload(transported(await preflight(graph))).pointerVersions;
      };

      const first = await versionsFor('a@example.com');
      const second = await versionsFor('b@example.com');

      expect(second.get('EMAIL_FROM')).not.toBe(first.get('EMAIL_FROM'));
      expect(second.get('API_TOKEN')).toBe(first.get('API_TOKEN'));
    });
  });
});
