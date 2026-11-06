/**
 * Which unset platform variables a service cannot do without, decided from its
 * schema and never from a value (ADR-0058). Both the deploy preflight and the
 * `prisma dev` preflight use it.
 */
import type { ServiceNode } from '@internal/core';
import type { PlatformMarkerUse } from '@internal/input-document';
import { inputValidationFailure, serializeInput } from './serializer.ts';

/** One variable a service needs, or several of which it needs some, with the reason. */
export interface MissingVariables {
  readonly names: readonly string[];
  readonly serviceAddress: string;
  readonly message: string;
  /** `schema` when the service's schema failed without them; `rule` when a rule outside the schema requires them. */
  readonly decidedBy: 'schema' | 'rule';
}

/** The verdict on a service's unset variables. `markers` are the input document's `$platform` markers, returned so the caller need not serialize the input again. */
export type RequirementCheck =
  | { readonly kind: 'invalid'; readonly message: string }
  | {
      readonly kind: 'checked';
      readonly missing: readonly MissingVariables[];
      readonly markers: readonly PlatformMarkerUse[];
    };

const ARRAY_POSITION_MESSAGE =
  'an array position reads it, and an array position cannot be left out';

/**
 * Validates the input with every variable present; a failure there is an
 * invalid input. A variable an array position reads is required. Then
 * validates with every other name in `unset` left out; if that fails, with
 * each one alone left out, and the ones whose absence alone fails are
 * required. When none fails alone, the service needs some of them.
 */
export function checkRequirements(
  node: ServiceNode,
  serviceAddress: string,
  binding: unknown,
  unset: readonly string[],
  env: Readonly<Record<string, unknown>>,
): RequirementCheck {
  const invalid = inputValidationFailure(node, serviceAddress, binding, {
    env,
    absentSecrets: new Set(),
  });
  if (invalid !== undefined) return { kind: 'invalid', message: invalid };
  const markers = serializeInput(node, serviceAddress, binding, { env })?.markers ?? [];
  const unsetNames = new Set(unset);
  const inArray = new Set(
    markers.filter((marker) => marker.inArray && unsetNames.has(marker.name)).map((m) => m.name),
  );
  const missing: MissingVariables[] = [...inArray].map((name) => ({
    names: [name],
    serviceAddress,
    message: ARRAY_POSITION_MESSAGE,
    decidedBy: 'rule',
  }));
  const rest = unset.filter((name) => !inArray.has(name));
  const checked = (found: readonly MissingVariables[]): RequirementCheck => ({
    kind: 'checked',
    missing: [...missing, ...found],
    markers,
  });
  if (rest.length === 0) return checked([]);
  const withoutAll = inputValidationFailure(node, serviceAddress, binding, {
    env,
    absentSecrets: new Set(rest),
  });
  if (withoutAll === undefined) return checked([]);
  const alone: MissingVariables[] = [];
  for (const name of rest) {
    const message = inputValidationFailure(node, serviceAddress, binding, {
      env,
      absentSecrets: new Set([name]),
    });
    if (message !== undefined) {
      alone.push({ names: [name], serviceAddress, message, decidedBy: 'schema' });
    }
  }
  return checked(
    alone.length > 0
      ? alone
      : [{ names: rest, serviceAddress, message: withoutAll, decidedBy: 'schema' }],
  );
}

/** A per-key param is required when it has no default and is not optional. */
export function paramIsRequired(node: ServiceNode, param: string): boolean {
  const declared = node.params[param];
  return declared !== undefined && declared.default === undefined && declared.optional !== true;
}
