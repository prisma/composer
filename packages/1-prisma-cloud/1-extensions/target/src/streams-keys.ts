/**
 * The streams module's bearer key as an ADR-0031 provisioning need: the ONE
 * brand and the ONE reserved provider param — shared by control.ts (which
 * registers the deploy-side `value(refs)` that mints and stores it — see its
 * `streamsApiKeyProvisioner`/`streamsApiKeyValue`) and compute.ts (which
 * validates and stashes it at boot), so minting and wiring can never drift
 * apart. Finding the edges themselves is `provisioned-edges.ts`'s generic,
 * brand-blind scan. Mirrors `service-keys.ts` exactly.
 *
 * **Why the brand lives here, not in the declaring package.** ADR-0031's
 * discipline is that the declarer owns the brand and the target imports it —
 * which is what `@internal/rpc` does, sitting BELOW the target. `@internal/streams`
 * sits ABOVE it (prisma-cloud's layer order is lowering → extensions →
 * modules), so a target import of the module would invert the layering. The
 * brand therefore lives in the target and the module imports it downward; the
 * writer/reader-share-one-key discipline is unchanged.
 *
 * This module is also reachable from the RUNTIME/authoring side (compute.ts,
 * re-exported through index.ts) — it must never import `@internal/lowering`
 * or `effect`, or those tokens leak into a user service's bundle (the
 * deploy-side `value(refs)` lives in control.ts, the control-plane-only
 * entry).
 */
import type { ProvisionNeed } from '@internal/core';
import { provisionNeed } from '@internal/core';
import { type } from 'arktype';
import type { ProviderParamEntry } from './serializer.ts';
import { configKey } from './serializer.ts';

/** ADR-0031's need brand for the streams module's bearer key — control.ts registers the provisioner under this. */
export const STREAMS_API_KEY: unique symbol = Symbol.for('prisma:streams/api-key');

/**
 * The provisioning need `durableStreams()`'s `apiKey` param declares: an
 * unguessable value the target mints ONCE PER PROVIDER (not per edge) —
 * `@prisma/streams-server` authenticates a single `API_KEY`, so every
 * consumer of one streams module must present the same value. Per-provider
 * cardinality is provisioner policy (ADR-0031), invisible to core.
 */
export const streamsApiKeyNeed = (): ProvisionNeed => provisionNeed(STREAMS_API_KEY);

/**
 * The reserved provider param for the streams bearer key: the var name is
 * `STREAMS_API_KEY`. `brand` is `STREAMS_API_KEY` itself (the same symbol
 * `streamsApiKeyNeed()`'s need carries) — control.ts looks its `value(refs)`
 * up by this field.
 */
export const STREAMS_API_KEY_PARAM: ProviderParamEntry = {
  name: 'STREAMS_API_KEY',
  schema: type('string'),
  brand: STREAMS_API_KEY,
};

/** The address-free name compute.ts re-stashes to and the streams entrypoint reads. */
export const STREAMS_API_KEY_ENV = configKey('', {
  owner: 'service',
  name: STREAMS_API_KEY_PARAM.name,
});
