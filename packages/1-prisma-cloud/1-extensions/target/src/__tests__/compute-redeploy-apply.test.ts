/** Two compute services, one reading the other's URL, deployed twice under the real Alchemy apply engine and the real `Prisma.App`, `Prisma.Deployment` and `Prisma.EnvironmentVariable` providers, against a fake Management API. */
import { expect, test } from 'bun:test';
import * as path from 'node:path';
import * as Prisma from '@alchemy.run/prisma';
import { dependency, string } from '@internal/core';
import type { LowerContext } from '@internal/core/deploy';
import {
  data,
  fakeManagementApi,
  page,
  runScratch,
  scratchStack,
} from '@internal/lowering/scratch-stack';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { compute } from '../compute.ts';
import { computeDescriptor } from '../descriptors/compute.ts';

const PROJECT_ID = 'proj_1';
const BRANCH_ID = 'br_default';
const CREATED_AT = '2026-11-20T00:00:00.000Z';

interface FakePlatform {
  readonly services: Map<string, Record<string, unknown>>;
  readonly deployments: Map<string, Record<string, unknown>>;
  /** The App id of every deployment ever created, in order; a deleted deployment stays listed. */
  readonly created: unknown[];
  readonly variables: Map<string, Record<string, unknown>>;
  readonly values: Map<string, unknown>;
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
      platform.created.push(service['id']);
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
    platform.values.set(String(sent['key']), sent['value']);
    return data(variable);
  }
  const variable = platform.variables.get(
    path.match(/^\/v1\/environment-variables\/([^/]+)$/)?.[1] ?? '',
  );
  if (variable !== undefined && method === 'GET') return data(variable);
  if (variable !== undefined && method === 'PATCH') {
    platform.values.set(String(variable['key']), sent['value']);
    return data(variable);
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
    values: new Map(),
  };
  const api = fakeManagementApi(({ method, path, body }) =>
    Effect.sync(() => respond(platform, method, new URL(path, 'https://api.prisma.test'), body)),
  );
  const providers = Layer.effect(
    Prisma.Providers,
    Provider.collection([Prisma.App, Prisma.Deployment, Prisma.EnvironmentVariable]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Prisma.AppProvider(),
        Prisma.DeploymentProvider(),
        Prisma.EnvironmentVariableProvider(),
      ),
    ),
    Layer.provideMerge(api),
  );
  const createdFor = (address: string) => {
    const service = [...platform.services.values()].find((s) => s['logicalId'] === address);
    return platform.created.filter((serviceId) => serviceId === service?.['id']);
  };
  return {
    platform,
    createdFor,
    stack: scratchStack({ providers, dev: false }, 'compute-redeploy'),
  };
}

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const auth = compute({ name: 'auth', deps: {}, build });
const web = compute({
  name: 'web',
  deps: {
    auth: dependency({
      type: 'rpc',
      connection: { params: { url: string() }, hydrate: (v) => v },
    }),
  },
  build,
});

const descriptor = computeDescriptor(() => ({ workspaceId: 'ws_1', providerParams: new Map() }));
const graph = { root: { id: 'shop' }, inputBindings: [], edges: [] };
const application = {
  projectId: PROJECT_ID,
  branchId: undefined,
  defaultBranchId: BRANCH_ID,
  branchless: false,
};
// The fake platform never unpacks an artifact, so any file serves as one.
const artifact = { path: import.meta.path, sha256: 'sha-artifact' };
const changedArtifact = { path: path.join(import.meta.dir, '..', 'compute.ts'), sha256: 'sha-2' };

function program(authArtifact = artifact) {
  return Effect.gen(function* () {
    const ctxOf = (address: string, node: unknown) =>
      ({ address, node, graph, application }) as unknown as LowerContext;
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
    const webSerialized = yield* descriptor.serialize(webCtx, webProvisioned, {
      service: { port: 3000 },
      inputs: { auth: { url: deployed.outputs['url'] } },
    });
    yield* descriptor.deploy(webCtx, webProvisioned, artifact, webSerialized);
  }) as Effect.Effect<void>;
}

test("an unchanged deploy keeps the deployment of a service that reads another service's url", async () => {
  const { platform, createdFor, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));
  expect(createdFor('shop.auth')).toHaveLength(1);
  expect(createdFor('shop.web')).toHaveLength(1);
  expect(platform.values.get('COMPOSER_SHOP_WEB_AUTH_URL')).toBe('https://svc_1.cdg.prisma.build');

  await runScratch(stack.deploy(program()));
  expect(createdFor('shop.auth')).toHaveLength(1);
  expect(createdFor('shop.web')).toHaveLength(1);
});

test('a new artifact for the service that is read replaces its deployment and keeps the reading service', async () => {
  const { createdFor, stack } = fakePlatform();

  await runScratch(stack.deploy(program()));
  await runScratch(stack.deploy(program(changedArtifact)));

  expect(createdFor('shop.auth')).toHaveLength(2);
  expect(createdFor('shop.web')).toHaveLength(1);
});
