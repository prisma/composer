/**
 * The `streams()` module: the production `@prisma/streams-server` runtime as
 * a Compute service behind a typed boundary. The durable tier arrives as a
 * dependency — wire a `storage()` module's `store` port into the `store` slot
 * (the first module-depends-on-module consumer of storage). The bearer key is
 * minted at deploy inside the module (ADR-0030) — the module owns its
 * `credentials` resource the way storage owns its minted SigV4 pair — and is
 * delivered to consumers through the `streams` binding, so the boundary has
 * no secret slot. Exposes a single `streams` port (`streamsContract`).
 */
import type { DependencyEnd, ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { bearerKey } from '@internal/prisma-cloud';
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
      const credentials = provision(bearerKey({ name: 'credentials' }), { id: 'credentials' });
      const service = provision(streamsService(), {
        id: 'service',
        deps: { store: inputs.store, credentials },
      });
      return { streams: service.streams };
    },
  );
}
