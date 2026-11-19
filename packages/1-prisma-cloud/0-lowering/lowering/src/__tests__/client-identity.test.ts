import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import pkg from '../../package.json' with { type: 'json' };
import {
  layer,
  type ManagementApiClient,
  ManagementClient,
  withDeploySourceHeaders,
} from '../client.ts';
import { deploySourceHeaders, PrismaCredentials } from '../credentials.ts';

const ORIGIN = 'https://api.prisma.test';
const IDENTITY_HEADERS = [
  'x-prisma-client-name',
  'x-prisma-client-version',
  'x-prisma-deploy-source',
] as const;

const identityOf = (request: Request) =>
  Object.fromEntries(IDENTITY_HEADERS.map((name) => [name, request.headers.get(name)]));

const ok = () => Response.json({ data: [], pagination: { hasMore: false, nextCursor: null } });

let originalGithubActions: string | undefined;
beforeEach(() => {
  originalGithubActions = process.env['GITHUB_ACTIONS'];
  delete process.env['GITHUB_ACTIONS'];
});
afterEach(() => {
  if (originalGithubActions === undefined) delete process.env['GITHUB_ACTIONS'];
  else process.env['GITHUB_ACTIONS'] = originalGithubActions;
});

/** The shared client `managementClientLayer()` builds, over a `fetch` that records each request. */
async function sharedClient(): Promise<{ client: ManagementApiClient; requests: Request[] }> {
  const requests: Request[] = [];
  const realFetch = globalThis.fetch;
  // openapi-fetch reads the global `fetch` once, when the client is built.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return ok();
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const client = await Effect.runPromise(
      Effect.service(ManagementClient).pipe(
        Effect.provide(
          layer({ apiOrigin: ORIGIN }).pipe(
            Layer.provide(Layer.succeed(PrismaCredentials, { token: Redacted.make('t') })),
          ),
        ),
      ),
    );
    return { client, requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('the shared Management API client identifies Composer', () => {
  test('every request carries the client name, the exact package version and the deploy source', async () => {
    const { client, requests } = await sharedClient();

    await client.GET('/v1/environment-variables', {
      params: { query: { projectId: 'proj', class: 'production', key: 'K' } },
    });
    await client.POST('/v1/projects', { body: { name: 'shop' } });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(identityOf(request)).toEqual({
        'x-prisma-client-name': 'composer',
        'x-prisma-client-version': pkg.version,
        'x-prisma-deploy-source': 'composer',
      });
    }
  });

  test('the deploy source is github-action when GITHUB_ACTIONS is "true"', async () => {
    process.env['GITHUB_ACTIONS'] = 'true';
    const { client, requests } = await sharedClient();

    await client.GET('/v1/environment-variables', {
      params: { query: { projectId: 'proj', class: 'production', key: 'K' } },
    });

    expect(requests[0]?.headers.get('x-prisma-deploy-source')).toBe('github-action');
  });
});

describe('withDeploySourceHeaders', () => {
  /** A client like the `prisma` CLI's: its own identity as default headers, over a recording fetch. */
  function callerClient() {
    const requests: Request[] = [];
    const client = createManagementApiClient({
      baseUrl: ORIGIN,
      headers: { 'x-prisma-client-name': 'prisma-cli', 'x-prisma-client-version': '8.0.0' },
      fetch: async (request: Request) => {
        requests.push(request);
        return ok();
      },
    });
    return { client, requests };
  }

  test("Composer's requests through the view say they came from Composer, over the caller's defaults", async () => {
    const { client, requests } = callerClient();

    await withDeploySourceHeaders(client).GET('/v1/environment-variables', {
      params: { query: { projectId: 'proj', class: 'preview', key: 'K' } },
    });
    await withDeploySourceHeaders(client).request('post', '/v1/projects', {
      body: { name: 'shop' },
    });

    for (const request of requests) {
      expect(identityOf(request)).toEqual({
        'x-prisma-client-name': 'composer',
        'x-prisma-client-version': pkg.version,
        'x-prisma-deploy-source': 'composer',
      });
    }
  });

  test("the caller's client is not changed: its own requests keep its headers", async () => {
    const { client, requests } = callerClient();
    withDeploySourceHeaders(client);

    await client.GET('/v1/workspaces');

    expect(requests[0]?.headers.get('x-prisma-client-name')).toBe('prisma-cli');
    expect(requests[0]?.headers.get('x-prisma-client-version')).toBe('8.0.0');
  });

  test("a request's own headers are kept, in every form openapi-fetch takes", async () => {
    const { client, requests } = callerClient();
    const view = withDeploySourceHeaders(client);

    await view.GET('/v1/workspaces', { headers: { 'x-custom': 'record' } });
    await view.GET('/v1/workspaces', { headers: new Headers({ 'x-custom': 'headers' }) });

    expect(requests.map((r) => r.headers.get('x-custom'))).toEqual(['record', 'headers']);
    for (const request of requests) {
      expect(request.headers.get('x-prisma-client-name')).toBe('composer');
    }
  });

  test("works over the engine's client, whose every property is an async call", async () => {
    const { client: sdk, requests } = callerClient();
    const engineClient = new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === 'symbol' || property === 'then'
            ? undefined
            : async (...args: unknown[]) => Reflect.apply(Reflect.get(sdk, property), sdk, args),
      },
    ) as ManagementApiClient;

    await withDeploySourceHeaders(engineClient).GET('/v1/workspaces');

    expect(requests[0]?.headers.get('x-prisma-client-name')).toBe('composer');
  });
});

describe('the identity header values follow the Management API format rules', () => {
  // docs/compute/DeployAnalytics.md in pdp-control-plane: the API silently
  // ignores a value that is longer or uses any other character.
  const FORMAT = /^[A-Za-z0-9._\-@/+]{1,100}$/;

  for (const [githubActions, label] of [
    [undefined, 'outside GitHub Actions'],
    ['true', 'in GitHub Actions'],
  ] as const) {
    test(`every value is valid ${label}`, () => {
      if (githubActions === undefined) delete process.env['GITHUB_ACTIONS'];
      else process.env['GITHUB_ACTIONS'] = githubActions;
      for (const value of Object.values(deploySourceHeaders())) expect(value).toMatch(FORMAT);
    });
  }

  test('prerelease versions are valid too', () => {
    for (const version of ['0.38.1', '0.39.0-dev.2', '1.0.0-rc.1+build.5']) {
      expect(version).toMatch(FORMAT);
    }
  });
});
