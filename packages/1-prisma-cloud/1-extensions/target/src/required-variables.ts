/**
 * Which unset platform variables a service cannot do without, decided from its
 * schema and never from a value (ADR-0058). Both the deploy preflight and the
 * `prisma dev` preflight use it.
 */
import type { ServiceNode } from '@internal/core';
import { inputValidationFailure } from './serializer.ts';

/** One variable the schema requires, or several of which it requires some. */
export interface MissingVariables {
  readonly names: readonly string[];
  readonly serviceAddress: string;
  readonly message: string;
}

export type RequiredVariables =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'checked'; readonly missing: readonly MissingVariables[] };

/**
 * Validates the input with every variable present; a failure there is an
 * invalid input. Then with every name in `unset` left out; if that fails,
 * with each one alone left out, and the ones whose absence alone fails are
 * required. When none fails alone, the service needs some of them.
 */
export function requiredVariables(
  node: ServiceNode,
  serviceAddress: string,
  binding: unknown,
  unset: readonly string[],
  env: Readonly<Record<string, unknown>>,
): RequiredVariables {
  const invalid = inputValidationFailure(node, serviceAddress, binding, {
    env,
    absentSecrets: new Set(),
  });
  if (invalid !== undefined) return { kind: 'invalid', message: invalid };
  if (unset.length === 0) return { kind: 'checked', missing: [] };
  const withoutAll = inputValidationFailure(node, serviceAddress, binding, {
    env,
    absentSecrets: new Set(unset),
  });
  if (withoutAll === undefined) return { kind: 'checked', missing: [] };
  const missing: MissingVariables[] = [];
  for (const name of unset) {
    const message = inputValidationFailure(node, serviceAddress, binding, {
      env,
      absentSecrets: new Set([name]),
    });
    if (message !== undefined) missing.push({ names: [name], serviceAddress, message });
  }
  return {
    kind: 'checked',
    missing: missing.length > 0 ? missing : [{ names: unset, serviceAddress, message: withoutAll }],
  };
}
