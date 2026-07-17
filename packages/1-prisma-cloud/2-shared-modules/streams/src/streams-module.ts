/**
 * The `streams()` module: the production `@prisma/streams-server` runtime as
 * a Compute service behind a typed boundary. The durable tier arrives as a
 * dependency — wire a `storage()` module's `store` port into the `store` slot
 * (the first module-depends-on-module consumer of storage). The bearer key is
 * neither wired nor owned by the module: a consumer's `durableStreams()`
 * binding declares it as a provisioning need, and the target mints one value
 * per streams module (ADR-0031) and stores it on this service. Exposes a
 * single `streams` port (`streamsContract`).
 */
import type { Contract, DependencyEnd, ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import type { S3Config, S3Contract } from '@internal/storage';
import { s3 } from '@internal/storage';
import type { StreamDefs } from './contract.ts';
import { streamsProviderContract } from './contract.ts';
import { streamsService } from './streams-service.ts';

export function streams(opts?: {
  name?: string;
}): ModuleNode<
  { store: DependencyEnd<S3Config, S3Contract> },
  { streams: Contract<'streams', StreamDefs> },
  Record<never, never>
> {
  return module(
    opts?.name ?? 'streams',
    {
      deps: { store: s3() },
      expose: { streams: streamsProviderContract },
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
