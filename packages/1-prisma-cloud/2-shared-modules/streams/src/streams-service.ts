/**
 * The streams service node: a plain `compute` service — the contract binding's
 * `url` is a producer output compute's deploy already carries, and its
 * `apiKey` is minted by the target's registered provisioner (ADR-0031), so
 * nothing is left for a bespoke lowering to extend. It declares the `store`
 * dependency (`s3()`, the storage module's port) and the `streams` expose; the
 * bearer key reaches this service through the target's reserved provider
 * param, not through a dependency. The deploy bootstrap runs the
 * default-exported bare node; the real wiring arrives through serialized
 * config at runtime — exactly like `storage-service.ts`.
 */
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { s3 } from '@internal/storage';
import { streamsProviderContract } from './contract.ts';

export function streamsService() {
  return compute({
    name: 'streams',
    deps: { store: s3() },
    build: node({
      module: new URL('./streams-service.mjs', import.meta.url).href,
      entry: './streams-entrypoint.mjs',
    }),
    expose: { streams: streamsProviderContract },
  });
}

export default streamsService();
