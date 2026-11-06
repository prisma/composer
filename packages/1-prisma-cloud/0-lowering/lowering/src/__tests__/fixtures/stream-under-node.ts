import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Stream from 'effect/Stream';
import { deployHttpClientLayer } from '../../deploy-http-client.ts';
import { refreshingEngineClient } from './refreshing-engine-client.ts';

const origin = process.argv[2] ?? '';
const { client, received } = refreshingEngineClient(origin);

const status = await Effect.runPromise(
  Effect.gen(function* () {
    const response = yield* (yield* HttpClient.HttpClient).execute(
      HttpClientRequest.post(`${origin}/v1/stream`).pipe(
        HttpClientRequest.bodyStream(
          Stream.make(new TextEncoder().encode('chunk1'), new TextEncoder().encode('chunk2')),
          { contentType: 'application/octet-stream' },
        ),
      ),
    );
    return response.status;
  }).pipe(Effect.scoped, Effect.provide(deployHttpClientLayer(client, origin))),
);

process.stdout.write(JSON.stringify({ status, received }));
