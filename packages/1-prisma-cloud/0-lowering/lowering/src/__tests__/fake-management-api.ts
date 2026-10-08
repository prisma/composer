import { Credentials, Retry } from '@distilled.cloud/prisma';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
}

export const data = (value: unknown): Response => Response.json({ data: value });
export const page = (values: unknown[]): Response =>
  Response.json({ data: values, pagination: { hasMore: false, nextCursor: null } });

export function fakeManagementApi(
  respond: (request: ApiRequest) => Effect.Effect<Response>,
): Layer.Layer<HttpClient.HttpClient | Credentials | Retry.Retry> {
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const body = request.body;
      const text = body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : '';
      const response = yield* respond({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: text ? JSON.parse(text) : undefined,
      });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        apiToken: Redacted.make('fake-token'),
        apiBaseUrl: 'https://api.prisma.test',
      }),
    ),
    Layer.succeed(Retry.Retry, Retry.makeDefault),
  );
}
