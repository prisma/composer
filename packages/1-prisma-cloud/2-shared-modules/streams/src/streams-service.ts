/**
 * The streams service node: a `compute` service routed to the `streams`
 * lowering (`streamsCompute` — the s3-store pattern), whose extended deploy
 * outputs surface the minted bearer key so a consumer's `durableStreams()`
 * binding resolves `{ url, apiKey }` by name. It declares the `store`
 * dependency (`s3()`, the storage module's port) and the `credentials`
 * dependency (`bearerKey()`, the module-minted key). The deploy bootstrap
 * runs the default-exported bare node; the real wiring arrives through
 * serialized config at runtime — exactly like `storage-service.ts`.
 */
import node from '@internal/node';
import { bearerKey, streamsCompute } from '@internal/prisma-cloud';
import { s3 } from '@internal/storage';
import { streamsContract } from './contract.ts';

export function streamsService() {
  return streamsCompute({
    name: 'streams',
    deps: { store: s3(), credentials: bearerKey() },
    build: node({
      module: new URL('./streams-service.mjs', import.meta.url).href,
      entry: './streams-entrypoint.mjs',
    }),
    expose: { streams: streamsContract },
  });
}

export default streamsService();
