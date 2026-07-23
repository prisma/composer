/** The dev stack's own provider aggregation (ADR-0041) — the dev counterpart of `deploy.ts`'s `mergedProviders`, kept in its own module so `lower()` learns nothing about dev (deploy.ts's REVISED — operator review of #162). */
import * as Layer from 'effect/Layer';
import {
  type ContainerInstance,
  type DevExtensionDescriptor,
  isBuildOnlyExtension,
  type PrismaAppConfig,
} from './app-config.ts';
import { LowerError } from './deploy.ts';

function noDevSupportError(id: string): LowerError {
  return new LowerError(
    `extension "${id}" has no dev support — it declares no \`dev\` descriptor (ADR-0041).`,
  );
}

/**
 * Resolves every non-build-only configured extension's lazy `dev` thunk,
 * once (ADR-0041's lazy dev reference — operator directive: the production
 * control entry carries only the thunk, never the descriptor, so resolving
 * it is this module's job, not something a deploy path ever does). A
 * build-only extension (`isBuildOnlyExtension`) owns no resources or
 * services and is skipped entirely — never even checked for a `dev` thunk.
 * Every other configured extension must be dev-capable, or dev cannot bring
 * the app up at all, so a missing thunk throws naming the extension. The
 * generated dev stack module calls this once and threads the resolved map
 * through every subsequent hook, including `devProviders`.
 */
export async function resolveDevDescriptors(
  config: PrismaAppConfig,
): Promise<ReadonlyMap<string, DevExtensionDescriptor>> {
  const entries = await Promise.all(
    config.extensions.flatMap((extension) => {
      if (isBuildOnlyExtension(extension)) return [];
      if (extension.dev === undefined) throw noDevSupportError(extension.id);
      return [extension.dev().then((descriptor) => [extension.id, descriptor] as const)];
    }),
  );
  return new Map(entries);
}

/**
 * All configured extensions' DEV providers merged, config array order
 * (ADR-0041), from the ALREADY-RESOLVED descriptor map
 * (`resolveDevDescriptors`'s product — this function itself never touches
 * a `dev` thunk). The generated dev stack module is this aggregator's one
 * caller, passing the result as `LowerOptions.providers`.
 */
export function devProviders(
  resolved: ReadonlyMap<string, DevExtensionDescriptor>,
  containers: ReadonlyMap<string, ContainerInstance>,
  devDir: string,
): Layer.Layer<never> {
  const layers = [...resolved.entries()].map(([id, descriptor]) =>
    descriptor.providers({ container: containers.get(id), devDir }),
  );
  const [first, ...rest] = layers;
  return first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest);
}
