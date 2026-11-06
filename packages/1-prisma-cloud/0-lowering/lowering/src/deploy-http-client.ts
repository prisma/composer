import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { blindCast } from '@internal/foundation/casts';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import type { ManagementApiClient } from './client.ts';
import { deploySourceHeaders } from './credentials.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

const isMethod = (method: string): method is Method => METHODS.some((m) => m === method);

interface RawInit extends Omit<RequestInit, 'headers' | 'body'> {
  readonly body: BodyInit | undefined;
  readonly headers: Record<string, string | null>;
  readonly bodySerializer: (body: BodyInit) => BodyInit;
  readonly parseAs: 'stream';
}

type RawCall = (
  path: string,
  init: RawInit,
) => Promise<{ readonly response: Response; readonly error?: unknown }>;

const rawCalls = (client: ManagementApiClient) =>
  blindCast<
    Readonly<Record<Method, RawCall>>,
    "openapi-fetch's per-method calls take any path string at runtime; its typed signature only narrows the path to the documented ones, and this client forwards paths Alchemy built"
  >(client);

const isJson = (contentType: string | null): boolean =>
  contentType !== null && /[/+]json\b/i.test(contentType);

/**
 * openapi-fetch reads an error body and gives it back parsed, so the response
 * it returns has no body left. A JSON body is serialized again, so a JSON
 * string keeps its quotes; any other body was left as text.
 */
const withErrorBody = (response: Response, error: unknown): Response => {
  if (!response.bodyUsed) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  const body =
    typeof error === 'string' && !isJson(response.headers.get('content-type'))
      ? error
      : JSON.stringify(error);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** A `fetch` that sends each request through the SDK client. The client owns authentication, so any `Authorization` the caller set is dropped. */
const fetchThrough = (client: ManagementApiClient): typeof globalThis.fetch => {
  const calls = rawCalls(client);
  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    if (!isMethod(method)) {
      return Promise.reject(new Error(`The Management API client cannot send ${method}.`));
    }
    const forwarded = new Headers(init?.headers);
    forwarded.delete('authorization');
    const headers: Record<string, string | null> = Object.fromEntries(forwarded.entries());
    // Without a content type of its own, openapi-fetch would label the body JSON.
    if (init?.body != null && headers['content-type'] === undefined) headers['content-type'] = null;
    const { response, error } = await calls[method](`${url.pathname}${url.search}`, {
      ...init,
      body: init?.body ?? undefined,
      headers,
      bodySerializer: (body) => body,
      parseAs: 'stream',
    });
    return withErrorBody(response, error);
  };
  return Object.assign(send, { preconnect: globalThis.fetch.preconnect });
};

/**
 * The deploy's `HttpClient`, for every host. Requests to the Management API
 * `origin` go through `client`, which alone authenticates them: their own
 * `Authorization` header is removed first. Every other host, such as a
 * presigned artifact upload URL, goes to node's transport unauthenticated,
 * because those uploads need node's explicit Content-Length. Every request
 * carries the deploy-source headers.
 */
export const deployHttpClientLayer = (
  client: ManagementApiClient,
  origin: string,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const management = yield* HttpClient.HttpClient.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchThrough(client)),
      );
      const other = yield* NodeHttpClient.makeNodeHttp;
      const routed = HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
        Effect.flatMap((request) =>
          URL.parse(request.url)?.origin === origin
            ? management.execute(request)
            : other.execute(request),
        ),
        Effect.succeed,
      );
      return HttpClient.mapRequest(routed, HttpClientRequest.setHeaders(deploySourceHeaders()));
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerAgent));
