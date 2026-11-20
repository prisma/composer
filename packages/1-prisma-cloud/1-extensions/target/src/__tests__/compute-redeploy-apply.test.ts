// A producer and a consumer that reads its url, deployed under the real Alchemy apply engine and the real `Prisma.App`, `Prisma.Deployment` and `Prisma.EnvironmentVariable` providers, against a fake Management API.
import { expect, test } from 'bun:test';
import * as path from 'node:path';
import * as Prisma from '@alchemy.run/prisma';
import type { Contract } from '@internal/core';
import { dependency, string } from '@internal/core';
import type { LowerContext } from '@internal/core/deploy';
import { environmentVariableProvider } from '@internal/lowering';
import {
  data,
  fakeManagementApi,
  page,
  runScratch,
  scratchStack,
} from '@internal/lowering/scratch-stack';
import { RPC_PEER_KEY } from '@internal/service-rpc';
import * as Output from 'alchemy/Output';
import * as Provider from 'alchemy/Provider';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Redacted from 'effect/Redacted';
import { compute } from '../compute.ts';
import { buildProviderParams } from '../control/extension.ts';
import { computeDescriptor, endpointDomainOf } from '../descriptors/compute.ts';
import { GeneratedParamProvider } from '../generated-param-resource.ts';
import { SELF_ORIGIN } from '../origin-key.ts';
import { RESERVED_PROVIDER_PARAMS } from '../provider-params.ts';
import { resourceId } from '../resource-ids.ts';
import { SentKeysProvider } from '../sent-keys-resource.ts';
import { STREAMS_API_KEY } from '../streams-keys.ts';

const PROJECT_ID = 'proj_1';
const BRANCH_ID = 'br_default';
const CREATED_AT = '2026-11-20T00:00:00.000Z';

interface FakePlatform {
  readonly services: Map<string, Record<string, unknown>>;
  readonly deployments: Map<string, Record<string, unknown>>;
  // A deleted deployment stays listed.
  readonly created: { readonly serviceId: unknown; readonly body: Record<string, unknown> }[];
  readonly variables: Map<string, Record<string, unknown>>;
  readonly requests: { readonly method: string; readonly path: string }[];
  readonly events: string[];
  // While set, the producer's deployment create waits until the consumer's arrives, so a consumer that does not wait for its producer is created first.
  authCreateWaitsForWeb: Deferred.Deferred<void> | undefined;
  failVariableDeletes: boolean;
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

function respond(platform: FakePlatform, method: string, url: URL, body: unknown): Response {
  const path = url.pathname;
  const sent = record(body);

  if (method === 'PUT' && path.startsWith('/upload/')) return new Response(null);

  if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/branches`) {
    return page([
      {
        id: BRANCH_ID,
        type: 'branch',
        url: `https://api.prisma.test/v1/branches/${BRANCH_ID}`,
        gitName: 'main',
        isDefault: true,
        role: 'production',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        project: {
          id: PROJECT_ID,
          url: `https://api.prisma.test/v1/projects/${PROJECT_ID}`,
          name: 'shop',
        },
      },
    ]);
  }
  if (method === 'GET' && path === '/v1/services') {
    const logicalId = url.searchParams.get('logicalId');
    return page(
      [...platform.services.values()].filter(
        (service) => logicalId === null || service['logicalId'] === logicalId,
      ),
    );
  }
  if (method === 'POST' && path === '/v1/services') {
    const id = `svc_${platform.services.size + 1}`;
    const service = {
      id,
      type: 'app',
      url: `https://api.prisma.test/v1/services/${id}`,
      name: sent['displayName'],
      region: { id: 'eu-west-3', name: 'Paris' },
      projectId: sent['projectId'],
      branchId: sent['branchId'] ?? BRANCH_ID,
      latestDeploymentId: null,
      appEndpointDomain: `https://${id}.cdg.prisma.build`,
      createdAt: CREATED_AT,
      logicalId: sent['logicalId'] ?? null,
    };
    platform.services.set(id, service);
    return data(service);
  }
  const serviceMatch = path.match(/^\/v1\/services\/([^/]+)(\/[a-z]+)?$/);
  const service = serviceMatch === null ? undefined : platform.services.get(serviceMatch[1] ?? '');
  if (serviceMatch !== null && service !== undefined) {
    const action = serviceMatch[2];
    if (method === 'GET' && action === undefined) return data(service);
    if (method === 'GET' && action === '/deployments') {
      return page(
        [...platform.deployments.values()].filter((d) => d['serviceId'] === service['id']),
      );
    }
    if (method === 'POST' && action === '/deployments') {
      platform.created.push({ serviceId: service['id'], body: sent });
      platform.events.push(`create:${service['logicalId']}`);
      const id = `dep_${platform.created.length}`;
      const deployment = {
        id,
        type: 'deployment',
        url: `https://api.prisma.test/v1/deployments/${id}`,
        serviceId: service['id'],
        foundryVersionId: `ver_${platform.created.length}`,
        status: 'new',
        previewDomain: null,
        createdAt: CREATED_AT,
      };
      platform.deployments.set(id, deployment);
      return data({ ...deployment, uploadUrl: `https://api.prisma.test/upload/${id}` });
    }
    if (method === 'POST' && action === '/promote') {
      service['latestDeploymentId'] = sent['deploymentId'];
      platform.events.push(`promote:${service['logicalId']}`);
      return data({ appEndpointDomain: service['appEndpointDomain'], reassignedDomains: 0 });
    }
  }
  const deploymentMatch = path.match(/^\/v1\/deployments\/([^/]+)(\/start|\/stop)?$/);
  const deployment =
    deploymentMatch === null ? undefined : platform.deployments.get(deploymentMatch[1] ?? '');
  if (deployment !== undefined) {
    if (method === 'GET' && deploymentMatch?.[2] === undefined) return data(deployment);
    if (method === 'POST' && deploymentMatch?.[2] === '/start') {
      deployment['status'] = 'running';
      deployment['previewDomain'] = `https://${deployment['id']}.preview.prisma.build`;
      return data({ previewDomain: deployment['previewDomain'] });
    }
    if (method === 'POST' && deploymentMatch?.[2] === '/stop') {
      deployment['status'] = 'stopped';
      return data(deployment);
    }
    if (method === 'DELETE') {
      platform.deployments.delete(String(deployment['id']));
      return data(deployment);
    }
  }

  if (method === 'GET' && path === '/v1/environment-variables') {
    const key = url.searchParams.get('key');
    return page([...platform.variables.values()].filter((v) => key === null || v['key'] === key));
  }
  if (method === 'POST' && path === '/v1/environment-variables') {
    const id = `var_${platform.variables.size + 1}`;
    const variable = {
      id,
      type: 'environment-variable',
      url: `https://api.prisma.test/v1/environment-variables/${id}`,
      projectId: sent['projectId'],
      branchId: null,
      class: sent['class'],
      key: sent['key'],
      valueKid: 'kid_1',
      isManagedBySystem: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    platform.variables.set(id, variable);
    return data(variable);
  }
  const variableId = path.match(/^\/v1\/environment-variables\/([^/]+)$/)?.[1] ?? '';
  const variable = platform.variables.get(variableId);
  if (variable === undefined && variableId !== '') {
    return Response.json({ error: { code: 'not-found', message: 'not found' } }, { status: 404 });
  }
  if (variable !== undefined && method === 'GET') return data(variable);
  if (variable !== undefined && method === 'PATCH') return data(variable);
  if (variable !== undefined && method === 'DELETE') {
    if (platform.failVariableDeletes) {
      return Response.json({ error: { code: 'bad-request', message: 'refused' } }, { status: 400 });
    }
    platform.events.push(`delete-variable:${variable['key']}`);
    platform.variables.delete(variableId);
    return new Response(null, { status: 204 });
  }

  return Response.json(
    { error: { code: 'unhandled', message: `${method} ${path}` } },
    { status: 400 },
  );
}

function fakePlatform() {
  const platform: FakePlatform = {
    services: new Map(),
    deployments: new Map(),
    created: [],
    variables: new Map(),
    requests: [],
    events: [],
    authCreateWaitsForWeb: undefined,
    failVariableDeletes: false,
  };
  const api = fakeManagementApi(({ method, path, body }) =>
    Effect.gen(function* () {
      const url = new URL(path, 'https://api.prisma.test');
      platform.requests.push({ method, path: url.pathname });
      const creating =
        method === 'POST' ? url.pathname.match(/^\/v1\/services\/([^/]+)\/deployments$/) : null;
      const address = platform.services.get(creating?.[1] ?? '')?.['logicalId'];
      const waitForWeb = platform.authCreateWaitsForWeb;
      if (waitForWeb !== undefined && address === 'shop.web') {
        yield* Deferred.succeed(waitForWeb, undefined);
      }
      if (waitForWeb !== undefined && address === 'shop.auth') {
        yield* Deferred.await(waitForWeb).pipe(Effect.timeoutOption(Duration.millis(500)));
      }
      return respond(platform, method, url, body);
    }),
  );
  const providers = Layer.effect(
    Prisma.Providers,
    Provider.collection([Prisma.App, Prisma.Deployment, Prisma.EnvironmentVariable]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Prisma.AppProvider(),
        Prisma.DeploymentProvider(),
        environmentVariableProvider(),
        SentKeysProvider(),
        GeneratedParamProvider(),
      ),
    ),
    Layer.provideMerge(api),
  );
  const serviceIdOf = (address: string) =>
    [...platform.services.values()].find((s) => s['logicalId'] === address)?.['id'];
  const createsFor = (address: string) =>
    platform.created.filter(({ serviceId }) => serviceId === serviceIdOf(address));
  const variableWrites = () =>
    platform.requests.filter(
      ({ method, path }) =>
        (method === 'POST' || method === 'PATCH') && path.startsWith('/v1/environment-variables'),
    );
  return {
    platform,
    createsFor,
    variablesSentTo: (address: string) => createsFor(address).map(({ body }) => body['variables']),
    variableWrites,
    stack: scratchStack({ providers, dev: false }, 'compute-redeploy'),
  };
}

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const exposed: Contract<'rpc', Record<never, never>> = {
  kind: 'rpc',
  __cmp: {},
  satisfies: () => true,
};
const urlDependency = () =>
  dependency({
    type: 'rpc',
    connection: { params: { url: string() }, hydrate: (v) => v },
  });
// `region` is never given a value here.
const authDependency = () =>
  dependency({
    type: 'rpc',
    connection: {
      params: { url: string(), region: string({ optional: true }) },
      hydrate: (v) => v,
    },
  });

interface Shape {
  /** The consumer also depends on a billing service outside this deploy. */
  readonly billing?: boolean;
  /** The producer serves streams to at least one consumer. */
  readonly streamsConsumer?: boolean;
  /** How many extra dependencies the consumer reads a url from. */
  readonly extraDependencies?: number;
}

const auth = compute({ name: 'auth', deps: {}, build, expose: { verify: exposed } });
const webOf = (shape: Shape) =>
  compute({
    name: 'web',
    deps: {
      auth: authDependency(),
      ...(shape.billing === true ? { billing: urlDependency() } : {}),
      ...Object.fromEntries(
        Array.from({ length: shape.extraDependencies ?? 0 }, (_, i) => [
          `extra${i}`,
          urlDependency(),
        ]),
      ),
    },
    build,
  });

const descriptorOf = (shape: Shape) =>
  computeDescriptor(() => ({
    workspaceId: 'ws_1',
    providerParams: buildProviderParams(
      RESERVED_PROVIDER_PARAMS,
      new Map([
        [RPC_PEER_KEY, { value: () => [] }],
        [
          STREAMS_API_KEY,
          { value: () => (shape.streamsConsumer === true ? 'minted-streams-key' : undefined) },
        ],
        [SELF_ORIGIN, { valueForService: endpointDomainOf }],
      ]),
    ),
  }));
const graphOf = (web: unknown) => ({
  root: { id: 'shop' },
  nodes: [
    { id: 'shop.auth', node: auth },
    { id: 'shop.web', node: web },
  ],
  inputBindings: [],
  edges: [{ from: 'shop.auth', to: 'shop.web', input: 'auth', kind: 'dependency' }],
});
const application = {
  projectId: PROJECT_ID,
  branchId: undefined,
  defaultBranchId: BRANCH_ID,
  branchless: false,
};
// The fake platform never unpacks an artifact, so any file serves as one.
const artifact = { path: import.meta.path, sha256: 'sha-artifact' };
const changedArtifact = { path: path.join(import.meta.dir, '..', 'compute.ts'), sha256: 'sha-2' };

function program(shape: Shape = {}, authArtifact = artifact, webArtifact = artifact) {
  return Effect.gen(function* () {
    const descriptor = descriptorOf(shape);
    const web = webOf(shape);
    const lowered = new Map<string, Readonly<Record<string, unknown>>>();
    const graph = graphOf(web);
    const ctxOf = (address: string, node: unknown) =>
      ({
        id: address,
        address,
        node,
        graph,
        application,
        lowered,
        provisioned: new Map(),
      }) as unknown as LowerContext;
    const authCtx = ctxOf('shop.auth', auth);
    const webCtx = ctxOf('shop.web', web);
    const authProvisioned = yield* descriptor.provision(authCtx);
    const webProvisioned = yield* descriptor.provision(webCtx);
    const authSerialized = yield* descriptor.serialize(authCtx, authProvisioned, {
      service: { port: 3000 },
      inputs: {},
    });
    const deployed = yield* descriptor.deploy(
      authCtx,
      authProvisioned,
      authArtifact,
      authSerialized,
    );
    lowered.set('shop.auth', deployed.outputs);
    const webSerialized = yield* descriptor.serialize(webCtx, webProvisioned, {
      service: { port: 3000 },
      inputs: {
        auth: { url: deployed.outputs['url'] },
        ...(shape.billing === true ? { billing: { url: 'https://billing.example' } } : {}),
        ...Object.fromEntries(
          Array.from({ length: shape.extraDependencies ?? 0 }, (_, i) => [
            `extra${i}`,
            { url: `https://extra${i}.example` },
          ]),
        ),
      },
    });
    yield* descriptor.deploy(webCtx, webProvisioned, webArtifact, webSerialized);
  }) as Effect.Effect<void>;
}

const authVariables = (streamsKey: string | null = null) => ({
  COMPOSER_SHOP_AUTH_PORT: '3000',
  COMPOSER_SHOP_AUTH_RPC_ACCEPTED_KEYS: '[]',
  COMPOSER_SHOP_AUTH_STREAMS_API_KEY: streamsKey,
  COMPOSER_SHOP_AUTH_ORIGIN: '"https://svc_1.cdg.prisma.build"',
});
const webVariables = {
  COMPOSER_SHOP_WEB_AUTH_URL: 'https://svc_1.cdg.prisma.build',
  COMPOSER_SHOP_WEB_AUTH_REGION: null,
  COMPOSER_SHOP_WEB_PORT: '3000',
  COMPOSER_SHOP_WEB_RPC_ACCEPTED_KEYS: null,
  COMPOSER_SHOP_WEB_STREAMS_API_KEY: null,
  COMPOSER_SHOP_WEB_ORIGIN: '"https://svc_2.cdg.prisma.build"',
};

test('a deployment is created with every key its service reads at boot, a missing value as null', async () => {
  const { variablesSentTo, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));

  expect(variablesSentTo('shop.auth')).toEqual([authVariables()]);
  expect(variablesSentTo('shop.web')).toEqual([webVariables]);
});

test("an unchanged deploy keeps the deployment of a consumer of the producer's url", async () => {
  const { createsFor, platform, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));
  const replaced = platform.events.length;
  await runScratch(stack.deploy(program()));

  expect(createsFor('shop.auth')).toHaveLength(1);
  expect(createsFor('shop.web')).toHaveLength(1);
  expect(platform.events.slice(replaced).filter((event) => event.startsWith('create:'))).toEqual(
    [],
  );
});

test('no platform deploy writes a variable row', async () => {
  const { variableWrites, stack } = fakePlatform();

  await runScratch(stack.deploy(program({ billing: true, streamsConsumer: true })));
  await runScratch(stack.deploy(program({}, changedArtifact, changedArtifact)));

  expect(variableWrites()).toEqual([]);
});

test("a new artifact for the producer replaces its deployment and keeps the consumer's", async () => {
  const { createsFor, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));
  await runScratch(stack.deploy(program({}, changedArtifact)));

  expect(createsFor('shop.auth')).toHaveLength(2);
  expect(createsFor('shop.web')).toHaveLength(1);
});

test('a changed value replaces only the service that reads it, and its new deployment carries it', async () => {
  const { createsFor, variablesSentTo, stack } = fakePlatform();

  await runScratch(stack.deploy(program({ streamsConsumer: true })));
  await runScratch(stack.deploy(program({ streamsConsumer: true, billing: true })));

  expect(createsFor('shop.auth')).toHaveLength(1);
  expect(variablesSentTo('shop.web')).toEqual([
    webVariables,
    { ...webVariables, COMPOSER_SHOP_WEB_BILLING_URL: 'https://billing.example' },
  ]);
});

test("a removed dependency's keys are sent as null on that deploy and on every later one", async () => {
  const { variablesSentTo, stack } = fakePlatform();

  await runScratch(stack.deploy(program({ billing: true })));
  await runScratch(stack.deploy(program()));
  await runScratch(stack.deploy(program({}, artifact, changedArtifact)));

  const retired = { ...webVariables, COMPOSER_SHOP_WEB_BILLING_URL: null };
  expect(variablesSentTo('shop.web')).toEqual([
    { ...webVariables, COMPOSER_SHOP_WEB_BILLING_URL: 'https://billing.example' },
    retired,
    retired,
  ]);
});

test('a streams service that loses its last consumer is deployed with STREAMS_API_KEY null', async () => {
  const { variablesSentTo, stack } = fakePlatform();

  await runScratch(stack.deploy(program({ streamsConsumer: true })));
  await runScratch(stack.deploy(program()));

  expect(variablesSentTo('shop.auth')).toEqual([
    authVariables('"minted-streams-key"'),
    authVariables(),
  ]);
});

test("on a first deploy, the producer is promoted before the consumer's deployment is created", async () => {
  const { platform, stack } = fakePlatform();
  platform.authCreateWaitsForWeb = Deferred.makeUnsafe<void>();

  await runScratch(stack.deploy(program()));

  expect(
    platform.events.filter((event) => event === 'promote:shop.auth' || event === 'create:shop.web'),
  ).toEqual(['promote:shop.auth', 'create:shop.web']);
});

test("when both artifacts change, the producer is promoted before the consumer's new deployment is created", async () => {
  const { platform, createsFor, stack } = fakePlatform();
  await runScratch(stack.deploy(program()));
  platform.events.length = 0;
  platform.authCreateWaitsForWeb = Deferred.makeUnsafe<void>();

  await runScratch(stack.deploy(program({}, changedArtifact, changedArtifact)));

  expect(createsFor('shop.web')).toHaveLength(2);
  expect(
    platform.events.filter((event) => event === 'promote:shop.auth' || event === 'create:shop.web'),
  ).toEqual(['promote:shop.auth', 'create:shop.web']);
});

test('a service with more than 50 variables is refused before any request', async () => {
  const { platform, stack } = fakePlatform();

  const exit = await runScratch(Effect.exit(stack.deploy(program({ extraDependencies: 48 }))));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
    'the service "shop.web" needs 51 variables, but Prisma Cloud stores at most 50 on one service',
  );
  expect(platform.requests).toEqual([]);
});

// What the release before this one declared for each service: one variable row per key and a deployment whose triggers repeat the row values.
function previousReleaseProgram(options: { readonly triggersRepeatValues: boolean }) {
  return Effect.gen(function* () {
    const descriptor = descriptorOf({});
    const lowered = new Map<string, Readonly<Record<string, unknown>>>();
    const graph = graphOf(webOf({}));
    for (const [address, node, values] of [
      ['shop.auth', auth, authVariables()],
      ['shop.web', webOf({}), webVariables],
    ] as const) {
      const ctx = {
        id: address,
        address,
        node,
        graph,
        application,
        lowered,
        provisioned: new Map(),
      } as unknown as LowerContext;
      const provisioned = yield* descriptor.provision(ctx);
      const rows: Prisma.EnvironmentVariable[] = [];
      const triggers: Record<string, Redacted.Redacted<string>> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value === null) continue;
        rows.push(
          yield* Prisma.EnvironmentVariable(resourceId(address, 'env', key), {
            project: PROJECT_ID,
            key,
            value: Redacted.make(value),
            class: 'production',
          }),
        );
        triggers[key] = Redacted.make(value);
      }
      yield* Prisma.Deployment(resourceId(address, 'deployment'), {
        app: Output.flatMap(
          Output.all(provisioned.serviceId, ...rows.map((row) => Output.of(row))),
          () => provisioned.serviceId,
        ),
        artifactPath: artifact.path,
        artifactContentType: 'application/gzip',
        triggers: options.triggersRepeatValues ? triggers : {},
        portMapping: { http: 3000 },
        start: true,
        promote: true,
      });
    }
  }) as Effect.Effect<void>;
}

const rowKeys = () =>
  [...Object.entries(authVariables()), ...Object.entries(webVariables)]
    .filter(([, value]) => value !== null)
    .map(([key]) => key)
    .sort();

test.each([{ triggersRepeatValues: true }, { triggersRepeatValues: false }])(
  'the upgrade from rows replaces each deployment once, with every value, then deletes the rows (triggers repeat values: $triggersRepeatValues)',
  async ({ triggersRepeatValues }) => {
    const { platform, createsFor, variablesSentTo, variableWrites, stack } = fakePlatform();
    await runScratch(stack.deploy(previousReleaseProgram({ triggersRepeatValues })));
    expect([...platform.variables.values()].map((v) => v['key']).sort()).toEqual(rowKeys());
    const writesBefore = variableWrites().length;
    platform.events.length = 0;

    await runScratch(stack.deploy(program()));

    expect(createsFor('shop.auth')).toHaveLength(2);
    expect(createsFor('shop.web')).toHaveLength(2);
    expect(variablesSentTo('shop.auth').at(-1)).toEqual(authVariables());
    expect(variablesSentTo('shop.web').at(-1)).toEqual(webVariables);
    expect(variableWrites()).toHaveLength(writesBefore);
    expect(platform.variables.size).toBe(0);
    for (const key of rowKeys()) {
      const owner = key.startsWith('COMPOSER_SHOP_AUTH_') ? 'shop.auth' : 'shop.web';
      expect(platform.events.indexOf(`delete-variable:${key}`)).toBeGreaterThan(
        platform.events.indexOf(`create:${owner}`),
      );
    }

    await runScratch(stack.deploy(program()));
    expect(createsFor('shop.auth')).toHaveLength(2);
    expect(createsFor('shop.web')).toHaveLength(2);
  },
);

test('an upgrade interrupted after the replacements finishes on the next deploy without replacing again', async () => {
  const { platform, createsFor, stack } = fakePlatform();
  await runScratch(stack.deploy(previousReleaseProgram({ triggersRepeatValues: true })));
  platform.failVariableDeletes = true;

  const interrupted = await runScratch(Effect.exit(stack.deploy(program())));
  expect(Exit.isFailure(interrupted)).toBe(true);
  expect(createsFor('shop.auth')).toHaveLength(2);
  expect(platform.variables.size).toBe(rowKeys().length);

  platform.failVariableDeletes = false;
  await runScratch(stack.deploy(program()));

  expect(createsFor('shop.auth')).toHaveLength(2);
  expect(createsFor('shop.web')).toHaveLength(2);
  expect(platform.variables.size).toBe(0);
});

test('a row already deleted on the platform does not fail the upgrade', async () => {
  const { platform, stack } = fakePlatform();
  await runScratch(stack.deploy(previousReleaseProgram({ triggersRepeatValues: true })));
  const [goneId] = [...platform.variables.entries()].find(
    ([, v]) => v['key'] === 'COMPOSER_SHOP_WEB_PORT',
  ) ?? [''];
  platform.variables.delete(goneId);

  await runScratch(stack.deploy(program()));

  expect(platform.variables.size).toBe(0);
});

test('a row whose platform record no longer matches deploy state is dropped with a warning naming its key', async () => {
  const { platform, stack } = fakePlatform();
  await runScratch(stack.deploy(previousReleaseProgram({ triggersRepeatValues: true })));
  const mismatched = [...platform.variables.values()].find(
    (v) => v['key'] === 'COMPOSER_SHOP_WEB_PORT',
  );
  if (mismatched === undefined) throw new Error('fixture: no COMPOSER_SHOP_WEB_PORT row');
  mismatched['branchId'] = 'br_other';
  const warnings: string[] = [];
  const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === 'Warn') warnings.push(JSON.stringify(message));
  });

  await runScratch(stack.deploy(program()).pipe(Effect.provide(Logger.layer([capture]))));
  const requestsBefore = platform.requests.length;
  await runScratch(stack.deploy(program()));

  expect(warnings.filter((warning) => warning.includes('COMPOSER_SHOP_WEB_PORT'))).toHaveLength(1);
  expect([...platform.variables.values()].map((v) => v['key'])).toEqual(['COMPOSER_SHOP_WEB_PORT']);
  expect(
    platform.requests
      .slice(requestsBefore)
      .filter(({ path }) => path.startsWith('/v1/environment-variables')),
  ).toEqual([]);
});
