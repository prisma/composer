/**
 * The service's own origin as a reserved provider param (ADR-0031): the ONE
 * brand and the ONE entry — shared by control.ts (which registers the
 * deploy-side value function that resolves the provisioned service's
 * `endpointDomain` — see its `selfOriginValue`) and compute.ts (which
 * validates and stashes the row at boot through the generic
 * `stashProviderParams` loop), so writer and reader cannot drift.
 *
 * Unlike the key-minting brands (`service-keys.ts`, `streams-keys.ts`) this
 * brand has no provisioner and no consumer edges: the value derives from the
 * service's OWN provisioned attributes, so control.ts registers it as a
 * service-derived provider param (`descriptors/shared.ts`'s
 * `ServiceProviderParam`) and the descriptor writes it for EVERY compute
 * service, exposing or not.
 *
 * This module is reachable from the RUNTIME/authoring side — it must never
 * import `@internal/lowering` or `effect`, or those tokens leak into a user
 * service's bundle (the deploy-side value function lives in control.ts, the
 * control-plane-only entry).
 */
import { type } from 'arktype';
import type { ProviderParamEntry } from './serializer.ts';
import { ORIGIN_KEY_NAME } from './serializer.ts';

/** ADR-0031's brand for the service's own origin — control.ts registers the deploy-side value function under this. */
export const SELF_ORIGIN: unique symbol = Symbol.for('prisma:self-origin');

/**
 * The reserved provider param for the origin row: the var name is `ORIGIN`,
 * derived through `configKey` at both ends (`configKey(address, …)` at
 * deploy, `configKey('', …)` — `COMPOSER_ORIGIN` — at boot, where
 * `readOrigin` reads it back). `brand` is `SELF_ORIGIN` — control.ts looks
 * its deploy-side value function up by this field.
 */
export const ORIGIN_PARAM: ProviderParamEntry = {
  name: ORIGIN_KEY_NAME,
  schema: type('string'),
  brand: SELF_ORIGIN,
};
