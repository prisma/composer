/**
 * The extension's DEV container lifecycle (local-dev spec § 5) — a purely
 * local identity, resolved with no platform call: `projectId` is the literal
 * `'local'`, and there is never a Branch. `deserialize` reuses
 * `container.ts`'s existing one — the dev and deploy container descriptors
 * produce/consume the identical wire shape (ADR-0037's transport), so the
 * SAME env var either narrows to a real hosted container or this local one
 * depending on which one the CLI resolved.
 */
import type { ContainerDescriptor, LocateContainerInput } from '@internal/core/config';
import { deserialize, PrismaCloudContainer } from '../container.ts';

function resolve(input: LocateContainerInput): PrismaCloudContainer {
  return new PrismaCloudContainer({ appName: input.appName, stage: undefined }, 'local', undefined);
}

export function devContainerDescriptor(): ContainerDescriptor<PrismaCloudContainer> {
  return {
    ensure: (input) => Promise.resolve(resolve(input)),
    locate: (input) => Promise.resolve(resolve(input)),
    remove: () => Promise.resolve(),
    deserialize,
  };
}
