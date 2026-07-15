/**
 * The durable-streams contract: the binding a consumer's `durableStreams()`
 * dependency requires, and the streams service's `streams` port provides.
 * Mirrors `s3Contract`/`s3()`: `satisfies` compares kind only, and the binding
 * IS the typed connection config (ADR-0015) — the app builds its own HTTP
 * client against the Durable Streams protocol. The bearer key IS in the
 * binding: it is a deploy-minted capability token (ADR-0030), not an ADR-0029
 * secret — minted once at deploy, stable in deploy state, delivered to
 * consumers on the same rail as the URL.
 */
import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

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
      params: { url: string(), apiKey: string() },
      hydrate: (v): StreamsConfig => v,
    },
    required: streamsContract,
  });
}
