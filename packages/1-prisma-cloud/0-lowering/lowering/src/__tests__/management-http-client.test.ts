import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Prisma from '@alchemy.run/prisma';
import type { Credentials, Retry } from '@distilled.cloud/prisma';
import { getWorkspaces } from '@distilled.cloud/prisma/management';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as Layer from 'effect/Layer';
import type { ManagementApiClient } from '../client.ts';
import { managementHttpClientLayer } from '../management-http-client.ts';
import { providers } from '../providers.ts';

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
    effect.pipe(Effect.scoped, Effect.provide(managementHttpClientLayer(client, ORIGIN))),
  );

describe('managementHttpClientLayer', () => {
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
