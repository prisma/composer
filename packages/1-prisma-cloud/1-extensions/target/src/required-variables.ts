import type { ServiceNode } from '@internal/core';
import type { PlatformMarkerUse } from '@internal/input-document';
import { inputValidationFailure, serializeInput } from './serializer.ts';

export interface MissingVariables {
  readonly names: readonly string[];
  readonly serviceAddress: string;
  readonly message: string;
  /** `schema` when the service's schema failed without them; `rule` when a rule outside the schema requires them. */
  readonly decidedBy: 'schema' | 'rule';
}

export type RequirementCheck =
  | { readonly kind: 'invalid'; readonly message: string }
  | {
      readonly kind: 'checked';
      readonly missing: readonly MissingVariables[];
      readonly markers: readonly PlatformMarkerUse[];
    };

const ARRAY_POSITION_MESSAGE =
  'an array position reads it, and an array position cannot be left out';

export function checkRequirements(
  node: ServiceNode,
  serviceAddress: string,
  binding: unknown,
  unset: readonly string[],
): RequirementCheck {
  const invalid = inputValidationFailure(node, serviceAddress, binding);
  if (invalid !== undefined) {
    return { kind: 'invalid', message: `${invalid.message}${invalid.variableNote}` };
  }
  const markers = serializeInput(node, serviceAddress, binding)?.markers ?? [];
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
    absentVariables: new Set(rest),
  });
  if (withoutAll === undefined) return checked([]);
  const alone: MissingVariables[] = [];
  for (const name of rest) {
    const failure = inputValidationFailure(node, serviceAddress, binding, {
      absentVariables: new Set([name]),
    });
    if (failure !== undefined) {
      alone.push({ names: [name], serviceAddress, message: failure.message, decidedBy: 'schema' });
    }
  }
  return checked(
    alone.length > 0
      ? alone
      : [{ names: rest, serviceAddress, message: withoutAll.message, decidedBy: 'schema' }],
  );
}
