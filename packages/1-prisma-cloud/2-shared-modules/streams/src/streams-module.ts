/**
 * The `streams()` module: the production `@prisma/streams-server` runtime as
 * a Compute service behind a typed boundary. The durable tier arrives as a
 * dependency — wire a `storage()` module's `store` port into the `store` slot
 * (the first module-depends-on-module consumer of storage). The bearer key is
 * neither wired nor owned by the module: a consumer's `durableStreams()`
 * binding declares it as a provisioning need, and the target mints one value
 * per streams module (ADR-0031) and lands it on this service. Exposes a
 * single `streams` port (`streamsContract`).
 */
import type { DependencyEnd, ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import type { S3Config, S3Contract } from '@internal/storage';
import { s3 } from '@internal/storage';
import { streamsContract } from './contract.ts';
import { streamsService } from './streams-service.ts';

export function streams(opts?: {
  name?: string;
}): ModuleNode<
  { store: DependencyEnd<S3Config, S3Contract> },
  { streams: typeof streamsContract },
  Record<never, never>
> {
  return module(
    opts?.name ?? 'streams',
    {
      deps: { store: s3() },
      expose: { streams: streamsContract },
    },
    ({ inputs, provision }) => {
      const service = provision(streamsService(), {
        id: 'service',
        deps: { store: inputs.store },
      });
      return { streams: service.streams };
    },
  );
}
