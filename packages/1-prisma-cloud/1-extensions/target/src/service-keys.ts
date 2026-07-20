/**
 * RPC's reserved provider param (ADR-0030/ADR-0031): the declaration —
 * name + schema + brand — for the accepted-keys set a provider stores, shared
 * by `control.ts` (which registers the deploy-side `value(refs)` that mints
 * and aggregates it — see its `rpcAcceptedKeysValue`) and `compute.ts` (which
 * validates and stashes it at boot), so writer and reader cannot drift.
 * Finding the edges themselves is `provisioned-edges.ts`'s generic,
 * brand-blind scan — RPC is not special-cased anywhere in this target.
 *
 * This module is reachable from the RUNTIME/authoring side — it must never
 * import `@internal/lowering` or `effect`, or those tokens leak into a user
 * service's bundle (the deploy-side `value(refs)` lives in control.ts, the
 * control-plane-only entry).
 */
import { RPC_PEER_KEY } from '@internal/rpc';
import { type } from 'arktype';
import type { ProviderParamEntry } from './serializer.ts';

/**
 * The reserved provider param for RPC's accepted-keys set: the var name is
 * `RPC_ACCEPTED_KEYS`, derived through `configKey` at both ends
 * (`configKey(address, …)` at deploy, `configKey('', …)` at boot — the
 * address-free form is `@internal/rpc`'s `RPC_ACCEPTED_KEYS_ENV`). `brand` is
 * `RPC_PEER_KEY`, the same brand `perBindingToken()`'s need carries — control.ts
 * looks its `value(refs)` up by this field.
 */
export const RPC_ACCEPTED_KEYS_PARAM: ProviderParamEntry = {
  name: 'RPC_ACCEPTED_KEYS',
  schema: type('string[]'),
  brand: RPC_PEER_KEY,
};
