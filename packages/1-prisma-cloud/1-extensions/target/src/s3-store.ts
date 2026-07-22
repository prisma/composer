import type { Deps, Expose, Params } from '@internal/core';
import { ComputeService, compute } from './compute.ts';

/**
 * The storage service authoring factory — a `compute` service routed to the
 * `s3-store` lowering instead of `compute`'s. It is exactly `compute`'s
 * runnable (run/load/config, deps, params, build, expose) with the routing
 * `type` overridden to `'s3-store'`: nothing at runtime keys off `type` (the
 * serializer keys off the deployment address and each param's owner/name, and
 * `load`/`config` off deps/params), so only the deploy-time descriptor lookup
 * sees the override and routes to the extended-output lowering (§ 5). The
 * return type is compute's exactly (including the reserved `port` param). The
 * storage module (D4b) calls this with its `db`/`credentials` deps, a `bucket`
 * param, and `expose: { store: s3Contract }`.
 *
 * `compute()`'s result is a `ComputeService` instance — its run/load/config/
 * secrets/origin methods live on the class prototype, not as the instance's
 * own properties, so a plain object spread (`{ ...node }`) would silently
 * drop them. Building a fresh `ComputeService` from the same data fields
 * (which `{ ...node }` DOES copy — they're the node's own enumerable
 * properties) with `type` overridden keeps every method intact.
 */
export function s3StoreService<
  D extends Deps,
  P extends Params = Record<never, never>,
  E extends Expose = Record<never, never>,
>(def: Parameters<typeof compute<D, P, E>>[0]): ReturnType<typeof compute<D, P, E>> {
  const node = compute<D, P, E>(def);
  const instance = new ComputeService<D, P, E, Record<never, never>>({ ...node, type: 's3-store' });
  Object.freeze(instance);
  return instance;
}
