/** The local-target stack's own provider aggregation (ADR-0041; naming, operator 2026-07-23 — the seam is `localTarget`, "dev" names the user-facing feature only) — the local-target counterpart of `deploy.ts`'s `mergedProviders`, kept in its own module so `lower()` learns nothing about it (deploy.ts's REVISED — operator review of #162). */
import * as Layer from 'effect/Layer';
import {
  type ContainerInstance,
  isBuildOnlyExtension,
  type LocalTargetDescriptor,
  type PrismaAppConfig,
} from './app-config.ts';
import { LowerError } from './deploy.ts';

function noLocalTargetSupportError(id: string): LowerError {
  return new LowerError(
    `extension "${id}" has no dev support — it declares no \`localTarget\` descriptor (ADR-0041).`,
  );
}

/**
 * Resolves every non-build-only configured extension's lazy `localTarget`
 * thunk, once (ADR-0041's lazy local-target reference — operator directive:
 * the production control entry carries only the thunk, never the
 * descriptor, so resolving it is this module's job, not something a deploy
 * path ever does). A build-only extension (`isBuildOnlyExtension`) owns no
 * resources or services and is skipped entirely — never even checked for a
 * `localTarget` thunk. Every other configured extension must be
 * local-target-capable, or the dev command cannot bring the app up at all,
 * so a missing thunk throws naming the extension. The generated dev stack
 * module calls this once and threads the resolved map through every
 * subsequent hook, including `localTargetProviders`.
 */
export async function resolveLocalTargets(
  config: PrismaAppConfig,
): Promise<ReadonlyMap<string, LocalTargetDescriptor>> {
  const entries = await Promise.all(
    config.extensions.flatMap((extension) => {
      if (isBuildOnlyExtension(extension)) return [];
      if (extension.localTarget === undefined) throw noLocalTargetSupportError(extension.id);
      return [extension.localTarget().then((descriptor) => [extension.id, descriptor] as const)];
    }),
  );
  return new Map(entries);
}

/**
 * All configured extensions' local-target providers merged, config array
 * order (ADR-0041), from the ALREADY-RESOLVED descriptor map
 * (`resolveLocalTargets`'s product — this function itself never touches a
 * `localTarget` thunk). The generated dev stack module is this
 * aggregator's one caller, passing the result as `LowerOptions.providers`.
 */
export function localTargetProviders(
  resolved: ReadonlyMap<string, LocalTargetDescriptor>,
  containers: ReadonlyMap<string, ContainerInstance>,
  devDir: string,
): Layer.Layer<never> {
  const layers = [...resolved.entries()].map(([id, descriptor]) =>
    descriptor.providers({ container: containers.get(id), devDir }),
  );
  const [first, ...rest] = layers;
  return first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest);
}
