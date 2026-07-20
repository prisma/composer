/**
 * The list of provider-side reserved params the boot path validates and
 * stashes (ADR-0031): every brand's `{name, schema, brand}` declaration,
 * collected from that brand's own module (`service-keys.ts`,
 * `streams-keys.ts`) so `compute.ts` names no brand itself.
 *
 * This list exists separately from `control.ts`'s deploy-side registry
 * (`PROVIDER_PARAMS`) because `control.ts` is deploy-only code — it imports
 * `@internal/lowering` and `effect` to mint values — and a booted service
 * must never import it. This module is reachable from a user service's
 * bundle through `compute.ts`, so it must never import `@internal/lowering`,
 * `effect`, `alchemy`, or `control.ts`.
 *
 * This is the single source of which reserved provider params exist:
 * control.ts builds `PROVIDER_PARAMS` by mapping over this list and looking
 * up each entry's `value(refs)` by its `brand`, throwing at module load if
 * one is missing. Adding a brand means adding its entry here, plus its
 * deploy-side `value(refs)` in control.ts — a brand registered for deploy
 * but absent here is no longer expressible, because deploy no longer names
 * its own param set independently.
 */
import type { ProviderParamEntry } from './serializer.ts';
import { RPC_ACCEPTED_KEYS_PARAM } from './service-keys.ts';
import { STREAMS_API_KEY_PARAM } from './streams-keys.ts';

export const RESERVED_PROVIDER_PARAMS: readonly ProviderParamEntry[] = [
  RPC_ACCEPTED_KEYS_PARAM,
  STREAMS_API_KEY_PARAM,
];
