import type { Contract, DependencyEnd, ResourceNode } from '@internal/core';
import { dependency, resource, string } from '@internal/core';

export interface BearerKeyConfig {
  readonly apiKey: string;
}

/**
 * The contract the `bearer-key` resource provides — a minted bearer API key.
 * `satisfies` compares KIND only (mirrors `credentialsContract`); `__cmp` is
 * the config the resource offers, which core never inspects.
 */
export const bearerKeyContract: Contract<'bearer-key', BearerKeyConfig> = Object.freeze({
  kind: 'bearer-key',
  __cmp: { apiKey: '' },
  satisfies: (required: Contract<'bearer-key', unknown>) => required.kind === 'bearer-key',
});

export type BearerKeyContract = typeof bearerKeyContract;

/**
 * The one bearer-key factory; the argument shape picks the role. `{ name }` is
 * the resource identity a module provisions — the ONE place the key is minted
 * (its lowering mints once and keeps it stable across deploys).
 */
export function bearerKey(opts: { name: string }): ResourceNode<typeof bearerKeyContract>;
/**
 * `bearerKey()` — a service's dependency on the minted key. Its binding is the
 * typed `BearerKeyConfig`. The service reads the key through this dependency
 * binding (invariant 4 — no bespoke env reads).
 */
export function bearerKey(): DependencyEnd<BearerKeyConfig, typeof bearerKeyContract>;
export function bearerKey(opts?: {
  name: string;
}):
  | ResourceNode<typeof bearerKeyContract>
  | DependencyEnd<BearerKeyConfig, typeof bearerKeyContract> {
  if (opts?.name !== undefined) {
    return resource({
      name: opts.name,
      extension: '@prisma/composer-prisma-cloud',
      provides: bearerKeyContract,
    });
  }
  return dependency({
    type: 'bearer-key',
    connection: {
      params: { apiKey: string() },
      hydrate: (v): BearerKeyConfig => v,
    },
    required: bearerKeyContract,
  });
}
