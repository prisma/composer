import type { Deps, Expose, Params } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { compute } from './compute.ts';

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
 */
export function s3StoreService<
  D extends Deps,
  P extends Params = Record<never, never>,
  E extends Expose = Record<never, never>,
>(def: Parameters<typeof compute<D, P, E>>[0]): ReturnType<typeof compute<D, P, E>> {
  const node = compute<D, P, E>(def);
  return Object.freeze(
    blindCast<
      ReturnType<typeof compute<D, P, E>>,
      "the spread copies compute's runnable (brand, deps/params/build/expose, run/load/config) and overrides only the routing type"
    >({ ...node, type: 's3-store' }),
  );
}
