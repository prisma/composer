/**
 * The durable-streams contract: the binding a consumer's `durableStreams()`
 * dependency requires, and the streams service's `streams` port provides.
 * Mirrors `s3Contract`/`s3()`: `satisfies` compares kind only, and the binding
 * IS the typed connection config (ADR-0015) — the app builds its own HTTP
 * client against the Durable Streams protocol.
 *
 * The bearer key rides the binding as an ADR-0031 **provisioning need**: the
 * framework mints it at deploy and fills the param like any other input, so it
 * is neither an ADR-0029 secret (no name to bind, no out-of-band value) nor a
 * producer output. The need's brand and the provisioner that resolves it live
 * in `@internal/prisma-cloud` — the target sits BELOW this module, so the
 * brand is imported downward (see its `streams-keys.ts` for why).
 */
import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { streamsApiKeyNeed } from '@internal/prisma-cloud';

export interface StreamsConfig {
  readonly url: string;
  readonly apiKey: string;
}

export const streamsContract: Contract<'streams', StreamsConfig> = Object.freeze({
  kind: 'streams',
  __cmp: { url: '', apiKey: '' },
  satisfies: (required: Contract<'streams', unknown>) => required.kind === 'streams',
});

export type StreamsContract = typeof streamsContract;

/** A consumer's dependency on a durable-streams server. */
export function durableStreams(): DependencyEnd<StreamsConfig, typeof streamsContract> {
  return dependency({
    type: 'streams',
    connection: {
      params: { url: string(), apiKey: string({ provision: streamsApiKeyNeed() }) },
      hydrate: (v): StreamsConfig => v,
    },
    required: streamsContract,
  });
}
