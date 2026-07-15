/**
 * The `streams()` module: the production `@prisma/streams-server` runtime as
 * a Compute service behind a typed boundary. The durable tier arrives as a
 * dependency — wire a `storage()` module's `store` port into the `store` slot
 * (the first module-depends-on-module consumer of storage). The bearer key is
 * a forwardable `secret()` slot the root binds (ADR-0029). Exposes a single
 * `streams` port (`streamsContract`).
 */
import type { DependencyEnd, ModuleNode, SecretNeed } from '@internal/core';
import { module, secret } from '@internal/core';
import type { S3Config, S3Contract } from '@internal/storage';
import { s3 } from '@internal/storage';
import { streamsContract } from './contract.ts';
import { streamsService } from './streams-service.ts';

export function streams(opts?: {
  name?: string;
}): ModuleNode<
  { store: DependencyEnd<S3Config, S3Contract> },
  { streams: typeof streamsContract },
  { apiKey: SecretNeed }
> {
  return module(
    opts?.name ?? 'streams',
    {
      deps: { store: s3() },
      secrets: { apiKey: secret() },
      expose: { streams: streamsContract },
    },
    ({ inputs, secrets, provision }) => {
      const service = provision(streamsService(), {
        id: 'service',
        deps: { store: inputs.store },
        secrets: { apiKey: secrets.apiKey },
      });
      return { streams: service.streams };
    },
  );
}
