import type { Contract, DependencyEnd, ResourceNode } from '@internal/core';
import { dependency, resource, string } from '@internal/core';

export interface CredentialsConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The contract the `s3-credentials` resource provides — a minted SigV4 key
 * pair. `satisfies` compares KIND only (mirrors `postgresContract`); `__cmp` is
 * the config the resource offers, which core never inspects.
 */
export const credentialsContract: Contract<'credentials', CredentialsConfig> = Object.freeze({
  kind: 'credentials',
  __cmp: { accessKeyId: '', secretAccessKey: '' },
  satisfies: (required: Contract<'credentials', unknown>) => required.kind === 'credentials',
});

export type CredentialsContract = typeof credentialsContract;

/**
 * The one credentials factory; the argument shape picks the role. `{ name }` is
 * the resource identity a module provisions — the ONE place the key pair is
 * minted (its lowering mints once and keeps it stable across deploys).
 */
export function s3Credentials(opts: { name: string }): ResourceNode<typeof credentialsContract>;
/**
 * `s3Credentials()` — a service's dependency on the minted pair. Its binding is
 * the typed `CredentialsConfig`. The storage service reads the pair through this
 * dependency binding (invariant 4 — no bespoke env reads).
 */
export function s3Credentials(): DependencyEnd<CredentialsConfig, typeof credentialsContract>;
export function s3Credentials(opts?: {
  name: string;
}):
  | ResourceNode<typeof credentialsContract>
  | DependencyEnd<CredentialsConfig, typeof credentialsContract> {
  if (opts?.name !== undefined) {
    return resource({
      name: opts.name,
      extension: '@prisma/compose-prisma-cloud',
      provides: credentialsContract,
    });
  }
  return dependency({
    type: 'credentials',
    connection: {
      params: {
        accessKeyId: string(),
        secretAccessKey: string(),
      },
      hydrate: (v): CredentialsConfig => v,
    },
    required: credentialsContract,
  });
}
