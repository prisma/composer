import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';

export function platformVariableDescriptor(): NodeDescriptor {
  const lowering: Lowering = () => Effect.succeed({ outputs: {}, entities: [] });
  return Object.assign(lowering, { kind: 'resource' as const });
}
