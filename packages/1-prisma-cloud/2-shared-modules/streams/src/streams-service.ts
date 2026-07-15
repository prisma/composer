/**
 * The streams service node: a plain `compute` service (no lowering extension —
 * the contract binding is `{ url }`, which compute's deploy outputs already
 * carry). It declares the `store` dependency (`s3()`, the storage module's
 * port), the `apiKey` secret slot, and the `streams` expose. The deploy
 * bootstrap runs the default-exported bare node; the real wiring arrives
 * through serialized config at runtime — exactly like `storage-service.ts`.
 */
import { secret } from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { s3 } from '@internal/storage';
import { streamsContract } from './contract.ts';

export function streamsService() {
  return compute({
    name: 'streams',
    deps: { store: s3() },
    secrets: { apiKey: secret() },
    build: node({
      module: new URL('./streams-service.mjs', import.meta.url).href,
      entry: './streams-entrypoint.mjs',
    }),
    expose: { streams: streamsContract },
  });
}

export default streamsService();
