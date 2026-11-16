import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as Prisma from '@alchemy.run/prisma';
import type { Credentials, Retry } from '@distilled.cloud/prisma';
import { getWorkspaces } from '@distilled.cloud/prisma/management';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import type { ManagementApiClient } from '../client.ts';
import { deployHttpClientLayer } from '../deploy-http-client.ts';
import { providers } from '../providers.ts';
import { refreshingEngineClient } from './fixtures/refreshing-engine-client.ts';

const ORIGIN = 'https://api.prisma.test';

/**
 * The SDK client the engine hands a command as `ctx.api`, over a fetch that
 * records each request. The engine wraps the client in a Proxy that turns
 * every property into an async call, so this does too: the adapter may only
 * call the client's methods.
 */
function fakeEngineClient(respond: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [];
  const sdk = createManagementApiClient({
    baseUrl: ORIGIN,
    fetch: async (request: Request) => {
      requests.push(request);
      return respond(request);
    },
  });
  const client = new Proxy(
    {},
    {
      get: (_target, property) =>
        typeof property === 'symbol' || property === 'then'
          ? undefined
          : async (...args: unknown[]) => Reflect.apply(Reflect.get(sdk, property), sdk, args),
    },
  ) as ManagementApiClient;
  return { client, requests };
}

const run = <A, E>(
  client: ManagementApiClient,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(deployHttpClientLayer(client, ORIGIN))),
  );

describe('deployHttpClientLayer', () => {
  test('a Management API request goes through the client with its body, query and headers intact and no Authorization', async () => {
    const { client, requests } = fakeEngineClient(() =>
      Response.json({ data: { id: 'proj_1' } }, { status: 201, headers: { 'x-request-id': 'r1' } }),
    );
    const body = '{"name":"shop",  "region":"eu-central-1"}';

    const response = await run(
      client,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.post(`${ORIGIN}/v1/projects`).pipe(
            HttpClientRequest.setUrlParams({ limit: '5', cursor: 'a b' }),
            HttpClientRequest.bodyText(body, 'application/json'),
            HttpClientRequest.setHeader('x-custom', 'kept'),
          ),
        );
        return {
          status: response.status,
          header: response.headers['x-request-id'],
          text: yield* response.text,
        };
      }),
    );

    expect(response).toEqual({ status: 201, header: 'r1', text: '{"data":{"id":"proj_1"}}' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) throw new Error('no request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${ORIGIN}/v1/projects?limit=5&cursor=a+b`);
    expect(await request.text()).toBe(body);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-custom')).toBe('kept');
    expect(request.headers.get('x-prisma-client-name')).toBe('composer');
    expect(request.headers.has('authorization')).toBe(false);
  });

  test('an error response keeps its status and body', async () => {
    const { client } = fakeEngineClient(
      () => new Response('{"error":{"code":"quota"}}', { status: 422 }),
    );

    const result = await run(
      client,
      Effect.gen(function* () {
        const response = yield* (yield* HttpClient.HttpClient).get(`${ORIGIN}/v1/projects/p1`);
        return { status: response.status, json: yield* response.json };
      }),
    );

    expect(result).toEqual({ status: 422, json: { error: { code: 'quota' } } });
  });

  test('a failure in the client is a TransportError carrying the cause', async () => {
    const failure = new Error('CLI.CREDENTIALS_REQUIRED');
    const { client } = fakeEngineClient(() => Promise.reject(failure));

    const error = await run(
      client,
      Effect.flip(
        Effect.flatMap(HttpClient.HttpClient, (http) => http.get(`${ORIGIN}/v1/projects`)),
      ),
    );

    expect(error.reason._tag).toBe('TransportError');
    expect(error.reason.cause).toBe(failure);
  });

  test('interrupting the request aborts the client call', async () => {
    let signal: AbortSignal | undefined;
    const { client } = fakeEngineClient(
      (request) =>
        new Promise((_resolve, reject) => {
          signal = request.signal;
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    );

    await run(
      client,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const fiber = yield* Effect.forkChild(http.get(`${ORIGIN}/v1/projects`));
        yield* Effect.promise(async () => {
          while (signal === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
        });
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(signal?.aborted).toBe(true);
  });

  test("a request's own Authorization never reaches the client", async () => {
    const { client, requests } = fakeEngineClient(() => Response.json({}));

    await run(
      client,
      Effect.flatMap(HttpClient.HttpClient, (http) =>
        http.execute(
          HttpClientRequest.get(`${ORIGIN}/v1/projects`).pipe(
            HttpClientRequest.bearerToken('stale'),
          ),
        ),
      ),
    );

    expect(requests[0]?.headers.has('authorization')).toBe(false);
  });

  test('a client built from a token keeps its own Authorization when the request carries one', async () => {
    const requests: Request[] = [];
    const client = createManagementApiClient({
      baseUrl: ORIGIN,
      token: 'fake-test-token',
      fetch: async (request: Request) => {
        requests.push(request);
        return Response.json({});
      },
    });

    await run(
      client,
      Effect.flatMap(HttpClient.HttpClient, (http) =>
        http.execute(
          HttpClientRequest.get(`${ORIGIN}/v1/projects`).pipe(HttpClientRequest.bearerToken('')),
        ),
      ),
    );

    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fake-test-token');
  });

  test('a JSON error body that is a string keeps its quotes, so it still decodes', async () => {
    const { client } = fakeEngineClient(
      () =>
        new Response('"quota exceeded"', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const json = await run(
      client,
      Effect.gen(function* () {
        const response = yield* (yield* HttpClient.HttpClient).get(`${ORIGIN}/v1/projects`);
        return yield* response.json;
      }),
    );

    expect(json).toBe('quota exceeded');
  });

  test('a text error body is passed back as it was', async () => {
    const { client } = fakeEngineClient(
      () =>
        new Response('upstream timeout', {
          status: 504,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    const text = await run(
      client,
      Effect.gen(function* () {
        const response = yield* (yield* HttpClient.HttpClient).get(`${ORIGIN}/v1/projects`);
        return yield* response.text;
      }),
    );

    expect(text).toBe('upstream timeout');
  });

  test('a byte body with no content type reaches the client unlabelled', async () => {
    const { client, requests } = fakeEngineClient(() => Response.json({}));

    await run(
      client,
      Effect.flatMap(HttpClient.HttpClient, (http) =>
        http.execute(
          HttpClientRequest.post(`${ORIGIN}/v1/raw`).pipe(
            HttpClientRequest.bodyUint8Array(new TextEncoder().encode('raw')),
          ),
        ),
      ),
    );

    const [request] = requests;
    expect(await request?.text()).toBe('raw');
    expect(request?.headers.get('content-type')).not.toBe('application/json');
  });

  test('a form-data body keeps its multipart boundary', async () => {
    const { client, requests } = fakeEngineClient(() => Response.json({}));
    const form = new FormData();
    form.append('name', 'shop');

    await run(
      client,
      Effect.flatMap(HttpClient.HttpClient, (http) =>
        http.execute(
          HttpClientRequest.post(`${ORIGIN}/v1/forms`).pipe(HttpClientRequest.bodyFormData(form)),
        ),
      ),
    );

    const received = await requests[0]?.formData();
    expect(received?.get('name')).toBe('shop');
  });

  test('a streamed body reaches the client whole, and again on its retry after a 401', async () => {
    const { client, received } = refreshingEngineClient(ORIGIN);

    const status = await run(
      client,
      Effect.gen(function* () {
        const response = yield* (yield* HttpClient.HttpClient).execute(
          HttpClientRequest.post(`${ORIGIN}/v1/stream`).pipe(
            HttpClientRequest.bodyStream(
              Stream.make(new TextEncoder().encode('chunk1'), new TextEncoder().encode('chunk2')),
              { contentType: 'application/octet-stream' },
            ),
          ),
        );
        return response.status;
      }),
    );

    expect(status).toBe(200);
    expect(received).toEqual([
      { authorization: 'Bearer expired', body: 'chunk1chunk2' },
      { authorization: 'Bearer refreshed', body: 'chunk1chunk2' },
    ]);
  });

  test('under node, a streamed body reaches the client whole, and again on its retry after a 401', () => {
    const result = spawnSync(
      'node',
      [path.join(import.meta.dir, 'fixtures', 'stream-under-node.ts'), ORIGIN],
      { encoding: 'utf8' },
    );

    if (result.status !== 0) throw new Error(result.stderr);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 200,
      received: [
        { authorization: 'Bearer expired', body: 'chunk1chunk2' },
        { authorization: 'Bearer refreshed', body: 'chunk1chunk2' },
      ],
    });
  });

  describe('another host', () => {
    const uploads: { method: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        uploads.push({ method: request.method ?? '', headers: request.headers, body });
        response.writeHead(200).end();
      });
    });
    let uploadUrl = '';
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      uploadUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/upload?sig=abc`;
    });
    afterAll(() => {
      server.close();
    });

    test('goes to the node transport with an explicit Content-Length and no credential, not through the client', async () => {
      const { client, requests } = fakeEngineClient(() => new Response(null, { status: 500 }));

      const status = await run(
        client,
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const response = yield* http.execute(
            HttpClientRequest.put(uploadUrl).pipe(
              HttpClientRequest.bodyUint8Array(
                new TextEncoder().encode('artifact'),
                'application/gzip',
              ),
            ),
          );
          return response.status;
        }),
      );

      expect(status).toBe(200);
      expect(requests).toEqual([]);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.method).toBe('PUT');
      expect(uploads[0]?.body).toBe('artifact');
      expect(uploads[0]?.headers['content-length']).toBe('8');
      expect(uploads[0]?.headers['authorization']).toBeUndefined();
    });
  });
});

/** The type lists the stack services the providers need when a stack runs them; these tests only call the clients the bundle exposes. */
const bundle = (client: ManagementApiClient) =>
  providers({ client }) as unknown as Layer.Layer<
    Prisma.PrismaClient | Credentials | HttpClient.HttpClient | Retry.Retry
  >;

describe('providers({ client })', () => {
  test("an upstream provider's request goes through the supplied client, with no token anywhere", async () => {
    const saved = process.env['PRISMA_SERVICE_TOKEN'];
    delete process.env['PRISMA_SERVICE_TOKEN'];
    const { client, requests } = fakeEngineClient(() =>
      Response.json({ data: { id: 'proj_1', name: 'shop' } }),
    );
    try {
      const project = await Effect.runPromise(
        Effect.gen(function* () {
          const prisma = yield* Prisma.PrismaClient;
          return yield* prisma.getProject('proj_1');
        }).pipe(Effect.scoped, Effect.provide(bundle(client))),
      );

      expect(project).toMatchObject({ id: 'proj_1' });
      // Alchemy addresses the default origin; the client sends the path to its own server.
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        `GET ${ORIGIN}/v1/projects/proj_1`,
      ]);
      expect(requests[0]?.headers.has('authorization')).toBe(false);
    } finally {
      if (saved !== undefined) process.env['PRISMA_SERVICE_TOKEN'] = saved;
    }
  });
});

describe('providers({ client }) and the generated operations', () => {
  test('a Distilled operation goes through the supplied client with no Authorization', async () => {
    const { client, requests } = fakeEngineClient(() =>
      Response.json({ data: [], pagination: { hasMore: false, nextCursor: null } }),
    );

    await Effect.runPromise(getWorkspaces({}).pipe(Effect.scoped, Effect.provide(bundle(client))));

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ['GET /v1/workspaces'],
    );
    expect(requests[0]?.headers.has('authorization')).toBe(false);
  });
});

/** A loopback Management API that records each request's path and Authorization header. */
function recordingServer(respond: (path: string) => unknown) {
  const received: { path: string; authorization: string | undefined }[] = [];
  const server = http.createServer((request, response) => {
    received.push({ path: request.url ?? '', authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(respond(request.url ?? '')));
  });
  return {
    received,
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`),
        ),
      ),
    stop: () => server.close(),
  };
}

describe('providers() with no client', () => {
  const api = recordingServer((path) =>
    path.startsWith('/v1/workspaces')
      ? { data: [], pagination: { hasMore: false, nextCursor: null } }
      : { data: { id: 'proj_1', name: 'shop' } },
  );
  let origin = '';
  beforeAll(async () => {
    origin = await api.start();
  });
  afterAll(() => {
    api.stop();
  });

  const withEnvironment = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      effect,
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({
        PRISMA_SERVICE_TOKEN: 'fake-test-token',
        PRISMA_API_URL: origin,
      }),
    );

  test('an upstream provider request and a Distilled operation carry the token from PRISMA_SERVICE_TOKEN', async () => {
    const envBundle = providers() as unknown as Layer.Layer<
      Prisma.PrismaClient | Credentials | HttpClient.HttpClient | Retry.Retry
    >;

    await Effect.runPromise(
      withEnvironment(
        Effect.gen(function* () {
          yield* (yield* Prisma.PrismaClient).getProject('proj_1');
          yield* getWorkspaces({});
        }).pipe(Effect.scoped, Effect.provide(envBundle)),
      ),
    );

    expect(api.received).toEqual([
      { path: '/v1/projects/proj_1', authorization: 'Bearer fake-test-token' },
      { path: '/v1/workspaces', authorization: 'Bearer fake-test-token' },
    ]);
  });
});

describe('providers({ client }) and the host settings', () => {
  const runWith = (env: Record<string, string>) => {
    const { client, requests } = fakeEngineClient(() => Response.json({ data: { id: 'proj_1' } }));
    return Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* Prisma.PrismaClient).getProject('proj_1');
      }).pipe(
        Effect.scoped,
        Effect.provide(bundle(client)),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      ),
    ).then((exit) => ({ exit, requests }));
  };

  test("requests are recognised by the client's own origin, from PRISMA_MANAGEMENT_API_URL", async () => {
    const { exit, requests } = await runWith({ PRISMA_MANAGEMENT_API_URL: ` ${ORIGIN} ` });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([`${ORIGIN}/v1/projects/proj_1`]);
  });

  test('PRISMA_API_URL naming the same origin is accepted', async () => {
    const { exit } = await runWith({
      PRISMA_MANAGEMENT_API_URL: ORIGIN,
      PRISMA_API_URL: `${ORIGIN}/`,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test('PRISMA_API_URL naming another origin fails, naming both values', async () => {
    const { exit, requests } = await runWith({
      PRISMA_MANAGEMENT_API_URL: ORIGIN,
      PRISMA_API_URL: 'https://api.prisma.io',
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
      'PRISMA_API_URL is https://api.prisma.io',
    );
    expect(requests).toEqual([]);
  });
});
