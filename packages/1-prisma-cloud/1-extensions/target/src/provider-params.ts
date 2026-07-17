/**
 * The list of provider-side reserved params the boot path validates and
 * stashes (ADR-0031): every brand's `{name, schema}` declaration, collected
 * from that brand's own module (`service-keys.ts`, `streams-keys.ts`) so
 * `compute.ts` names no brand itself.
 *
 * This list exists separately from `control.ts`'s deploy-side registry
 * (`PROVIDER_PARAMS`) because `control.ts` is deploy-only code — it imports
 * `@internal/lowering` and `effect` to mint values — and a booted service
 * must never import it. This module is reachable from a user service's
 * bundle through `compute.ts`, so it must never import `@internal/lowering`,
 * `effect`, `alchemy`, or `control.ts`.
 *
 * Adding a brand means adding its entry here, plus its deploy-side
 * registration in `control.ts`. `__tests__/provider-params.test.ts` fails if
 * the two lists ever name a different set of params.
 */
import type { ProviderParamEntry } from './serializer.ts';
import { RPC_ACCEPTED_KEYS_PARAM } from './service-keys.ts';
import { STREAMS_API_KEY_PARAM } from './streams-keys.ts';

export const RESERVED_PROVIDER_PARAMS: readonly ProviderParamEntry[] = [
  RPC_ACCEPTED_KEYS_PARAM,
  STREAMS_API_KEY_PARAM,
];
