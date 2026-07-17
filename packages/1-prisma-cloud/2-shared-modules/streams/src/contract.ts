/**
 * The durable-streams contract: it names the streams a consumer's
 * `durableStreams()` dependency binds to. `streamsContract(defs)` is the
 * authoring surface — one entry per stream, each an optional `streamDef()`
 * (untyped only in this slice: no event schema yet, that is a follow-up
 * slice). The def map is the contract's `__cmp`, the same place rpc's
 * `contract()` puts its function map.
 *
 * `satisfies` stays kind-only: the Durable Streams server is schema-agnostic
 * (it carries bytes, not types), so a provider cannot attest to a consumer's
 * chosen stream names or event shapes, and checking `__cmp` at wiring time
 * would be a guess. Two consumers naming the same stream with different defs
 * is therefore expressible and unchecked at Load; each reader's own
 * (currently no-op, future typed) validation is what would catch a lie.
 *
 * The wire binding underneath is still the typed connection config
 * (ADR-0015) — `{ url, apiKey }` — unchanged by which streams a contract
 * names, since stream names are protocol data (URL path segments), never
 * config keys.
 *
 * The bearer key rides the binding as an ADR-0031 provisioning need: the
 * framework mints it at deploy and fills the param like any other input, so
 * it is neither an ADR-0029 secret (no name to bind, no out-of-band value)
 * nor a producer output. The need's brand and the provisioner that resolves
 * it live in `@internal/prisma-cloud` — the target sits BELOW this module, so
 * the brand is imported downward (see its `streams-keys.ts` for why).
 */
import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { streamsApiKeyNeed } from '@internal/prisma-cloud';
import type { StreamHandle } from './client.ts';
import { StreamsClient } from './client.ts';

export interface StreamsConfig {
  readonly url: string;
  readonly apiKey: string;
}

/**
 * One stream's declaration in a `streamsContract` def map. Untyped only in
 * this slice — carries no event schema. Typed validation
 * (`streamDef({ event })`) is a recorded follow-up slice; this shape is
 * deliberately empty rather than half-carrying a schema parameter that does
 * nothing.
 */
export interface StreamDef {
  readonly kind: 'stream-def';
}

/** Declares an untyped stream in a `streamsContract` def map. */
export function streamDef(): StreamDef {
  return Object.freeze({ kind: 'stream-def' as const });
}

export type StreamDefs = Record<string, StreamDef>;

/**
 * Names the streams a contract transports, each with an optional def:
 * `streamsContract({ jobs: streamDef(), audit: streamDef() })`. The
 * `durableStreams(contract)` dependency built from it hydrates to one handle
 * per declared name.
 */
export function streamsContract<D extends StreamDefs>(defs: D): Contract<'streams', D> {
  return Object.freeze({
    kind: 'streams',
    __cmp: defs,
    satisfies: (required: Contract<'streams', unknown>) => required.kind === 'streams',
  });
}

/** The type of a `streamsContract(defs)` value. */
export type StreamsContract<D extends StreamDefs = StreamDefs> = Contract<'streams', D>;

/**
 * The `streams()` module's own exposed port: a general streams provider,
 * satisfied by kind alone. It carries no def map of its own — the module
 * doesn't know its eventual consumers' stream names, and different
 * consumers of the same module may each name different streams — so its
 * `__cmp` is typed `never` rather than any specific def map. `never` is the
 * one `Cmp` a `Contract<'streams', Cmp>` can carry that is structurally
 * assignable to every consumer's own, more specific `streamsContract(defs)`
 * requirement (a `Record<string, StreamDef>`, unlike `never`, is NOT
 * assignable to a narrower literal record type — TypeScript requires the
 * literal property, an index signature alone doesn't supply it). The
 * `blindCast` below is the honest way to say that: no value of type `never`
 * exists, and none is needed, because `satisfies` below never reads `__cmp`.
 */
export const streamsProviderContract: Contract<'streams', never> = Object.freeze({
  kind: 'streams',
  __cmp: blindCast<
    never,
    'no consumer reads this __cmp — satisfies() below checks kind only — and never is the one Cmp that structurally satisfies every more specific streamsContract(defs) requirement'
  >(undefined),
  satisfies: (required: Contract<'streams', unknown>) => required.kind === 'streams',
});

/** The handles a `durableStreams(contract)` dependency hydrates to: one per declared stream name. */
export type StreamHandles<D extends StreamDefs> = { readonly [K in keyof D]: StreamHandle };

const connectionParams = {
  url: string(),
  apiKey: string({ provision: streamsApiKeyNeed() }),
};

/**
 * A consumer's dependency on a durable-streams server. Given a
 * `streamsContract(defs)`, hydrates to one handle per declared stream name —
 * the handle owns the name, so no call site names it again. Called with no
 * argument, hydrates to a `StreamsClient` for dynamic stream names (e.g.
 * per-tenant streams) — the `postgres()` parity: the same lifecycle
 * ownership, the name is data rather than a wiring-time declaration.
 */
export function durableStreams<D extends StreamDefs>(
  contract: Contract<'streams', D>,
): DependencyEnd<StreamHandles<D>, Contract<'streams', D>>;
export function durableStreams(): DependencyEnd<StreamsClient, Contract<'streams', StreamDefs>>;
export function durableStreams(contract?: Contract<'streams', StreamDefs>): unknown {
  return dependency({
    type: 'streams',
    connection: {
      params: connectionParams,
      hydrate: (v: StreamsConfig) => {
        const client = new StreamsClient(v);
        if (contract === undefined) return client;
        const handles: Record<string, StreamHandle> = {};
        for (const name of Object.keys(contract.__cmp)) handles[name] = client.stream(name);
        return handles;
      },
    },
    required: contract ?? streamsProviderContract,
  });
}
